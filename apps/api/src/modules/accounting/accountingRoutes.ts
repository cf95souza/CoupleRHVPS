import { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccountingEngine,
  Cnab240Engine,
  CostAllocationEngine,
  DEFAULT_CHART_OF_ACCOUNTS,
  IncomeReportEngine,
  ProvisionsLedgerCalculator,
  addMoney,
  divideMoney,
  round2,
  subtractMoney,
  sumMoney,
  validateCostAllocations,
  type AccountingErpFormat,
  type AccountingRuleDefinition,
  type Cnab240BeneficiaryItem,
  type CostAllocationTarget,
  type IncomeAlimonyComplementItem,
  type IncomeHealthPlanComplementItem,
} from '@couplerh/payroll-core';
import { authenticate, requireAnyPermission, requirePermission } from '../auth/authMiddleware.js';

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function toIsoDateOnly(v: any): string {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
}

function getLastDayIso(year: number, month: number): string {
  const dt = new Date(Date.UTC(year, month, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function mapCnabAccountType(raw?: string | null): 'CC' | 'POUPANCA' | 'SALARIO' | 'TED' | 'PIX' {
  const val = String(raw || '').toUpperCase();
  if (val === 'PIX') return 'PIX';
  if (val === 'POUPANCA') return 'POUPANCA';
  if (val === 'SALARIO') return 'SALARIO';
  if (val === 'TED') return 'TED';
  return 'CC';
}

const contractCostAllocationsSchema = z.object({
  allocations: z
    .array(
      z.object({
        costCenterId: z.string().uuid().optional().nullable(),
        projectCode: z.string().max(60).optional().nullable(),
        tomadorCnpj: z.string().max(18).optional().nullable(),
        tomadorName: z.string().max(150).optional().nullable(),
        cnoNumber: z.string().max(20).optional().nullable(),
        esocialLotacaoCode: z.string().max(30).optional().nullable(),
        percentage: z.coerce.number().positive().max(100),
      })
    )
    .min(1),
});

const chartAccountSchema = z.object({
  companyId: z.string().uuid().optional().nullable(),
  accountCode: z.string().min(2).max(40),
  accountName: z.string().min(2).max(150),
  reducedCode: z.string().max(20).optional().nullable(),
  accountType: z.enum(['ASSET', 'LIABILITY', 'EXPENSE', 'REVENUE', 'TRANSITORY']),
  nature: z.enum(['DEBIT', 'CREDIT']),
  requiresCostCenter: z.boolean().default(false),
});

const mappingRuleSchema = z.object({
  companyId: z.string().uuid().optional().nullable(),
  ruleScope: z.enum(['RUBRIC', 'EMPLOYER_TAX', 'PROVISION', 'NET_SALARY']),
  rubricCode: z.string().max(20).optional().nullable(),
  eventKey: z.string().min(2).max(60),
  debitAccountId: z.string().uuid(),
  creditAccountId: z.string().uuid(),
  historyTemplate: z.string().min(3).max(200),
  erpHistoryCode: z.string().max(20).optional().nullable(),
  splitByCostCenter: z.boolean().default(true),
  priority: z.coerce.number().int().default(100),
});

async function ensureDefaultChartOfAccounts(client: any, tenantId: string, companyId?: string | null) {
  const { rows: existing } = await client.query(
    `SELECT * FROM public.accounting_chart_of_accounts
     WHERE tenant_id = $1::uuid AND ($2::uuid IS NULL OR company_id IS NULL OR company_id = $2::uuid)
     ORDER BY account_code ASC;`,
    [tenantId, companyId || null]
  );
  if (existing.length > 0) return existing;

  for (const acc of DEFAULT_CHART_OF_ACCOUNTS) {
    await client.query(
      `INSERT INTO public.accounting_chart_of_accounts (
         tenant_id, company_id, account_code, account_name, reduced_code,
         account_type, nature, requires_cost_center, is_system_default
       ) VALUES ($1::uuid, NULL, $2, $3, $4, $5, $6, $7, TRUE)
       ON CONFLICT DO NOTHING;`,
      [
        tenantId,
        acc.accountCode,
        acc.accountName,
        acc.reducedCode || null,
        acc.accountType,
        acc.nature,
        acc.requiresCostCenter,
      ]
    );
  }
  const { rows: seeded } = await client.query(
    `SELECT * FROM public.accounting_chart_of_accounts
     WHERE tenant_id = $1::uuid ORDER BY account_code ASC;`,
    [tenantId]
  );
  return seeded;
}

async function loadPeriodEntriesContext(client: any, tenantId: string, periodId: string) {
  const { rows: pRows } = await client.query(
    `SELECT pp.id, pp.company_id, pp.year, pp.month, pp.type, co.cnpj, co.corporate_name
     FROM public.payroll_periods pp
     JOIN public.companies co ON co.id = pp.company_id
     WHERE pp.id = $1::uuid AND pp.tenant_id = $2::uuid;`,
    [periodId, tenantId]
  );
  if (pRows.length === 0) return null;
  const period = pRows[0];

  const [slipsRes, itemsRes, taxRes, allocRes, provRes, rulesRes] = await Promise.all([
    client.query(
      `SELECT total_earnings, total_deductions, net_salary FROM public.payslips WHERE payroll_period_id = $1::uuid;`,
      [periodId]
    ),
    client.query(
      `SELECT pi.rubric_code, pi.amount
       FROM public.payslip_items pi
       JOIN public.payslips ps ON ps.id = pi.payslip_id
       WHERE ps.payroll_period_id = $1::uuid AND pi.type = 'DEDUCTION';`,
      [periodId]
    ),
    client.query(
      `SELECT * FROM public.payroll_company_taxes WHERE payroll_period_id = $1::uuid LIMIT 1;`,
      [periodId]
    ),
    client.query(
      `SELECT pca.cost_center_id, COALESCE(cc.code, 'GERAL') AS cc_code, cc.name AS cc_name,
              MAX(pca.cno_number) AS cno_number,
              SUM(pca.gross_amount) AS earnings_sum,
              SUM(pca.inss_employer_amount + pca.rat_amount + pca.terceiros_amount) AS employer_inss_sum,
              SUM(pca.fgts_amount) AS fgts_sum
       FROM public.payslip_cost_allocations pca
       LEFT JOIN public.cost_centers cc ON cc.id = pca.cost_center_id
       WHERE pca.payroll_period_id = $1::uuid
       GROUP BY pca.cost_center_id, cc.code, cc.name
       ORDER BY cc.code ASC;`,
      [periodId]
    ),
    client.query(
      `SELECT provision_type,
              COALESCE(SUM(net_accounting_entry), 0) AS net_entry,
              COALESCE(SUM(net_charges_entry), 0) AS charges_entry
       FROM public.accounting_provisions_ledger
       WHERE payroll_period_id = $1::uuid
       GROUP BY provision_type;`,
      [periodId]
    ),
    client.query(
      `SELECT mr.rule_scope, mr.rubric_code, mr.event_key, mr.history_template, mr.erp_history_code,
              mr.split_by_cost_center,
              da.account_code AS debit_code, da.account_name AS debit_name,
              ca.account_code AS credit_code, ca.account_name AS credit_name
       FROM public.accounting_mapping_rules mr
       JOIN public.accounting_chart_of_accounts da ON da.id = mr.debit_account_id
       JOIN public.accounting_chart_of_accounts ca ON ca.id = mr.credit_account_id
       WHERE mr.tenant_id = $1::uuid AND mr.is_active = TRUE
         AND (mr.company_id IS NULL OR mr.company_id = $2::uuid)
       ORDER BY mr.company_id NULLS FIRST, mr.priority ASC;`,
      [tenantId, period.company_id]
    ),
  ]);

  const totalEarnings = sumMoney(slipsRes.rows.map((p: any) => Number(p.total_earnings || 0)));
  const totalDeductions = sumMoney(slipsRes.rows.map((p: any) => Number(p.total_deductions || 0)));
  const totalNetSalary = sumMoney(slipsRes.rows.map((p: any) => Number(p.net_salary || 0)));

  let totalInssEmployee = 0;
  let totalIrrfEmployee = 0;
  let totalAlimony = 0;
  for (const it of itemsRes.rows) {
    const amt = Number(it.amount || 0);
    if (it.rubric_code === '901' || it.rubric_code === '582') {
      totalInssEmployee = addMoney(totalInssEmployee, amt);
    } else if (it.rubric_code === '902' || it.rubric_code === '583' || it.rubric_code === '915') {
      totalIrrfEmployee = addMoney(totalIrrfEmployee, amt);
    } else if (it.rubric_code === '904') {
      totalAlimony = addMoney(totalAlimony, amt);
    }
  }
  const totalOtherDeductions = Math.max(
    0,
    subtractMoney(totalDeductions, sumMoney([totalInssEmployee, totalIrrfEmployee, totalAlimony]))
  );

  const tax = taxRes.rows[0] || {};
  const employerInssPatronalTotal = sumMoney([
    Number(tax.inss_patronal || 0),
    Number(tax.inss_patronal_pro_labore || 0),
    Number(tax.rat_amount || 0),
    Number(tax.rat_special_retirement_amount || 0),
    Number(tax.other_entities_amount || 0),
  ]);
  const employerFgtsTotal = round2(Number(tax.fgts_total || 0));

  let vacNet = 0;
  let vacCharges = 0;
  let d13Net = 0;
  let d13Charges = 0;
  for (const pr of provRes.rows) {
    if (pr.provision_type === 'VACATION') {
      vacNet = Number(pr.net_entry || 0);
      vacCharges = Number(pr.charges_entry || 0);
    } else if (pr.provision_type === 'THIRTEENTH') {
      d13Net = Number(pr.net_entry || 0);
      d13Charges = Number(pr.charges_entry || 0);
    }
  }

  const customRules: AccountingRuleDefinition[] = rulesRes.rows.map((r: any) => ({
    ruleScope: r.rule_scope,
    rubricCode: r.rubric_code,
    eventKey: r.event_key,
    debitAccountCode: r.debit_code,
    debitAccountName: r.debit_name,
    creditAccountCode: r.credit_code,
    creditAccountName: r.credit_name,
    historyTemplate: r.history_template,
    erpHistoryCode: r.erp_history_code,
    splitByCostCenter: Boolean(r.split_by_cost_center),
  }));

  const costCenterBreakdown = allocRes.rows.map((r: any) => ({
    costCenterCode: r.cc_code,
    costCenterName: r.cc_name,
    cnoNumber: r.cno_number,
    earningsAmount: round2(Number(r.earnings_sum || 0)),
    employerInssAmount: round2(Number(r.employer_inss_sum || 0)),
    fgtsAmount: round2(Number(r.fgts_sum || 0)),
  }));

  const padMonth = String(period.month).padStart(2, '0');
  const journal = AccountingEngine.generateDoubleEntryJournal({
    entryDate: getLastDayIso(Number(period.year), Number(period.month)),
    competenceLabel: `${padMonth}/${period.year}`,
    companyCnpj: period.cnpj,
    totalEarnings,
    totalNetSalary,
    totalInssEmployee,
    totalIrrfEmployee,
    totalAlimonyDeductions: totalAlimony,
    totalOtherDeductions,
    employerInssPatronalTotal,
    employerFgtsTotal,
    vacationProvisionNetEntry: vacNet,
    vacationChargesNetEntry: vacCharges,
    thirteenthProvisionNetEntry: d13Net,
    thirteenthChargesNetEntry: d13Charges,
    costCenterBreakdown: costCenterBreakdown.length > 0 ? costCenterBreakdown : undefined,
    customRules,
  });

  return { period, journal };
}

export const accountingRoutes: FastifyPluginAsync = async (app) => {
  // =========================================================================
  // CONT-01: Rateio Multi-CC, Projetos, Tomadores (Lei 9.711/98) e Obras CNO
  // =========================================================================
  app.get(
    '/contracts/:contractId/cost-allocations',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'view_employees', 'calculate_payroll'])] },
    async (request, reply) => {
      const { contractId } = request.params as { contractId: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const rows = await request.withContext(async (client) => {
        const { rows: list } = await client.query(
          `SELECT cca.*, cc.code AS cost_center_code, cc.name AS cost_center_name, cc.allocation_type
           FROM public.contract_cost_allocations cca
           LEFT JOIN public.cost_centers cc ON cc.id = cca.cost_center_id
           WHERE cca.contract_id = $1::uuid AND cca.is_active = TRUE
           ORDER BY cca.percentage DESC, cca.created_at ASC;`,
          [contractId]
        );
        return list;
      });

      return reply.send({ success: true, data: rows });
    }
  );

  app.put(
    '/contracts/:contractId/cost-allocations',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'manage_employees', 'calculate_payroll'])] },
    async (request, reply) => {
      const { contractId } = request.params as { contractId: string };
      const parse = contractCostAllocationsSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({ success: false, error: 'Payload de rateio inválido.', details: parse.error.format() });
      }

      const validation = validateCostAllocations(parse.data.allocations as CostAllocationTarget[]);
      if (!validation.valid) {
        return reply.status(400).send({ success: false, error: validation.errors[0], details: validation.errors });
      }

      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      const tenantId = request.user!.tenant_id!;

      const saved = await request.withContext(async (client) => {
        await client.query(`DELETE FROM public.contract_cost_allocations WHERE contract_id = $1::uuid;`, [contractId]);
        const inserted: any[] = [];
        for (const al of parse.data.allocations) {
          const { rows } = await client.query(
            `INSERT INTO public.contract_cost_allocations (
               tenant_id, contract_id, cost_center_id, project_code,
               tomador_cnpj, tomador_name, cno_number, esocial_lotacao_code, percentage
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4,
               $5, $6, $7, $8, $9
             ) RETURNING *;`,
            [
              tenantId,
              contractId,
              al.costCenterId || null,
              al.projectCode || null,
              al.tomadorCnpj || null,
              al.tomadorName || null,
              al.cnoNumber || null,
              al.esocialLotacaoCode || null,
              al.percentage,
            ]
          );
          inserted.push(rows[0]);
        }
        return inserted;
      });

      return reply.send({ success: true, data: saved });
    }
  );

  app.post(
    '/periods/:periodId/cost-allocations/generate',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      const tenantId = request.user!.tenant_id!;

      const data = await request.withContext(async (client) => {
        const { rows: slips } = await client.query(
          `SELECT ps.id AS payslip_id, ps.contract_id, ps.total_earnings, ps.total_deductions, ps.net_salary,
                  ps.base_inss, ps.fgts_month, c.cost_center_id, c.base_salary,
                  COALESCE(c.calculation_regime, 'CLT') AS calculation_regime,
                  cc.code AS default_cc_code, cc.name AS default_cc_name,
                  cc.project_code AS default_project, cc.tomador_cnpj AS default_tomador_cnpj,
                  cc.tomador_name AS default_tomador_name, cc.cno_number AS default_cno,
                  cc.esocial_lotacao_code AS default_lotacao
           FROM public.payslips ps
           JOIN public.contracts c ON c.id = ps.contract_id
           LEFT JOIN public.cost_centers cc ON cc.id = c.cost_center_id
           WHERE ps.payroll_period_id = $1::uuid;`,
          [periodId]
        );
        if (slips.length === 0) return { generatedCount: 0, lines: [] };

        const contractIds = slips.map((s: any) => s.contract_id);
        const [allocRes, taxRes, provRes] = await Promise.all([
          client.query(
            `SELECT cca.*, cc.code AS cc_code, cc.name AS cc_name
             FROM public.contract_cost_allocations cca
             LEFT JOIN public.cost_centers cc ON cc.id = cca.cost_center_id
             WHERE cca.contract_id = ANY($1::uuid[]) AND cca.is_active = TRUE;`,
            [contractIds]
          ),
          client.query(
            `SELECT * FROM public.payroll_company_taxes WHERE payroll_period_id = $1::uuid LIMIT 1;`,
            [periodId]
          ),
          client.query(
            `SELECT contract_id, provision_type, net_accounting_entry
             FROM public.accounting_provisions_ledger
             WHERE payroll_period_id = $1::uuid;`,
            [periodId]
          ),
        ]);

        const allocsByContract = new Map<string, any[]>();
        for (const row of allocRes.rows) {
          const arr = allocsByContract.get(row.contract_id) || [];
          arr.push(row);
          allocsByContract.set(row.contract_id, arr);
        }

        const vacProvMap = new Map<string, number>();
        const thProvMap = new Map<string, number>();
        for (const pr of provRes.rows) {
          if (pr.provision_type === 'VACATION') vacProvMap.set(pr.contract_id, Number(pr.net_accounting_entry || 0));
          if (pr.provision_type === 'THIRTEENTH') thProvMap.set(pr.contract_id, Number(pr.net_accounting_entry || 0));
        }

        const tax = taxRes.rows[0] || {};
        const totalBaseInssAll = sumMoney(slips.map((s: any) => Number(s.base_inss || 0)));
        const periodInssPat = addMoney(Number(tax.inss_patronal || 0), Number(tax.inss_patronal_pro_labore || 0));
        const periodRat = addMoney(Number(tax.rat_amount || 0), Number(tax.rat_special_retirement_amount || 0));
        const periodTerc = Number(tax.other_entities_amount || 0);

        await client.query(`DELETE FROM public.payslip_cost_allocations WHERE payroll_period_id = $1::uuid;`, [periodId]);

        const allLines: any[] = [];
        for (const s of slips) {
          const shareRatio = totalBaseInssAll > 0 ? Number(s.base_inss || 0) / totalBaseInssAll : 0;
          const empInssShare = round2(periodInssPat * shareRatio);
          const empRatShare = round2(periodRat * shareRatio);
          const empTercShare = round2(periodTerc * shareRatio);

          const exemptProv = ['PRO_LABORE', 'AUTONOMOUS_RPA', 'INTERN'].includes(String(s.calculation_regime));
          const vacProv = vacProvMap.has(s.contract_id)
            ? vacProvMap.get(s.contract_id)!
            : exemptProv
              ? 0
              : round2((Number(s.base_salary || 0) * (4 / 3)) / 12);
          const thProv = thProvMap.has(s.contract_id)
            ? thProvMap.get(s.contract_id)!
            : exemptProv
              ? 0
              : divideMoney(Number(s.base_salary || 0), 12);

          const configured = allocsByContract.get(s.contract_id) || [];
          const targets: CostAllocationTarget[] =
            configured.length > 0
              ? configured.map((a) => ({
                  costCenterId: a.cost_center_id,
                  costCenterCode: a.cc_code,
                  costCenterName: a.cc_name,
                  projectCode: a.project_code,
                  tomadorCnpj: a.tomador_cnpj,
                  tomadorName: a.tomador_name,
                  cnoNumber: a.cno_number,
                  esocialLotacaoCode: a.esocial_lotacao_code,
                  percentage: Number(a.percentage),
                }))
              : [
                  {
                    costCenterId: s.cost_center_id || null,
                    costCenterCode: s.default_cc_code || 'GERAL',
                    costCenterName: s.default_cc_name || 'Centro Geral',
                    projectCode: s.default_project || null,
                    tomadorCnpj: s.default_tomador_cnpj || null,
                    tomadorName: s.default_tomador_name || null,
                    cnoNumber: s.default_cno || null,
                    esocialLotacaoCode: s.default_lotacao || 'LOT-PADRAO',
                    percentage: 100,
                  },
                ];

          const allocated = CostAllocationEngine.allocatePayslipCosts({
            payslipId: s.payslip_id,
            contractId: s.contract_id,
            grossAmount: Number(s.total_earnings || 0),
            deductionsAmount: Number(s.total_deductions || 0),
            netAmount: Number(s.net_salary || 0),
            inssEmployerAmount: empInssShare,
            ratAmount: empRatShare,
            terceirosAmount: empTercShare,
            fgtsAmount: Number(s.fgts_month || 0),
            vacationProvisionAmount: vacProv,
            thirteenthProvisionAmount: thProv,
            allocations: targets,
          });

          for (const line of allocated) {
            const { rows: ins } = await client.query(
              `INSERT INTO public.payslip_cost_allocations (
                 tenant_id, payroll_period_id, payslip_id, contract_id, cost_center_id,
                 project_code, tomador_cnpj, tomador_name, cno_number, esocial_lotacao_code, percentage,
                 gross_amount, deductions_amount, net_amount, inss_employer_amount, rat_amount,
                 terceiros_amount, fgts_amount, vacation_provision_amount, thirteenth_provision_amount,
                 total_employer_cost, is_rounding_adjusted
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16,
                 $17, $18, $19, $20, $21, $22
               ) RETURNING *;`,
              [
                tenantId,
                periodId,
                line.payslipId,
                line.contractId,
                line.costCenterId || null,
                line.projectCode || null,
                line.tomadorCnpj || null,
                line.tomadorName || null,
                line.cnoNumber || null,
                line.esocialLotacaoCode || null,
                line.percentage,
                line.grossAmount,
                line.deductionsAmount,
                line.netAmount,
                line.inssEmployerAmount,
                line.ratAmount,
                line.terceirosAmount,
                line.fgtsAmount,
                line.vacationProvisionAmount,
                line.thirteenthProvisionAmount,
                line.totalEmployerCost,
                line.isRoundingAdjusted,
              ]
            );
            allLines.push(ins[0]);
          }
        }

        return { generatedCount: allLines.length, lines: allLines };
      });

      return reply.send({ success: true, data });
    }
  );

  app.get(
    '/periods/:periodId/cost-allocations',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const data = await request.withContext(async (client) => {
        const [itemsRes, summaryRes] = await Promise.all([
          client.query(
            `SELECT pca.*, w.full_name AS employee_name, cc.code AS cost_center_code, cc.name AS cost_center_name
             FROM public.payslip_cost_allocations pca
             JOIN public.contracts c ON c.id = pca.contract_id
             JOIN public.workers w ON w.id = c.worker_id
             LEFT JOIN public.cost_centers cc ON cc.id = pca.cost_center_id
             WHERE pca.payroll_period_id = $1::uuid
             ORDER BY w.full_name ASC, pca.percentage DESC;`,
            [periodId]
          ),
          client.query(
            `SELECT COALESCE(cc.code, 'GERAL') AS cost_center_code,
                    COALESCE(cc.name, 'Centro Geral') AS cost_center_name,
                    pca.project_code, pca.tomador_cnpj, pca.tomador_name, pca.cno_number,
                    SUM(pca.gross_amount) AS total_gross,
                    SUM(pca.inss_employer_amount + pca.rat_amount + pca.terceiros_amount) AS total_employer_inss,
                    SUM(pca.fgts_amount) AS total_fgts,
                    SUM(pca.vacation_provision_amount + pca.thirteenth_provision_amount) AS total_provisions,
                    SUM(pca.total_employer_cost) AS total_cost
             FROM public.payslip_cost_allocations pca
             LEFT JOIN public.cost_centers cc ON cc.id = pca.cost_center_id
             WHERE pca.payroll_period_id = $1::uuid
             GROUP BY cc.code, cc.name, pca.project_code, pca.tomador_cnpj, pca.tomador_name, pca.cno_number
             ORDER BY total_cost DESC;`,
            [periodId]
          ),
        ]);
        return { items: itemsRes.rows, summary: summaryRes.rows };
      });

      return reply.send({ success: true, data });
    }
  );

  // =========================================================================
  // CONT-02: Provisões Contábeis Reais Acumuladas com Baixa Mensal
  // =========================================================================
  app.post(
    '/periods/:periodId/provisions/generate',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      const tenantId = request.user!.tenant_id!;

      const result = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT id, company_id, year, month, status FROM public.payroll_periods WHERE id = $1::uuid;`,
          [periodId]
        );
        if (pRows.length === 0) return null;
        const period = pRows[0];
        const compYear = Number(period.year);
        const compMonth = Number(period.month);
        const compIdx = compYear * 12 + compMonth;

        const [compRes, slipRes, prevLedgerRes, settlementsRes] = await Promise.all([
          client.query(
            `SELECT id, tax_regime, labor_config, cprb_gross_revenue_exempt, cprb_gross_revenue_total, cprb_reoneration_year
             FROM public.companies WHERE id = $1::uuid;`,
            [period.company_id]
          ),
          client.query(
            `SELECT ps.contract_id, ps.worker_id, c.cost_center_id, c.base_salary,
                    COALESCE(c.calculation_regime, 'CLT') AS calculation_regime,
                    COALESCE(c.special_retirement_exposure_code, '01') AS special_retirement_exposure_code,
                    w.is_apprentice, w.full_name AS employee_name
             FROM public.payslips ps
             JOIN public.contracts c ON c.id = ps.contract_id
             JOIN public.workers w ON w.id = ps.worker_id
             WHERE ps.payroll_period_id = $1::uuid
             ORDER BY w.full_name ASC;`,
            [periodId]
          ),
          client.query(
            `SELECT DISTINCT ON (contract_id, provision_type)
                    contract_id, provision_type, closing_balance, charges_closing_balance,
                    avos_accumulated, reference_salary
             FROM public.accounting_provisions_ledger
             WHERE company_id = $1::uuid AND (year * 12 + month) < $2
             ORDER BY contract_id, provision_type, (year * 12 + month) DESC;`,
            [period.company_id, compIdx]
          ),
          // Baixas reais no mês (férias gozadas/dobro/abono, 13º 1ª/2ª/complementar e verbas rescisórias de férias/13º)
          client.query(
            `SELECT ps.contract_id, pi.rubric_code, SUM(pi.amount) AS paid_amount
             FROM public.payslip_items pi
             JOIN public.payslips ps ON ps.id = pi.payslip_id
             JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
             WHERE pp.company_id = $1::uuid
               AND pp.year = $2
               AND pp.month = $3
               AND pi.rubric_code IN ('512', '513', '514', '515', '516', '601', '602', '604', '605', '701', '702', '703', '704', '707')
             GROUP BY ps.contract_id, pi.rubric_code;`,
            [period.company_id, compYear, compMonth]
          ),
        ]);

        const comp = compRes.rows[0] || {};
        const laborCfg = {
          ...(comp.labor_config || {}),
          tax_regime: comp.tax_regime ?? comp.labor_config?.tax_regime,
          cprb_gross_revenue_exempt: Number(comp.cprb_gross_revenue_exempt || 0),
          cprb_gross_revenue_total: Number(comp.cprb_gross_revenue_total || 0),
          competence_year: comp.cprb_reoneration_year ?? compYear,
        };

        const prevMap = new Map<string, any>();
        for (const row of prevLedgerRes.rows) {
          prevMap.set(`${row.contract_id}:${row.provision_type}`, row);
        }

        const vacSettlementMap = new Map<string, number>();
        const thSettlementMap = new Map<string, number>();
        for (const sRow of settlementsRes.rows) {
          const amt = Number(sRow.paid_amount || 0);
          if (['701', '702', '703', '704', '707', '514', '515', '516'].includes(sRow.rubric_code)) {
            vacSettlementMap.set(sRow.contract_id, addMoney(vacSettlementMap.get(sRow.contract_id) || 0, amt));
          } else {
            thSettlementMap.set(sRow.contract_id, addMoney(thSettlementMap.get(sRow.contract_id) || 0, amt));
          }
        }

        const ledgerRows: any[] = [];
        for (const s of slipRes.rows) {
          for (const provType of ['VACATION', 'THIRTEENTH'] as const) {
            const prev = prevMap.get(`${s.contract_id}:${provType}`);
            const settlementsPaid =
              provType === 'VACATION'
                ? vacSettlementMap.get(s.contract_id) || 0
                : thSettlementMap.get(s.contract_id) || 0;

            const calc = ProvisionsLedgerCalculator.calculate({
              contractId: s.contract_id,
              provisionType: provType,
              year: compYear,
              month: compMonth,
              currentSalary: Number(s.base_salary || 0),
              previousSalary: prev ? Number(prev.reference_salary) : Number(s.base_salary || 0),
              avosPreviouslyAccumulated: prev ? Number(prev.avos_accumulated || 0) : 0,
              earnedAvoInMonth: true,
              openingBalance: prev ? Number(prev.closing_balance || 0) : 0,
              chargesOpeningBalance: prev ? Number(prev.charges_closing_balance || 0) : 0,
              settlementsPaid,
              calculationRegime: s.calculation_regime,
              isApprentice: Boolean(s.is_apprentice),
              specialRetirementExposureCode: s.special_retirement_exposure_code,
              companyConfig: laborCfg,
            });

            const { rows: upRows } = await client.query(
              `INSERT INTO public.accounting_provisions_ledger (
                 tenant_id, company_id, payroll_period_id, contract_id, worker_id, cost_center_id,
                 year, month, provision_type,
                 opening_balance, monthly_accrual, salary_adjustment_diff, averages_adjustment, settlements_paid, closing_balance,
                 charges_opening_balance, charges_monthly_accrual, charges_adjustment_diff, charges_settlements_paid, charges_closing_balance,
                 net_accounting_entry, net_charges_entry, effective_employer_rate, avos_accumulated, reference_salary, breakdown_json, status
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                 $7, $8, $9,
                 $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $19, $20,
                 $21, $22, $23, $24, $25, $26::jsonb, $27
               )
               ON CONFLICT (tenant_id, payroll_period_id, contract_id, provision_type) DO UPDATE SET
                 opening_balance = EXCLUDED.opening_balance,
                 monthly_accrual = EXCLUDED.monthly_accrual,
                 salary_adjustment_diff = EXCLUDED.salary_adjustment_diff,
                 averages_adjustment = EXCLUDED.averages_adjustment,
                 settlements_paid = EXCLUDED.settlements_paid,
                 closing_balance = EXCLUDED.closing_balance,
                 charges_opening_balance = EXCLUDED.charges_opening_balance,
                 charges_monthly_accrual = EXCLUDED.charges_monthly_accrual,
                 charges_adjustment_diff = EXCLUDED.charges_adjustment_diff,
                 charges_settlements_paid = EXCLUDED.charges_settlements_paid,
                 charges_closing_balance = EXCLUDED.charges_closing_balance,
                 net_accounting_entry = EXCLUDED.net_accounting_entry,
                 net_charges_entry = EXCLUDED.net_charges_entry,
                 effective_employer_rate = EXCLUDED.effective_employer_rate,
                 avos_accumulated = EXCLUDED.avos_accumulated,
                 reference_salary = EXCLUDED.reference_salary,
                 breakdown_json = EXCLUDED.breakdown_json,
                 updated_at = NOW()
               RETURNING *;`,
              [
                tenantId,
                period.company_id,
                periodId,
                s.contract_id,
                s.worker_id,
                s.cost_center_id || null,
                compYear,
                compMonth,
                provType,
                calc.openingBalance,
                calc.monthlyAccrual,
                calc.salaryAdjustmentDiff,
                calc.averagesAdjustment,
                calc.settlementsPaid,
                calc.closingBalance,
                calc.chargesOpeningBalance,
                calc.chargesMonthlyAccrual,
                calc.chargesAdjustmentDiff,
                calc.chargesSettlementsPaid,
                calc.chargesClosingBalance,
                calc.netAccountingEntry,
                calc.netChargesEntry,
                calc.effectiveEmployerRate,
                calc.avosAccumulated,
                calc.referenceSalary,
                JSON.stringify(calc.breakdown),
                period.status === 'CLOSED' ? 'CLOSED' : 'CALCULATED',
              ]
            );
            ledgerRows.push({ ...upRows[0], employee_name: s.employee_name });
          }
        }

        const totalClosingPrincipal = sumMoney(ledgerRows.map((r) => Number(r.closing_balance || 0)));
        const totalClosingCharges = sumMoney(ledgerRows.map((r) => Number(r.charges_closing_balance || 0)));
        const totalNetEntry = sumMoney(ledgerRows.map((r) => Number(r.net_accounting_entry || 0)));
        return { totalClosingPrincipal, totalClosingCharges, totalNetEntry, entries: ledgerRows };
      });

      if (!result) return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      return reply.send({ success: true, data: result });
    }
  );

  app.get(
    '/periods/:periodId/provisions',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const data = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT apl.*, w.full_name AS employee_name
           FROM public.accounting_provisions_ledger apl
           JOIN public.workers w ON w.id = apl.worker_id
           WHERE apl.payroll_period_id = $1::uuid
           ORDER BY w.full_name ASC, apl.provision_type ASC;`,
          [periodId]
        );
        return {
          totalClosingPrincipal: sumMoney(rows.map((r: any) => Number(r.closing_balance || 0))),
          totalClosingCharges: sumMoney(rows.map((r: any) => Number(r.charges_closing_balance || 0))),
          totalNetEntry: sumMoney(rows.map((r: any) => Number(r.net_accounting_entry || 0))),
          entries: rows,
        };
      });

      return reply.send({ success: true, data });
    }
  );

  // =========================================================================
  // CONT-03: Plano de Contas Editável, Regras D/C e Exportação Multi-ERP
  // =========================================================================
  app.get(
    '/chart-of-accounts',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll'])] },
    async (request, reply) => {
      const q = (request.query || {}) as { companyId?: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const rows = await request.withContext(async (client) => {
        return ensureDefaultChartOfAccounts(client, request.user!.tenant_id!, q.companyId || null);
      });
      return reply.send({ success: true, data: rows });
    }
  );

  app.post(
    '/chart-of-accounts',
    { preHandler: [authenticate, requirePermission('view_payroll_accounting')] },
    async (request, reply) => {
      const parse = chartAccountSchema.safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      const d = parse.data;

      const created = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO public.accounting_chart_of_accounts (
             tenant_id, company_id, account_code, account_name, reduced_code,
             account_type, nature, requires_cost_center, is_system_default
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, FALSE)
           RETURNING *;`,
          [
            request.user!.tenant_id,
            d.companyId || null,
            d.accountCode,
            d.accountName,
            d.reducedCode || null,
            d.accountType,
            d.nature,
            d.requiresCostCenter,
          ]
        );
        return rows[0];
      });
      return reply.status(201).send({ success: true, data: created });
    }
  );

  app.put(
    '/chart-of-accounts/:id',
    { preHandler: [authenticate, requirePermission('view_payroll_accounting')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parse = chartAccountSchema.partial().safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      const d = parse.data;

      const updated = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `UPDATE public.accounting_chart_of_accounts
           SET account_code = COALESCE($2, account_code),
               account_name = COALESCE($3, account_name),
               reduced_code = COALESCE($4, reduced_code),
               account_type = COALESCE($5, account_type),
               nature = COALESCE($6, nature),
               requires_cost_center = COALESCE($7, requires_cost_center),
               updated_at = NOW()
           WHERE id = $1::uuid RETURNING *;`,
          [
            id,
            d.accountCode || null,
            d.accountName || null,
            d.reducedCode ?? null,
            d.accountType || null,
            d.nature || null,
            d.requiresCostCenter ?? null,
          ]
        );
        return rows[0] || null;
      });
      if (!updated) return reply.status(404).send({ success: false, error: 'Conta contábil não encontrada.' });
      return reply.send({ success: true, data: updated });
    }
  );

  app.get(
    '/mapping-rules',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll'])] },
    async (request, reply) => {
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      const rows = await request.withContext(async (client) => {
        const { rows: list } = await client.query(
          `SELECT mr.*, da.account_code AS debit_code, da.account_name AS debit_name,
                  ca.account_code AS credit_code, ca.account_name AS credit_name
           FROM public.accounting_mapping_rules mr
           LEFT JOIN public.accounting_chart_of_accounts da ON da.id = mr.debit_account_id
           LEFT JOIN public.accounting_chart_of_accounts ca ON ca.id = mr.credit_account_id
           ORDER BY mr.priority ASC, mr.event_key ASC;`
        );
        return list;
      });
      return reply.send({ success: true, data: rows });
    }
  );

  app.post(
    '/mapping-rules',
    { preHandler: [authenticate, requirePermission('view_payroll_accounting')] },
    async (request, reply) => {
      const parse = mappingRuleSchema.safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      const d = parse.data;

      const created = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO public.accounting_mapping_rules (
             tenant_id, company_id, rule_scope, rubric_code, event_key,
             debit_account_id, credit_account_id, history_template, erp_history_code,
             split_by_cost_center, priority
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9, $10, $11)
           RETURNING *;`,
          [
            request.user!.tenant_id,
            d.companyId || null,
            d.ruleScope,
            d.rubricCode || null,
            d.eventKey,
            d.debitAccountId,
            d.creditAccountId,
            d.historyTemplate,
            d.erpHistoryCode || null,
            d.splitByCostCenter,
            d.priority,
          ]
        );
        return rows[0];
      });
      return reply.status(201).send({ success: true, data: created });
    }
  );

  app.get(
    '/periods/:periodId/entries',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const result = await request.withContext((client) =>
        loadPeriodEntriesContext(client, request.user!.tenant_id!, periodId)
      );
      if (!result) return reply.status(404).send({ success: false, error: 'Período não encontrado.' });

      return reply.send({ success: true, data: result.journal });
    }
  );

  app.post(
    '/periods/:periodId/export',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'export_financial_reports'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      const bodySchema = z.object({
        format: z.enum(['DOMINIO', 'ALTERDATA', 'PROTHEUS', 'SENIOR', 'CSV_CONFIGURABLE']),
        delimiter: z.string().max(3).optional(),
      });
      const parse = bodySchema.safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const tenantId = request.user!.tenant_id!;
      const exported = await request.withContext(async (client) => {
        const ctx = await loadPeriodEntriesContext(client, tenantId, periodId);
        if (!ctx) return null;

        const file = AccountingEngine.exportAccountingBatch(
          parse.data.format as AccountingErpFormat,
          ctx.journal.entries,
          {
            companyCnpj: ctx.period.cnpj,
            batchNumber: 1,
            csvOptions: { delimiter: parse.data.delimiter || ';' },
          }
        );

        const hash = sha256Hex(file.content);
        const { rows: batchRows } = await client.query(
          `INSERT INTO public.accounting_export_batches (
             tenant_id, company_id, payroll_period_id, erp_format,
             total_debit, total_credit, entries_count, is_balanced,
             file_name, file_hash_sha256, created_by
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::uuid)
           RETURNING *;`,
          [
            tenantId,
            ctx.period.company_id,
            periodId,
            parse.data.format,
            ctx.journal.totalDebit,
            ctx.journal.totalCredit,
            ctx.journal.entries.length,
            ctx.journal.isBalanced,
            file.fileName,
            hash,
            request.user!.sub,
          ]
        );

        return {
          batch: batchRows[0],
          fileName: file.fileName,
          fileHash: hash,
          content: file.content,
          journal: ctx.journal,
        };
      });

      if (!exported) return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      return reply.status(201).send({ success: true, data: exported });
    }
  );

  // =========================================================================
  // CONT-04: CNAB 240 Multi-Banco + PIX/TED + Pensão + Retorno .ret
  // =========================================================================
  app.post(
    '/periods/:periodId/cnab240/generate',
    { preHandler: [authenticate, requireAnyPermission(['export_financial_reports', 'view_payroll_accounting', 'calculate_payroll'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      const bodySchema = z.object({
        bankCode: z.string().min(3).max(5).default('341'),
        paymentChannel: z.enum(['MIXED', 'TED_CC', 'PIX']).default('MIXED'),
        includeAlimony: z.boolean().default(true),
        paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      });
      const parse = bodySchema.safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const tenantId = request.user!.tenant_id!;
      const d = parse.data;

      const generated = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT pp.id, pp.company_id, pp.year, pp.month, pp.payment_date,
                  co.corporate_name, co.cnpj, co.payment_bank_code, co.payment_agency,
                  co.payment_agency_digit, co.payment_account, co.payment_account_digit, co.payment_agreement_code
           FROM public.payroll_periods pp
           JOIN public.companies co ON co.id = pp.company_id
           WHERE pp.id = $1::uuid;`,
          [periodId]
        );
        if (pRows.length === 0) return null;
        const period = pRows[0];
        const payDate = d.paymentDate || toIsoDateOnly(period.payment_date) || getLastDayIso(Number(period.year), Number(period.month));

        const [slipsRes, alimonyRes, seqRes] = await Promise.all([
          client.query(
            `SELECT ps.id AS payslip_id, ps.contract_id, ps.net_salary,
                    w.full_name, w.cpf, w.bank_code, w.bank_agency, w.bank_account, w.bank_account_type,
                    w.pix_key, w.pix_key_type
             FROM public.payslips ps
             JOIN public.workers w ON w.id = ps.worker_id
             WHERE ps.payroll_period_id = $1::uuid AND ps.net_salary > 0
             ORDER BY w.full_name ASC;`,
            [periodId]
          ),
          d.includeAlimony
            ? client.query(
                `SELECT pas.id AS split_id, pas.payslip_id, pas.contract_id, pas.amount,
                        pas.beneficiary_name, pas.beneficiary_cpf, pas.payment_method,
                        ab.bank_code, ab.bank_agency, ab.bank_account, ab.bank_account_type,
                        ab.pix_key, ab.pix_key_type
                 FROM public.payslip_alimony_splits pas
                 LEFT JOIN public.alimony_beneficiaries ab ON ab.id = pas.beneficiary_id
                 WHERE pas.payroll_period_id = $1::uuid AND pas.amount > 0
                 ORDER BY pas.beneficiary_name ASC;`,
                [periodId]
              )
            : Promise.resolve({ rows: [] as any[] }),
          client.query(
            `SELECT COALESCE(MAX(sequential_number), 0) + 1 AS next_seq
             FROM public.cnab_remittances WHERE company_id = $1::uuid;`,
            [period.company_id]
          ),
        ]);

        const beneficiaries: Cnab240BeneficiaryItem[] = [];
        for (let idx = 0; idx < slipsRes.rows.length; idx++) {
          const s = slipsRes.rows[idx];
          const method =
            d.paymentChannel === 'PIX' && s.pix_key
              ? 'PIX'
              : d.paymentChannel === 'MIXED' && s.pix_key && !s.bank_account
                ? 'PIX'
                : mapCnabAccountType(s.bank_account_type);
          beneficiaries.push({
            id: s.payslip_id,
            beneficiaryType: 'EMPLOYEE',
            payslipId: s.payslip_id,
            contractId: s.contract_id,
            name: s.full_name,
            cpf: s.cpf || '00000000000',
            paymentMethod: method,
            bankCode: s.bank_code || d.bankCode,
            agency: s.bank_agency || '00001',
            accountNumber: s.bank_account || '000000000001',
            pixKey: s.pix_key,
            pixKeyType: s.pix_key_type,
            amount: Number(s.net_salary),
            paymentDate: payDate,
            yourNumber: `SAL${String(idx + 1).padStart(7, '0')}`,
          });
        }

        for (let idx = 0; idx < alimonyRes.rows.length; idx++) {
          const al = alimonyRes.rows[idx];
          const method =
            al.payment_method === 'PIX' || d.paymentChannel === 'PIX'
              ? 'PIX'
              : mapCnabAccountType(al.bank_account_type);
          beneficiaries.push({
            id: al.split_id,
            beneficiaryType: 'ALIMONY',
            payslipId: al.payslip_id,
            contractId: al.contract_id,
            alimonySplitId: al.split_id,
            name: al.beneficiary_name,
            cpf: al.beneficiary_cpf || '00000000000',
            paymentMethod: method,
            bankCode: al.bank_code || d.bankCode,
            agency: al.bank_agency || '00001',
            accountNumber: al.bank_account || '000000000001',
            pixKey: al.pix_key,
            pixKeyType: al.pix_key_type,
            amount: Number(al.amount),
            paymentDate: payDate,
            yourNumber: `PEN${String(idx + 1).padStart(7, '0')}`,
          });
        }

        const seqNum = Number(seqRes.rows[0]?.next_seq || 1);
        const cnabOut = Cnab240Engine.generateCnab240Remittance({
          company: {
            corporateName: period.corporate_name,
            cnpj: period.cnpj,
            bankCode: d.bankCode || period.payment_bank_code || '341',
            agency: period.payment_agency || '0001',
            agencyDigit: period.payment_agency_digit || ' ',
            accountNumber: period.payment_account || '123456',
            accountDigit: period.payment_account_digit || '0',
            agreementCode: period.payment_agreement_code || '',
          },
          beneficiaries,
          generationDate: payDate,
          sequentialFileNumber: seqNum,
        });

        const fileName = `CNAB240_${cnabOut.bankCode}_${period.year}${String(period.month).padStart(2, '0')}_SEQ${seqNum}.rem`;
        const fileHash = sha256Hex(cnabOut.content);

        const { rows: remRows } = await client.query(
          `INSERT INTO public.cnab_remittances (
             tenant_id, company_id, payroll_period_id, bank_code, bank_name,
             payment_channel, sequential_number, payment_date, include_alimony,
             total_records, employees_count, alimony_count, total_amount,
             file_name, file_content, file_hash_sha256, status, created_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5,
             $6, $7, $8::date, $9,
             $10, $11, $12, $13,
             $14, $15, $16, 'GENERATED', $17::uuid
           ) RETURNING *;`,
          [
            tenantId,
            period.company_id,
            periodId,
            cnabOut.bankCode,
            cnabOut.bankName,
            d.paymentChannel,
            seqNum,
            payDate,
            d.includeAlimony,
            cnabOut.totalLines,
            cnabOut.employeesCount,
            cnabOut.alimonyCount,
            cnabOut.totalAmount,
            fileName,
            cnabOut.content,
            fileHash,
            request.user!.sub,
          ]
        );
        const remittance = remRows[0];

        const benById = new Map(beneficiaries.map((b) => [b.id, b]));
        const insertedItems: any[] = [];
        for (const it of cnabOut.items) {
          const orig = benById.get(it.itemId)!;
          const { rows: itRows } = await client.query(
            `INSERT INTO public.cnab_remittance_items (
               tenant_id, remittance_id, payroll_period_id, payslip_id, contract_id,
               alimony_split_id, beneficiary_type, beneficiary_name, beneficiary_cpf,
               payment_method, bank_code, agency, account, pix_key, pix_key_type,
               amount, your_number, status
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               $6::uuid, $7, $8, $9,
               $10, $11, $12, $13, $14, $15,
               $16, $17, 'PENDING'
             ) RETURNING *;`,
            [
              tenantId,
              remittance.id,
              periodId,
              orig.payslipId || null,
              orig.contractId || null,
              orig.alimonySplitId || null,
              orig.beneficiaryType,
              orig.name,
              orig.cpf,
              orig.paymentMethod,
              orig.bankCode || null,
              orig.agency || null,
              orig.accountNumber || null,
              orig.pixKey || null,
              orig.pixKeyType || null,
              it.amount,
              it.yourNumber,
            ]
          );
          insertedItems.push(itRows[0]);
        }

        return { remittance, items: insertedItems };
      });

      if (!generated) return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      return reply.status(201).send({ success: true, data: generated });
    }
  );

  app.get(
    '/periods/:periodId/cnab240',
    { preHandler: [authenticate, requireAnyPermission(['export_financial_reports', 'view_payroll_accounting', 'calculate_payroll'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const data = await request.withContext(async (client) => {
        const { rows: remittances } = await client.query(
          `SELECT * FROM public.cnab_remittances WHERE payroll_period_id = $1::uuid ORDER BY created_at DESC;`,
          [periodId]
        );
        const latest = remittances[0] || null;
        let items: any[] = [];
        if (latest) {
          const { rows: itRows } = await client.query(
            `SELECT * FROM public.cnab_remittance_items WHERE remittance_id = $1::uuid ORDER BY beneficiary_type DESC, beneficiary_name ASC;`,
            [latest.id]
          );
          items = itRows;
        }
        return { remittances, latest, items };
      });

      return reply.send({ success: true, data });
    }
  );

  app.post(
    '/cnab240/return-import',
    { preHandler: [authenticate, requireAnyPermission(['export_financial_reports', 'view_payroll_accounting'])] },
    async (request, reply) => {
      const bodySchema = z.object({
        companyId: z.string().uuid().optional(),
        remittanceId: z.string().uuid().optional(),
        fileName: z.string().min(1).default('retorno.ret'),
        content: z.string().min(20),
      });
      const parse = bodySchema.safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const tenantId = request.user!.tenant_id!;
      const d = parse.data;
      const parsed = Cnab240Engine.parseCnab240Return(d.content);

      const data = await request.withContext(async (client) => {
        let companyId = d.companyId;
        if (!companyId && d.remittanceId) {
          const { rows: remLookup } = await client.query(
            `SELECT company_id FROM public.cnab_remittances WHERE id = $1::uuid;`,
            [d.remittanceId]
          );
          companyId = remLookup[0]?.company_id;
        }
        if (!companyId) {
          const { rows: compLookup } = await client.query(
            `SELECT id FROM public.companies WHERE tenant_id = $1::uuid LIMIT 1;`,
            [tenantId]
          );
          companyId = compLookup[0]?.id;
        }

        let matchedCount = 0;
        const impactedRemittances = new Set<string>();
        if (d.remittanceId) impactedRemittances.add(d.remittanceId);

        for (const entry of parsed.entries) {
          if (!entry.yourNumber) continue;
          const { rows: upd } = await client.query(
            `UPDATE public.cnab_remittance_items
             SET status = $1,
                 bank_occurrence_code = $2,
                 bank_occurrence_message = $3,
                 settled_at = CASE WHEN $1 = 'PAID' THEN NOW() ELSE settled_at END,
                 updated_at = NOW()
             WHERE tenant_id = $4::uuid
               AND your_number = $5
               AND ($6::uuid IS NULL OR remittance_id = $6::uuid)
             RETURNING remittance_id;`,
            [
              entry.status,
              entry.occurrenceCodes.join(',') || '00',
              entry.occurrenceMessage,
              tenantId,
              entry.yourNumber,
              d.remittanceId || null,
            ]
          );
          if (upd.length > 0) {
            matchedCount += upd.length;
            upd.forEach((r: any) => impactedRemittances.add(r.remittance_id));
          }
        }

        for (const remId of impactedRemittances) {
          const { rows: stats } = await client.query(
            `SELECT COUNT(*) FILTER (WHERE status = 'PAID') AS paid_cnt,
                    COUNT(*) FILTER (WHERE status = 'REJECTED') AS rej_cnt,
                    COUNT(*) AS total_cnt
             FROM public.cnab_remittance_items WHERE remittance_id = $1::uuid;`,
            [remId]
          );
          const st = stats[0];
          const total = Number(st?.total_cnt || 0);
          const paid = Number(st?.paid_cnt || 0);
          const rej = Number(st?.rej_cnt || 0);
          const newStatus =
            total > 0 && paid === total
              ? 'PAID'
              : total > 0 && rej === total
                ? 'REJECTED'
                : paid > 0
                  ? 'PARTIALLY_PAID'
                  : 'SENT';
          await client.query(`UPDATE public.cnab_remittances SET status = $1, updated_at = NOW() WHERE id = $2::uuid;`, [
            newStatus,
            remId,
          ]);
        }

        const { rows: impRows } = await client.query(
          `INSERT INTO public.cnab_return_imports (
             tenant_id, company_id, remittance_id, bank_code, file_name, file_hash_sha256,
             total_items, paid_count, rejected_count, total_paid_amount, summary_json, imported_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
             $7, $8, $9, $10, $11::jsonb, $12::uuid
           ) RETURNING *;`,
          [
            tenantId,
            companyId,
            d.remittanceId || null,
            parsed.bankCode,
            d.fileName,
            sha256Hex(d.content),
            parsed.totalEntries,
            parsed.paidCount,
            parsed.rejectedCount,
            parsed.totalPaidAmount,
            JSON.stringify({ matchedCount, entries: parsed.entries }),
            request.user!.sub,
          ]
        );

        return { returnImport: impRows[0], matchedCount, parsed };
      });

      return reply.send({ success: true, data });
    }
  );

  // =========================================================================
  // CONT-05: Informe de Rendimentos RFB (Quadros 1-7) & Conciliação Fiscal
  // =========================================================================
  app.get(
    '/income-reports/:year',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'view_payslips', 'export_financial_reports'])] },
    async (request, reply) => {
      const { year } = request.params as { year: string };
      const calYear = parseInt(year, 10);
      if (!Number.isFinite(calYear)) return reply.status(400).send({ success: false, error: 'Ano inválido.' });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const rows = await request.withContext(async (client) => {
        const { rows: list } = await client.query(
          `SELECT w.id AS worker_id, w.full_name, w.cpf, co.id AS company_id, co.corporate_name,
                  SUM(ps.total_earnings) AS total_earnings,
                  SUM(ps.net_salary) AS total_net
           FROM public.payslips ps
           JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
           JOIN public.workers w ON w.id = ps.worker_id
           JOIN public.companies co ON co.id = pp.company_id
           WHERE pp.year = $1
           GROUP BY w.id, w.full_name, w.cpf, co.id, co.corporate_name
           ORDER BY w.full_name ASC;`,
          [calYear]
        );
        return list;
      });

      return reply.send({ success: true, data: rows });
    }
  );

  app.get(
    '/income-reports/:year/workers/:workerId',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'view_payslips', 'export_financial_reports'])] },
    async (request, reply) => {
      const { year, workerId } = request.params as { year: string; workerId: string };
      const calYear = parseInt(year, 10);
      if (!Number.isFinite(calYear)) return reply.status(400).send({ success: false, error: 'Ano inválido.' });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const data = await request.withContext(async (client) => {
        const { rows: wRows } = await client.query(
          `SELECT w.id, w.full_name, w.cpf, co.corporate_name, co.cnpj
           FROM public.workers w
           JOIN public.contracts c ON c.worker_id = w.id AND c.deleted_at IS NULL
           JOIN public.companies co ON co.id = c.company_id
           WHERE w.id = $1::uuid
           ORDER BY c.admission_date DESC LIMIT 1;`,
          [workerId]
        );
        if (wRows.length === 0) return null;
        const worker = wRows[0];

        const itemsRes = await client.query(
          `SELECT pi.rubric_code, pi.type, pi.amount, pp.type AS period_type
           FROM public.payslip_items pi
           JOIN public.payslips ps ON ps.id = pi.payslip_id
           JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
           WHERE ps.worker_id = $1::uuid
             AND (
               (pp.irrf_regime = 'COMPETENCE' AND pp.year = $2)
               OR (pp.irrf_regime = 'CASH' AND EXTRACT(YEAR FROM COALESCE(pp.payment_date, pp.competence_date)) = $2)
             );`,
          [workerId, calYear]
        );
        const ledgerRes = await client.query(
          `SELECT taxation_bucket,
                  SUM(gross_taxable) AS gross_taxable,
                  SUM(inss_deducted) AS inss_deducted,
                  SUM(alimony_deducted) AS alimony_deducted,
                  SUM(irrf_withheld) AS irrf_withheld
           FROM public.irrf_cash_ledger
           WHERE worker_id = $1::uuid AND cash_year = $2
           GROUP BY taxation_bucket;`,
          [workerId, calYear]
        );
        const alimonyRes = await client.query(
          `SELECT pas.beneficiary_name, pas.beneficiary_cpf, ab.beneficiary_birth_date, ab.relationship,
                  SUM(pas.amount) AS total_amount
           FROM public.payslip_alimony_splits pas
           JOIN public.payslips ps ON ps.id = pas.payslip_id
           JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
           LEFT JOIN public.alimony_beneficiaries ab ON ab.id = pas.beneficiary_id
           WHERE ps.worker_id = $1::uuid AND pp.year = $2
           GROUP BY pas.beneficiary_name, pas.beneficiary_cpf, ab.beneficiary_birth_date, ab.relationship;`,
          [workerId, calYear]
        );
        const healthDepRes = await client.query(
          `SELECT COALESCE(bc.default_provider, bc.name) AS operator_name, bc.provider_cnpj, bc.ans_code,
                  eb.holder_discount_value,
                  ebd.dependent_name, ebd.dependent_cpf, ebd.employee_discount AS dep_discount
           FROM public.employee_benefits eb
           JOIN public.contracts c ON c.id = eb.contract_id
           JOIN public.benefit_catalogs bc ON bc.id = eb.benefit_catalog_id
           LEFT JOIN public.employee_benefit_dependents ebd ON ebd.employee_benefit_id = eb.id AND ebd.is_active = TRUE AND ebd.deleted_at IS NULL
           WHERE c.worker_id = $1::uuid AND eb.is_active = TRUE AND bc.benefit_type IN ('HEALTH_PLAN', 'DENTAL_PLAN');`,
          [workerId]
        );
        const copayRes = await client.query(
          `SELECT patient_type, patient_name, patient_cpf, SUM(copay_amount) AS total_amount
           FROM public.benefit_copayments
           WHERE worker_id = $1::uuid AND competence_year = $2 AND status = 'DEDUCTED'
           GROUP BY patient_type, patient_name, patient_cpf;`,
          [workerId, calYear]
        );
        const rraRes = await client.query(
          `SELECT SUM(prb.diff_amount) AS rra_taxable,
                  SUM(prb.inss_origin_diff) AS rra_inss,
                  COUNT(DISTINCT (prb.origin_year * 100 + prb.origin_month)) AS rra_months,
                  MAX(ra.title) AS rra_title
           FROM public.payslip_retroactive_breakdown prb
           JOIN public.payslips ps ON ps.id = prb.payslip_id
           JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
           JOIN public.retroactive_adjustments ra ON ra.id = prb.retroactive_adjustment_id
           WHERE ps.worker_id = $1::uuid AND pp.year = $2 AND prb.is_prior_calendar_year = TRUE;`,
          [workerId, calYear]
        );

        let monthlyTaxable = 0;
        let monthlyInss = 0;
        let monthlyIrrf = 0;
        let alimonyTotal = 0;
        let abono = 0;
        let dobra = 0;
        let indTerm = 0;
        let salFam = 0;
        let d13Bruto = 0;
        let d13Inss = 0;
        let d13Irrf = 0;
        let plrTotal = 0;
        let rraIrrf = 0;

        for (const it of itemsRes.rows) {
          const amt = Number(it.amount || 0);
          const code = String(it.rubric_code || '');
          const pType = String(it.period_type || '');
          const is13th = pType.startsWith('THIRTEENTH') || ['601', '602', '604', '605', '512', '513'].includes(code);

          if (code === '915') {
            rraIrrf = addMoney(rraIrrf, amt);
            continue;
          }
          if (code === '703' || code === '704') {
            abono = addMoney(abono, amt);
            continue;
          }
          if (code === '705' || code === '706') {
            dobra = addMoney(dobra, amt);
            continue;
          }
          if (code === '305' || code === '521') {
            salFam = addMoney(salFam, amt);
            continue;
          }
          if (['511', '514', '515', '516', '517', '518', '520'].includes(code)) {
            indTerm = addMoney(indTerm, amt);
            continue;
          }
          if (pType === 'PROFIT_SHARING' && it.type === 'EARNING') {
            plrTotal = addMoney(plrTotal, amt);
            continue;
          }

          if (is13th) {
            if (it.type === 'EARNING') d13Bruto = addMoney(d13Bruto, amt);
            else if (code === '901' || code === '582') d13Inss = addMoney(d13Inss, amt);
            else if (code === '902' || code === '583') d13Irrf = addMoney(d13Irrf, amt);
          } else {
            if (it.type === 'EARNING' && code !== '499' && code !== '110') {
              monthlyTaxable = addMoney(monthlyTaxable, amt);
            } else if (code === '901' || code === '582') {
              monthlyInss = addMoney(monthlyInss, amt);
            } else if (code === '902' || code === '583') {
              monthlyIrrf = addMoney(monthlyIrrf, amt);
            } else if (code === '904') {
              alimonyTotal = addMoney(alimonyTotal, amt);
            }
          }
        }

        // Quando há ledger de caixa consolidado no ano, ele reflete o IRRF efetivamente retido na fonte
        for (const lr of ledgerRes.rows) {
          if (lr.taxation_bucket === 'THIRTEENTH_EXCLUSIVE') {
            d13Irrf = Math.max(d13Irrf, Number(lr.irrf_withheld || 0));
          } else if (lr.taxation_bucket === 'MONTHLY_CASH') {
            monthlyIrrf = Math.max(monthlyIrrf, Number(lr.irrf_withheld || 0));
          }
        }

        const alimonyDetails: IncomeAlimonyComplementItem[] = alimonyRes.rows.map((r: any) => ({
          beneficiaryName: r.beneficiary_name,
          beneficiaryCpf: r.beneficiary_cpf,
          beneficiaryBirthDate: r.beneficiary_birth_date ? toIsoDateOnly(r.beneficiary_birth_date) : null,
          relationship: r.relationship,
          totalAmount: round2(Number(r.total_amount || 0)),
        }));

        const healthPlanDetails: IncomeHealthPlanComplementItem[] = [];
        const seenHolderOps = new Set<string>();
        for (const h of healthDepRes.rows) {
          const opKey = `${h.operator_name}|${h.ans_code || ''}`;
          if (!seenHolderOps.has(opKey) && Number(h.holder_discount_value || 0) > 0) {
            seenHolderOps.add(opKey);
            healthPlanDetails.push({
              operatorName: h.operator_name,
              operatorCnpj: h.provider_cnpj,
              ansCode: h.ans_code,
              beneficiaryType: 'HOLDER',
              beneficiaryName: worker.full_name,
              beneficiaryCpf: worker.cpf,
              totalAmount: round2(Number(h.holder_discount_value || 0) * 12),
            });
          }
          if (h.dependent_name && Number(h.dep_discount || 0) > 0) {
            healthPlanDetails.push({
              operatorName: h.operator_name,
              operatorCnpj: h.provider_cnpj,
              ansCode: h.ans_code,
              beneficiaryType: 'DEPENDENT',
              beneficiaryName: h.dependent_name,
              beneficiaryCpf: h.dependent_cpf,
              totalAmount: round2(Number(h.dep_discount || 0) * 12),
            });
          }
        }
        for (const cp of copayRes.rows) {
          healthPlanDetails.push({
            operatorName: 'Coparticipação Assistencial',
            beneficiaryType: cp.patient_type === 'DEPENDENT' ? 'DEPENDENT' : 'HOLDER',
            beneficiaryName: cp.patient_name,
            beneficiaryCpf: cp.patient_cpf,
            totalAmount: round2(Number(cp.total_amount || 0)),
          });
        }

        const rraRow = rraRes.rows[0] || {};
        const report = IncomeReportEngine.buildAnnualIncomeReport({
          calendarYear: calYear,
          company: { cnpj: worker.cnpj, corporateName: worker.corporate_name },
          worker: { cpf: worker.cpf, fullName: worker.full_name },
          monthlyTaxableEarnings: monthlyTaxable,
          officialSocialSecurityInss: monthlyInss,
          privatePension: 0,
          alimonyTotal,
          irrfMonthlyWithheld: monthlyIrrf,
          exemptVacationAbono: abono,
          exemptDoubleVacation: dobra,
          exemptTerminationIndemnity: indTerm,
          exemptFamilySalary: salFam,
          thirteenthGrossTaxable: d13Bruto,
          thirteenthInss: d13Inss,
          thirteenthIrrf: d13Irrf,
          plrTotal,
          rraProcessNumber: rraRow.rra_title || null,
          rraMonthsCount: Number(rraRow.rra_months || 0),
          rraTaxableAmount: Number(rraRow.rra_taxable || 0),
          rraInssDeduction: Number(rraRow.rra_inss || 0),
          rraIrrfWithheld: rraIrrf,
          alimonyDetails,
          healthPlanDetails,
        });

        return {
          report,
          html: IncomeReportEngine.renderIncomeReportHtml(report),
        };
      });

      if (!data) return reply.status(404).send({ success: false, error: 'Colaborador não encontrado.' });
      return reply.send({ success: true, data });
    }
  );

  app.get(
    '/periods/:periodId/tax-reconciliation',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const data = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT * FROM public.tax_reconciliation_snapshots WHERE payroll_period_id = $1::uuid ORDER BY source_type ASC;`,
          [periodId]
        );
        return rows;
      });
      return reply.send({ success: true, data });
    }
  );

  app.post(
    '/periods/:periodId/tax-reconciliation',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll'])] },
    async (request, reply) => {
      const { periodId } = request.params as { periodId: string };
      const bodySchema = z.object({
        sourceType: z.enum(['DCTFWEB', 'FGTS_DIGITAL', 'IRRF_DARF']),
        declaredBaseAmount: z.coerce.number().nonnegative().optional(),
        declaredTaxAmount: z.coerce.number().nonnegative(),
        notes: z.string().optional().nullable(),
      });
      const parse = bodySchema.safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const tenantId = request.user!.tenant_id!;
      const d = parse.data;

      const snapshot = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT id, company_id, year, month FROM public.payroll_periods WHERE id = $1::uuid;`,
          [periodId]
        );
        if (pRows.length === 0) return null;
        const period = pRows[0];

        const [slipsRes, itemsRes, taxRes] = await Promise.all([
          client.query(
            `SELECT SUM(base_inss) AS base_inss, SUM(base_fgts) AS base_fgts, SUM(base_irrf) AS base_irrf,
                    SUM(fgts_month) AS fgts_sum
             FROM public.payslips WHERE payroll_period_id = $1::uuid;`,
            [periodId]
          ),
          client.query(
            `SELECT pi.rubric_code, SUM(pi.amount) AS total
             FROM public.payslip_items pi
             JOIN public.payslips ps ON ps.id = pi.payslip_id
             WHERE ps.payroll_period_id = $1::uuid AND pi.rubric_code IN ('901', '902', '915', '582', '583')
             GROUP BY pi.rubric_code;`,
            [periodId]
          ),
          client.query(
            `SELECT * FROM public.payroll_company_taxes WHERE payroll_period_id = $1::uuid LIMIT 1;`,
            [periodId]
          ),
        ]);

        const sl = slipsRes.rows[0] || {};
        const tax = taxRes.rows[0] || {};
        let inssEmp = 0;
        let irrfEmp = 0;
        for (const it of itemsRes.rows) {
          if (it.rubric_code === '901' || it.rubric_code === '582') inssEmp = addMoney(inssEmp, Number(it.total || 0));
          else irrfEmp = addMoney(irrfEmp, Number(it.total || 0));
        }

        let engineBase = 0;
        let engineTax = 0;
        if (d.sourceType === 'DCTFWEB') {
          engineBase = round2(Number(sl.base_inss || 0));
          const grossDarf = sumMoney([
            inssEmp,
            Number(tax.inss_patronal || 0),
            Number(tax.inss_patronal_pro_labore || 0),
            Number(tax.rat_amount || 0),
            Number(tax.rat_special_retirement_amount || 0),
            Number(tax.other_entities_amount || 0),
          ]);
          const netDarf = Math.max(
            0,
            subtractMoney(grossDarf, addMoney(Number(tax.maternity_deduction || 0), Number(tax.family_salary_deduction || 0)))
          );
          engineTax = tax.net_inss_due !== undefined && tax.net_inss_due !== null ? Number(tax.net_inss_due) : netDarf;
        } else if (d.sourceType === 'FGTS_DIGITAL') {
          engineBase = round2(Number(sl.base_fgts || 0));
          engineTax = round2(Number(tax.fgts_total ?? sl.fgts_sum ?? 0));
        } else {
          engineBase = round2(Number(sl.base_irrf || 0));
          engineTax = irrfEmp;
        }

        const diffAmount = subtractMoney(round2(d.declaredTaxAmount), engineTax);
        const status = Math.abs(diffAmount) <= 0.02 ? 'MATCHED' : 'DIVERGENT';

        const { rows: up } = await client.query(
          `INSERT INTO public.tax_reconciliation_snapshots (
             tenant_id, company_id, payroll_period_id, year, month, source_type,
             engine_base_amount, engine_tax_amount, declared_base_amount, declared_tax_amount,
             diff_amount, status, notes, reconciled_by, reconciled_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
             $7, $8, $9, $10,
             $11, $12, $13, $14::uuid, NOW()
           )
           ON CONFLICT (tenant_id, payroll_period_id, source_type) DO UPDATE SET
             engine_base_amount = EXCLUDED.engine_base_amount,
             engine_tax_amount = EXCLUDED.engine_tax_amount,
             declared_base_amount = EXCLUDED.declared_base_amount,
             declared_tax_amount = EXCLUDED.declared_tax_amount,
             diff_amount = EXCLUDED.diff_amount,
             status = EXCLUDED.status,
             notes = EXCLUDED.notes,
             reconciled_by = EXCLUDED.reconciled_by,
             reconciled_at = NOW(),
             updated_at = NOW()
           RETURNING *;`,
          [
            tenantId,
            period.company_id,
            periodId,
            Number(period.year),
            Number(period.month),
            d.sourceType,
            engineBase,
            engineTax,
            d.declaredBaseAmount ?? engineBase,
            round2(d.declaredTaxAmount),
            diffAmount,
            status,
            d.notes || null,
            request.user!.sub,
          ]
        );
        return up[0];
      });

      if (!snapshot) return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      return reply.send({ success: true, data: snapshot });
    }
  );
};
