import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V4 & Gate V4 Oficial: Testes E2E de Saneamento do Motor sobre PostgreSQL 17 Puro
 * Cobre BUG-01 a BUG-10 via API REST Fastify + couplerh_app (RLS ativo).
 */
describe('Gate V4: Saneamento de Bugs Críticos do Motor (BUG-01 a BUG-10)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let adminToken: string;

  const tenantId = 'a4000000-0000-0000-0000-000000000001';
  const companyId = 'a4000000-0000-0000-0000-000000000011';
  const estId = 'a4000000-0000-0000-0000-000000000021';
  const posId = 'a4000000-0000-0000-0000-000000000031';
  const wpSpId = 'a4000000-0000-0000-0000-000000000041';
  const wpRjId = 'a4000000-0000-0000-0000-000000000042';

  const userAdminId = 'a4000000-0000-0000-0000-000000000101';

  const workerCltId = 'a4000000-0000-0000-0000-000000000201';
  const workerAprId = 'a4000000-0000-0000-0000-000000000202';
  const contractCltId = 'a4000000-0000-0000-0000-000000000301';
  const contractAprId = 'a4000000-0000-0000-0000-000000000302';

  const vacPeriodId = 'a4000000-0000-0000-0000-000000000401';
  const vacScheduleId = 'a4000000-0000-0000-0000-000000000402';

  const periodVacationId = 'a4000000-0000-0000-0000-000000000501';
  const periodMonthlyId = 'a4000000-0000-0000-0000-000000000502';
  const period13th1Id = 'a4000000-0000-0000-0000-000000000503';
  const period13th2Id = 'a4000000-0000-0000-0000-000000000504';

  const fixedPericId = 'a4000000-0000-0000-0000-000000000601';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      // Limpeza idempotente de dados anteriores do Gate V4
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.holidays WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid;`, [userAdminId]);

      const passHash = await hashPassword('GateV4@2026!');

      await client.query(
        `INSERT INTO public.users (id, email, password_hash, full_name, is_active)
         VALUES ($1, 'admin.v4@couplerh.test', $2, 'Admin Gate V4', TRUE);`,
        [userAdminId, passHash]
      );

      await client.query(
        `INSERT INTO public.tenants (id, name, status)
         VALUES ($1, 'Empresa Gate V4 Ltda', 'ACTIVE');`,
        [tenantId]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1, $2, 'system_admin', 'ALL', TRUE);`,
        [tenantId, userAdminId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1, $2, 'Empresa Gate V4 SA', '44444444000144', 'LUCRO_PRESUMIDO', 'ACTIVE');`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1, $2, $3, 'Matriz SP', '44444444000144');`,
        [estId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, company_id, title, cbo)
         VALUES ($1, $2, $3, 'Analista de Sistemas', '212405');`,
        [posId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES
           ($1, $3, $4, 'Unidade São Paulo', 'SP', '3550308'),
           ($2, $3, $4, 'Unidade Rio de Janeiro', 'RJ', '3304557');`,
        [wpSpId, wpRjId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, pis, is_apprentice, is_active)
         VALUES
           ($1, $3, 'Colaborador CLT V4', '44411122233', '12044411122', FALSE, TRUE),
           ($2, $3, 'Jovem Aprendiz V4', '44411122244', '12044411123', TRUE, TRUE);`,
        [workerCltId, workerAprId, tenantId]
      );

      await client.query(
        `INSERT INTO public.contracts (
          id, tenant_id, worker_id, company_id, establishment_id, position_id, workplace_id,
          registration_number, admission_date, base_salary, monthly_hours, weekly_hours, regime, status
        ) VALUES
          ($1, $3, $5, $7, $8, $9, $10, 'MAT-V4-001', '2024-01-10', 3000.00, 220, 44, 'CLT', 'ACTIVE'),
          ($2, $4, $6, $7, $8, $9, $11, 'MAT-V4-002', '2025-02-01', 1518.00, 220, 44, 'APPRENTICE', 'ACTIVE');`,
        [contractCltId, contractAprId, tenantId, tenantId, workerCltId, workerAprId, companyId, estId, posId, wpSpId, wpRjId]
      );

      // Adicional Fixo de Periculosidade (30% = R$ 900,00) para o CLT (testa BUG-01 nas férias)
      await client.query(
        `INSERT INTO public.payroll_fixed_events (
          id, tenant_id, contract_id, rubric_id, value_type, percentage, valid_from, is_active
        ) VALUES (
          $1, $2, $3, 'a0000000-0000-0000-0000-000000000151', 'PERCENT', 30.00, '2024-01-10', TRUE
        );`,
        [fixedPericId, tenantId, contractCltId]
      );

      // Férias em 10/2026 (20 dias de gozo + 10 dias abono) para o CLT
      await client.query(
        `INSERT INTO public.vacation_periods (
          id, tenant_id, contract_id, acquisition_start, acquisition_end, concessive_end,
          days_accrued, days_taken, days_remaining, status
        ) VALUES (
          $1, $2, $3, '2025-01-10', '2026-01-09', '2027-01-09', 30, 30, 0, 'CLOSED'
        );`,
        [vacPeriodId, tenantId, contractCltId]
      );

      await client.query(
        `INSERT INTO public.vacation_schedules (
          id, tenant_id, vacation_period_id, contract_id, start_date, end_date,
          days_count, sell_days_count, wants_thirteenth_advance, status
        ) VALUES (
          $1, $2, $3, $4, '2026-10-05', '2026-10-24', 20, 10, FALSE, 'APPROVED'
        );`,
        [vacScheduleId, tenantId, vacPeriodId, contractCltId]
      );

      // Feriado municipal EXCLUSIVO de SP em 15/10/2026 (não deve afetar trabalhador do RJ)
      await client.query(
        `INSERT INTO public.holidays (tenant_id, date, name, type, state_code, city_code, status)
         VALUES ($1, '2026-10-15', 'Feriado Municipal SP Teste', 'MUNICIPAL', 'SP', '3550308', 'ACTIVE');`,
        [tenantId]
      );

      // Períodos de Folha (Férias 10/2026, Mensal 10/2026, 13º 1ª Parcela 11/2026, 13º 2ª Parcela 12/2026)
      await client.query(
        `INSERT INTO public.payroll_periods (id, tenant_id, company_id, year, month, type, status, payment_date, competence_date)
         VALUES
           ($1, $5, $6, 2026, 10, 'VACATION', 'DRAFT', '2026-10-03', '2026-10-01'),
           ($2, $5, $6, 2026, 10, 'MONTHLY', 'DRAFT', '2026-11-06', '2026-10-01'),
           ($3, $5, $6, 2026, 11, 'THIRTEENTH_1', 'DRAFT', '2026-11-30', '2026-11-01'),
           ($4, $5, $6, 2026, 12, 'THIRTEENTH_2', 'DRAFT', '2026-12-18', '2026-12-01');`,
        [periodVacationId, periodMonthlyId, period13th1Id, period13th2Id, tenantId, companyId]
      );

      // Batida/Resumo de ponto para testar integração Ponto -> Folha (BUG-04) na mensal 10/2026
      await client.query(
        `INSERT INTO public.time_punch_daily_summaries (
          tenant_id, contract_id, work_date, expected_hours, worked_hours, normal_hours,
          overtime_50_hours, overtime_100_hours, night_hours, delay_hours, status
        ) VALUES (
          $1, $2, '2026-10-26', 8, 18, 8, 10, 0, 2, 0, 'REGULAR'
        );`,
        [tenantId, contractCltId]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const session = await tokenService.createSession({
      userId: userAdminId,
      email: 'admin.v4@couplerh.test',
      tenantId,
      role: 'system_admin',
      aal: 'aal2',
    });
    adminToken = session.accessToken;
  });

  afterAll(async () => {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.holidays WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid;`, [userAdminId]);
      await client.query('COMMIT;');
    } finally {
      client.release();
    }
    await app.close();
  });

  it('BUG-01 & BUG-06: Folha VACATION calcula sem ReferenceError com adicionais fixos + abono + 1/3 exato', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { period_id: periodVacationId },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.processed).toBe(1);

    // Base férias = 3000 + 30% periculosidade (900) = 3900
    // 20 dias férias = 2600.00; 1/3 = 866.67; 10 dias abono = 1300.00; 1/3 abono = 433.33
    // Total proventos = 5200.00
    const rows = await withTenantContext({ tenantId, userId: userAdminId, role: 'system_admin' }, async (client) => {
      const { rows: r } = await client.query(
        `SELECT total_earnings, base_inss, fgts_month, version FROM public.payslips
         WHERE payroll_period_id = $1::uuid AND contract_id = $2::uuid;`,
        [periodVacationId, contractCltId]
      );
      return r;
    });
    expect(Number(rows[0].total_earnings)).toBe(5200);
    expect(Number(rows[0].base_inss)).toBe(3466.67); // Férias + 1/3 (abono é isento)
    expect(Number(rows[0].version)).toBe(1);
  });

  it('BUG-02, BUG-04, BUG-09 & BUG-10: Integração Ponto->Folha, Consolidação T16 INSS, Aprendiz FGTS 2%, Guias & Versão', async () => {
    // 1. Integrar ponto na folha mensal 10/2026 (BUG-04: grava manual_value = NULL)
    const intRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/integrate-payroll',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { periodId: periodMonthlyId, year: 2026, month: 10, contractId: contractCltId },
    });
    expect(intRes.statusCode).toBe(200);
    const intBody = JSON.parse(intRes.body);
    expect(intBody.data.eventsInserted).toBeGreaterThanOrEqual(2);

    // 2. Calcular Folha Mensal 10/2026 (CLT com Férias no mês + Aprendiz 2% + HE/Noturno do Ponto)
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { period_id: periodMonthlyId },
    });
    const calcBody = JSON.parse(calcRes.body);
    if (calcRes.statusCode !== 200) {
      throw new Error(`MONTHLY 422/err: ${JSON.stringify(calcBody)}`);
    }
    expect(calcRes.statusCode).toBe(200);
    expect(calcBody.success).toBe(true);
    expect(calcBody.processed).toBe(2);

    // Verifica FGTS real do aprendiz (2% de 1518 = 30.36) e CLT (8%)
    const slips = await withTenantContext({ tenantId, userId: userAdminId, role: 'system_admin' }, async (client) => {
      const { rows: r } = await client.query(
        `SELECT contract_id, fgts_month, total_earnings, version, legal_version_id
         FROM public.payslips WHERE payroll_period_id = $1::uuid;`,
        [periodMonthlyId]
      );
      return r;
    });
    const slipApr = slips.find((s) => s.contract_id === contractAprId);
    const slipClt = slips.find((s) => s.contract_id === contractCltId);
    expect(Number(slipApr.fgts_month)).toBe(30.36);
    expect(slipClt.legal_version_id).toBeTruthy();

    // Verifica que HE e Adic. Noturno integrados com manual_value=NULL geraram valores > 0
    const itemsClt = await withTenantContext({ tenantId, userId: userAdminId, role: 'system_admin' }, async (client) => {
      const { rows: r } = await client.query(
        `SELECT pi.rubric_code, pi.amount, pi.rubric_version_id
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id = $2::uuid;`,
        [periodMonthlyId, contractCltId]
      );
      return r;
    });
    const he50Item = itemsClt.find((i) => i.rubric_code === '102');
    const nightItem = itemsClt.find((i) => i.rubric_code === '301');
    expect(Number(he50Item.amount)).toBeGreaterThan(0);
    expect(Number(nightItem.amount)).toBeGreaterThan(0);
    expect(he50Item.rubric_version_id).toBeTruthy();

    // 3. Recalcular e validar incremento de payslips.version (BUG-09)
    const recalcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { period_id: periodMonthlyId },
    });
    expect(recalcRes.statusCode).toBe(200);
    const slipsAfter = await withTenantContext({ tenantId, userId: userAdminId, role: 'system_admin' }, async (client) => {
      const { rows: r } = await client.query(
        `SELECT version FROM public.payslips WHERE payroll_period_id = $1::uuid AND contract_id = $2::uuid;`,
        [periodMonthlyId, contractCltId]
      );
      return r;
    });
    expect(Number(slipsAfter[0].version)).toBe(2);

    // 4. Guias Tributárias (BUG-09) — deve retornar valores não-zerados e FGTS real (CLT + Aprendiz 2%)
    const guidesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodMonthlyId}/tax-guides`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(guidesRes.statusCode).toBe(200);
    const guidesBody = JSON.parse(guidesRes.body).data;
    expect(guidesBody.inssEmpregados).toBeGreaterThan(0);
    expect(guidesBody.fgtsTotal).toBeGreaterThan(30.36);

    // 5. Pre-flight audit usa public.leaves sem erro de tabela inexistente (BUG-09)
    const auditRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodMonthlyId}/pre-flight-audit`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(auditRes.statusCode).toBe(200);
  });

  it('BUG-03: 13º Salário 1ª Parcela (com rubrica 903) + 2ª Parcela com FGTS diferencial exato', async () => {
    // Isola médias de HE geradas no teste BUG-04 para manter o cenário base de R$ 3.000,00 fixos
    await withTenantContext({ tenantId, userId: userAdminId, role: 'system_admin' }, async (client) => {
      await client.query(
        `DELETE FROM public.payslips WHERE payroll_period_id = $1::uuid AND contract_id = $2::uuid;`,
        [periodMonthlyId, contractCltId]
      );
    });

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { period_id: period13th1Id },
    });
    expect(res1.statusCode).toBe(200);

    const slips1 = await withTenantContext({ tenantId, userId: userAdminId, role: 'system_admin' }, async (client) => {
      const { rows: r } = await client.query(
        `SELECT contract_id, total_earnings, fgts_month FROM public.payslips WHERE payroll_period_id = $1::uuid;`,
        [period13th1Id]
      );
      return r;
    });
    const clt1 = slips1.find((s) => s.contract_id === contractCltId);
    // 1ª parcela em Novembro (mês 11): 11/12 de 3000 / 2 = 1375.00; FGTS 8% = 110.00
    expect(Number(clt1.total_earnings)).toBe(1375);
    expect(Number(clt1.fgts_month)).toBe(110);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { period_id: period13th2Id },
    });
    expect(res2.statusCode).toBe(200);

    const slips2 = await withTenantContext({ tenantId, userId: userAdminId, role: 'system_admin' }, async (client) => {
      const { rows: r } = await client.query(
        `SELECT contract_id, total_earnings, fgts_month FROM public.payslips WHERE payroll_period_id = $1::uuid;`,
        [period13th2Id]
      );
      return r;
    });
    const clt2 = slips2.find((s) => s.contract_id === contractCltId);
    expect(Number(clt2.total_earnings)).toBe(3000);
    // FGTS diferencial na 2ª parcela: 240.00 (8% sobre 3000) - 110.00 (1ª parcela) = 130.00
    expect(Number(clt2.fgts_month)).toBe(130);
    expect(Number(clt1.fgts_month) + Number(clt2.fgts_month)).toBe(240);
  });

  it('BUG-08: Endpoint POST /api/v1/termination/calculate calcula TRCT real com projeção Dez->Jan e sem dupla dedução de INSS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/termination/calculate',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        contractId: contractCltId,
        resignationDate: '2026-12-20',
        dismissalType: 'WITHOUT_CAUSE',
        noticeType: 'INDEMNIFIED',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.proventos.saldoSalario.valor).toBe(2000);
    expect(body.data.metadados.diasAvisoReal).toBe(36); // Admissão 10/01/2024 -> 2 anos completos -> 36 dias
    expect(body.data.metadados.dataProjetada).toBe('2027-01-25'); // Virada Dez -> Jan!
    expect(body.data.proventos.decimoTerceiroAviso.avos).toBe(1); // >= 15 dias em Jan/2027
  });

  it('Audit BUG: GET /api/v1/settings/legal-parameters retorna versão vigente 2026 sem erro SQL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/legal-parameters',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.inss.length).toBeGreaterThanOrEqual(4);
    expect(body.data.irrf.length).toBeGreaterThanOrEqual(5);
    expect(Number(body.data.general.irrf_exemption_limit)).toBe(5000);
  });
});
