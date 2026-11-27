import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdminRole, requireAnyPermission, requirePermission } from '../auth/authMiddleware.js';
import {
  addMoney,
  buildAtomicPayrollPayload,
  evaluateIRRFDependents,
  RetroactiveDissidioCalculator,
  validateAllLegalTables,
  type OriginalCompetenceSnapshot,
  type RawCalculatedPayslip,
  type RawPayrollMemory,
  type RawPayslipItem,
  type RetroactiveDissidioResult,
} from '@couplerh/payroll-core';

const createDissidioSchema = z.object({
  company_id: z.string().uuid(),
  union_id: z.string().uuid().optional().nullable(),
  collective_agreement_id: z.string().uuid().optional().nullable(),
  title: z.string().min(3).max(200),
  adjustment_type: z.enum(['PERCENTAGE', 'FIXED_TABLE']).default('PERCENTAGE'),
  percentage: z.coerce.number().min(0).max(500).default(0),
  fixed_table_json: z.record(z.number()).optional().default({}),
  start_year: z.coerce.number().int().min(2000).max(2100),
  start_month: z.coerce.number().int().min(1).max(12),
  end_year: z.coerce.number().int().min(2000).max(2100),
  end_month: z.coerce.number().int().min(1).max(12),
  payment_year: z.coerce.number().int().min(2000).max(2100),
  payment_month: z.coerce.number().int().min(1).max(12),
  installments_count: z.coerce.number().int().min(1).max(12).default(1),
  apply_rra: z.boolean().default(true),
  esocial_tp_ac_conv: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G']).default('A'),
  agreement_signature_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

async function computeDissidioForAdjustment(
  client: any,
  tenantId: string,
  adj: any,
  contractIdsFilter?: string[]
): Promise<{
  contractResults: Array<{
    contractId: string;
    workerId: string;
    workerName: string;
    result: RetroactiveDissidioResult;
  }>;
  summary: {
    contractsCount: number;
    totalGrossDiff: number;
    totalInssDiff: number;
    totalIrrf: number;
    totalFgtsDiff: number;
    totalNetPayable: number;
  };
  legalVersionId: string;
  legalVersionCode: string;
}> {
  const startKey = Number(adj.start_year) * 100 + Number(adj.start_month);
  const endKey = Number(adj.end_year) * 100 + Number(adj.end_month);
  const payPeriodStart = `${adj.payment_year}-${String(adj.payment_month).padStart(2, '0')}-01`;

  const { rows: lvRows } = await client.query(
    `SELECT id, code, valid_from, valid_to
     FROM public.legal_versions
     WHERE is_active = TRUE
       AND valid_from <= $1::date
       AND (valid_to IS NULL OR valid_to >= $1::date)
     ORDER BY valid_from DESC LIMIT 1;`,
    [payPeriodStart]
  );
  if (lvRows.length === 0) {
    throw new Error(`Versão legal não encontrada para ${adj.payment_month}/${adj.payment_year}.`);
  }
  const lv = lvRows[0];

  const [inssRes, irrfRes, genRes, rubricsRes] = await Promise.all([
    client.query(`SELECT bracket_number, base_limit, aliquot FROM public.inss_parameters WHERE legal_version_id = $1::uuid ORDER BY bracket_number ASC;`, [lv.id]),
    client.query(`SELECT bracket_number, base_limit, aliquot, deduction FROM public.irrf_parameters WHERE legal_version_id = $1::uuid ORDER BY bracket_number ASC;`, [lv.id]),
    client.query(`SELECT * FROM public.general_legal_parameters WHERE legal_version_id = $1::uuid LIMIT 1;`, [lv.id]),
    client.query(`SELECT * FROM public.rubrics WHERE (tenant_id = $1::uuid OR is_system = TRUE) AND deleted_at IS NULL;`, [tenantId]),
  ]);

  const inssBrackets = inssRes.rows.map((r: any) => ({
    bracket_number: Number(r.bracket_number),
    base_limit: Number(r.base_limit),
    aliquot: Number(r.aliquot),
    deduction: 0,
  }));
  const irrfBrackets = irrfRes.rows.map((r: any) => ({
    bracket_number: Number(r.bracket_number),
    base_limit: r.base_limit !== null ? Number(r.base_limit) : null,
    aliquot: Number(r.aliquot),
    deduction: Number(r.deduction),
  }));
  const rawGen = genRes.rows[0];
  const generalParams = {
    minimum_wage: Number(rawGen.minimum_wage),
    inss_ceiling: Number(rawGen.inss_ceiling),
    dependent_deduction: Number(rawGen.dependent_deduction),
    simplified_discount: Number(rawGen.simplified_discount),
    family_salary_ceiling: Number(rawGen.family_salary_ceiling),
    family_salary_value: Number(rawGen.family_salary_value),
    fgts_standard_aliquot: Number(rawGen.fgts_standard_aliquot),
    fgts_apprentice_aliquot: Number(rawGen.fgts_apprentice_aliquot),
    irrf_exemption_limit: rawGen.irrf_exemption_limit !== null ? Number(rawGen.irrf_exemption_limit) : undefined,
    irrf_reduction_formula_limit: rawGen.irrf_reduction_formula_limit !== null ? Number(rawGen.irrf_reduction_formula_limit) : undefined,
    irrf_reduction_a: rawGen.irrf_reduction_a !== null ? Number(rawGen.irrf_reduction_a) : undefined,
    irrf_reduction_b: rawGen.irrf_reduction_b !== null ? Number(rawGen.irrf_reduction_b) : undefined,
  };

  validateAllLegalTables({
    version: { ...lv, version_name: lv.code },
    inssBrackets,
    irrfBrackets,
    generalParams,
    periodMonth: Number(adj.payment_month),
    periodYear: Number(adj.payment_year),
  });

  // Carrega holerites originais do intervalo [start, end] na empresa
  let slipSql = `
    SELECT ps.id AS payslip_id, ps.contract_id, ps.worker_id, ps.base_inss, ps.base_fgts,
           pp.year, pp.month, pp.type AS period_type,
           c.base_salary, c.union_id, c.collective_agreement_id, w.full_name AS worker_name, w.is_apprentice
    FROM public.payslips ps
    JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
    JOIN public.contracts c ON c.id = ps.contract_id
    JOIN public.workers w ON w.id = ps.worker_id
    WHERE ps.tenant_id = $1::uuid
      AND pp.company_id = $2::uuid
      AND pp.type IN ('MONTHLY', 'VACATION', 'THIRTEENTH_2')
      AND pp.status IN ('CALCULATED', 'APPROVED', 'LOCKED', 'CLOSED')
      AND (pp.year * 100 + pp.month) >= $3
      AND (pp.year * 100 + pp.month) <= $4
  `;
  const slipParams: any[] = [tenantId, adj.company_id, startKey, endKey];
  if (adj.collective_agreement_id) {
    slipSql += ` AND c.collective_agreement_id = $${slipParams.length + 1}::uuid`;
    slipParams.push(adj.collective_agreement_id);
  } else if (adj.union_id) {
    slipSql += ` AND c.union_id = $${slipParams.length + 1}::uuid`;
    slipParams.push(adj.union_id);
  }
  if (contractIdsFilter && contractIdsFilter.length > 0) {
    slipSql += ` AND ps.contract_id = ANY($${slipParams.length + 1}::uuid[])`;
    slipParams.push(contractIdsFilter);
  }
  slipSql += ` ORDER BY pp.year ASC, pp.month ASC;`;

  const { rows: slipRows } = await client.query(slipSql, slipParams);
  if (slipRows.length === 0) {
    return {
      contractResults: [],
      summary: { contractsCount: 0, totalGrossDiff: 0, totalInssDiff: 0, totalIrrf: 0, totalFgtsDiff: 0, totalNetPayable: 0 },
      legalVersionId: lv.id,
      legalVersionCode: lv.code,
    };
  }

  const payslipIds = slipRows.map((s: any) => s.payslip_id);
  const workerIds = Array.from(new Set(slipRows.map((s: any) => s.worker_id)));

  const [itemRes, depRes] = await Promise.all([
    client.query(
      `SELECT pi.payslip_id, pi.rubric_code, pi.rubric_name, pi.amount, pi.type,
              r.category, r.incidencias
       FROM public.payslip_items pi
       LEFT JOIN public.rubrics r ON r.id = pi.rubric_id
       WHERE pi.payslip_id = ANY($1::uuid[]);`,
      [payslipIds]
    ),
    client.query(
      `SELECT * FROM public.dependents WHERE worker_id = ANY($1::uuid[]) AND deleted_at IS NULL;`,
      [workerIds]
    ),
  ]);

  const itemsByPayslip = new Map<string, any[]>();
  for (const it of itemRes.rows) {
    const arr = itemsByPayslip.get(it.payslip_id) || [];
    arr.push(it);
    itemsByPayslip.set(it.payslip_id, arr);
  }

  const depsByWorker = new Map<string, any[]>();
  for (const d of depRes.rows) {
    const arr = depsByWorker.get(d.worker_id) || [];
    arr.push(d);
    depsByWorker.set(d.worker_id, arr);
  }

  const slipsByContract = new Map<string, any[]>();
  for (const s of slipRows) {
    const arr = slipsByContract.get(s.contract_id) || [];
    arr.push(s);
    slipsByContract.set(s.contract_id, arr);
  }

  const contractResults: Array<{
    contractId: string;
    workerId: string;
    workerName: string;
    result: RetroactiveDissidioResult;
  }> = [];

  let sumGross = 0;
  let sumInss = 0;
  let sumIrrf = 0;
  let sumFgts = 0;
  let sumNet = 0;

  for (const [contractId, slips] of slipsByContract.entries()) {
    const first = slips[0];
    const workerDeps = (depsByWorker.get(first.worker_id) || []).map((dep: any) => ({
      ...dep,
      birth_date: dep.birth_date instanceof Date ? dep.birth_date.toISOString().slice(0, 10) : String(dep.birth_date).slice(0, 10),
    }));
    const depEval = evaluateIRRFDependents(workerDeps, Number(adj.payment_year), Number(adj.payment_month));

    const competences: OriginalCompetenceSnapshot[] = slips.map((s: any) => {
      const pItems = itemsByPayslip.get(s.payslip_id) || [];
      const inssEmp = pItems
        .filter((it: any) => it.rubric_code === '901')
        .reduce((acc: number, it: any) => addMoney(acc, Number(it.amount || 0)), 0);
      const baseSalaryItem = pItems.find((it: any) => it.rubric_code === '101');
      const origBase = baseSalaryItem ? Number(baseSalaryItem.amount) : Number(s.base_salary || 0);

      return {
        year: Number(s.year),
        month: Number(s.month),
        periodType: s.period_type,
        originalBaseSalary: origBase,
        originalBaseInss: Number(s.base_inss || 0),
        originalBaseFgts: Number(s.base_fgts || 0),
        originalInssEmployee: inssEmp,
        items: pItems
          .filter((it: any) => it.type === 'EARNING')
          .map((it: any) => ({
            rubricCode: it.rubric_code,
            rubricName: it.rubric_name,
            category: it.category || 'OTHER',
            originalAmount: Number(it.amount || 0),
            inssIncidence: it.incidencias?.gera_base_inss !== false,
            irrfIncidence: it.incidencias?.gera_base_irrf !== false,
            fgtsIncidence: it.incidencias?.gera_base_fgts !== false,
          })),
      };
    });

    const fixedMap = adj.fixed_table_json || {};
    const fixedSalary = fixedMap[contractId] ? Number(fixedMap[contractId]) : undefined;

    const result = RetroactiveDissidioCalculator.calculate({
      contractId,
      adjustmentType: adj.adjustment_type,
      percentage: Number(adj.percentage || 0),
      newBaseSalaryFixed: fixedSalary,
      paymentYear: Number(adj.payment_year),
      paymentMonth: Number(adj.payment_month),
      installmentsCount: Number(adj.installments_count || 1),
      applyRra: adj.apply_rra !== false,
      esocialTpAcConv: adj.esocial_tp_ac_conv || 'A',
      agreementSignatureDate:
        adj.agreement_signature_date instanceof Date
          ? adj.agreement_signature_date.toISOString().slice(0, 10)
          : adj.agreement_signature_date
            ? String(adj.agreement_signature_date).slice(0, 10)
            : undefined,
      dependentsCount: depEval.eligibleCount,
      isApprentice: Boolean(first.is_apprentice),
      defaultInssBrackets: inssBrackets,
      paymentIrrfBrackets: irrfBrackets,
      generalLegalParameters: generalParams,
      competences,
    });

    if (result.totalGrossDiff > 0) {
      contractResults.push({
        contractId,
        workerId: first.worker_id,
        workerName: first.worker_name,
        result,
      });
      sumGross = addMoney(sumGross, result.totalGrossDiff);
      sumInss = addMoney(sumInss, result.totalInssDiff);
      sumIrrf = addMoney(sumIrrf, result.totalIrrf);
      sumFgts = addMoney(sumFgts, result.totalFgtsDiff);
      sumNet = addMoney(sumNet, result.netPayableTotal);
    }
  }

  return {
    contractResults,
    summary: {
      contractsCount: contractResults.length,
      totalGrossDiff: sumGross,
      totalInssDiff: sumInss,
      totalIrrf: sumIrrf,
      totalFgtsDiff: sumFgts,
      totalNetPayable: sumNet,
    },
    legalVersionId: lv.id,
    legalVersionCode: lv.code,
    rubricsRes: rubricsRes.rows,
  } as any;
}

export const dissidioRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { preHandler: [authenticate, requireAnyPermission(['view_payslips', 'calculate_payroll'])] },
    async (request, reply) => {
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      const rows = await request.withContext(async (client) => {
        const { rows: list } = await client.query(
          `SELECT * FROM public.retroactive_adjustments ORDER BY created_at DESC;`
        );
        return list;
      });
      return reply.send({ success: true, data: rows });
    }
  );

  app.post(
    '/',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const parse = createDissidioSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({ success: false, details: parse.error.format() });
      }
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const d = parse.data;
      const created = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO public.retroactive_adjustments (
             tenant_id, company_id, union_id, collective_agreement_id, title,
             adjustment_type, percentage, fixed_table_json,
             start_year, start_month, end_year, end_month,
             payment_year, payment_month, installments_count,
             apply_rra, esocial_tp_ac_conv, agreement_signature_date, status, created_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
             $6, $7, $8::jsonb,
             $9, $10, $11, $12,
             $13, $14, $15,
             $16, $17, $18::date, 'DRAFT', $19::uuid
           ) RETURNING *;`,
          [
            request.user!.tenant_id,
            d.company_id,
            d.union_id || null,
            d.collective_agreement_id || null,
            d.title,
            d.adjustment_type,
            d.percentage,
            JSON.stringify(d.fixed_table_json || {}),
            d.start_year,
            d.start_month,
            d.end_year,
            d.end_month,
            d.payment_year,
            d.payment_month,
            d.installments_count,
            d.apply_rra,
            d.esocial_tp_ac_conv,
            d.agreement_signature_date || null,
            request.user!.sub,
          ]
        );
        return rows[0];
      });

      return reply.status(201).send({ success: true, data: created });
    }
  );

  app.post(
    '/:id/calculate',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as { contractIds?: string[] };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      try {
        const calc = await request.withContext(async (client) => {
          const { rows } = await client.query(
            `SELECT * FROM public.retroactive_adjustments WHERE id = $1::uuid;`,
            [id]
          );
          if (rows.length === 0) return null;
          const adj = rows[0];
          const computed = await computeDissidioForAdjustment(
            client,
            request.user!.tenant_id!,
            adj,
            body.contractIds
          );
          await client.query(
            `UPDATE public.retroactive_adjustments
             SET status = 'CALCULATED', summary_json = $2::jsonb, updated_at = NOW()
             WHERE id = $1::uuid;`,
            [id, JSON.stringify(computed.summary)]
          );
          return computed;
        });

        if (!calc) return reply.status(404).send({ success: false, error: 'Dissídio não encontrado.' });
        return reply.send({ success: true, data: calc });
      } catch (err: any) {
        return reply.status(400).send({ success: false, error: err.message });
      }
    }
  );

  app.post(
    '/:id/apply',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as { contractIds?: string[] };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const tenantId = request.user!.tenant_id!;
      try {
        const applied = await request.withContext(async (client) => {
          const { rows } = await client.query(
            `SELECT * FROM public.retroactive_adjustments WHERE id = $1::uuid FOR UPDATE;`,
            [id]
          );
          if (rows.length === 0) return null;
          const adj = rows[0];

          const computed: any = await computeDissidioForAdjustment(
            client,
            tenantId,
            adj,
            body.contractIds
          );

          const rubricsByCode = new Map<string, string>();
          for (const r of computed.rubricsRes || []) {
            if (r.code) rubricsByCode.set(r.code, r.id);
          }

          const payYear = Number(adj.payment_year);
          const payMonth = Number(adj.payment_month);
          const compDate = `${payYear}-${String(payMonth).padStart(2, '0')}-01`;

          const { rows: pRows } = await client.query(
            `INSERT INTO public.payroll_periods (
               tenant_id, company_id, year, month, type, status, payment_date, competence_date, irrf_regime
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4, 'COMPLEMENTARY', 'DRAFT', $5::date, $5::date, 'CASH'
             )
             ON CONFLICT (tenant_id, company_id, year, month, type) DO UPDATE SET updated_at = NOW()
             RETURNING *;`,
            [tenantId, adj.company_id, payYear, payMonth, compDate]
          );
          const period = pRows[0];

          const payslips: RawCalculatedPayslip[] = [];
          const breakdownRowsToInsert: Array<{ contractId: string; item: any }> = [];

          for (const cr of computed.contractResults) {
            const r = cr.result;
            const items: RawPayslipItem[] = [];
            const memory: RawPayrollMemory[] = [];

            const pushItem = (
              code: string,
              name: string,
              type: 'EARNING' | 'DEDUCTION' | 'NEUTRAL',
              amount: number
            ) => {
              const rid = rubricsByCode.get(code);
              if (!rid || amount <= 0) return;
              items.push({ rubric_id: rid, rubric_version_id: rid, reference: '1', amount, type });
              memory.push({
                rubric_id: rid,
                step_name: name,
                base_value: r.totalGrossDiff,
                quantity_used: 1,
                percentage_used: Number(adj.percentage || 0),
                parsed_formula: r.memoryLines.join(' | ') || `${name}: R$ ${amount.toFixed(2)}`,
                result_value: amount,
                origin: 'RETROACTIVE_DISSIDIO',
                engine_version: '2.2.0',
              });
            };

            pushItem('110', 'Diferença Salarial Retroativa (Dissídio)', 'EARNING', r.totalDiffSalary110);
            pushItem('111', 'Diferença Reflexos Retroativos (HE/DSR/Adic.)', 'EARNING', r.totalDiffReflexes111);
            pushItem('112', 'Diferença Retroativa Férias/13º', 'EARNING', r.totalDiffVacation13th112);
            pushItem('901', 'INSS Diferencial Dissídio', 'DEDUCTION', r.totalInssDiff);
            pushItem('902', 'IRRF Diferencial Dissídio (Caixa)', 'DEDUCTION', r.currentYearIrrf);
            pushItem('915', 'IRRF sobre RRA (Art. 12-A)', 'DEDUCTION', r.priorYearsIrrfRra);
            pushItem('903', 'FGTS Diferencial Dissídio', 'NEUTRAL', r.totalFgtsDiff);

            payslips.push({
              contract_id: cr.contractId,
              total_earnings: r.totalGrossDiff,
              total_deductions: r.totalDeductions,
              net_salary: r.netPayableTotal,
              base_inss: r.totalGrossDiff,
              base_irrf: Math.max(0, r.totalGrossDiff - r.totalInssDiff),
              base_fgts: r.totalGrossDiff,
              fgts_month: r.totalFgtsDiff,
              inss_employee: r.totalInssDiff,
              status: 'CALCULATED',
              legal_version_id: computed.legalVersionId,
              engine_version: '2.2.0',
              inss_table_version: computed.legalVersionCode,
              irrf_table_version: computed.legalVersionCode,
              fgts_table_version: computed.legalVersionCode,
              items,
              memory,
            });

            for (const b of r.breakdown) {
              breakdownRowsToInsert.push({ contractId: cr.contractId, item: b });
            }
          }

          if (payslips.length > 0) {
            const atomicPayload = buildAtomicPayrollPayload({
              tenant_id: tenantId,
              period_id: period.id,
              contract_id_filter: null,
              payslips,
              company_taxes: [],
            });
            await client.query(`SELECT public.save_payroll_period($1::uuid, $2::jsonb);`, [
              period.id,
              JSON.stringify(atomicPayload),
            ]);
          }

          const { rows: slipRows } = await client.query(
            `SELECT id, contract_id FROM public.payslips WHERE payroll_period_id = $1::uuid;`,
            [period.id]
          );
          const payslipIdByContract = new Map<string, string>();
          for (const s of slipRows) payslipIdByContract.set(s.contract_id, s.id);

          await client.query(
            `DELETE FROM public.payslip_retroactive_breakdown WHERE retroactive_adjustment_id = $1::uuid;`,
            [id]
          );

          for (const entry of breakdownRowsToInsert) {
            const b = entry.item;
            await client.query(
              `INSERT INTO public.payslip_retroactive_breakdown (
                 tenant_id, retroactive_adjustment_id, payslip_id, contract_id,
                 origin_year, origin_month, origin_period_type, rubric_code, rubric_name,
                 original_amount, recalculated_amount, diff_amount,
                 inss_origin_diff, fgts_origin_diff, is_prior_calendar_year, esocial_ide_adc_json
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                 $5, $6, $7, $8, $9,
                 $10, $11, $12,
                 $13, $14, $15, $16::jsonb
               );`,
              [
                tenantId,
                id,
                payslipIdByContract.get(entry.contractId) || null,
                entry.contractId,
                b.originYear,
                b.originMonth,
                b.originPeriodType,
                b.rubricCode,
                b.rubricName,
                b.originalAmount,
                b.recalculatedAmount,
                b.diffAmount,
                b.inssOriginDiff,
                b.fgtsOriginDiff,
                b.isPriorCalendarYear,
                JSON.stringify(b.ideAdc),
              ]
            );
          }

          await client.query(
            `UPDATE public.retroactive_adjustments
             SET status = 'APPLIED', payment_period_id = $2::uuid, summary_json = $3::jsonb, updated_at = NOW()
             WHERE id = $1::uuid;`,
            [id, period.id, JSON.stringify(computed.summary)]
          );

          return {
            periodId: period.id,
            summary: computed.summary,
            contractsApplied: payslips.length,
            breakdownCount: breakdownRowsToInsert.length,
          };
        });

        if (!applied) return reply.status(404).send({ success: false, error: 'Dissídio não encontrado.' });
        return reply.send({ success: true, data: applied });
      } catch (err: any) {
        return reply.status(400).send({ success: false, error: err.message });
      }
    }
  );
};

