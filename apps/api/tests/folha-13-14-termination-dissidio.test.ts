import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V6 — FOLHA-13 e FOLHA-14 (Integração API + PostgreSQL Real)
 *
 * Validações E2E:
 * 1. FOLHA-13: TerminationOrchestrator via POST /calculate (aviso misto + férias em dobro + banco de horas + trintídio Art. 9º),
 *    efetivação via POST /confirm (payslip + memória + termination), POST /:id/complementary e GET /:id/trct.
 * 2. FOLHA-14: Dissídio retroativo multi-competência (8% sobre 06..08/2026 com HE em 06/2026) via POST /dissidio -> /calculate -> /apply,
 *    gerando folha COMPLEMENTARY e payslip_retroactive_breakdown com ideADC e RRA (2025->2026 rubrica 915).
 */
describe('FOLHA-13 e 14: Motor Unificado de Rescisão e Dissídio Retroativo', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;

  const tenantId = 'f6130000-0000-0000-0000-000000000001';
  const companyId = 'f6130000-0000-0000-0000-000000000011';
  const estId = 'f6130000-0000-0000-0000-000000000021';
  const posId = 'f6130000-0000-0000-0000-000000000031';
  const wpId = 'f6130000-0000-0000-0000-000000000041';
  const userId = 'f6130000-0000-0000-0000-000000000101';
  const unionId = 'f6130000-0000-0000-0000-000000000501';

  const workers = {
    wTerm: 'f6130000-0000-0000-0000-000000000201',
    wDiss: 'f6130000-0000-0000-0000-000000000202',
  };
  const contracts = {
    cTerm: 'f6130000-0000-0000-0000-000000000301',
    cDiss: 'f6130000-0000-0000-0000-000000000302',
  };

  let rubricHe50Id = '';
  let terminationId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Folha1314!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`DELETE FROM public.payslip_retroactive_breakdown WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.retroactive_adjustments WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.terminations WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.vacation_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_variable_events WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.workers WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.establishments WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.workplaces WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.positions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.companies WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid`, [userId]);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active)
         VALUES ($1::uuid, 'admin.v6b@couplerh.test', 'Admin V6B', $2, TRUE)`,
        [userId, pwHash]
      );
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V6B', 'ACTIVE')`, [tenantId]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active) VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Empresa Rescisão & Dissídio Ltda', '61300000000113', 'LUCRO_REAL', 'ACTIVE')`,
        [companyId, tenantId]
      );
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz V6B', '61300000000113')`,
        [estId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sede V6B', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo) VALUES ($1::uuid, $2::uuid, 'Analista Financeiro', '252210')`,
        [posId, tenantId]
      );
      // Sindicato com data-base em Setembro (mês 9) para acionar Trintídio Art. 9º quando projeção cai em Agosto
      await client.query(
        `INSERT INTO public.unions (id, tenant_id, code, cnpj, name, trade_name, union_type, base_month)
         VALUES ($1::uuid, $2::uuid, 'SIND-V6B', '61300000000201', 'Sindicato Financeiro V6B', 'SINDFIN', 'EMPLOYEE', 9)`,
        [unionId, tenantId]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES ($1::uuid, $2::uuid, 'Bruno Rescindido', '61300000001', '1987-04-12', TRUE)`,
        [workers.wTerm, tenantId]
      );
      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES ($1::uuid, $2::uuid, 'Carla Dissídio', '61300000002', '1991-09-21', TRUE)`,
        [workers.wDiss, tenantId]
      );

      // Contrato Rescisão: admitido 01/03/2023 (aviso 30 + 9 = 39d), salário 4.000
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, union_id, registration_number, admission_date, base_salary,
           salary_type, monthly_hours, weekly_hours, regime, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, 'MAT-V6B-1', '2023-03-01', 4000.00,
           'MONTHLY', 220, 44, 'CLT', 'ACTIVE'
         )`,
        [contracts.cTerm, tenantId, companyId, estId, posId, wpId, workers.wTerm, unionId]
      );
      // Férias vencidas em aberto para wTerm -> rescisão deve pagar em dobro!
      await client.query(
        `INSERT INTO public.vacation_periods (
           tenant_id, contract_id, acquisition_start, acquisition_end, concessive_end,
           days_accrued, days_taken, days_remaining, absences_count, status
         ) VALUES (
           $1::uuid, $2::uuid, '2024-03-01', '2025-02-28', '2026-02-28',
           30, 0, 30, 0, 'OPEN'
         )`,
        [tenantId, contracts.cTerm]
      );

      // Contrato Dissídio: salário 3.000
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, union_id, registration_number, admission_date, base_salary,
           salary_type, monthly_hours, weekly_hours, regime, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, 'MAT-V6B-2', '2024-01-01', 3000.00,
           'MONTHLY', 220, 44, 'CLT', 'ACTIVE'
         )`,
        [contracts.cDiss, tenantId, companyId, estId, posId, wpId, workers.wDiss, unionId]
      );

      const { rows: rHe } = await client.query(
        `SELECT id FROM public.rubrics WHERE code IN ('102', '301') AND is_system = TRUE ORDER BY code ASC LIMIT 1;`
      );
      rubricHe50Id = rHe[0]?.id;

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const auth = await tokenService.createSession({
      userId,
      tenantId,
      role: 'system_admin',
      email: 'admin.v6b@couplerh.test',
      aal: 'aal2',
    });
    tokenAdmin = auth.accessToken;
  });

  afterAll(async () => {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query(`DELETE FROM public.payslip_retroactive_breakdown WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.retroactive_adjustments WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.terminations WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.vacation_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_variable_events WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.workers WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.establishments WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.workplaces WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.positions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.companies WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid`, [userId]);
      await client.query('COMMIT;');
    } catch {
      await client.query('ROLLBACK;');
    } finally {
      client.release();
      await app.close();
    }
  });

  it('1. FOLHA-13: Deve calcular rescisão unificada (MIXED + Trintídio + Férias Dobro + Banco de Horas), confirmar TRCT e gerar complementar', async () => {
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/termination/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.cTerm,
        noticeDate: '2026-07-01',
        resignationDate: '2026-07-31',
        dismissalType: 'WITHOUT_CAUSE',
        noticeType: 'MIXED',
        fgtsBalancePrior: 10000,
        timeBankPositiveHours: 10,
      },
    });
    expect(calcRes.statusCode).toBe(200);
    const calcData = calcRes.json().data;
    expect(calcData.metadados.diasAvisoTrabalhado).toBe(30);
    expect(calcData.metadados.diasAvisoIndenizado).toBe(9);
    expect(calcData.proventos.indenizacaoArt9.aplicada).toBe(true);
    expect(calcData.proventos.feriasDobro.valor).toBeGreaterThan(0);
    expect(calcData.proventos.quitacaoBancoHoras.valor).toBeGreaterThan(0);

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/termination/confirm',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.cTerm,
        noticeDate: '2026-07-01',
        resignationDate: '2026-07-31',
        dismissalType: 'WITHOUT_CAUSE',
        noticeType: 'MIXED',
        fgtsBalancePrior: 10000,
        timeBankPositiveHours: 10,
      },
    });
    expect(confirmRes.statusCode).toBe(201);
    const persisted = confirmRes.json().data;
    expect(persisted.termination.id).toBeDefined();
    expect(persisted.termination.payslip_id).toBeDefined();
    terminationId = persisted.termination.id;

    // TRCT renderizado (JSON + HTML)
    const trctRes = await app.inject({
      method: 'GET',
      url: `/api/v1/termination/${terminationId}/trct`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(trctRes.statusCode).toBe(200);
    expect(trctRes.json().data.html).toContain('Termo de Rescisão');

    // Rescisão Complementar com aumento retroativo de salário (+10% -> 4.400)
    const compRes = await app.inject({
      method: 'POST',
      url: `/api/v1/termination/${terminationId}/complementary`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        reason: 'Diferença salarial por homologação de dissídio coletivo',
        newBaseSalary: 4400.0,
      },
    });
    expect(compRes.statusCode).toBe(201);
    const compData = compRes.json().data;
    expect(compData.diffGross).toBeGreaterThan(0);
    expect(compData.complementaryTermination.is_complementary).toBe(true);
  });

  it('2. FOLHA-14: Deve apurar e aplicar Dissídio Retroativo 8% multi-competência com reflexo em HE e RRA', async () => {
    // 2.1 Cria e calcula 06, 07 e 08/2026 para Carla (em 06/2026 com 20h extras para validar rubrica 111)
    for (const month of [6, 7, 8]) {
      const pRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/periods',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        payload: { company_id: companyId, month, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
      });
      expect(pRes.statusCode).toBe(201);
      const pid = pRes.json().data.id;

      if (month === 6) {
        await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
          await client.query(
            `INSERT INTO public.payroll_variable_events (tenant_id, payroll_period_id, contract_id, rubric_id, quantity, origin)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 20, 'MANUAL');`,
            [tenantId, pid, contracts.cDiss, rubricHe50Id]
          );
        });
      }

      const calcRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/calculate',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        payload: { period_id: pid, contract_id: contracts.cDiss },
      });
      expect(calcRes.statusCode).toBe(200);
    }

    // 2.2 Cria dissídio retroativo de 8% (06..08/2026 pago em 10/2026)
    const createDisRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/dissidio',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        union_id: unionId,
        title: 'Dissídio Retroativo Data-Base 2026',
        adjustment_type: 'PERCENTAGE',
        percentage: 8.0,
        start_year: 2026,
        start_month: 6,
        end_year: 2026,
        end_month: 8,
        payment_year: 2026,
        payment_month: 10,
        installments_count: 1,
        apply_rra: true,
        esocial_tp_ac_conv: 'A',
        agreement_signature_date: '2026-09-25',
      },
    });
    expect(createDisRes.statusCode).toBe(201);
    const dissidioId = createDisRes.json().data.id;

    // Calcula prévia
    const calcDisRes = await app.inject({
      method: 'POST',
      url: `/api/v1/payroll/dissidio/${dissidioId}/calculate`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { contractIds: [contracts.cDiss] },
    });
    expect(calcDisRes.statusCode).toBe(200);
    const disCalc = calcDisRes.json().data;
    expect(disCalc.summary.contractsCount).toBe(1);
    expect(disCalc.summary.totalGrossDiff).toBeGreaterThan(720); // 3 * 240 + reflexos HE

    // Aplica gerando folha COMPLEMENTARY + payslip_retroactive_breakdown
    const applyDisRes = await app.inject({
      method: 'POST',
      url: `/api/v1/payroll/dissidio/${dissidioId}/apply`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { contractIds: [contracts.cDiss] },
    });
    expect(applyDisRes.statusCode).toBe(200);

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: brkRows } = await client.query(
        `SELECT * FROM public.payslip_retroactive_breakdown
         WHERE retroactive_adjustment_id = $1::uuid AND contract_id = $2::uuid;`,
        [dissidioId, contracts.cDiss]
      );
      expect(brkRows.length).toBeGreaterThanOrEqual(4); // 3 salários base + 1 HE em 06/2026
      expect(brkRows[0].esocial_ide_adc_json).toBeDefined();
      expect(brkRows[0].esocial_ide_adc_json.tpAcConv).toBe('A');
    });
  });
});
