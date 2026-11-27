import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdminRole, requirePermission, requireAnyPermission } from '../auth/authMiddleware.js';
import { calculatePayrollPeriod, loadHistoricalAveragesItems } from './payrollCalculationService.js';
import {
  createPayrollCalculationJob,
  dispatchPayrollJob,
  processPayrollCalculationJob,
  runPayrollWatchdog,
} from './payrollJobService.js';
import {
  addMoney,
  AlimonySolver,
  AveragesCalculator,
  calculateDefaultPaymentDate,
  divideMoney,
  EmployerTaxesCalculator,
  FamilyAllowanceCalculator,
  multiplyMoney,
  resolveIrrfTaxationBucket,
  round2,
  subtractMoney,
  sumMoney,
  type AverageTarget,
  type AverageWindowMode,
} from '@couplerh/payroll-core';
import { getUserPermissions } from '../auth/rbacMiddleware.js';
import { serializeAlimonySplit, type UserPermissionContext } from '../../shared/serializers/entitySerializers.js';

const createPeriodSchema = z.object({
  company_id: z.string().uuid('ID da empresa inválido.'),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  type: z.enum(['MONTHLY', 'ADVANCE', 'THIRTEENTH_1', 'THIRTEENTH_2', 'THIRTEENTH_SINGLE', 'THIRTEENTH_COMPLEMENTARY', 'VACATION', 'TERMINATION', 'COMPLEMENTARY', 'PROFIT_SHARING']).default('MONTHLY'),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  irrf_regime: z.enum(['CASH', 'COMPETENCE']).default('CASH'),
  parent_period_id: z.string().uuid().optional().nullable(),
  complement_reason: z.string().optional().nullable(),
});

const updatePeriodCashConfigSchema = z.object({
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  irrf_regime: z.enum(['CASH', 'COMPETENCE']).optional(),
});

const calculatePayrollSchema = z.object({
  period_id: z.string().uuid('ID do período inválido.'),
  contract_id: z.string().uuid().optional().nullable(),
});

const scenarioParamsSchema = z
  .object({
    label: z.string().max(120).optional(),
    salary_increase_pct: z.coerce.number().min(-100).max(500).optional(),
    salary_increase_fixed: z.coerce.number().min(-1000000).max(1000000).optional(),
    bonus_amount: z.coerce.number().min(0).max(1000000).optional(),
    bonus_rubric_code: z.string().max(20).optional(),
    overtime_hours_delta: z.coerce.number().min(0).max(500).optional(),
    department_id: z.string().uuid().optional().nullable(),
    position_id: z.string().uuid().optional().nullable(),
    cost_center_id: z.string().uuid().optional().nullable(),
    contract_ids: z.array(z.string().uuid()).optional(),
  })
  .optional()
  .default({});

const createPayrollJobSchema = z.object({
  period_id: z.string().uuid('ID do período inválido.'),
  mode: z.enum(['REAL', 'SIMULATION']).default('REAL'),
  contract_id: z.string().uuid().optional().nullable(),
  scenario_params: scenarioParamsSchema,
  execute_sync: z.boolean().optional().default(false),
});

const simulateWhatIfSchema = z.object({
  period_id: z.string().uuid('ID do período inválido.'),
  contract_id: z.string().uuid().optional().nullable(),
  scenario_params: scenarioParamsSchema,
  execute_sync: z.boolean().optional().default(false),
});

const closePayrollSchema = z.object({
  notes: z.string().optional(),
});

const reopenPayrollSchema = z.object({
  reason: z.string().min(15, 'A justificativa de reabertura deve conter no mínimo 15 caracteres.'),
});

