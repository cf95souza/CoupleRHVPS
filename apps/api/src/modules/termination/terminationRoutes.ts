import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdminRole, requirePermission } from '../auth/authMiddleware.js';
import {
  buildAtomicPayrollPayload,
  evaluateIRRFDependents,
  TerminationOrchestrator,
  validateAllLegalTables,
  type UnifiedDismissalReason,
  type UnifiedNoticeType,
  type UnifiedTerminationInput,
  type UnifiedTerminationOutput,
} from '@couplerh/payroll-core';
import { loadHistoricalAveragesItems } from '../payroll/payrollCalculationService.js';

const terminationPreviewSchema = z.object({
  contractId: z.string().uuid().optional(),
  contract_id: z.string().uuid().optional(),
  resignationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  terminationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  contractEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  dismissalType: z
    .enum([
      'WITHOUT_CAUSE',
      'WITH_CAUSE',
      'RESIGNATION',
      'MUTUAL_AGREEMENT',
      'CONTRACT_EXPIRATION',
      'EARLY_TERMINATION_EMPLOYER',
      'EARLY_TERMINATION_EMPLOYEE',
      'DEATH',
      'INDIRECT_DISMISSAL',
      'RECIPROCAL_FAULT',
      'COMPANY_EXTINCTION',
    ])
    .optional(),
  reason: z.string().optional(),
  noticeType: z
    .enum(['WORKED', 'INDEMNIFIED', 'WAIVED', 'DISPENSED', 'MIXED', 'NONE', 'worked', 'indemnified', 'waived', 'mixed'])
    .default('INDEMNIFIED'),
  mediasAdicionais: z.number().nonnegative().default(0),
  outrosDescontos: z.number().nonnegative().default(0),
  fgtsBalancePrior: z.number().nonnegative().optional(),
  timeBankPositiveHours: z.number().nonnegative().optional(),
});

function mapDismissalReason(dismissalType?: string, reason?: string): UnifiedDismissalReason {
  if (dismissalType) return dismissalType as UnifiedDismissalReason;
  const map: Record<string, UnifiedDismissalReason> = {
    '1': 'WITHOUT_CAUSE',
    '2': 'RESIGNATION',
    '3': 'WITH_CAUSE',
    '4': 'CONTRACT_EXPIRATION',
    '5': 'MUTUAL_AGREEMENT',
    '01': 'WITH_CAUSE',
    '02': 'WITHOUT_CAUSE',
    '03': 'INDIRECT_DISMISSAL',
    '04': 'EARLY_TERMINATION_EMPLOYER',
    '05': 'EARLY_TERMINATION_EMPLOYEE',
    '06': 'CONTRACT_EXPIRATION',
    '07': 'RESIGNATION',
    '10': 'DEATH',
    '14': 'RECIPROCAL_FAULT',
    '17': 'COMPANY_EXTINCTION',
    '33': 'MUTUAL_AGREEMENT',
  };
  return map[reason || '1'] || 'WITHOUT_CAUSE';
}

function toIsoDate(v: any): string {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
}

