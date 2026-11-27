import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { IRRFCalculator } from '@couplerh/payroll-core';

/**
 * FASE V5 — FOLHA-02: Testes E2E de IRRF em Regime de Caixa (Lei 7.713/88 / IN RFB 1.500)
 * Valida contra API Fastify + PostgreSQL 17 puro (RLS ativo sob couplerh_app).
 */
describe('FOLHA-02: IRRF em Regime de Caixa (Ledger, 5º Dia Útil, Adiantamento & Buckets Exclusivos)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let tokenTenantA: string;
  let tokenTenantB: string;

  const tenantAId = 'f5020000-0000-0000-0000-000000000001';
  const tenantBId = 'f5020000-0000-0000-0000-000000000002';

  const companyAId = 'f5020000-0000-0000-0000-000000000011';
  const companyBId = 'f5020000-0000-0000-0000-000000000012';
  const estAId = 'f5020000-0000-0000-0000-000000000021';
  const posAId = 'f5020000-0000-0000-0000-000000000031';
  const wpAId = 'f5020000-0000-0000-0000-000000000041';

  const userAdminAId = 'f5020000-0000-0000-0000-000000000101';
  const userAdminBId = 'f5020000-0000-0000-0000-000000000102';

  const workerId = 'f5020000-0000-0000-0000-000000000201';
  const contractId = 'f5020000-0000-0000-0000-000000000301';

  const vacPeriodId = 'f5020000-0000-0000-0000-000000000401';
  const vacScheduleId = 'f5020000-0000-0000-0000-000000000402';

  let periodOctMonthlyId: string;
  let periodNovAdvanceId: string;
  let periodNovVacationId: string;
  let periodDec13th2Id: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantBId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantBId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.users WHERE id IN ($1::uuid, $2::uuid);`, [
        userAdminAId,
        userAdminBId,
      ]);

      const passHash = await hashPassword('Folha02@2026!');

      await client.query(
        `INSERT INTO public.users (id, email, password_hash, full_name, is_active)
         VALUES
           ($1, 'admin.a.f502@couplerh.test', $3, 'Admin A F502', TRUE),
           ($2, 'admin.b.f502@couplerh.test', $3, 'Admin B F502', TRUE);`,
        [userAdminAId, userAdminBId, passHash]
      );

      // Tenant B
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1, 'Tenant Beta F502', 'ACTIVE');`, [
        tenantBId,
      ]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1, $2, 'system_admin', 'ALL', TRUE);`,
        [tenantBId, userAdminBId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1, $2, 'Beta F502 Ltda', '62222222000162', 'SIMPLES_NACIONAL', 'ACTIVE');`,
        [companyBId, tenantBId]
      );

      // Tenant A com política 5º dia útil e retenção de IRRF no adiantamento
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1, 'Tenant Alpha F502', 'ACTIVE');`, [
        tenantAId,
      ]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1, $2, 'system_admin', 'ALL', TRUE);`,
        [tenantAId, userAdminAId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, labor_config, status)
         VALUES ($1, $2, 'Alpha Caixa SA', '61111111000161', 'LUCRO_PRESUMIDO', $3::jsonb, 'ACTIVE');`,
        [
          companyAId,
          tenantAId,
          JSON.stringify({
            salary_payment_rule: 'FIFTH_BUSINESS_DAY',
            withhold_irrf_on_advance: true,
          }),
        ]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1, $2, $3, 'Matriz SP', '61111111000161');`,
        [estAId, tenantAId, companyAId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, company_id, title, cbo)
         VALUES ($1, $2, $3, 'Analista Fiscal', '252515');`,
        [posAId, tenantAId, companyAId]
      );

      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1, $2, $3, 'Sede SP', 'SP', '3550308');`,
        [wpAId, tenantAId, companyAId]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, pis, is_apprentice, is_active)
         VALUES ($1, $2, 'Colaborador Caixa 2026', '66611122233', '12066611122', FALSE, TRUE);`,
        [workerId, tenantAId]
      );

      // Salário base R$ 4.000,00 com 50% de adiantamento (= R$ 2.000,00) -> reproduz exatamente o Aceite do Blueprint
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, worker_id, company_id, establishment_id, position_id, workplace_id,
           registration_number, admission_date, base_salary, receives_advance, advance_percentage,
           monthly_hours, weekly_hours, regime, status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           'MAT-CAIXA-01', '2024-01-10', 4000.00, TRUE, 50.00,
           220, 44, 'CLT', 'ACTIVE'
         );`,
        [contractId, tenantAId, workerId, companyAId, estAId, posAId, wpAId]
      );

      // Férias de 20 dias em Novembro/2026 para testar isolamento do bucket VACATION_EXCLUSIVE
      await client.query(
        `INSERT INTO public.vacation_periods (
           id, tenant_id, contract_id, acquisition_start, acquisition_end, concessive_end,
           days_accrued, days_taken, days_remaining, status
         ) VALUES ($1, $2, $3, '2025-01-10', '2026-01-09', '2027-01-09', 30, 20, 10, 'CLOSED');`,
        [vacPeriodId, tenantAId, contractId]
      );
      await client.query(
        `INSERT INTO public.vacation_schedules (
           id, tenant_id, vacation_period_id, contract_id, start_date, end_date,
           days_count, sell_days_count, wants_thirteenth_advance, status
         ) VALUES ($1, $2, $3, $4, '2026-11-09', '2026-11-28', 20, 0, FALSE, 'APPROVED');`,
        [vacScheduleId, tenantAId, vacPeriodId, contractId]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const tokA = await tokenService.createSession({
      userId: userAdminAId,
      email: 'admin.a.f502@couplerh.test',
      tenantId: tenantAId,
      role: 'system_admin',
      aal: 'aal2',
    });
    tokenTenantA = tokA.accessToken;

    const tokB = await tokenService.createSession({
      userId: userAdminBId,
      email: 'admin.b.f502@couplerh.test',
      tenantId: tenantBId,
      role: 'system_admin',
      aal: 'aal2',
    });
    tokenTenantB = tokB.accessToken;
  });

  afterAll(async () => {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantBId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantBId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.users WHERE id IN ($1::uuid, $2::uuid);`, [
        userAdminAId,
        userAdminBId,
      ]);
      await client.query('COMMIT;');
    } finally {
      client.release();
    }
    await app.close();
  });

  it('1. Aceite Blueprint E2E: Salário Outubro pago em Novembro (R$ 4.000) + Adiantamento Novembro pago em 20/11 (R$ 2.000) somam R$ 6.000 no caixa de Novembro', async () => {
    // 1.1 Cria competência 10/2026 MONTHLY -> payment_date automática no 5º dia útil de 11/2026 (2026-11-07 devido ao feriado 02/11 Finados)
    const createOct = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        company_id: companyAId,
        year: 2026,
        month: 10,
        type: 'MONTHLY',
        irrf_regime: 'CASH',
      },
    });
    expect(createOct.statusCode).toBe(201);
    const octPeriod = JSON.parse(createOct.body).data;
    periodOctMonthlyId = octPeriod.id;
    expect(octPeriod.irrf_regime).toBe('CASH');
    expect(String(octPeriod.payment_date).slice(0, 10)).toBe('2026-11-07');

    // Ajusta payment_date para 06/11 (caso de aceite do blueprint) via PATCH
    const patchOct = await app.inject({
      method: 'PATCH',
      url: `/api/v1/payroll/periods/${periodOctMonthlyId}`,
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: { payment_date: '2026-11-06' },
    });
    expect(patchOct.statusCode).toBe(200);

    // Calcula Outubro/2026 (R$ 4.000 pago em 06/11 -> isento de IRRF na regra 2026)
    const calcOct = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: { period_id: periodOctMonthlyId },
    });
    expect(calcOct.statusCode).toBe(200);

    const ledgerOctRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodOctMonthlyId}/irrf-cash-ledger`,
      headers: { Authorization: `Bearer ${tokenTenantA}` },
    });
    expect(ledgerOctRes.statusCode).toBe(200);
    const ledgerOct = JSON.parse(ledgerOctRes.body).entries;
    expect(ledgerOct).toHaveLength(1);
    expect(ledgerOct[0].cash_year).toBe(2026);
    expect(ledgerOct[0].cash_month).toBe(11);
    expect(ledgerOct[0].taxation_bucket).toBe('MONTHLY_CASH');
    expect(Number(ledgerOct[0].gross_taxable)).toBe(4000);
    expect(Number(ledgerOct[0].irrf_withheld)).toBe(0);

    // 1.2 Cria Adiantamento 11/2026 pago em 2026-11-20 (R$ 2.000 no MESMO mês de caixa 11/2026!)
    const createAdv = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        company_id: companyAId,
        year: 2026,
        month: 11,
        type: 'ADVANCE',
        payment_date: '2026-11-20',
        irrf_regime: 'CASH',
      },
    });
    expect(createAdv.statusCode).toBe(201);
    periodNovAdvanceId = JSON.parse(createAdv.body).data.id;

    const calcAdv = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: { period_id: periodNovAdvanceId },
    });
    expect(calcAdv.statusCode).toBe(200);

    const ledgerAdvRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodNovAdvanceId}/irrf-cash-ledger`,
      headers: { Authorization: `Bearer ${tokenTenantA}` },
    });
    const ledgerAdv = JSON.parse(ledgerAdvRes.body).entries;
    expect(ledgerAdv).toHaveLength(1);
    expect(ledgerAdv[0].cash_year).toBe(2026);
    expect(ledgerAdv[0].cash_month).toBe(11);
    expect(ledgerAdv[0].taxation_bucket).toBe('MONTHLY_CASH');
    expect(Number(ledgerAdv[0].gross_taxable)).toBe(2000);

    // Calcula valor esperado sobre R$ 6.000 (4.000 + 2.000) - INSS de 4.000
    const ctxA = { tenantId: tenantAId, userId: userAdminAId, role: 'system_admin' };
    const { inssOct, irrfAdvSaved, advMemory, dbIrrfBrackets, dbGeneralParams } = await withTenantContext(ctxA, async (client) => {
      const { rows: octSlip } = await client.query(
        `SELECT pi.amount FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.payroll_period_id = $1::uuid AND pi.rubric_code = '901';`,
        [periodOctMonthlyId]
      );
      const { rows: advSlip } = await client.query(
        `SELECT ps.id, ps.legal_version_id, pi.amount FROM public.payslips ps
         LEFT JOIN public.payslip_items pi ON pi.payslip_id = ps.id AND pi.rubric_code = '902'
         WHERE ps.payroll_period_id = $1::uuid;`,
        [periodNovAdvanceId]
      );
      const { rows: memRows } = await client.query(
        `SELECT parsed_formula, result_value FROM public.payroll_memory_calc
         WHERE payslip_id = $1::uuid AND step_name = 'IRRF';`,
        [advSlip[0].id]
      );
      const { rows: brackets } = await client.query(
        `SELECT bracket_number, base_limit, aliquot, deduction FROM public.irrf_parameters
         WHERE legal_version_id = $1::uuid ORDER BY bracket_number ASC;`,
        [advSlip[0].legal_version_id]
      );
      const { rows: gen } = await client.query(
        `SELECT * FROM public.general_legal_parameters WHERE legal_version_id = $1::uuid LIMIT 1;`,
        [advSlip[0].legal_version_id]
      );
      return {
        inssOct: Number(octSlip[0].amount),
        irrfAdvSaved: Number(advSlip[0].amount || 0),
        advMemory: memRows[0],
        dbIrrfBrackets: brackets.map((b: any) => ({
          bracket_number: Number(b.bracket_number),
          base_limit: b.base_limit !== null ? Number(b.base_limit) : null,
          aliquot: Number(b.aliquot),
          deduction: Number(b.deduction),
        })),
        dbGeneralParams: {
          simplified_discount: Number(gen[0].simplified_discount),
          dependent_deduction: Number(gen[0].dependent_deduction),
          irrf_exemption_limit: gen[0].irrf_exemption_limit !== null ? Number(gen[0].irrf_exemption_limit) : undefined,
          irrf_reduction_formula_limit: gen[0].irrf_reduction_formula_limit !== null ? Number(gen[0].irrf_reduction_formula_limit) : undefined,
          irrf_reduction_a: gen[0].irrf_reduction_a !== null ? Number(gen[0].irrf_reduction_a) : undefined,
          irrf_reduction_b: gen[0].irrf_reduction_b !== null ? Number(gen[0].irrf_reduction_b) : undefined,
        },
      };
    });

    const expectedCashIrrf = IRRFCalculator.calculateCashConsolidated({
      current: { grossIncome: 2000, inss: 0, dependents: 0, alimony: 0 },
      priorEntries: [{ gross_taxable: 4000, inss_deducted: inssOct, alimony_deducted: 0, irrf_withheld: 0 }],
      bucket: 'MONTHLY_CASH',
      brackets: dbIrrfBrackets,
      params: dbGeneralParams,
    });

    expect(Number(ledgerAdv[0].irrf_withheld)).toBe(expectedCashIrrf.value);
    expect(irrfAdvSaved).toBe(expectedCashIrrf.value);
    expect(irrfAdvSaved).toBeGreaterThan(0);
    expect(advMemory.parsed_formula).toContain('Acumulado Caixa: R$ 6000.00');
  });

  it('2. deve isolar Férias (VACATION_EXCLUSIVE) e 13º (THIRTEENTH_EXCLUSIVE) no ledger sem somar ao caixa MONTHLY_CASH', async () => {
    // Férias pagas em 06/11/2026 (20 dias de gozo sobre R$ 4.000 + 1/3 = R$ 3.555,56 <= R$ 5.000)
    // Se somasse com o MONTHLY_CASH de Novembro (R$ 6.000), cobraria IRRF! Isolado, deve dar IRRF = 0.
    const createVac = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        company_id: companyAId,
        year: 2026,
        month: 11,
        type: 'VACATION',
        payment_date: '2026-11-07',
        irrf_regime: 'CASH',
      },
    });
    expect(createVac.statusCode).toBe(201);
    periodNovVacationId = JSON.parse(createVac.body).data.id;

    const calcVac = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: { period_id: periodNovVacationId },
    });
    expect(calcVac.statusCode).toBe(200);

    const ledgerVacRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodNovVacationId}/irrf-cash-ledger`,
      headers: { Authorization: `Bearer ${tokenTenantA}` },
    });
    const ledgerVac = JSON.parse(ledgerVacRes.body).entries;
    expect(ledgerVac).toHaveLength(1);
    expect(ledgerVac[0].taxation_bucket).toBe('VACATION_EXCLUSIVE');
    expect(Number(ledgerVac[0].irrf_withheld)).toBe(0);

    // 13º 2ª parcela paga em 20/12/2026 -> bucket THIRTEENTH_EXCLUSIVE
    const create13 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        company_id: companyAId,
        year: 2026,
        month: 12,
        type: 'THIRTEENTH_2',
        payment_date: '2026-12-20',
        irrf_regime: 'CASH',
      },
    });
    expect(create13.statusCode).toBe(201);
    periodDec13th2Id = JSON.parse(create13.body).data.id;

    const calc13 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: { period_id: periodDec13th2Id },
    });
    expect(calc13.statusCode).toBe(200);

    const ledger13Res = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodDec13th2Id}/irrf-cash-ledger`,
      headers: { Authorization: `Bearer ${tokenTenantA}` },
    });
    const ledger13 = JSON.parse(ledger13Res.body).entries;
    expect(ledger13).toHaveLength(1);
    expect(ledger13[0].taxation_bucket).toBe('THIRTEENTH_EXCLUSIVE');
    expect(Number(ledger13[0].irrf_withheld)).toBe(0);
  });

  it('3. deve garantir que simulação What-If não grava nem altera o irrf_cash_ledger e que RLS isola Tenants', async () => {
    const ctxA = { tenantId: tenantAId, userId: userAdminAId, role: 'system_admin' };
    const beforeLedger = await withTenantContext(ctxA, async (client) => {
      const { rows } = await client.query(
        `SELECT id, gross_taxable, irrf_withheld FROM public.irrf_cash_ledger WHERE period_id = $1::uuid;`,
        [periodOctMonthlyId]
      );
      return rows;
    });

    const simRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/simulate',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        period_id: periodOctMonthlyId,
        execute_sync: true,
        scenario_params: { salary_increase_pct: 80 },
      },
    });
    expect(simRes.statusCode).toBe(200);

    const afterLedger = await withTenantContext(ctxA, async (client) => {
      const { rows } = await client.query(
        `SELECT id, gross_taxable, irrf_withheld FROM public.irrf_cash_ledger WHERE period_id = $1::uuid;`,
        [periodOctMonthlyId]
      );
      return rows;
    });
    expect(afterLedger).toEqual(beforeLedger);

    // Tenant B não pode enxergar ledger do Tenant A
    const crossTenantRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodOctMonthlyId}/irrf-cash-ledger`,
      headers: { Authorization: `Bearer ${tokenTenantB}` },
    });
    expect(crossTenantRes.statusCode).toBe(200);
    expect(JSON.parse(crossTenantRes.body).entries).toEqual([]);
  });
});