export const payrollPeriodRoutes: FastifyPluginAsync = async (app) => {
  // Criação / Garantia Idempotente de Competência com Data de Pagamento (Regime de Caixa FOLHA-02)
  app.post(
    '/periods',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const parse = createPeriodSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros inválidos para criação de competência.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      const tenantId = request.user!.tenant_id!;
      const competenceDate = `${d.year}-${String(d.month).padStart(2, '0')}-01`;

      const period = await request.withContext(async (client) => {
        let resolvedPaymentDate = d.payment_date || null;

        if (!resolvedPaymentDate) {
          const { rows: compRows } = await client.query(
            `SELECT labor_config FROM public.companies WHERE id = $1::uuid AND tenant_id = $2::uuid;`,
            [d.company_id, tenantId]
          );
          const laborConfig = compRows[0]?.labor_config || {};

          const { rows: holRows } = await client.query(
            `SELECT date FROM public.holidays
             WHERE (tenant_id IS NULL OR tenant_id = $1::uuid)
               AND status = 'ACTIVE'
               AND date >= $2::date
               AND date <= ($2::date + INTERVAL '2 months');`,
            [tenantId, competenceDate]
          );
          const holidaysIso = holRows.map((h: any) =>
            h.date instanceof Date
              ? h.date.toISOString().slice(0, 10)
              : String(h.date).slice(0, 10)
          );

          resolvedPaymentDate = calculateDefaultPaymentDate(
            d.year,
            d.month,
            d.type,
            laborConfig,
            holidaysIso
          );
        }

        if (d.type === 'COMPLEMENTARY') {
          const { rows } = await client.query(
            `INSERT INTO public.payroll_periods (
               tenant_id, company_id, year, month, type, status,
               payment_date, competence_date, irrf_regime, parent_period_id
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4, $5, 'DRAFT',
               $6::date, $7::date, $8, $9::uuid
             )
             ON CONFLICT (tenant_id, company_id, year, month, type) DO UPDATE SET
               parent_period_id = COALESCE(EXCLUDED.parent_period_id, public.payroll_periods.parent_period_id),
               updated_at = NOW()
             RETURNING *;`,
            [
              tenantId,
              d.company_id,
              d.year,
              d.month,
              d.type,
              resolvedPaymentDate,
              competenceDate,
              d.irrf_regime,
              d.parent_period_id || null,
            ]
          );
          return rows[0];
        }

        const { rows: existing } = await client.query(
          `SELECT * FROM public.payroll_periods
           WHERE tenant_id = $1::uuid AND company_id = $2::uuid
             AND year = $3 AND month = $4 AND type = $5
           LIMIT 1;`,
          [tenantId, d.company_id, d.year, d.month, d.type]
        );
        if (existing.length > 0) {
          return existing[0];
        }

        const { rows: inserted } = await client.query(
          `INSERT INTO public.payroll_periods (
             tenant_id, company_id, year, month, type, status,
             payment_date, competence_date, irrf_regime
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, 'DRAFT',
             $6::date, $7::date, $8
           )
           RETURNING *;`,
          [tenantId, d.company_id, d.year, d.month, d.type, resolvedPaymentDate, competenceDate, d.irrf_regime]
        );
        return inserted[0];
      });

      return reply.status(201).send({ success: true, data: period });
    }
  );

  // Atualização de Data de Pagamento e Regime IRRF (enquanto não CLOSED)
  app.patch(
    '/periods/:id',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parse = updatePeriodCashConfigSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros inválidos para atualização da competência.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const updated = await request.withContext(async (client) => {
        const { rows: check } = await client.query(
          `SELECT id, status FROM public.payroll_periods WHERE id = $1::uuid;`,
          [id]
        );
        if (check.length === 0) return { notFound: true };
        if (check[0].status === 'CLOSED') return { closed: true };

        const { rows } = await client.query(
          `UPDATE public.payroll_periods
           SET payment_date = COALESCE($2::date, payment_date),
               irrf_regime = COALESCE($3::text, irrf_regime),
               updated_at = NOW()
           WHERE id = $1::uuid
           RETURNING *;`,
          [id, parse.data.payment_date || null, parse.data.irrf_regime || null]
        );
        return { row: rows[0] };
      });

      if ((updated as any).notFound) {
        return reply.status(404).send({ success: false, error: 'Competência não encontrada.' });
      }
      if ((updated as any).closed) {
        return reply.status(422).send({
          success: false,
          error: 'Não é possível alterar data de pagamento ou regime IRRF de folha fechada.',
        });
      }

      return reply.send({ success: true, data: (updated as any).row });
    }
  );

  // Consulta ao Ledger de IRRF em Regime de Caixa (FOLHA-02)
  app.get(
    '/periods/:id/irrf-cash-ledger',
    { preHandler: [authenticate, requireAnyPermission(['calculate_payroll', 'view_payslips', 'view_payroll_accounting'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const entries = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT l.*, w.full_name AS worker_name
           FROM public.irrf_cash_ledger l
           JOIN public.workers w ON w.id = l.worker_id
           WHERE l.period_id = $1::uuid
           ORDER BY w.full_name ASC;`,
          [id]
        );
        return rows;
      });

      return reply.send({ success: true, entries });
    }
  );

  // Processamento Oficial do Motor de Cálculo de Folha (PostgreSQL 17 + @couplerh/payroll-core)
  app.post(
    '/calculate',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const parse = calculatePayrollSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros inválidos para cálculo da folha.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          return calculatePayrollPeriod(client, {
            tenantId: request.user!.tenant_id!,
            periodId: parse.data.period_id,
            contractIdFilter: parse.data.contract_id || null,
          });
        });

        if (!result.success) {
          return reply.status(result.httpStatus || 422).send(result);
        }

        return reply.send(result);
      } catch (err: any) {
        request.log.error(err, '[PAYROLL_CALCULATE] Erro ao calcular folha');
        return reply.status(400).send({
          success: false,
          error: err.message || 'Erro ao processar folha de pagamento.',
        });
      }
    }
  );

  // Guias Tributárias Consolidadas (BUG-09: seleciona ps.id e usa fgts_month real)
  app.get(
    '/periods/:id/tax-guides',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT id, company_id, month, year, status FROM public.payroll_periods WHERE id = $1::uuid;`,
          [id]
        );
        if (pRows.length === 0) return null;
        const period = pRows[0];

        const { rows: payslips } = await client.query(
          `SELECT id, contract_id, base_inss, base_fgts, base_irrf, fgts_month, total_earnings, total_deductions, net_salary
           FROM public.payslips
           WHERE payroll_period_id = $1::uuid;`,
          [id]
        );

        const payslipIds = payslips.map((p: any) => p.id);
        let inssEmpregados = 0;
        let irrfEmpregados = 0;

        if (payslipIds.length > 0) {
          const { rows: items } = await client.query(
            `SELECT rubric_code, amount
             FROM public.payslip_items
             WHERE payslip_id = ANY($1::uuid[])
               AND rubric_code IN ('901', '902');`,
            [payslipIds]
          );
          for (const it of items) {
            if (it.rubric_code === '901') inssEmpregados = addMoney(inssEmpregados, Number(it.amount || 0));
            if (it.rubric_code === '902') irrfEmpregados = addMoney(irrfEmpregados, Number(it.amount || 0));
          }
        }

        const { rows: taxRows } = await client.query(
          `SELECT * FROM public.payroll_company_taxes WHERE payroll_period_id = $1::uuid LIMIT 1;`,
          [id]
        );
        const companyTax = taxRows[0] || null;

        const totalBaseInss = sumMoney(payslips.map((p: any) => Number(p.base_inss || 0)));
        const totalBaseFgts = sumMoney(payslips.map((p: any) => Number(p.base_fgts || 0)));
        const totalBaseIrrf = sumMoney(payslips.map((p: any) => Number(p.base_irrf || 0)));
        const fgtsTotalReal = sumMoney(payslips.map((p: any) => Number(p.fgts_month || 0)));

        const inssPatronal = Number(companyTax?.inss_patronal || 0);
        const inssPatronalProLabore = Number(companyTax?.inss_patronal_pro_labore || 0);
        const ratAmount = Number(companyTax?.rat_amount || 0);
        const ratSpecialRetirementAmount = Number(companyTax?.rat_special_retirement_amount || 0);
        const terceirosAmount = Number(companyTax?.other_entities_amount || 0);
        const maternityDeduction = Number(companyTax?.maternity_deduction || 0);
        const familySalaryDeduction = Number(companyTax?.family_salary_deduction || 0);
        const cprbReductionRatio = Number(companyTax?.cprb_reduction_ratio || 0);
        const cprbEffectiveCppRate =
          companyTax?.cprb_effective_cpp_rate !== undefined && companyTax?.cprb_effective_cpp_rate !== null
            ? Number(companyTax.cprb_effective_cpp_rate)
            : 20;
        const totalDarfPrevidenciarioBruto = sumMoney([
          inssEmpregados,
          inssPatronal,
          inssPatronalProLabore,
          ratAmount,
          ratSpecialRetirementAmount,
          terceirosAmount,
        ]);
        const totalDarfInss =
          companyTax?.net_inss_due !== undefined && companyTax?.net_inss_due !== null
            ? Number(companyTax.net_inss_due)
            : Math.max(0, round2(totalDarfPrevidenciarioBruto - maternityDeduction - familySalaryDeduction));

        return {
          period,
          payslipsCount: payslips.length,
          totalBaseInss,
          totalBaseFgts,
          totalBaseIrrf,
          inssEmpregados,
          irrfEmpregados,
          fgtsTotal: fgtsTotalReal,
          inssPatronal,
          inssPatronalProLabore,
          ratAmount,
          ratSpecialRetirementAmount,
          terceirosAmount,
          maternityDeduction,
          familySalaryDeduction,
          cprbReductionRatio,
          cprbEffectiveCppRate,
          breakdown: companyTax?.breakdown_json || {},
          totalDarfPrevidenciarioBruto: round2(totalDarfPrevidenciarioBruto),
          totalDarfPrevidenciario: round2(totalDarfInss),
          totalDarfIrrf: round2(irrfEmpregados),
          totalFgtsDigital: round2(fgtsTotalReal),
        };
      });

      if (!data) {
        return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      }

      return reply.send({ success: true, data });
    }
  );

  // Resumo Server-Side de Provisões Mensais (Férias + 1/3 e 13º com Encargos Reais - FOLHA-16)
  app.get(
    '/periods/:id/provisions-summary',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT id, company_id, month, year FROM public.payroll_periods WHERE id = $1::uuid;`,
          [id]
        );
        if (pRows.length === 0) return null;
        const period = pRows[0];

        const [compRes, slipRes] = await Promise.all([
          client.query(
            `SELECT id, tax_regime, labor_config, cprb_gross_revenue_exempt, cprb_gross_revenue_total, cprb_reoneration_year
             FROM public.companies WHERE id = $1::uuid;`,
            [period.company_id]
          ),
          client.query(
            `SELECT ps.contract_id, c.base_salary, COALESCE(c.calculation_regime, 'CLT') AS calculation_regime,
                    w.full_name AS employee_name, w.is_apprentice
             FROM public.payslips ps
             JOIN public.contracts c ON c.id = ps.contract_id
             JOIN public.workers w ON w.id = ps.worker_id
             WHERE ps.payroll_period_id = $1::uuid
             ORDER BY w.full_name ASC;`,
            [id]
          ),
        ]);

        const comp = compRes.rows[0] || {};
        const laborCfg = {
          ...(comp.labor_config || {}),
          tax_regime: comp.tax_regime ?? comp.labor_config?.tax_regime,
          cprb_gross_revenue_exempt: Number(comp.cprb_gross_revenue_exempt || 0),
          cprb_gross_revenue_total: Number(comp.cprb_gross_revenue_total || 0),
          competence_year: comp.cprb_reoneration_year ?? period.year,
        };

        let totalMonthlyFerias = 0;
        let totalMonthlyTercoFerias = 0;
        let totalMonthlyThirteenth = 0;
        let totalChargesFerias = 0;
        let totalChargesThirteenth = 0;

        const items = slipRes.rows.map((row: any) => {
          const regime = String(row.calculation_regime || 'CLT').toUpperCase();
          const exemptProvision = ['PRO_LABORE', 'AUTONOMOUS_RPA', 'INTERN'].includes(regime);
          const baseSalary = exemptProvision ? 0 : Number(row.base_salary || 0);

          const monthlyFerias = divideMoney(baseSalary, 12);
          const monthlyTercoFerias = divideMoney(monthlyFerias, 3);
          const monthlyThirteenth = divideMoney(baseSalary, 12);
          const baseFeriasComTerco = addMoney(monthlyFerias, monthlyTercoFerias);

          const fgtsRate = row.is_apprentice || regime === 'APPRENTICE' ? 0.02 : 0.08;
          const feriasTaxes = EmployerTaxesCalculator.calculateAdvanced({
            baseInssEmployees: baseFeriasComTerco,
            baseFgts: baseFeriasComTerco,
            fgtsMonthSum: round2(baseFeriasComTerco * fgtsRate),
            config: laborCfg,
          });
          const thirteenthTaxes = EmployerTaxesCalculator.calculateAdvanced({
            baseInssEmployees: monthlyThirteenth,
            baseFgts: monthlyThirteenth,
            fgtsMonthSum: round2(monthlyThirteenth * fgtsRate),
            config: laborCfg,
          });

          const chargesFerias = feriasTaxes.total;
          const chargesThirteenth = thirteenthTaxes.total;
          const totalMonthly = sumMoney([
            baseFeriasComTerco,
            chargesFerias,
            monthlyThirteenth,
            chargesThirteenth,
          ]);

          totalMonthlyFerias = addMoney(totalMonthlyFerias, monthlyFerias);
          totalMonthlyTercoFerias = addMoney(totalMonthlyTercoFerias, monthlyTercoFerias);
          totalMonthlyThirteenth = addMoney(totalMonthlyThirteenth, monthlyThirteenth);
          totalChargesFerias = addMoney(totalChargesFerias, chargesFerias);
          totalChargesThirteenth = addMoney(totalChargesThirteenth, chargesThirteenth);

          return {
            contractId: row.contract_id,
            employeeName: row.employee_name,
            monthlyFerias,
            monthlyTercoFerias,
            monthlyThirteenth,
            chargesFerias,
            chargesThirteenth,
            totalMonthly,
          };
        });

        return {
          totalMonthlyFerias,
          totalMonthlyTercoFerias,
          totalMonthlyThirteenth,
          totalChargesFerias,
          totalChargesThirteenth,
          totalMonthlyLiability: sumMoney([
            totalMonthlyFerias,
            totalMonthlyTercoFerias,
            totalMonthlyThirteenth,
            totalChargesFerias,
            totalChargesThirteenth,
          ]),
          items,
        };
      });

      if (!data) {
        return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      }
      return reply.send({ success: true, data });
    }
  );

  // Resumo Contábil Server-Side (Partidas Dobradas D === C usando Encargos Persistidos - FOLHA-16)
  app.get(
    '/periods/:id/accounting-summary',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT id FROM public.payroll_periods WHERE id = $1::uuid;`,
          [id]
        );
        if (pRows.length === 0) return null;

        const [slipsRes, itemsRes, taxRes] = await Promise.all([
          client.query(
            `SELECT total_earnings, total_deductions, net_salary
             FROM public.payslips WHERE payroll_period_id = $1::uuid;`,
            [id]
          ),
          client.query(
            `SELECT pi.rubric_code, pi.amount
             FROM public.payslip_items pi
             JOIN public.payslips ps ON ps.id = pi.payslip_id
             WHERE ps.payroll_period_id = $1::uuid AND pi.type = 'DEDUCTION';`,
            [id]
          ),
          client.query(
            `SELECT * FROM public.payroll_company_taxes WHERE payroll_period_id = $1::uuid LIMIT 1;`,
            [id]
          ),
        ]);

        const totalEarnings = sumMoney(slipsRes.rows.map((p: any) => Number(p.total_earnings || 0)));
        const totalDeductions = sumMoney(slipsRes.rows.map((p: any) => Number(p.total_deductions || 0)));
        const totalNetSalary = sumMoney(slipsRes.rows.map((p: any) => Number(p.net_salary || 0)));

        let totalInssEmployee = 0;
        let totalIrrfEmployee = 0;
        for (const it of itemsRes.rows) {
          if (it.rubric_code === '901' || it.rubric_code === '582') {
            totalInssEmployee = addMoney(totalInssEmployee, Number(it.amount || 0));
          } else if (it.rubric_code === '902' || it.rubric_code === '583' || it.rubric_code === '915') {
            totalIrrfEmployee = addMoney(totalIrrfEmployee, Number(it.amount || 0));
          }
        }
        const totalOtherDeductions = Math.max(
          0,
          subtractMoney(totalDeductions, addMoney(totalInssEmployee, totalIrrfEmployee))
        );

        const tax = taxRes.rows[0] || {};
        const totalEmployerInss = sumMoney([
          Number(tax.inss_patronal || 0),
          Number(tax.inss_patronal_pro_labore || 0),
          Number(tax.rat_amount || 0),
          Number(tax.rat_special_retirement_amount || 0),
          Number(tax.other_entities_amount || 0),
        ]);
        const fgtsCompany = round2(Number(tax.fgts_total || 0));

        const entries: Array<{
          accountCode: string;
          accountName: string;
          type: 'DEBIT' | 'CREDIT';
          amount: number;
          history: string;
        }> = [
          {
            accountCode: '3.1.1.01',
            accountName: 'Despesas com Salários e Ordenados',
            type: 'DEBIT',
            amount: totalEarnings,
            history: 'Valor bruto da folha de pagamento do período',
          },
        ];

        if (totalEmployerInss > 0) {
          entries.push({
            accountCode: '3.1.2.01',
            accountName: 'Encargos Sociais - INSS Patronal / RAT / Especial / Terceiros',
            type: 'DEBIT',
            amount: totalEmployerInss,
            history: 'Encargos previdenciários e outras entidades a recolher',
          });
        }

        if (fgtsCompany > 0) {
          entries.push({
            accountCode: '3.1.2.02',
            accountName: 'Encargos Sociais - FGTS Despesa',
            type: 'DEBIT',
            amount: fgtsCompany,
            history: 'Depósito do FGTS incidente sobre a folha mensal',
          });
        }

        entries.push({
          accountCode: '2.1.2.01',
          accountName: 'Salários a Pagar (Líquido)',
          type: 'CREDIT',
          amount: totalNetSalary,
          history: 'Remuneração líquida creditada aos colaboradores',
        });

        const inssTotalRecolher = addMoney(totalInssEmployee, totalEmployerInss);
        if (inssTotalRecolher > 0) {
          entries.push({
            accountCode: '2.1.3.01',
            accountName: 'INSS e Outras Entidades a Recolher',
            type: 'CREDIT',
            amount: inssTotalRecolher,
            history: 'Retenção de empregados e quota patronal da DCTFWeb',
          });
        }

        if (totalIrrfEmployee > 0) {
          entries.push({
            accountCode: '2.1.3.02',
            accountName: 'IRRF a Recolher',
            type: 'CREDIT',
            amount: totalIrrfEmployee,
            history: 'Imposto de Renda Retido na Fonte dos colaboradores (DARF 0561)',
          });
        }

        if (fgtsCompany > 0) {
          entries.push({
            accountCode: '2.1.3.03',
            accountName: 'FGTS a Recolher',
            type: 'CREDIT',
            amount: fgtsCompany,
            history: 'Guia do FGTS Digital a recolher no mês',
          });
        }

        if (totalOtherDeductions > 0) {
          entries.push({
            accountCode: '2.1.2.02',
            accountName: 'Outros Descontos / Convênios / Benefícios',
            type: 'CREDIT',
            amount: totalOtherDeductions,
            history: 'Descontos diversos retidos em folha',
          });
        }

        const totalDebit = sumMoney(entries.filter((e) => e.type === 'DEBIT').map((e) => e.amount));
        const totalCredit = sumMoney(entries.filter((e) => e.type === 'CREDIT').map((e) => e.amount));

        return {
          isBalanced: Math.abs(subtractMoney(totalDebit, totalCredit)) <= 0.02,
          totalDebit,
          totalCredit,
          entries,
        };
      });

      if (!data) {
        return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      }
      return reply.send({ success: true, data });
    }
  );

  // Pré-auditoria de Folha (BUG-09: usa tabela public.leaves filtrando por company_id)
  app.get(
    '/periods/:id/pre-flight-audit',
    { preHandler: [authenticate, requireAnyPermission(['calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT id, company_id, month, year FROM public.payroll_periods WHERE id = $1::uuid;`,
          [id]
        );
        if (pRows.length === 0) return null;
        const period = pRows[0];
        const startOfMonth = `${period.year}-${String(period.month).padStart(2, '0')}-01`;
        const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
        const endOfMonth = `${period.year}-${String(period.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        const { rows: activeLeaves } = await client.query(
          `SELECT l.id, l.contract_id, l.leave_type, l.start_date, l.end_date
           FROM public.leaves l
           JOIN public.contracts c ON c.id = l.contract_id
           WHERE c.company_id = $1::uuid
             AND l.status = 'ACTIVE'
             AND l.start_date <= $2::date
             AND (l.end_date IS NULL OR l.end_date >= $3::date);`,
          [period.company_id, endOfMonth, startOfMonth]
        );

        const { rows: depRows } = await client.query(
          `SELECT d.id, d.name, d.cpf, d.birth_date, d.relationship,
                  d.is_family_salary, d.is_incapacitated, d.start_date, d.end_date,
                  d.vaccination_card_date, d.school_frequency_date,
                  c.id AS contract_id, c.base_salary, w.full_name AS worker_name
           FROM public.dependents d
           JOIN public.workers w ON w.id = d.worker_id
           JOIN public.contracts c ON c.worker_id = w.id
           WHERE c.company_id = $1::uuid
             AND c.deleted_at IS NULL
             AND c.status IN ('ACTIVE', 'LEAVE', 'VACATION')
             AND d.deleted_at IS NULL
             AND d.is_family_salary = TRUE;`,
          [period.company_id]
        );

        const toIso = (v: any): string | null => {
          if (!v) return null;
          if (typeof v === 'string') return v.slice(0, 10);
          return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
        };

        const { rows: genRows } = await client.query(
          `SELECT glp.family_salary_ceiling, glp.family_salary_value
           FROM public.general_legal_parameters glp
           JOIN public.legal_versions lv ON lv.id = glp.legal_version_id
           WHERE lv.is_active = TRUE AND lv.valid_from <= $1::date AND (lv.valid_to IS NULL OR lv.valid_to >= $1::date)
           ORDER BY lv.valid_from DESC
           LIMIT 1;`,
          [startOfMonth]
        );
        const fsCeiling = Number(genRows[0]?.family_salary_ceiling || 0);
        const fsQuota = Number(genRows[0]?.family_salary_value || 0);

        const depsByContract = new Map<string, { workerName: string; baseSalary: number; deps: any[] }>();
        for (const r of depRows) {
          const entry = depsByContract.get(r.contract_id) || {
            workerName: String(r.worker_name || ''),
            baseSalary: Number(r.base_salary || 0),
            deps: [] as any[],
          };
          entry.deps.push({
            id: r.id,
            name: r.name,
            cpf: r.cpf,
            birth_date: toIso(r.birth_date) || '',
            relationship: r.relationship,
            is_family_salary: r.is_family_salary,
            is_incapacitated: r.is_incapacitated,
            start_date: toIso(r.start_date),
            end_date: toIso(r.end_date),
            vaccination_card_date: toIso(r.vaccination_card_date),
            school_frequency_date: toIso(r.school_frequency_date),
          });
          depsByContract.set(r.contract_id, entry);
        }

        const familyAllowanceAlerts: Array<{
          contract_id: string;
          worker_name: string;
          dependent_id?: string;
          dependent_name: string;
          reason_code: string;
          reason: string;
          age_at_competence: number;
        }> = [];

        if (fsCeiling > 0 && fsQuota > 0) {
          for (const [contractId, info] of depsByContract.entries()) {
            if (info.baseSalary > fsCeiling) continue;
            const evalRes = FamilyAllowanceCalculator.calculate({
              dependents: info.deps,
              competenceYear: period.year,
              competenceMonth: period.month,
              monthlyInssBase: info.baseSalary,
              contractualSalary: info.baseSalary,
              familySalaryCeiling: fsCeiling,
              quotaValue: fsQuota,
            });
            for (const alert of evalRes.complianceAlerts) {
              familyAllowanceAlerts.push({
                contract_id: contractId,
                worker_name: info.workerName,
                dependent_id: alert.dependentId,
                dependent_name: alert.name,
                reason_code: alert.reasonCode,
                reason: alert.reason,
                age_at_competence: alert.ageAtCompetence,
              });
            }
          }
        }

        return {
          period,
          activeLeavesCount: activeLeaves.length,
          activeLeaves,
          familyAllowanceAlertsCount: familyAllowanceAlerts.length,
          familyAllowanceAlerts,
        };
      });

      if (!data) {
        return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      }

      return reply.send({ success: true, data });
    }
  );

  // Fechamento Formal e Travamento de Folha de Pagamento
  app.post(
    '/periods/:id/close',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const parseResult = closePayrollSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados inválidos para fechamento.',
          details: parseResult.error.format(),
        });
      }

      const { notes } = parseResult.data;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows } = await client.query(
            'SELECT public.close_payroll_period($1, $2) AS res;',
            [id, notes || null]
          );

          await client.query(
            `UPDATE public.benefit_copayments
             SET status = 'DEDUCTED', updated_at = NOW()
             WHERE payroll_period_id = $1::uuid AND status = 'PENDING';`,
            [id]
          );

          return rows[0]?.res;
        });

        return reply.send({
          success: true,
          data: {
            status: 'CLOSED',
            ...(result || {}),
          },
        });
      } catch (err: any) {
        request.log.warn(err, '[PAYROLL_CLOSE] Erro ao fechar folha');
        const message = err.message || 'Erro ao fechar período de folha.';

        if (message.includes('Acesso negado') || message.includes('permissao')) {
          return reply.status(403).send({
            success: false,
            code: 'FORBIDDEN_CLOSE_PAYROLL',
            error: message,
          });
        }

        if (message.includes('bloqueado') || message.includes('Compliance') || message.includes('Art. 462')) {
          return reply.status(400).send({
            success: false,
            code: 'PAYROLL_VALIDATION_ERROR',
            error: message,
          });
        }

        if (message.includes('nao encontrado')) {
          return reply.status(404).send({
            success: false,
            code: 'NOT_FOUND',
            error: message,
          });
        }

        return reply.status(400).send({
          success: false,
          error: message,
        });
      }
    }
  );

  // Reabertura Auditada de Folha com Justificativa Legal
  app.post(
    '/periods/:id/reopen',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const parseResult = reopenPayrollSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: parseResult.error.issues[0]?.message || 'Justificativa de reabertura inválida.',
        });
      }

      const { reason } = parseResult.data;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows } = await client.query(
            'SELECT public.reopen_payroll_period($1, $2) AS res;',
            [id, reason]
          );
          return rows[0]?.res;
        });

        return reply.send({
          success: true,
          data: result,
        });
      } catch (err: any) {
        request.log.warn(err, '[PAYROLL_REOPEN] Erro ao reabrir folha');
        const message = err.message || 'Erro ao reabrir período de folha.';

        if (message.includes('Acesso negado') || message.includes('permissao')) {
          return reply.status(403).send({
            success: false,
            code: 'FORBIDDEN_REOPEN_PAYROLL',
            error: message,
          });
        }

        if (message.includes('nao encontrado')) {
          return reply.status(404).send({
            success: false,
            code: 'NOT_FOUND',
            error: message,
          });
        }

        return reply.status(400).send({
          success: false,
          error: message,
        });
      }
    }
  );

  // Disparo Assíncrono em Lotes (Chunks de 50 contratos) — Modo REAL ou SIMULATION (FOLHA-01)
  app.post(
    '/jobs',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const parse = createPayrollJobSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros inválidos para criação do lote de cálculo.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const created = await request.withContext(async (client) => {
        return createPayrollCalculationJob(client, {
          tenantId: request.user!.tenant_id!,
          periodId: parse.data.period_id,
          userId: request.user!.sub || null,
          mode: parse.data.mode,
          scenarioParams: parse.data.scenario_params || {},
          contractIdFilter: parse.data.contract_id || null,
        });
      });

      if (!created.success || !created.job) {
        return reply.status(created.httpStatus || 422).send(created);
      }

      const payload = {
        jobId: created.job.id,
        tenantId: request.user!.tenant_id!,
        userId: request.user!.sub || null,
        role: request.user!.role || null,
      };

      if (parse.data.execute_sync) {
        const finalJob = await processPayrollCalculationJob(payload);
        return reply.status(200).send({
          success: finalJob?.status !== 'FAILED',
          job: finalJob,
        });
      }

      const dispatch = await dispatchPayrollJob(payload);
      return reply.status(202).send({
        success: true,
        dispatched_via: dispatch.via,
        job: created.job,
      });
    }
  );

  // Atalho Tipado de Simulação What-If em Lote (sem tocar em payslips) (FOLHA-01)
  app.post(
    '/simulate',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const parse = simulateWhatIfSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros inválidos para simulação What-If.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const created = await request.withContext(async (client) => {
        return createPayrollCalculationJob(client, {
          tenantId: request.user!.tenant_id!,
          periodId: parse.data.period_id,
          userId: request.user!.sub || null,
          mode: 'SIMULATION',
          scenarioParams: parse.data.scenario_params || {},
          contractIdFilter: parse.data.contract_id || null,
        });
      });

      if (!created.success || !created.job) {
        return reply.status(created.httpStatus || 422).send(created);
      }

      const payload = {
        jobId: created.job.id,
        tenantId: request.user!.tenant_id!,
        userId: request.user!.sub || null,
        role: request.user!.role || null,
      };

      if (parse.data.execute_sync) {
        const finalJob = await processPayrollCalculationJob(payload);
        return reply.status(200).send({
          success: finalJob?.status !== 'FAILED',
          job: finalJob,
        });
      }

      const dispatch = await dispatchPayrollJob(payload);
      return reply.status(202).send({
        success: true,
        dispatched_via: dispatch.via,
        job: created.job,
      });
    }
  );

  // Polling de Progresso e Resultado de Job em Lote / What-If
  app.get(
    '/jobs/:jobId',
    { preHandler: [authenticate, requireAnyPermission(['calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const job = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT * FROM public.payroll_calculation_jobs WHERE id = $1::uuid;`,
          [jobId]
        );
        return rows[0] || null;
      });

      if (!job) {
        return reply.status(404).send({ success: false, error: 'Job de cálculo não encontrado.' });
      }

      const total = Number(job.total_contracts || 0);
      const processed = Number(job.processed_contracts || 0);
      const progressPct =
        job.status === 'COMPLETED'
          ? 100
          : total > 0
            ? Math.min(99, Math.round((processed / total) * 100))
            : 0;

      return reply.send({
        success: true,
        job: {
          ...job,
          progress_pct: progressPct,
        },
      });
    }
  );

  // Histórico de Lotes e Simulações de uma Competência
  app.get(
    '/periods/:id/jobs',
    { preHandler: [authenticate, requireAnyPermission(['calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const jobs = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT id, period_id, mode, scenario_params, status, total_contracts, processed_contracts,
                  error_count, summary_json, started_by, locked_at, heartbeat_at, finished_at, created_at
           FROM public.payroll_calculation_jobs
           WHERE period_id = $1::uuid
           ORDER BY created_at DESC
           LIMIT 20;`,
          [id]
        );
        return rows;
      });

      return reply.send({ success: true, jobs });
    }
  );

  // Cancelamento Controlado de Job Ativo
  app.post(
    '/jobs/:jobId/cancel',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const job = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `UPDATE public.payroll_calculation_jobs
           SET status = 'CANCELLED', finished_at = NOW(), updated_at = NOW()
           WHERE id = $1::uuid AND status IN ('QUEUED', 'RUNNING')
           RETURNING *;`,
          [jobId]
        );
        if (rows[0]?.mode === 'REAL') {
          await client.query(
            `UPDATE public.payroll_periods
             SET status = COALESCE(NULLIF($2, ''), 'DRAFT'),
                 locked_at = NULL,
                 heartbeat_at = NULL,
                 updated_at = NOW()
             WHERE id = $1::uuid AND status = 'CALCULATING';`,
            [rows[0].period_id, rows[0].restore_period_status]
          );
        }
        return rows[0] || null;
      });

      if (!job) {
        return reply.status(404).send({
          success: false,
          error: 'Job ativo não encontrado ou já finalizado.',
        });
      }

      return reply.send({ success: true, job });
    }
  );

  // Execução Sob Demanda do Watchdog Anti-Deadlock
  app.post(
    '/watchdog/run',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const result = await runPayrollWatchdog();
      return reply.send({ success: true, ...result });
    }
  );

  // FOLHA-03: Rateio de Pensão Alimentícia por Holerite (`payslip_alimony_splits`)
  app.get(
    '/payslips/:payslipId/alimony-splits',
    { preHandler: [authenticate, requireAnyPermission(['view_payslips', 'calculate_payroll'])] },
    async (request, reply) => {
      const { payslipId } = request.params as { payslipId: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const splits = await request.withContext(async (client) => {
        const permsList = await getUserPermissions(
          client,
          request.user!.sub,
          request.user!.tenant_id!,
          request.user!.role
        );
        const permsSet = new Set(permsList);
        const ctx: UserPermissionContext = {
          hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
        };

        const { rows } = await client.query(
          `SELECT s.*, w.full_name AS worker_name
           FROM public.payslip_alimony_splits s
           JOIN public.payslips ps ON ps.id = s.payslip_id
           JOIN public.workers w ON w.id = ps.worker_id
           WHERE s.payslip_id = $1::uuid
           ORDER BY s.created_at ASC;`,
          [payslipId]
        );
        return rows.map((r) => serializeAlimonySplit(r, ctx));
      });

      return reply.send({ success: true, splits });
    }
  );

  // FOLHA-03: Rateio consolidado de Pensão Alimentícia de toda a Competência (remessas/PIX)
  app.get(
    '/periods/:id/alimony-splits',
    { preHandler: [authenticate, requireAnyPermission(['view_payslips', 'calculate_payroll'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const permsList = await getUserPermissions(
          client,
          request.user!.sub,
          request.user!.tenant_id!,
          request.user!.role
        );
        const permsSet = new Set(permsList);
        const ctx: UserPermissionContext = {
          hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
        };

        const { rows } = await client.query(
          `SELECT s.*, w.full_name AS worker_name
           FROM public.payslip_alimony_splits s
           JOIN public.payslips ps ON ps.id = s.payslip_id
           JOIN public.workers w ON w.id = ps.worker_id
           WHERE s.payroll_period_id = $1::uuid
           ORDER BY w.full_name ASC, s.beneficiary_name ASC;`,
          [id]
        );
        const splits = rows.map((r) => serializeAlimonySplit(r, ctx));
        const totalAmount = round2(sumMoney(splits.map((s) => Number(s.amount || 0))));
        return { splits, totalAmount };
      });

      return reply.send({ success: true, ...data });
    }
  );

  // FOLHA-03: Simulador/Preview de Convergência Pensão ↔ IRRF (sem gravação no banco)
  app.post(
    '/alimony/preview',
    { preHandler: [authenticate, requireAnyPermission(['calculate_payroll', 'manage_employees'])] },
    async (request, reply) => {
      const bodySchema = z.object({
        contract_id: z.string().uuid().optional(),
        gross_salary: z.coerce.number().positive(),
        inss: z.coerce.number().min(0).default(0),
        dependents: z.coerce.number().int().min(0).default(0),
        period_type: z.string().default('MONTHLY'),
        irrf_regime: z.enum(['CASH', 'COMPETENCE']).default('COMPETENCE'),
        beneficiaries: z
          .array(
            z.object({
              id: z.string().default('preview'),
              beneficiary_name: z.string(),
              calculation_basis: z.enum([
                'NET_SALARY',
                'GROSS_SALARY',
                'BASE_SALARY',
                'MINIMUM_WAGE',
                'FIXED_AMOUNT',
              ]),
              percentage: z.coerce.number().min(0).max(100).optional().nullable(),
              fixed_amount: z.coerce.number().min(0).optional().nullable(),
              min_amount: z.coerce.number().min(0).optional().nullable(),
              max_amount: z.coerce.number().min(0).optional().nullable(),
            })
          )
          .min(1),
      });

      const parse = bodySchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros inválidos para simulação de pensão.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      const solved = await request.withContext(async (client) => {
        const { rows: lvRows } = await client.query(
          `SELECT id FROM public.legal_versions
           WHERE is_active = TRUE
           ORDER BY valid_from DESC LIMIT 1;`
        );
        if (lvRows.length === 0) {
          throw new Error('Versão legal vigente não encontrada.');
        }
        const lvId = lvRows[0].id;
        const [irrfRes, genRes] = await Promise.all([
          client.query(
            `SELECT bracket_number, base_limit, aliquot, deduction
             FROM public.irrf_parameters WHERE legal_version_id = $1::uuid ORDER BY bracket_number ASC;`,
            [lvId]
          ),
          client.query(
            `SELECT * FROM public.general_legal_parameters WHERE legal_version_id = $1::uuid LIMIT 1;`,
            [lvId]
          ),
        ]);

        const rawGen = genRes.rows[0];
        return AlimonySolver.solve({
          beneficiaries: d.beneficiaries,
          grossForAlimony: d.gross_salary,
          baseSalary: d.gross_salary,
          minimumWage: Number(rawGen?.minimum_wage || 0),
          inss: d.inss,
          grossForIrrf: d.gross_salary,
          dependents: d.dependents,
          irrfRegime: d.irrf_regime,
          irrfBucket: resolveIrrfTaxationBucket(d.period_type),
          irrfBrackets: irrfRes.rows.map((r: any) => ({
            bracket_number: Number(r.bracket_number),
            base_limit: r.base_limit !== null ? Number(r.base_limit) : null,
            aliquot: Number(r.aliquot),
            deduction: Number(r.deduction),
          })),
          generalLegalParameters: rawGen
            ? {
                minimum_wage: Number(rawGen.minimum_wage),
                dependent_deduction: Number(rawGen.dependent_deduction),
                simplified_discount: Number(rawGen.simplified_discount),
                irrf_exemption_limit:
                  rawGen.irrf_exemption_limit !== null ? Number(rawGen.irrf_exemption_limit) : undefined,
                irrf_reduction_formula_limit:
                  rawGen.irrf_reduction_formula_limit !== null
                    ? Number(rawGen.irrf_reduction_formula_limit)
                    : undefined,
                irrf_reduction_a:
                  rawGen.irrf_reduction_a !== null ? Number(rawGen.irrf_reduction_a) : undefined,
                irrf_reduction_b:
                  rawGen.irrf_reduction_b !== null ? Number(rawGen.irrf_reduction_b) : undefined,
              }
            : undefined,
        });
      });

      return reply.send({ success: true, preview: solved });
    }
  );

  // Prévia Auditável do Motor de Médias Configurável por CCT (FOLHA-10)
  app.get(
    '/contracts/:contractId/averages-preview',
    { preHandler: [authenticate, requireAnyPermission(['calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { contractId } = request.params as { contractId: string };
      const q = (request.query || {}) as {
        target?: AverageTarget;
        year?: string;
        month?: string;
        windowMode?: AverageWindowMode;
      };

      const target: AverageTarget =
        q.target && ['VACATION', 'THIRTEENTH', 'NOTICE'].includes(q.target) ? q.target : 'VACATION';
      const now = new Date();
      const refYear = Number(q.year) || now.getUTCFullYear();
      const refMonth = Number(q.month) || now.getUTCMonth() + 1;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const { rows: cRows } = await client.query(
          `SELECT c.id, c.base_salary, c.monthly_hours, c.admission_date, c.collective_agreement_id,
                  ca.average_calculation_months, ca.average_window_mode, ca.average_monetary_index_rate
           FROM public.contracts c
           LEFT JOIN public.collective_agreements ca ON ca.id = c.collective_agreement_id
           WHERE c.id = $1::uuid AND c.deleted_at IS NULL;`,
          [contractId]
        );
        if (cRows.length === 0) return null;
        const contract = cRows[0];

        const fromIdx = refYear * 12 + (refMonth - 1) - 23;
        const fromYear = Math.floor(fromIdx / 12);
        const fromMonth = (fromIdx % 12) + 1;

        const histMap = await loadHistoricalAveragesItems(client, {
          tenantId: request.user!.tenant_id!,
          contractIds: [contractId],
          fromYear,
          fromMonth,
          toYear: refYear,
          toMonth: refMonth,
        });

        const windowMode: AverageWindowMode =
          q.windowMode || contract.average_window_mode || 'ACQUISITIVE_OR_12M';

        return AveragesCalculator.calculate({
          target,
          referenceYear: refYear,
          referenceMonth: refMonth,
          currentHourlyBase: Number(contract.base_salary || 0),
          divisor: Number(contract.monthly_hours || 220),
          windowMode,
          windowMonths: Number(contract.average_calculation_months || 12),
          monthlyIndexRate: Number(contract.average_monetary_index_rate || 0),
          entries: histMap.get(contractId) || [],
        });
      });

      if (!data) {
        return reply.status(404).send({ success: false, error: 'Contrato não encontrado.' });
      }

      return reply.send({ success: true, data });
    }
  );
};