async function buildTerminationInputFromDb(
  client: any,
  params: {
    tenantId: string;
    contractId: string;
    resignationDate: string;
    noticeDate?: string;
    contractEndDate?: string | null;
    dismissalType: UnifiedDismissalReason;
    noticeType: UnifiedNoticeType;
    mediasAdicionais?: number;
    outrosDescontos?: number;
    fgtsBalancePrior?: number;
    timeBankPositiveHours?: number;
    allowTerminatedContract?: boolean;
  }
): Promise<{ contract: any; input: UnifiedTerminationInput }> {
  const {
    tenantId,
    contractId,
    resignationDate,
    noticeDate,
    contractEndDate,
    dismissalType,
    noticeType,
    mediasAdicionais,
    outrosDescontos,
    fgtsBalancePrior,
    timeBankPositiveHours,
    allowTerminatedContract = false,
  } = params;

  const statusFilter = allowTerminatedContract
    ? `c.status IN ('ACTIVE', 'LEAVE', 'VACATION', 'TERMINATED')`
    : `c.status IN ('ACTIVE', 'LEAVE', 'VACATION')`;

  const { rows: contractRows } = await client.query(
    `SELECT c.id, c.company_id, c.base_salary, c.admission_date, c.termination_date, c.worker_id,
            c.regime, c.incidences, c.monthly_hours, c.collective_agreement_id, c.union_id,
            w.full_name AS worker_name, w.cpf AS worker_cpf, w.is_apprentice,
            u.base_month AS union_base_month,
            ca.average_window_mode, ca.average_calculation_months, ca.overtime_percentage_tier1
     FROM public.contracts c
     JOIN public.workers w ON w.id = c.worker_id
     LEFT JOIN public.unions u ON u.id = c.union_id
     LEFT JOIN public.collective_agreements ca ON ca.id = c.collective_agreement_id
     WHERE c.id = $1::uuid AND ${statusFilter} AND c.deleted_at IS NULL;`,
    [contractId]
  );

  if (contractRows.length === 0) {
    throw new Error('CONTRACT_NOT_FOUND');
  }

  const contract = contractRows[0];
  const admissionDate = toIsoDate(contract.admission_date);
  const [termYearStr, termMonthStr] = resignationDate.split('-');
  const termYear = parseInt(termYearStr, 10);
  const termMonth = parseInt(termMonthStr, 10);
  const periodStartDate = `${termYearStr}-${termMonthStr}-01`;

  const { rows: versions } = await client.query(
    `SELECT id, code, valid_from, valid_to
     FROM public.legal_versions
     WHERE is_active = TRUE
       AND valid_from <= $1::date
       AND (valid_to IS NULL OR valid_to >= $1::date)
     ORDER BY valid_from DESC
     LIMIT 1;`,
    [periodStartDate]
  );

  if (versions.length === 0) {
    throw new Error(`Nenhuma versão legal vigente encontrada para ${termMonth}/${termYear}.`);
  }

  const version = versions[0];
  const [inssRes, irrfRes, genRes, rubricsRes, depRes, vacRes, bankRes] = await Promise.all([
    client.query(
      `SELECT bracket_number, base_limit, aliquot FROM public.inss_parameters WHERE legal_version_id = $1::uuid ORDER BY bracket_number ASC;`,
      [version.id]
    ),
    client.query(
      `SELECT bracket_number, base_limit, aliquot, deduction FROM public.irrf_parameters WHERE legal_version_id = $1::uuid ORDER BY bracket_number ASC;`,
      [version.id]
    ),
    client.query(
      `SELECT * FROM public.general_legal_parameters WHERE legal_version_id = $1::uuid LIMIT 1;`,
      [version.id]
    ),
    client.query(
      `SELECT * FROM public.rubrics WHERE (tenant_id = $1::uuid OR is_system = TRUE) AND deleted_at IS NULL;`,
      [tenantId]
    ),
    client.query(
      `SELECT id, name, cpf, birth_date, relationship, is_irrf_dependent, is_family_salary,
              is_incapacitated, start_date, end_date, vaccination_card_date, school_frequency_date
       FROM public.dependents
       WHERE worker_id = $1::uuid AND deleted_at IS NULL;`,
      [contract.worker_id]
    ),
    client.query(
      `SELECT id, acquisition_start, acquisition_end, concessive_end, days_remaining, absences_count, lost_by_leave, status
       FROM public.vacation_periods
       WHERE contract_id = $1::uuid
       ORDER BY acquisition_start ASC;`,
      [contractId]
    ),
    client.query(
      `SELECT COALESCE(balance_minutes, 0) AS balance_minutes
       FROM public.time_bank_accounts
       WHERE contract_id = $1::uuid
       ORDER BY updated_at DESC LIMIT 1;`,
      [contractId]
    ),
  ]);

  const inssParameters = inssRes.rows.map((r: any) => ({
    bracket_number: Number(r.bracket_number),
    base_limit: Number(r.base_limit),
    aliquot: Number(r.aliquot),
    deduction: 0,
  }));
  const irrfParameters = irrfRes.rows.map((r: any) => ({
    bracket_number: Number(r.bracket_number),
    base_limit: r.base_limit !== null ? Number(r.base_limit) : null,
    aliquot: Number(r.aliquot),
    deduction: Number(r.deduction),
  }));
  const rawGen = genRes.rows[0] || null;
  const generalLegalParameters = rawGen
    ? {
      minimum_wage: Number(rawGen.minimum_wage),
      inss_ceiling: Number(rawGen.inss_ceiling),
      dependent_deduction: Number(rawGen.dependent_deduction),
      simplified_discount: Number(rawGen.simplified_discount),
      family_salary_ceiling: Number(rawGen.family_salary_ceiling),
      family_salary_value: Number(rawGen.family_salary_value),
      fgts_standard_aliquot: Number(rawGen.fgts_standard_aliquot),
      fgts_apprentice_aliquot: Number(rawGen.fgts_apprentice_aliquot),
      irrf_exemption_limit:
        rawGen.irrf_exemption_limit !== null && rawGen.irrf_exemption_limit !== undefined
          ? Number(rawGen.irrf_exemption_limit)
          : undefined,
      irrf_reduction_formula_limit:
        rawGen.irrf_reduction_formula_limit !== null && rawGen.irrf_reduction_formula_limit !== undefined
          ? Number(rawGen.irrf_reduction_formula_limit)
          : undefined,
      irrf_reduction_a:
        rawGen.irrf_reduction_a !== null && rawGen.irrf_reduction_a !== undefined
          ? Number(rawGen.irrf_reduction_a)
          : undefined,
      irrf_reduction_b:
        rawGen.irrf_reduction_b !== null && rawGen.irrf_reduction_b !== undefined
          ? Number(rawGen.irrf_reduction_b)
          : undefined,
    }
    : null;

  validateAllLegalTables({
    version: { ...version, version_name: version.code },
    inssBrackets: inssParameters,
    irrfBrackets: irrfParameters,
    generalParams: generalLegalParameters,
    periodMonth: termMonth,
    periodYear: termYear,
  });

  const normalizedDeps = depRes.rows.map((dep: any) => ({
    id: dep.id,
    name: dep.name,
    cpf: dep.cpf,
    birth_date: toIsoDate(dep.birth_date),
    relationship: dep.relationship,
    is_irrf_dependent: dep.is_irrf_dependent,
    is_family_salary: dep.is_family_salary,
    is_incapacitated: dep.is_incapacitated,
    start_date: dep.start_date ? toIsoDate(dep.start_date) : null,
    end_date: dep.end_date ? toIsoDate(dep.end_date) : null,
    vaccination_card_date: dep.vaccination_card_date ? toIsoDate(dep.vaccination_card_date) : null,
    school_frequency_date: dep.school_frequency_date ? toIsoDate(dep.school_frequency_date) : null,
  }));
  const depEval = evaluateIRRFDependents(normalizedDeps, termYear, termMonth);

  const fromIdx = termYear * 12 + (termMonth - 1) - 11;
  const fromYear = Math.floor(fromIdx / 12);
  const fromMonth = (fromIdx % 12) + 1;
  const histMap = await loadHistoricalAveragesItems(client, {
    tenantId,
    contractIds: [contractId],
    fromYear,
    fromMonth,
    toYear: termYear,
    toMonth: termMonth,
  });

  const rubricsByCode = new Map<string, any>();
  for (const r of rubricsRes.rows) {
    if (r.code) rubricsByCode.set(r.code, r);
  }

  const dbBankMinutes = Number(bankRes.rows[0]?.balance_minutes || 0);
  const resolvedBankHours =
    timeBankPositiveHours !== undefined
      ? timeBankPositiveHours
      : dbBankMinutes > 0
        ? Number((dbBankMinutes / 60).toFixed(2))
        : 0;

  const cctTier1Pct = Number(contract.overtime_percentage_tier1 ?? 50);

  const input: UnifiedTerminationInput = {
    contractId: contract.id,
    baseSalary: Number(contract.base_salary),
    admissionDate,
    resignationDate,
    noticeDate,
    contractEndDate: contractEndDate ?? null,
    dismissalType,
    noticeType,
    mediasAdicionais,
    historicalEntries: histMap.get(contractId) || [],
    averageWindowMode: contract.average_window_mode || 'LAST_12M',
    averageMonths: Number(contract.average_calculation_months || 12),
    divisor: Number(contract.monthly_hours || 220),
    vacationPeriods: vacRes.rows.map((vp: any) => ({
      id: vp.id,
      acquisition_start: toIsoDate(vp.acquisition_start),
      acquisition_end: toIsoDate(vp.acquisition_end),
      concessive_end: toIsoDate(vp.concessive_end),
      days_remaining: Number(vp.days_remaining || 0),
      absences_count: Number(vp.absences_count || 0),
      lost_by_leave: Boolean(vp.lost_by_leave),
      status: vp.status,
    })),
    unionBaseMonth: contract.union_base_month ? Number(contract.union_base_month) : null,
    timeBankPositiveHours: resolvedBankHours,
    timeBankOvertimeFactor: 1 + cctTier1Pct / 100,
    outrosDescontos,
    dependentsCount: depEval.eligibleCount,
    dependents: normalizedDeps,
    employeeRegime: contract.regime,
    hasInssIncidence: contract.incidences?.has_inss !== false,
    isApprentice: Boolean(contract.is_apprentice || contract.regime === 'APPRENTICE'),
    fgtsBalancePrior,
    inssParameters,
    irrfParameters,
    generalLegalParameters: generalLegalParameters!,
    rubricsByCode,
    legalVersionId: version.id,
    engineVersion: '2.2.0',
  };

  return { contract, input };
}

