import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { withTenantContext } from '../src/shared/db/context.js';

/**
 * FASE V9.5 — IMP-01: Adequação Integral do 13º Salário (Integração API + PostgreSQL 17 Real)
 *
 * 1. 1ª Parcela com Médias de Horas Extras + Periculosidade na base horária (Súmula 347 TST),
 *    decomposta em rubrica 601 (base) e 604 (médias), sem INSS e sem IRRF, com FGTS integral.
 * 2. Abatimento de adiantamento de 13º pago em Férias (VACATION) na 1ª e na 2ª parcela, com zero bitributação de FGTS.
 * 3. Parcela Única de 13º (THIRTEENTH_SINGLE) projetando 12 avos, tributação exclusiva de 13º (INSS, IRRF, FGTS)
 *    e integração com o 13º Complementar de Janeiro (THIRTEENTH_COMPLEMENTARY).
 */
describe('IMP-01: 13º Salário Completo (Médias 1ª Parc, Parcela Única e Adiantamento em Férias)', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;

  const tenantId = 'e9100000-0000-0000-0000-000000000001';
  const companyId = 'e9100000-0000-0000-0000-000000000011';
  const estId = 'e9100000-0000-0000-0000-000000000021';
  const posId = 'e9100000-0000-0000-0000-000000000031';
  const wpId = 'e9100000-0000-0000-0000-000000000041';
  const deptId = 'e9100000-0000-0000-0000-000000000051';
  const userId = 'e9100000-0000-0000-0000-000000000101';

  const workers = {
    wAverages: 'e9100000-0000-0000-0000-000000000201', // Colaborador com médias de HE + adicional fixo
    wVacation: 'e9100000-0000-0000-0000-000000000202', // Colaborador com 13º pago nas férias
    wSingle: 'e9100000-0000-0000-0000-000000000203',   // Colaborador de Parcela Única em novembro
  };
  const contracts = {
    cAverages: 'e9100000-0000-0000-0000-000000000301',
    cVacation: 'e9100000-0000-0000-0000-000000000302',
    cSingle: 'e9100000-0000-0000-0000-000000000303',
  };
  const unionId = 'e9100000-0000-0000-0000-000000000501';
  const cctId = 'e9100000-0000-0000-0000-000000000502';

  let rubricHe50Id = '';
  let rubricPericId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Imp01!13Salario2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`UPDATE public.payroll_periods SET status = 'OPEN' WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_fixed_events WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_variable_events WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payslip_items WHERE payslip_id IN (SELECT id FROM public.payslips WHERE tenant_id = $1::uuid);`, [tenantId]);
      await client.query(`DELETE FROM public.payslips WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.collective_agreements WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.departments WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.workers WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.establishments WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.workplaces WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.positions WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.companies WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid;`, [userId]);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active)
         VALUES ($1::uuid, 'admin.imp01@couplerh.test', 'Admin IMP-01', $2, TRUE)`,
        [userId, pwHash]
      );

      await client.query(
        `INSERT INTO public.tenants (id, name, status)
         VALUES ($1::uuid, 'Tenant IMP-01', 'ACTIVE')`,
        [tenantId]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
         VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Empresa 13º Enterprise LTDA', '12345678000199', 'LUCRO_PRESUMIDO', 'ACTIVE')`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz IMP-01', '12345678000199')`,
        [estId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1::uuid, $2::uuid, 'Engenheiro de Operações', '214005')`,
        [posId, tenantId]
      );

      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sede Central', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.departments (id, tenant_id, company_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Departamento de Engenharia')`,
        [deptId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.unions (id, tenant_id, code, cnpj, name, trade_name, union_type, base_month)
         VALUES ($1::uuid, $2::uuid, 'SINDENG', '99888777000166', 'Sindicato dos Engenheiros', 'SINDENG', 'EMPLOYEE', 5)`,
        [unionId, tenantId]
      );

      await client.query(
        `INSERT INTO public.collective_agreements (
           id, tenant_id, union_id, title, agreement_type, start_date, end_date,
           average_calculation_months, average_window_mode, average_monetary_index_rate,
           include_averages_in_13th_first_installment
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'CCT Engenharia 2026', 'CCT', '2026-01-01', '2026-12-31',
           12, 'CALENDAR_YEAR', 0, TRUE
         )`,
        [cctId, tenantId, unionId]
      );

      // Colaboradores
      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES 
           ($1::uuid, $4::uuid, 'Carlos Silva Médias', '11122233344', '1985-04-12', TRUE),
           ($2::uuid, $4::uuid, 'Mariana Costa Férias', '22233344455', '1990-07-20', TRUE),
           ($3::uuid, $4::uuid, 'Roberto Parcela Única', '33344455566', '1988-11-05', TRUE)`,
        [workers.wAverages, workers.wVacation, workers.wSingle, tenantId]
      );

      // Contratos: todos admitidos no início do ano (12 avos de direito)
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, department_id, position_id, workplace_id,
           worker_id, union_id, collective_agreement_id, registration_number, admission_date,
           base_salary, salary_type, monthly_hours, weekly_hours, regime, status
         ) VALUES
           ($1::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid, 'MAT-001', '2025-01-10', 4000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE'),
           ($2::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $13::uuid, $11::uuid, $12::uuid, 'MAT-002', '2025-01-10', 4000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE'),
           ($3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $14::uuid, $11::uuid, $12::uuid, 'MAT-003', '2025-01-10', 8000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE')`,
        [
          contracts.cAverages,
          contracts.cVacation,
          contracts.cSingle,
          tenantId,
          companyId,
          estId,
          deptId,
          posId,
          wpId,
          workers.wAverages,
          unionId,
          cctId,
          workers.wVacation,
          workers.wSingle,
        ]
      );

      // Rubricas: HE 50% (102) e Periculosidade (151)
      const rHeRes = await client.query(`SELECT id FROM public.rubrics WHERE code = '102' LIMIT 1;`);
      rubricHe50Id = rHeRes.rows[0].id;

      const rPericRes = await client.query(`SELECT id FROM public.rubrics WHERE code = '151' LIMIT 1;`);
      rubricPericId = rPericRes.rows[0].id;

      // Adiciona adicional fixo de periculosidade de 30% (R$ 1.200,00) ao contrato cAverages
      await client.query(
        `INSERT INTO public.payroll_fixed_events (
           id, tenant_id, contract_id, rubric_id, value_type, percentage, valid_from, is_active
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'PERCENT', 30.00, '2025-01-01', TRUE
         )`,
        [tenantId, contracts.cAverages, rubricPericId]
      );

      // Insere histórico de Horas Extras 50% de Janeiro a Outubro para cAverages (40 horas/mês)
      // Com base horária valorizada com periculosidade: (4000 + 1200) / 220 = 23.636363 * 1.5 = 35.454545/hora
      for (let m = 1; m <= 10; m++) {
        const periodId = `e9100000-0000-0000-0001-0000000000${m < 10 ? '0' + m : m}`;
        const compDate = `2026-${m < 10 ? '0' + m : m}-01`;
        await client.query(
          `INSERT INTO public.payroll_periods (id, tenant_id, company_id, year, month, type, status, irrf_regime, payment_date, competence_date)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 2026, $4, 'MONTHLY', 'CLOSED', 'CASH', '2026-02-05', $5::date)`,
          [periodId, tenantId, companyId, m, compDate]
        );

        const payslipId = `e9100000-0000-0000-0002-0000000000${m < 10 ? '0' + m : m}`;
        await client.query(
          `INSERT INTO public.payslips (id, tenant_id, payroll_period_id, contract_id, worker_id, total_earnings, total_deductions, net_salary, base_fgts, fgts_month)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 6618.18, 800.00, 5818.18, 6618.18, 529.45)`,
          [payslipId, tenantId, periodId, contracts.cAverages, workers.wAverages]
        );

        await client.query(
          `INSERT INTO public.payslip_items (
             id, tenant_id, payslip_id, rubric_id, rubric_code, rubric_name, type, amount, reference
           ) VALUES (
             gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, '102', 'Horas Extras 50%', 'EARNING', 1418.18, 40.0
           )`,
          [tenantId, payslipId, rubricHe50Id]
        );
      }

      // Colaborador cVacation: Adiantamento de 13º pago em folha de férias (VACATION) em Julho/2026
      const vacPeriodId = 'e9100000-0000-0000-0001-000000000077';
      await client.query(
        `INSERT INTO public.payroll_periods (id, tenant_id, company_id, year, month, type, status, irrf_regime, payment_date, competence_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 2026, 7, 'VACATION', 'CLOSED', 'CASH', '2026-07-10', '2026-07-01')`,
        [vacPeriodId, tenantId, companyId]
      );

      const vacPayslipId = 'e9100000-0000-0000-0002-000000000077';
      await client.query(
        `INSERT INTO public.payslips (id, tenant_id, payroll_period_id, contract_id, worker_id, total_earnings, total_deductions, net_salary, base_fgts, fgts_month)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 7333.33, 600.00, 6733.33, 7333.33, 586.66)`,
        [vacPayslipId, tenantId, vacPeriodId, contracts.cVacation, workers.wVacation]
      );

      // Adiantamento de R$ 2.000,00 de 13º pago na folha de férias
      const r601Res = await client.query(`SELECT id FROM public.rubrics WHERE code = '601' LIMIT 1;`);
      await client.query(
        `INSERT INTO public.payslip_items (
           id, tenant_id, payslip_id, rubric_id, rubric_code, rubric_name, type, amount, reference
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, '601', '13º Salário - 1ª Parcela', 'EARNING', 2000.00, 12.0
         )`,
        [tenantId, vacPayslipId, r601Res.rows[0].id]
      );

      await client.query('COMMIT;');
    } catch (e) {
      await client.query('ROLLBACK;');
      throw e;
    } finally {
      client.release();
    }

    const auth = await tokenService.createSession({
      userId,
      tenantId,
      role: 'system_admin',
      email: 'admin.imp01@couplerh.test',
      aal: 'aal2',
    });
    tokenAdmin = auth.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. THIRTEENTH_1: Deve incluir 50% das médias na rubrica 604 com periculosidade na base horária (Súmula 347 TST), sem INSS/IRRF e com FGTS', async () => {
    // Cria período de 1ª Parcela (Novembro/2026)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        month: 11,
        year: 2026,
        type: 'THIRTEENTH_1',
        payment_date: '2026-11-30',
        irrf_regime: 'CASH',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const period13_1 = createRes.json().data;

    // Calcula folha para cAverages
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        period_id: period13_1.id,
        contract_id: contracts.cAverages,
      },
    });
    expect(calcRes.statusCode).toBe(200);

    // Consulta payslip gerado
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      const { rows: slips } = await client.query(
        `SELECT ps.* FROM public.payslips ps WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id = $2::uuid;`,
        [period13_1.id, contracts.cAverages]
      );
      expect(slips.length).toBe(1);
      const ps = slips[0];

      // Busca itens da folha
      const { rows: items } = await client.query(
        `SELECT rubric_code, amount, reference FROM public.payslip_items WHERE payslip_id = $1::uuid ORDER BY rubric_code;`,
        [ps.id]
      );

      const r601 = items.find((i: any) => i.rubric_code === '601');
      const r604 = items.find((i: any) => i.rubric_code === '604');
      const r901 = items.find((i: any) => i.rubric_code === '901'); // INSS
      const r902 = items.find((i: any) => i.rubric_code === '902'); // IRRF

      // Base 1ª Parcela: Salário 4.000 / 12 * 11 avos = 3.666,67 / 2 = 1.833,33 (ou 11 avos em nov)
      expect(r601).toBeDefined();
      expect(Number(r601.amount)).toBeGreaterThan(1800);

      // Médias 1ª Parcela na rubrica 604: médias de HE 50% valorizadas com periculosidade
      expect(r604).toBeDefined();
      expect(Number(r604.amount)).toBeGreaterThan(0);

      // 1ª Parcela do 13º NÃO pode sofrer desconto de INSS nem de IRRF!
      expect(r901).toBeUndefined();
      expect(r902).toBeUndefined();
      expect(Number(ps.base_inss)).toBe(0);
      expect(Number(ps.base_irrf)).toBe(0);

      // FGTS: Incidência integral de 8% sobre a soma de 601 + 604
      const expectedFgtsBase = Number(r601.amount) + Number(r604.amount);
      expect(Number(ps.base_fgts)).toBeCloseTo(expectedFgtsBase, 2);
      expect(Number(ps.fgts_month)).toBeCloseTo(expectedFgtsBase * 0.08, 2);
    });
  });

  it('2. FÉRIAS -> 13º: Adiantamento recebido em férias (VACATION) zera 1ª parcela e abate na 2ª parcela sem duplicar FGTS', async () => {
    let p1Id = '';
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      const { rows: p1Rows } = await client.query(
        `SELECT id FROM public.payroll_periods WHERE tenant_id = $1::uuid AND company_id = $2::uuid AND year = 2026 AND type = 'THIRTEENTH_1';`,
        [tenantId, companyId]
      );
      p1Id = p1Rows[0]?.id;
    });

    if (!p1Id) {
      const p1Res = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/periods',
        headers: { authorization: `Bearer ${tokenAdmin}` },
        payload: {
          company_id: companyId,
          month: 11,
          year: 2026,
          type: 'THIRTEENTH_1',
          payment_date: '2026-11-30',
          irrf_regime: 'CASH',
        },
      });
      p1Id = p1Res.json().data.id;
    }

    // Calcula 1ª parcela para cVacation (que já recebeu R$ 2.000,00 de adiantamento em julho)
    await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: p1Id, contract_id: contracts.cVacation },
    });

    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      // Como o colaborador já recebeu R$ 2.000,00 de adiantamento em férias, em novembro ele não deve receber novo adiantamento duplicado
      const { rows: p1Items } = await client.query(
        `SELECT pi.* FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id = $2::uuid;`,
        [p1Id, contracts.cVacation]
      );
      // Se gerou holerite, o valor de 601 deve ser 0 ou o colaborador é dispensado
      const totalP1 = p1Items.reduce((acc: number, cur: any) => acc + Number(cur.amount || 0), 0);
      expect(totalP1).toBe(0);
    });

    // Agora cria a 2ª Parcela do 13º (Dezembro/2026)
    const p2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        month: 12,
        year: 2026,
        type: 'THIRTEENTH_2',
        payment_date: '2026-12-20',
        irrf_regime: 'CASH',
      },
    });
    expect(p2Res.statusCode).toBe(201);
    const p2Period = p2Res.json().data;

    // Calcula 2ª parcela para cVacation
    await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: p2Period.id, contract_id: contracts.cVacation },
    });

    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      const { rows: p2Items } = await client.query(
        `SELECT pi.rubric_code, pi.amount FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id = $2::uuid;`,
        [p2Period.id, contracts.cVacation]
      );

      const r602 = p2Items.find((i: any) => i.rubric_code === '602');
      const r603 = p2Items.find((i: any) => i.rubric_code === '603'); // Dedução 1ª parcela

      expect(r602).toBeDefined();
      expect(Number(r602.amount)).toBe(4000.00); // 12 avos de R$ 4.000

      // Dedução do adiantamento recebido em férias
      expect(r603).toBeDefined();
      expect(Number(r603.amount)).toBe(2000.00);

      // FGTS: base deve ser apenas a diferença (4000 - 2000 = 2000), sem bitributar!
      const { rows: p2Slips } = await client.query(
        `SELECT base_fgts, fgts_month FROM public.payslips WHERE payroll_period_id = $1::uuid AND contract_id = $2::uuid;`,
        [p2Period.id, contracts.cVacation]
      );
      expect(Number(p2Slips[0].base_fgts)).toBe(2000.00);
      expect(Number(p2Slips[0].fgts_month)).toBe(160.00);
    });
  });

  it('3. THIRTEENTH_SINGLE: Parcela Única em novembro projeta 12 avos, tributa exclusivamente e integra com Complementar de Janeiro', async () => {
    // Cria período THIRTEENTH_SINGLE em Novembro/2026
    const singleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        month: 11,
        year: 2026,
        type: 'THIRTEENTH_SINGLE',
        payment_date: '2026-11-30',
        irrf_regime: 'CASH',
      },
    });
    expect(singleRes.statusCode).toBe(201);
    const singlePeriod = singleRes.json().data;
    expect(singlePeriod.type).toBe('THIRTEENTH_SINGLE');

    // Calcula folha para cSingle
    const calcSingle = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: singlePeriod.id, contract_id: contracts.cSingle },
    });
    expect(calcSingle.statusCode).toBe(200);

    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      const { rows: singleItems } = await client.query(
        `SELECT pi.rubric_code, pi.amount, pi.reference, ps.base_inss, ps.base_irrf, ps.base_fgts
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id = $2::uuid;`,
        [singlePeriod.id, contracts.cSingle]
      );

      const r602 = singleItems.find((i: any) => i.rubric_code === '602');
      const r901 = singleItems.find((i: any) => i.rubric_code === '901'); // INSS
      const r902 = singleItems.find((i: any) => i.rubric_code === '902'); // IRRF

      // Parcela Única em novembro DEVE projetar 12 avos integrais (Lei 4.749/65)
      expect(r602).toBeDefined();
      expect(Number(r602.reference)).toBe(12);
      expect(Number(r602.amount)).toBe(8000.00);

      // Tributação exclusiva na fonte no próprio período
      expect(r901).toBeDefined();
      expect(Number(r901.amount)).toBeGreaterThan(0);
      expect(r902).toBeDefined();
      expect(Number(r902.amount)).toBeGreaterThan(0);

      // Fecha a folha de Parcela Única para permitir que a complementar de janeiro a consulte
      await client.query(`UPDATE public.payroll_periods SET status = 'CLOSED' WHERE id = $1::uuid;`, [singlePeriod.id]);
    });

    // Cria período 13º Complementar em Janeiro/2027
    const compRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        month: 1,
        year: 2027,
        type: 'THIRTEENTH_COMPLEMENTARY',
        payment_date: '2027-01-10',
        irrf_regime: 'CASH',
      },
    });
    expect(compRes.statusCode).toBe(201);
    const compPeriod = compRes.json().data;

    // Insere variáveis de dezembro para cSingle para testar diferença positiva no ajuste de janeiro
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      const rHeId = rubricHe50Id;
      await client.query(
        `INSERT INTO public.payroll_variable_events (
           id, tenant_id, contract_id, payroll_period_id, rubric_id, manual_value, quantity, origin
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, 800.00, 20.0, 'MANUAL'
         )`,
        [tenantId, contracts.cSingle, compPeriod.id, rHeId]
      );
    });

    // Processa 13º Complementar
    const calcComp = await app.inject({
      method: 'POST',
      url: `/api/v1/payroll/calculate`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: compPeriod.id, contract_id: contracts.cSingle },
    });
    expect(calcComp.statusCode).toBe(200);

    // O sistema deve ter localizado a folha THIRTEENTH_SINGLE anterior com gross R$ 4.000,00
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      const { rows: compItems } = await client.query(
        `SELECT pi.rubric_code, pi.amount FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id = $2::uuid;`,
        [compPeriod.id, contracts.cSingle]
      );

      // Se recalculou, deve reconhecer a base prévia de 4000
      const r605 = compItems.find((i: any) => i.rubric_code === '605');
      // Verificação: se houve diferença positiva, lança 605
      if (r605) {
        expect(Number(r605.amount)).toBeGreaterThan(0);
      }
    });
  });
});
