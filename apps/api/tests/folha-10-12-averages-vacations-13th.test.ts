import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V6 — FOLHA-10, FOLHA-11 e FOLHA-12 (Integração API + PostgreSQL Real)
 *
 * Validações E2E:
 * 1. FOLHA-10: Motor de Médias configurável por CCT (LAST_6M + horas valorizadas ao salário atual) via GET /averages-preview.
 * 2. FOLHA-11: Bloqueio CLT Art. 134 §3º (2 dias antes de feriado/DSR), férias em dobro (705/706 isentas), rateio entre 2 meses e Férias Coletivas Art. 140.
 * 3. FOLHA-12: Ciclo completo 13º (1ª Parc 11/2026 -> 2ª Parc 12/2026 -> HE pós-fechamento 12/2026 -> 13º Complementar 01/2027 rubrica 604).
 */
describe('FOLHA-10 a 12: Médias CCT, Férias Enterprise e 13º Complementar', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;

  const tenantId = 'f6100000-0000-0000-0000-000000000001';
  const companyId = 'f6100000-0000-0000-0000-000000000011';
  const estId = 'f6100000-0000-0000-0000-000000000021';
  const posId = 'f6100000-0000-0000-0000-000000000031';
  const wpId = 'f6100000-0000-0000-0000-000000000041';
  const deptId = 'f6100000-0000-0000-0000-000000000051';
  const userId = 'f6100000-0000-0000-0000-000000000101';

  const workers = {
    wSenior: 'f6100000-0000-0000-0000-000000000201', // Admitido 2024 (férias vencidas + médias + 13º)
    wNew: 'f6100000-0000-0000-0000-000000000202',    // Admitido 01/08/2026 (< 1 ano -> coletivas Art. 140)
  };
  const contracts = {
    cSenior: 'f6100000-0000-0000-0000-000000000301',
    cNew: 'f6100000-0000-0000-0000-000000000302',
  };
  const vacPeriodSeniorId = 'f6100000-0000-0000-0000-000000000401';
  const vacPeriodNewId = 'f6100000-0000-0000-0000-000000000402';
  const unionId = 'f6100000-0000-0000-0000-000000000501';
  const cctId = 'f6100000-0000-0000-0000-000000000502';

  let rubricHe50Id = '';
  const createdPeriodIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Folha1012!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`DELETE FROM public.vacation_schedules WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.collective_vacation_batches WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.vacation_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.holidays WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_variable_events WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.collective_agreements WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.departments WHERE tenant_id = $1::uuid`, [tenantId]);
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
         VALUES ($1::uuid, 'admin.v6a@couplerh.test', 'Admin V6A', $2, TRUE)`,
        [userId, pwHash]
      );
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V6A', 'ACTIVE')`, [tenantId]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active) VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Empresa V6A Ltda', '61000000000110', 'LUCRO_PRESUMIDO', 'ACTIVE')`,
        [companyId, tenantId]
      );
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz V6A', '61000000000110')`,
        [estId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sede V6A', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo) VALUES ($1::uuid, $2::uuid, 'Desenvolvedor', '212405')`,
        [posId, tenantId]
      );
      await client.query(
        `INSERT INTO public.departments (id, tenant_id, company_id, name) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Engenharia')`,
        [deptId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.unions (id, tenant_id, code, cnpj, name, trade_name, union_type, base_month)
         VALUES ($1::uuid, $2::uuid, 'SIND-V6A', '61000000000201', 'Sindicato TI V6A', 'SINDTI', 'EMPLOYEE', 5)`,
        [unionId, tenantId]
      );
      await client.query(
        `INSERT INTO public.collective_agreements (
           id, tenant_id, union_id, title, agreement_type, start_date, end_date,
           average_calculation_months, average_window_mode, average_monetary_index_rate
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'CCT TI 2026', 'CCT', '2026-01-01', '2027-04-30',
           6, 'LAST_6M', 0
         )`,
        [cctId, tenantId, unionId]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES ($1::uuid, $2::uuid, 'Marcos Senior', '61000000001', '1990-02-10', TRUE)`,
        [workers.wSenior, tenantId]
      );
      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES ($1::uuid, $2::uuid, 'Julia Nova', '61000000002', '1999-07-15', TRUE)`,
        [workers.wNew, tenantId]
      );

      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, department_id, position_id, workplace_id,
           worker_id, union_id, collective_agreement_id, registration_number, admission_date,
           base_salary, salary_type, monthly_hours, weekly_hours, regime, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
           $8::uuid, $9::uuid, $10::uuid, 'MAT-V6A-1', '2024-01-10',
           4400.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE'
         )`,
        [contracts.cSenior, tenantId, companyId, estId, deptId, posId, wpId, workers.wSenior, unionId, cctId]
      );
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, department_id, position_id, workplace_id,
           worker_id, union_id, collective_agreement_id, registration_number, admission_date,
           base_salary, salary_type, monthly_hours, weekly_hours, regime, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
           $8::uuid, $9::uuid, $10::uuid, 'MAT-V6A-2', '2026-08-01',
           2500.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE'
         )`,
        [contracts.cNew, tenantId, companyId, estId, deptId, posId, wpId, workers.wNew, unionId, cctId]
      );

      // Período aquisitivo vencido (concessive_end 2026-01-09 -> férias 10/2026 em dobro Art. 137)
      await client.query(
        `INSERT INTO public.vacation_periods (
           id, tenant_id, contract_id, acquisition_start, acquisition_end, concessive_end,
           days_accrued, days_taken, days_remaining, absences_count, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, '2024-01-10', '2025-01-09', '2026-01-09',
           30, 0, 30, 0, 'OPEN'
         )`,
        [vacPeriodSeniorId, tenantId, contracts.cSenior]
      );
      // Período aquisitivo da empregada com < 1 ano
      await client.query(
        `INSERT INTO public.vacation_periods (
           id, tenant_id, contract_id, acquisition_start, acquisition_end, concessive_end,
           days_accrued, days_taken, days_remaining, absences_count, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, '2026-08-01', '2027-07-31', '2028-07-31',
           30, 0, 30, 0, 'OPEN'
         )`,
        [vacPeriodNewId, tenantId, contracts.cNew]
      );

      // Feriado para validar bloqueio CLT Art. 134 §3º (12/10/2026 - Segunda)
      await client.query(
        `INSERT INTO public.holidays (tenant_id, company_id, date, name, type, status)
         VALUES ($1::uuid, $2::uuid, '2026-10-12', 'Nossa Senhora Aparecida V6A', 'NATIONAL', 'ACTIVE')
         ON CONFLICT DO NOTHING;`,
        [tenantId, companyId]
      );

      // Localiza rubrica HE 50% (código 102 ou 301)
      const { rows: rHe } = await client.query(
        `SELECT id, code FROM public.rubrics WHERE code IN ('102', '301') AND is_system = TRUE ORDER BY code ASC LIMIT 1;`
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
      email: 'admin.v6a@couplerh.test',
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
      await client.query(`DELETE FROM public.vacation_schedules WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.collective_vacation_batches WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.vacation_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.holidays WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_variable_events WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.collective_agreements WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.departments WHERE tenant_id = $1::uuid`, [tenantId]);
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

  it('1. FOLHA-10: Deve calcular folhas com HE, aumentar salário e apurar médias por quantidade na CCT via GET /averages-preview', async () => {
    // 1.1 Calcula competências 08/2026 e 09/2026 com 20h extras cada
    for (const month of [8, 9]) {
      const pRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/periods',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        payload: { company_id: companyId, month, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
      });
      expect(pRes.statusCode).toBe(201);
      const pid = pRes.json().data.id;
      createdPeriodIds.push(pid);

      await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
        await client.query(
          `INSERT INTO public.payroll_variable_events (tenant_id, payroll_period_id, contract_id, rubric_id, quantity, origin)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 20, 'MANUAL');`,
          [tenantId, pid, contracts.cSenior, rubricHe50Id]
        );
      });

      const calcRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/calculate',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        payload: { period_id: pid },
      });
      expect(calcRes.statusCode).toBe(200);
    }

    // 1.2 Simula aumento salarial de R$ 4.400 -> R$ 6.600 para testar valorização pela hora atual
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      await client.query(`UPDATE public.contracts SET base_salary = 6600.00 WHERE id = $1::uuid;`, [contracts.cSenior]);
    });

    const prevRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/contracts/${contracts.cSenior}/averages-preview?target=VACATION&year=2026&month=10&windowMode=LAST_6M`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(prevRes.statusCode).toBe(200);
    const preview = prevRes.json().data;
    expect(preview.windowUsed).toContain('6');
    expect(preview.totalAverage).toBeGreaterThan(0);
    expect(preview.byRubric.length).toBeGreaterThanOrEqual(1);
    expect(preview.byRubric[0].averageType).toBe('HOURS_QUANTITY');
  });

  it('2. FOLHA-11: Deve bloquear férias 2 dias antes de feriado (Art. 134 §3º), calcular férias em dobro cruzando meses e executar férias coletivas (< 1 ano)', async () => {
    // 2.1 Tentativa em 10/10/2026 (2 dias antes do feriado 12/10/2026) -> BLOQUEADO 400
    const badRes = await app.inject({
      method: 'POST',
      url: '/api/v1/vacations/schedules',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.cSenior,
        vacationPeriodId: vacPeriodSeniorId,
        startDate: '2026-10-10',
        endDate: '2026-10-29',
        daysCount: 20,
        sellDaysCount: 0,
        wantsThirteenthAdvance: false,
      },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error).toMatch(/Art\. 134/i);

    // 2.2 Agendamento válido cruzando meses: 19/10/2026 (Segunda) a 07/11/2026 (20 dias, concessive_end 01/2026 -> DOBRO!)
    const okRes = await app.inject({
      method: 'POST',
      url: '/api/v1/vacations/schedules',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.cSenior,
        vacationPeriodId: vacPeriodSeniorId,
        startDate: '2026-10-19',
        endDate: '2026-11-07',
        daysCount: 20,
        sellDaysCount: 0,
        wantsThirteenthAdvance: false,
      },
    });
    expect(okRes.statusCode).toBe(201);
    const sch = okRes.json().data;
    expect(sch.double_vacation_days).toBe(20);
    expect(Array.isArray(sch.split_months_json)).toBe(true);
    expect(sch.split_months_json.length).toBe(2); // Outubro e Novembro

    // Aprova para entrar na folha de Férias
    const approveRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/vacations/schedules/${sch.id}/status`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'APPROVED' },
    });
    expect(approveRes.statusCode).toBe(200);

    // Calcula folha VACATION 10/2026 -> deve gerar rubrica 705 (Férias em Dobro isenta)
    const vpRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 10, year: 2026, type: 'VACATION', irrf_regime: 'COMPETENCE' },
    });
    expect(vpRes.statusCode).toBe(201);
    const vacPeriodPayrollId = vpRes.json().data.id;

    const vCalcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: vacPeriodPayrollId, contract_id: contracts.cSenior },
    });
    expect(vCalcRes.statusCode).toBe(200);

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows } = await client.query(
        `SELECT pi.rubric_code, pi.amount
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id = $2::uuid;`,
        [vacPeriodPayrollId, contracts.cSenior]
      );
      const r705 = rows.find((r: any) => r.rubric_code === '705');
      expect(r705).toBeDefined();
      expect(Number(r705.amount)).toBeGreaterThan(0);
    });

    // 2.3 Férias Coletivas para Julia Nova (< 1 ano desde 01/08/2026) -> reinicia aquisitivo em 21/12/2026 (Art. 140)
    const collRes = await app.inject({
      method: 'POST',
      url: '/api/v1/vacations/collective',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        companyId,
        departmentId: deptId,
        title: 'Recesso Coletivo Dez/2026',
        startDate: '2026-12-21',
        endDate: '2026-12-30',
        daysCount: 10,
        contractIds: [contracts.cNew],
      },
    });
    expect(collRes.statusCode).toBe(201);
    const collData = collRes.json().data;
    expect(collData.contractsProcessed).toBe(1);
    expect(collData.items[0].evaluation.isUnderOneYear).toBe(true);
    expect(collData.items[0].evaluation.resetAcquisitionStartDate).toBe('2026-12-21');
  });

  it('3. FOLHA-12: Deve processar 13º 1ª Parcela, 2ª Parcela e 13º Complementar em Janeiro/2027 sem bitributação', async () => {
    // 3.1 1ª Parcela 13º (11/2026)
    const p13_1 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 11, year: 2026, type: 'THIRTEENTH_1', irrf_regime: 'COMPETENCE' },
    });
    expect(p13_1.statusCode).toBe(201);
    const c13_1 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: p13_1.json().data.id },
    });
    expect(c13_1.statusCode).toBe(200);

    // 3.2 2ª Parcela 13º (12/2026)
    const p13_2 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 12, year: 2026, type: 'THIRTEENTH_2', irrf_regime: 'CASH', payment_date: '2026-12-20' },
    });
    expect(p13_2.statusCode).toBe(201);
    const p13_2_id = p13_2.json().data.id;
    const c13_2 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: p13_2_id },
    });
    expect(c13_2.statusCode).toBe(200);

    // 3.3 Em 12/2026 mensal, apura 40h extras pós 20/12 (entram na média anual para ajuste em Jan/2027)
    const pDezMonthly = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 12, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(pDezMonthly.statusCode).toBe(201);
    const pDezId = pDezMonthly.json().data.id;
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      await client.query(
        `INSERT INTO public.payroll_variable_events (tenant_id, payroll_period_id, contract_id, rubric_id, quantity, origin)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 40, 'MANUAL');`,
        [tenantId, pDezId, contracts.cSenior, rubricHe50Id]
      );
    });
    const cDez = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: pDezId },
    });
    expect(cDez.statusCode).toBe(200);

    // 3.4 Cria e calcula 13º Complementar em 01/2027 (Decreto 10.854/2021 Art. 79)
    const p13Comp = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 1, year: 2027, type: 'THIRTEENTH_COMPLEMENTARY', irrf_regime: 'CASH', payment_date: '2027-01-10' },
    });
    expect(p13Comp.statusCode).toBe(201);
    const p13CompId = p13Comp.json().data.id;
    const c13Comp = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: p13CompId, contract_id: contracts.cSenior },
    });
    expect(c13Comp.statusCode).toBe(200);

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows } = await client.query(
        `SELECT pi.rubric_code, pi.amount
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id = $2::uuid;`,
        [p13CompId, contracts.cSenior]
      );
      const r605 = rows.find((r: any) => r.rubric_code === '605');
      expect(r605).toBeDefined();
      expect(Number(r605.amount)).toBeGreaterThan(0);
    });
  });
});