export const terminationRoutes: FastifyPluginAsync = async (app) => {
  // 1. Prévia / Cálculo Oficial Unificado de Rescisão (TRCT - FOLHA-13)
  app.post(
    '/calculate',
    { preHandler: [authenticate, requireAdminRole, requirePermission('manage_terminations')] },
    async (request, reply) => {
      const parseResult = terminationPreviewSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros de rescisão inválidos.',
          details: parseResult.error.format(),
        });
      }

      const d = parseResult.data;
      const contractId = d.contractId || d.contract_id;
      const resignationDate = d.resignationDate || d.terminationDate;

      if (!contractId || !resignationDate) {
        return reply.status(400).send({
          success: false,
          error: 'contractId e resignationDate são obrigatórios.',
        });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { input } = await buildTerminationInputFromDb(client, {
            tenantId: request.user!.tenant_id!,
            contractId,
            resignationDate,
            noticeDate: d.noticeDate,
            contractEndDate: d.contractEndDate,
            dismissalType: mapDismissalReason(d.dismissalType, d.reason),
            noticeType: d.noticeType.toUpperCase() as UnifiedNoticeType,
            mediasAdicionais: d.mediasAdicionais,
            outrosDescontos: d.outrosDescontos,
            fgtsBalancePrior: d.fgtsBalancePrior,
            timeBankPositiveHours: d.timeBankPositiveHours,
          });

          const trct = TerminationOrchestrator.calculate(input);
          return {
            contractId,
            ...trct,
          };
        });

        return reply.send({ success: true, data: result });
      } catch (err: any) {
        if (err.message === 'CONTRACT_NOT_FOUND') {
          return reply.status(404).send({ success: false, error: 'Contrato ativo não localizado.' });
        }
        request.log.error(err, '[TERMINATION_CALCULATE] Erro ao calcular rescisão');
        return reply.status(400).send({ success: false, error: err.message || 'Erro ao calcular rescisão.' });
      }
    }
  );

  // 2. Efetivar / Gravar Rescisão Unificada ao PayrollEngine (payslips + payslip_items + memory + terminations)
  app.post(
    '/confirm',
    { preHandler: [authenticate, requireAdminRole, requirePermission('manage_terminations')] },
    async (request, reply) => {
      const parseResult = terminationPreviewSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ success: false, details: parseResult.error.format() });
      }

      const d = parseResult.data;
      const contractId = d.contractId || d.contract_id;
      const resignationDate = d.resignationDate || d.terminationDate;

      if (!contractId || !resignationDate) {
        return reply.status(400).send({ success: false, error: 'contractId e resignationDate são obrigatórios.' });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const tenantId = request.user!.tenant_id!;

      try {
        const persisted = await request.withContext(async (client) => {
          const dismissalType = mapDismissalReason(d.dismissalType, d.reason);
          const noticeType = d.noticeType.toUpperCase() as UnifiedNoticeType;

          const { contract, input } = await buildTerminationInputFromDb(client, {
            tenantId,
            contractId,
            resignationDate,
            noticeDate: d.noticeDate,
            contractEndDate: d.contractEndDate,
            dismissalType,
            noticeType,
            mediasAdicionais: d.mediasAdicionais,
            outrosDescontos: d.outrosDescontos,
            fgtsBalancePrior: d.fgtsBalancePrior,
            timeBankPositiveHours: d.timeBankPositiveHours,
          });

          const trct = TerminationOrchestrator.calculate(input);
          const [termYStr, termMStr] = resignationDate.split('-');
          const termYear = parseInt(termYStr, 10);
          const termMonth = parseInt(termMStr, 10);

          // Garante/reutiliza período de folha TERMINATION para a competência
          let { rows: pRows } = await client.query(
            `SELECT * FROM public.payroll_periods
             WHERE tenant_id = $1::uuid AND company_id = $2::uuid AND year = $3 AND month = $4 AND type = 'TERMINATION'
             LIMIT 1;`,
            [tenantId, contract.company_id, termYear, termMonth]
          );
          let period = pRows[0];
          if (!period) {
            const { rows: insPeriod } = await client.query(
              `INSERT INTO public.payroll_periods (
                 tenant_id, company_id, year, month, type, status, payment_date, competence_date, irrf_regime
               ) VALUES (
                 $1::uuid, $2::uuid, $3, $4, 'TERMINATION', 'DRAFT', $5::date, $6::date, 'CASH'
               ) RETURNING *;`,
              [tenantId, contract.company_id, termYear, termMonth, resignationDate, `${termYStr}-${termMStr}-01`]
            );
            period = insPeriod[0];
          }

          const atomicPayload = buildAtomicPayrollPayload({
            tenant_id: tenantId,
            period_id: period.id,
            contract_id_filter: contractId,
            payslips: [trct.payslip],
            company_taxes: [],
          });

          await client.query(`SELECT public.save_payroll_period($1::uuid, $2::jsonb);`, [
            period.id,
            JSON.stringify(atomicPayload),
          ]);

          const { rows: slipRows } = await client.query(
            `SELECT id FROM public.payslips
             WHERE payroll_period_id = $1::uuid AND contract_id = $2::uuid LIMIT 1;`,
            [period.id, contractId]
          );
          const payslipId = slipRows[0]?.id || null;

          const dbNoticeType = ['WORKED', 'INDEMNIFIED', 'WAIVED', 'DISPENSED', 'MIXED', 'NONE'].includes(noticeType)
            ? noticeType
            : 'INDEMNIFIED';

          const { rows: termRows } = await client.query(
            `INSERT INTO public.terminations (
               tenant_id, contract_id, termination_reason, notice_type, notice_date,
               dismissal_date, projected_end_date, notice_days,
               notice_worked_days, notice_indemnified_days,
               gross_amount, deductions_amount, net_amount, fgts_fine_amount,
               trct_data, status, payment_date,
               payroll_period_id, payslip_id, esocial_reason_code, art_477_cap_applied, fgts_balance_real
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4, $5::date,
               $6::date, $7::date, $8,
               $9, $10,
               $11, $12, $13, $14,
               $15::jsonb, 'CALCULATED', $6::date,
               $16::uuid, $17::uuid, $18, $19, $20
             ) RETURNING *;`,
            [
              tenantId,
              contractId,
              dismissalType,
              dbNoticeType,
              d.noticeDate || resignationDate,
              resignationDate,
              trct.metadados.dataProjetada,
              trct.metadados.diasAvisoReal,
              trct.metadados.diasAvisoTrabalhado,
              trct.metadados.diasAvisoIndenizado,
              trct.totais.bruto,
              trct.totais.descontos,
              trct.totais.liquido,
              trct.encargos.multaFGTS,
              JSON.stringify({ input, trct }),
              period.id,
              payslipId,
              trct.esocialReasonCode,
              trct.descontos.tetoArt477Aplicado,
              d.fgtsBalancePrior ?? 0,
            ]
          );

          await client.query(
            `UPDATE public.contracts
             SET status = 'TERMINATED', termination_date = $2::date, updated_at = NOW()
             WHERE id = $1::uuid;`,
            [contractId, resignationDate]
          );

          return {
            termination: termRows[0],
            payslipId,
            periodId: period.id,
            trct,
          };
        });

        return reply.status(201).send({ success: true, data: persisted });
      } catch (err: any) {
        if (err.message === 'CONTRACT_NOT_FOUND') {
          return reply.status(404).send({ success: false, error: 'Contrato ativo não localizado.' });
        }
        request.log.error(err, '[TERMINATION_CONFIRM] Erro ao efetivar rescisão');
        return reply.status(400).send({ success: false, error: err.message || 'Erro ao efetivar rescisão.' });
      }
    }
  );

  // 3. Rescisão Complementar (apuração exclusiva de diferenças sobre TRCT original)
  app.post(
    '/:id/complementary',
    { preHandler: [authenticate, requireAdminRole, requirePermission('manage_terminations')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const bodySchema = z.object({
        reason: z.string().min(5, 'Informe o motivo da rescisão complementar.'),
        newBaseSalary: z.number().positive().optional(),
        additionalMedias: z.number().nonnegative().optional(),
        additionalTimeBankHours: z.number().nonnegative().optional(),
      });
      const parse = bodySchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({ success: false, details: parse.error.format() });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const tenantId = request.user!.tenant_id!;
      const d = parse.data;

      try {
        const result = await request.withContext(async (client) => {
          const { rows: origRows } = await client.query(
            `SELECT * FROM public.terminations WHERE id = $1::uuid AND tenant_id = $2::uuid;`,
            [id, tenantId]
          );
          if (origRows.length === 0) {
            return null;
          }
          const orig = origRows[0];
          const savedTrctData = orig.trct_data || {};
          const origOutput: UnifiedTerminationOutput | undefined = savedTrctData.trct;
          const origInput: UnifiedTerminationInput | undefined = savedTrctData.input;

          if (!origOutput || !origInput) {
            throw new Error('A rescisão original não possui memória estruturada para gerar complementar.');
          }

          const { input: freshInput } = await buildTerminationInputFromDb(client, {
            tenantId,
            contractId: orig.contract_id,
            resignationDate: toIsoDate(orig.dismissal_date),
            noticeDate: toIsoDate(orig.notice_date),
            contractEndDate: origInput.contractEndDate,
            dismissalType: origInput.dismissalType,
            noticeType: origInput.noticeType,
            mediasAdicionais:
              d.additionalMedias !== undefined
                ? (origInput.mediasAdicionais || 0) + d.additionalMedias
                : origInput.mediasAdicionais,
            outrosDescontos: origInput.outrosDescontos,
            fgtsBalancePrior: origInput.fgtsBalancePrior,
            timeBankPositiveHours:
              d.additionalTimeBankHours !== undefined
                ? (origInput.timeBankPositiveHours || 0) + d.additionalTimeBankHours
                : origInput.timeBankPositiveHours,
            allowTerminatedContract: true,
          });

          if (d.newBaseSalary !== undefined) {
            freshInput.baseSalary = d.newBaseSalary;
          }

          const comp = TerminationOrchestrator.calculateComplementary({
            originalOutput: origOutput,
            updatedInput: freshInput,
            reason: d.reason,
          });

          const now = new Date();
          const compYear = now.getUTCFullYear();
          const compMonth = now.getUTCMonth() + 1;

          const { rows: compPeriodRows } = await client.query(
            `INSERT INTO public.payroll_periods (
               tenant_id, company_id, year, month, type, status, payment_date, competence_date, irrf_regime, parent_period_id
             )
             SELECT $1::uuid, c.company_id, $3, $4, 'COMPLEMENTARY', 'DRAFT', CURRENT_DATE, make_date($3, $4, 1), 'CASH', $5::uuid
             FROM public.contracts c WHERE c.id = $2::uuid
             ON CONFLICT (tenant_id, company_id, year, month, type) DO UPDATE SET updated_at = NOW()
             RETURNING *;`,
            [tenantId, orig.contract_id, compYear, compMonth, orig.payroll_period_id]
          );
          const compPeriod = compPeriodRows[0];

          const atomicPayload = buildAtomicPayrollPayload({
            tenant_id: tenantId,
            period_id: compPeriod.id,
            contract_id_filter: orig.contract_id,
            payslips: [comp.payslip],
            company_taxes: [],
          });

          await client.query(`SELECT public.save_payroll_period($1::uuid, $2::jsonb);`, [
            compPeriod.id,
            JSON.stringify(atomicPayload),
          ]);

          const { rows: slipRows } = await client.query(
            `SELECT id FROM public.payslips WHERE payroll_period_id = $1::uuid AND contract_id = $2::uuid LIMIT 1;`,
            [compPeriod.id, orig.contract_id]
          );

          const { rows: compRows } = await client.query(
            `INSERT INTO public.terminations (
               tenant_id, contract_id, termination_reason, notice_type, notice_date,
               dismissal_date, projected_end_date, notice_days,
               gross_amount, deductions_amount, net_amount, fgts_fine_amount,
               trct_data, status, payment_date,
               payroll_period_id, payslip_id, parent_termination_id, is_complementary, complementary_reason, esocial_reason_code
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4, $5::date,
               $6::date, $7::date, $8,
               $9, $10, $11, $12,
               $13::jsonb, 'CALCULATED', CURRENT_DATE,
               $14::uuid, $15::uuid, $16::uuid, TRUE, $17, $18
             ) RETURNING *;`,
            [
              tenantId,
              orig.contract_id,
              orig.termination_reason,
              orig.notice_type,
              toIsoDate(orig.notice_date),
              toIsoDate(orig.dismissal_date),
              toIsoDate(orig.projected_end_date),
              orig.notice_days,
              comp.diffGross,
              comp.diffDeductions,
              comp.diffNetPayable,
              comp.diffFgtsFine,
              JSON.stringify(comp),
              compPeriod.id,
              slipRows[0]?.id || null,
              orig.id,
              d.reason,
              orig.esocial_reason_code,
            ]
          );

          return {
            complementaryTermination: compRows[0],
            ...comp,
          };
        });

        if (!result) {
          return reply.status(404).send({ success: false, error: 'Rescisão original não encontrada.' });
        }

        return reply.status(201).send({ success: true, data: result });
      } catch (err: any) {
        request.log.error(err, '[TERMINATION_COMPLEMENTARY] Erro ao gerar rescisão complementar');
        return reply.status(400).send({ success: false, error: err.message });
      }
    }
  );

  // 4. Consulta e Renderização Oficial do TRCT (JSON + HTML imprimível)
  app.get(
    '/:id/trct',
    { preHandler: [authenticate, requireAdminRole, requirePermission('manage_terminations')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT t.*, w.full_name AS worker_name, w.cpf AS worker_cpf, co.corporate_name, co.cnpj AS company_cnpj
           FROM public.terminations t
           JOIN public.contracts c ON c.id = t.contract_id
           JOIN public.workers w ON w.id = c.worker_id
           JOIN public.companies co ON co.id = c.company_id
           WHERE t.id = $1::uuid;`,
          [id]
        );
        return rows[0] || null;
      });

      if (!data) {
        return reply.status(404).send({ success: false, error: 'TRCT não encontrado.' });
      }

      const breakdown: Array<{ code: string; name: string; type: string; amount: number }> =
        data.trct_data?.trct?.metadados?.rubricBreakdown || [];

      const rowsHtml = breakdown
        .map(
          (r) =>
            `<tr><td>${r.code}</td><td>${r.name}</td><td>${r.type}</td><td style="text-align:right">R$ ${Number(r.amount).toFixed(2)}</td></tr>`
        )
        .join('');

      const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>TRCT - ${data.worker_name}</title></head><body style="font-family:sans-serif;padding:24px;"><h2>Termo de Rescisão do Contrato de Trabalho (TRCT)</h2><p><strong>Empregador:</strong> ${data.corporate_name} (${data.company_cnpj})</p><p><strong>Trabalhador:</strong> ${data.worker_name} | <strong>Desligamento:</strong> ${toIsoDate(data.dismissal_date)} | <strong>Motivo eSocial:</strong> ${data.esocial_reason_code || data.termination_reason}</p><table border="1" cellpadding="6" cellspacing="0" width="100%"><thead><tr><th>Rubrica</th><th>Descrição</th><th>Tipo</th><th>Valor</th></tr></thead><tbody>${rowsHtml}</tbody></table><p><strong>Total Bruto:</strong> R$ ${Number(data.gross_amount).toFixed(2)} | <strong>Total Descontos:</strong> R$ ${Number(data.deductions_amount).toFixed(2)} | <strong>Líquido:</strong> R$ ${Number(data.net_amount).toFixed(2)}</p></body></html>`;

      return reply.send({ success: true, data: { ...data, html } });
    }
  );
};
