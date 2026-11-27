import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V5 — FOLHA-04: Integração Completa de Afastamentos (Tabela 18 eSocial)
 * Valida Auxílio-Doença (15d + 60d CID + INSS 16º+), Acidente Trabalho (FGTS + Estabilidade 12m),
 * Licença-Maternidade (120/180d + DCTFWeb), Serviço Militar (FGTS), Reflexo 13º e Perda Férias (>180d CLT art. 133 IV).
 */
describe('FOLHA-04: Integração Completa de Afastamentos (leaves — Tabela 18 eSocial)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let tokenAdmin: string;

  const tenantId = 'f5040000-0000-0000-0000-000000000001';
  const companyId = 'f5040000-0000-0000-0000-000000000011';
  const estId = 'f5040000-0000-0000-0000-000000000021';
  const posId = 'f5040000-0000-0000-0000-000000000031';
  const wpId = 'f5040000-0000-0000-0000-000000000041';
  const userId = 'f5040000-0000-0000-0000-000000000101';

  const workers = {
    sick: 'f5040000-0000-0000-0000-000000000201',
    accident: 'f5040000-0000-0000-0000-000000000202',
    maternity: 'f5040000-0000-0000-0000-000000000203',
    military: 'f5040000-0000-0000-0000-000000000204',
    sick13th: 'f5040000-0000-0000-0000-000000000205',
  };

  const contracts = {
    sick: 'f5040000-0000-0000-0000-000000000301',
    accident: 'f5040000-0000-0000-0000-000000000302',
    maternity: 'f5040000-0000-0000-0000-000000000303',
    military: 'f5040000-0000-0000-0000-000000000304',
    sick13th: 'f5040000-0000-0000-0000-000000000305',
  };

  const vacPeriodLostId = 'f5040000-0000-0000-0000-000000000401';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid;`, [userId]);

      const passHash = await hashPassword('Folha04@2026!');
      await client.query(
        `INSERT INTO public.users (id, email, password_hash, full_name, is_active)
         VALUES ($1, 'admin.f504@couplerh.test', $2, 'Admin F504', TRUE);`,
        [userId, passHash]
      );

      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1, 'Tenant F504', 'ACTIVE');`, [
        tenantId,
      ]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1, $2, 'system_admin', 'ALL', TRUE);`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1, $2, 'Empresa F504 SA', '81111111000181', 'LUCRO_REAL', 'ACTIVE');`,
        [companyId, tenantId]
      );
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1, $2, $3, 'Matriz F504', '81111111000181');`,
        [estId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1, $2, 'Analista Operacional', '252105');`,
        [posId, tenantId]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1, $2, $3, 'Unidade SP', 'SP', '3550308');`,
        [wpId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, email)
         VALUES
           ($1, $6, 'Joao Doenca 60d', '81100000001', '1990-01-01', 'sick@f504.test'),
           ($2, $6, 'Pedro Acidente B91', '81100000002', '1991-02-02', 'acc@f504.test'),
           ($3, $6, 'Maria Maternidade', '81100000003', '1992-03-03', 'mat@f504.test'),
           ($4, $6, 'Lucas Militar', '81100000004', '2004-04-04', 'mil@f504.test'),
           ($5, $6, 'Marcos Auxilio 13o', '81100000005', '1989-05-05', 's13@f504.test');`,
        [workers.sick, workers.accident, workers.maternity, workers.military, workers.sick13th, tenantId]
      );

      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, registration_number, admission_date, base_salary, salary_type,
           monthly_hours, weekly_hours, status, receives_advance
         ) VALUES
           ($1, $6, $7, $8, $9, $10, $11, 'F504-01', '2024-01-10', 6000.00, 'MONTHLY', 220, 44, 'ACTIVE', FALSE),
           ($2, $6, $7, $8, $9, $10, $12, 'F504-02', '2024-01-10', 4500.00, 'MONTHLY', 220, 44, 'ACTIVE', FALSE),
           ($3, $6, $7, $8, $9, $10, $13, 'F504-03', '2024-01-10', 5000.00, 'MONTHLY', 220, 44, 'ACTIVE', FALSE),
           ($4, $6, $7, $8, $9, $10, $14, 'F504-04', '2024-01-10', 3000.00, 'MONTHLY', 220, 44, 'ACTIVE', FALSE),
           ($5, $6, $7, $8, $9, $10, $15, 'F504-05', '2024-01-10', 6000.00, 'MONTHLY', 220, 44, 'ACTIVE', FALSE);`,
        [
          contracts.sick,
          contracts.accident,
          contracts.maternity,
          contracts.military,
          contracts.sick13th,
          tenantId,
          companyId,
          estId,
          posId,
          wpId,
          workers.sick,
          workers.accident,
          workers.maternity,
          workers.military,
          workers.sick13th,
        ]
      );

      await client.query(
        `INSERT INTO public.vacation_periods (
           id, tenant_id, contract_id, acquisition_start, acquisition_end, concessive_end,
           days_accrued, days_taken, days_remaining, status
         ) VALUES ($1, $2, $3, '2025-01-10', '2026-01-09', '2027-01-09', 30, 0, 30, 'OPEN');`,
        [vacPeriodLostId, tenantId, contracts.sick13th]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const tok = await tokenService.createSession({
      userId,
      tenantId,
      role: 'system_admin',
      email: 'admin.f504@couplerh.test',
      aal: 'aal2',
    });
    tokenAdmin = tok.accessToken;
  });

  afterAll(async () => {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid;`, [userId]);
      await client.query('COMMIT;');
    } catch {
      await client.query('ROLLBACK;');
    } finally {
      client.release();
    }
    await app.close();
  });

  it('1. registra afastamentos via API calculando soma 60d CID, estabilidade 12m em Acidente B91 e perda de aquisitivo (>180d - CLT art. 133 IV)', async () => {
    // 1.1 Auxílio-Doença 1: 10 dias CID M54
    const s1 = await app.inject({
      method: 'POST',
      url: '/api/v1/leaves',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.sick,
        leaveType: 'SICK_LEAVE',
        esocialReasonCode: '03',
        cid10Code: 'M54',
        startDate: '2026-11-01',
        endDate: '2026-11-10',
        status: 'ACTIVE',
      },
    });
    expect(s1.statusCode).toBe(201);
    expect(s1.json().data.company_paid_days).toBe(10);
    expect(s1.json().data.is_inss_responsible).toBe(false);

    // 1.2 Auxílio-Doença 2: 10 dias mesma CID M54 em 20/11 (dentro de 60 dias!) -> 5d empresa + 5d INSS
    const s2 = await app.inject({
      method: 'POST',
      url: '/api/v1/leaves',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.sick,
        leaveType: 'SICK_LEAVE',
        esocialReasonCode: '03',
        cid10Code: 'M54',
        startDate: '2026-11-20',
        endDate: '2026-11-29',
        status: 'ACTIVE',
      },
    });
    expect(s2.statusCode).toBe(201);
    expect(s2.json().data.is_same_cid_relapse).toBe(true);
    expect(s2.json().data.company_paid_days).toBe(5);
    expect(s2.json().data.is_inss_responsible).toBe(true);

    // 1.3 Acidente Trabalho B91 (01/10 a 30/11, retorno 01/12) -> Estabilidade 12m até 2027-12-01
    const accRes = await app.inject({
      method: 'POST',
      url: '/api/v1/leaves',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.accident,
        leaveType: 'WORK_ACCIDENT',
        esocialReasonCode: '01',
        cid10Code: 'S62',
        startDate: '2026-10-01',
        endDate: '2026-11-30',
        returnDate: '2026-12-01',
        status: 'ACTIVE',
      },
    });
    expect(accRes.statusCode).toBe(201);
    expect(accRes.json().data.stability_until.slice(0, 10)).toBe('2027-12-01');

    // 1.4 Licença-Maternidade (01/11 a 28/02/2027)
    const matRes = await app.inject({
      method: 'POST',
      url: '/api/v1/leaves',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.maternity,
        leaveType: 'MATERNITY',
        esocialReasonCode: '17',
        startDate: '2026-11-01',
        endDate: '2027-02-28',
        status: 'ACTIVE',
      },
    });
    expect(matRes.statusCode).toBe(201);

    // 1.5 Serviço Militar (01/11 a 30/11)
    const milRes = await app.inject({
      method: 'POST',
      url: '/api/v1/leaves',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.military,
        leaveType: 'MILITARY_SERVICE',
        esocialReasonCode: '19',
        startDate: '2026-11-01',
        endDate: '2026-11-30',
        status: 'ACTIVE',
      },
    });
    expect(milRes.statusCode).toBe(201);

    // 1.6 Afastamento >180d INSS no período aquisitivo (2025-03-01 a 2025-09-20) -> Perda de Férias (CLT art. 133 IV)
    const longSick = await app.inject({
      method: 'POST',
      url: '/api/v1/leaves',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.sick13th,
        leaveType: 'SICK_LEAVE',
        esocialReasonCode: '03',
        startDate: '2025-03-01',
        endDate: '2025-09-20',
        status: 'COMPLETED',
      },
    });
    expect(longSick.statusCode).toBe(201);
    expect(longSick.json().forfeitedVacationPeriods).toBe(1);

    // Também cadastra afastamento em 2026 (01/05 a 31/08) para testar reflexo no 13º
    const sick2026 = await app.inject({
      method: 'POST',
      url: '/api/v1/leaves',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.sick13th,
        leaveType: 'SICK_LEAVE',
        esocialReasonCode: '03',
        startDate: '2026-05-01',
        endDate: '2026-08-31',
        status: 'COMPLETED',
      },
    });
    expect(sick2026.statusCode).toBe(201);

    // Verifica que agendar férias no período perdido falha com erro CLT Art. 133 IV
    const schedFail = await app.inject({
      method: 'POST',
      url: '/api/v1/vacations/schedules',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.sick13th,
        vacationPeriodId: vacPeriodLostId,
        startDate: '2026-12-01',
        endDate: '2026-12-15',
        daysCount: 15,
      },
    });
    expect(schedFail.statusCode).toBe(400);
    expect(JSON.stringify(schedFail.json())).toContain('CLT Art. 133 IV');
  });

  it('2. calcula folha mensal 11/2026 aplicando 105 (15d empresa), 906 (FGTS Acidente/Militar) e 104 (Maternidade com dedução automática DCTFWeb)', async () => {
    const createMonthly = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        month: 11,
        year: 2026,
        type: 'MONTHLY',
        irrf_regime: 'COMPETENCE',
      },
    });
    expect(createMonthly.statusCode).toBe(201);
    const periodId = createMonthly.json().data.id;

    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodId },
    });
    expect(calcRes.statusCode).toBe(200);

    const dbState = await withTenantContext({ userId, tenantId, role: 'system_admin' }, async (client) => {
      const ps = await client.query(
        `SELECT ps.*, c.registration_number
         FROM public.payslips ps
         JOIN public.contracts c ON c.id = ps.contract_id
         WHERE ps.payroll_period_id = $1::uuid;`,
        [periodId]
      );
      const items = await client.query(
        `SELECT pi.payslip_id, pi.rubric_code, pi.type, pi.reference, pi.amount
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.payroll_period_id = $1::uuid;`,
        [periodId]
      );
      const tax = await client.query(
        `SELECT * FROM public.payroll_company_taxes WHERE payroll_period_id = $1::uuid;`,
        [periodId]
      );
      return { payslips: ps.rows, items: items.rows, companyTax: tax.rows[0] };
    });

    const byReg = (reg: string) => dbState.payslips.find((p: any) => p.registration_number === reg);
    const itemsOf = (psId: string) => dbState.items.filter((i: any) => i.payslip_id === psId);

    // 2.1 Auxílio-doença 15d (105) + 10d trabalhados (101) = 5000.00 (5d INSS)
    const psSick = byReg('F504-01');
    expect(Number(psSick.total_earnings)).toBe(5000);
    const sickItems = itemsOf(psSick.id);
    expect(Number(sickItems.find((i: any) => i.rubric_code === '101')?.amount)).toBe(2000);
    expect(Number(sickItems.find((i: any) => i.rubric_code === '105')?.amount)).toBe(3000);

    // 2.2 Acidente de trabalho B91: salário 0, INSS 0, MAS FGTS obrigatório 8% sobre 4500 = R$ 360,00!
    const psAcc = byReg('F504-02');
    expect(Number(psAcc.total_earnings)).toBe(0);
    expect(Number(psAcc.base_inss)).toBe(0);
    expect(Number(psAcc.base_fgts)).toBe(4500);
    expect(Number(psAcc.fgts_month)).toBe(360);
    expect(itemsOf(psAcc.id).find((i: any) => i.rubric_code === '906')?.type).toBe('NEUTRAL');

    // 2.3 Serviço Militar: salário 0, MAS FGTS obrigatório 8% sobre 3000 = R$ 240,00!
    const psMil = byReg('F504-04');
    expect(Number(psMil.total_earnings)).toBe(0);
    expect(Number(psMil.base_fgts)).toBe(3000);
    expect(Number(psMil.fgts_month)).toBe(240);

    // 2.4 Licença-Maternidade: 104 = R$ 5.000,00 + dedução automática DCTFWeb = R$ 5.000,00!
    const psMat = byReg('F504-03');
    expect(Number(psMat.total_earnings)).toBe(5000);
    expect(Number(itemsOf(psMat.id).find((i: any) => i.rubric_code === '104')?.amount)).toBe(5000);
    expect(Number(dbState.companyTax.maternity_deduction)).toBe(5000);

    // 2.5 Rota /tax-guides retorna dedução automática de Maternidade na DCTFWeb
    const guidesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodId}/tax-guides`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(guidesRes.statusCode).toBe(200);
    expect(guidesRes.json().data.maternityDeduction).toBe(5000);
    expect(guidesRes.json().data.totalDarfPrevidenciario).toBeLessThan(
      guidesRes.json().data.totalDarfPrevidenciarioBruto
    );
  });

  it('3. calcula reflexo dos afastamentos nos avos do 13º Salário (THIRTEENTH_2): Auxílio-Doença reduz avos (9/12) e Maternidade mantém 12/12', async () => {
    // Ativa contrato F504-05 para o cálculo de 13º (afastamento de 2026 já COMPLETED)
    await withTenantContext({ userId, tenantId, role: 'system_admin' }, async (client) => {
      await client.query(`UPDATE public.contracts SET status = 'ACTIVE' WHERE id = $1::uuid;`, [
        contracts.sick13th,
      ]);
    });

    const create13th = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        month: 12,
        year: 2026,
        type: 'THIRTEENTH_2',
        irrf_regime: 'COMPETENCE',
      },
    });
    expect(create13th.statusCode).toBe(201);
    const period13Id = create13th.json().data.id;

    const calc13 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: period13Id },
    });
    expect(calc13.statusCode).toBe(200);

    const rows13 = await withTenantContext({ userId, tenantId, role: 'system_admin' }, async (client) => {
      const { rows } = await client.query(
        `SELECT c.registration_number, ps.total_earnings
         FROM public.payslips ps
         JOIN public.contracts c ON c.id = ps.contract_id
         WHERE ps.payroll_period_id = $1::uuid;`,
        [period13Id]
      );
      return rows;
    });

    const slipSick13 = rows13.find((r: any) => r.registration_number === 'F504-05');
    // Salário R$ 6.000 com 3 meses integrais no INSS (Jun, Jul, Ago) -> 9/12 avos = R$ 4.500,00!
    expect(Number(slipSick13.total_earnings)).toBe(4500);
  });
});
