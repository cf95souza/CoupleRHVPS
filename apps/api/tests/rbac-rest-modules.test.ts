import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

describe('RBAC-05: Módulos REST Validados com Zod e Alinhamento do Frontend apiClient', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;

  const tenantId = 'e1000000-0000-0000-0000-000000000001';
  const companyId = 'e1000000-0000-0000-0000-000000000002';
  const establishmentId = 'e1000000-0000-0000-0000-000000000003';
  const departmentId = 'e1000000-0000-0000-0000-000000000004';
  const positionId = 'e1000000-0000-0000-0000-000000000005';

  const adminUserId = 'e1000000-0000-0000-0000-000000000010';
  const employeeUserId = 'e1000000-0000-0000-0000-000000000020';
  const unlinkedUserId = 'e1000000-0000-0000-0000-000000000030';

  const workerId = 'e1000000-0000-0000-0000-000000000040';
  const contractId = 'e1000000-0000-0000-0000-000000000041';
  const vacationPeriodId = 'e1000000-0000-0000-0000-000000000050';

  let tokenAdmin: string;
  let tokenEmployee: string;
  let tokenUnlinked: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      // 1. Tenant
      await client.query(
        `INSERT INTO public.tenants (id, name, status, settings)
         VALUES ($1, 'Rest Modules Corp', 'ACTIVE', '{"sessionTimeoutMinutes": 60}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';`,
        [tenantId]
      );

      // 2. Estrutura Organizacional
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj)
         VALUES ($1, $2, 'Rest Modules S.A.', 'Rest Modules', '99.999.999/0001-99')
         ON CONFLICT (id) DO NOTHING;`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1, $2, $3, 'Matriz Rest', '99.999.999/0001-99')
         ON CONFLICT (id) DO NOTHING;`,
        [establishmentId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.departments (id, tenant_id, company_id, code, name)
         VALUES ($1, $2, $3, 'ENG', 'Engenharia de Software')
         ON CONFLICT (id) DO NOTHING;`,
        [departmentId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, company_id, title, cbo)
         VALUES ($1, $2, $3, 'Engenheiro Full Stack', '2124-05')
         ON CONFLICT (id) DO NOTHING;`,
        [positionId, tenantId, companyId]
      );

      // 3. Usuários
      const passwordHash = await hashPassword('SenhaForte123!');

      await client.query(
        `INSERT INTO public.users (id, full_name, email, password_hash, is_active)
         VALUES
           ($1, 'Admin Rest', 'admin.rest@test.com', $4, TRUE),
           ($2, 'Employee Rest', 'employee.rest@test.com', $4, TRUE),
           ($3, 'Unlinked Rest', 'unlinked.rest@test.com', $4, TRUE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE;`,
        [adminUserId, employeeUserId, unlinkedUserId, passwordHash]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES
           ($1, $2, 'tenant_admin', 'ALL', TRUE),
           ($1, $3, 'employee', 'SELF_ONLY', TRUE),
           ($1, $4, 'employee', 'SELF_ONLY', TRUE)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE;`,
        [tenantId, adminUserId, employeeUserId, unlinkedUserId]
      );

      // 4. Trabalhador e Contrato
      await client.query(
        `INSERT INTO public.workers (
          id, tenant_id, user_id, full_name, cpf, rg, pis, birth_date, gender, email, is_active
        ) VALUES (
          $1, $2, $3, 'Employee Rest Trabalhador', '81122233344', '12345678', '82345678901', '1995-02-10', 'M', 'employee.rest@test.com', TRUE
        ) ON CONFLICT (tenant_id, cpf) DO UPDATE SET full_name = EXCLUDED.full_name;`,
        [workerId, tenantId, employeeUserId]
      );

      await client.query(
        `INSERT INTO public.contracts (
          id, tenant_id, worker_id, company_id, establishment_id, department_id,
          position_id, registration_number, admission_date, base_salary, status
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, 'MAT-REST-01', '2022-01-01', 6500.00, 'ACTIVE'
        ) ON CONFLICT (tenant_id, company_id, registration_number) DO UPDATE SET base_salary = EXCLUDED.base_salary;`,
        [contractId, tenantId, workerId, companyId, establishmentId, departmentId, positionId]
      );

      // 5. Período Aquisitivo de Férias (limpa agendamentos de execuções anteriores para idempotência)
      await client.query(`DELETE FROM public.vacation_schedules WHERE vacation_period_id = $1;`, [
        vacationPeriodId,
      ]);
      await client.query(
        `INSERT INTO public.vacation_periods (
          id, tenant_id, contract_id, acquisition_start, acquisition_end, concessive_end,
          days_accrued, days_taken, days_remaining, status
        ) VALUES (
          $1, $2, $3, '2023-01-01', '2023-12-31', '2024-12-31',
          30, 0, 30, 'OPEN'
        ) ON CONFLICT (id) DO UPDATE SET days_accrued = 30, days_remaining = 30, days_taken = 0, absences_count = 0, status = 'OPEN', lost_by_leave = FALSE;`,
        [vacationPeriodId, tenantId, contractId]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    // Emissão de Tokens
    const sAdmin = await tokenService.createSession({
      userId: adminUserId,
      email: 'admin.rest@test.com',
      tenantId,
      role: 'tenant_admin',
    });
    tokenAdmin = sAdmin.accessToken;

    const sEmployee = await tokenService.createSession({
      userId: employeeUserId,
      email: 'employee.rest@test.com',
      tenantId,
      role: 'employee',
      workerId,
    });
    tokenEmployee = sEmployee.accessToken;

    const sUnlinked = await tokenService.createSession({
      userId: unlinkedUserId,
      email: 'unlinked.rest@test.com',
      tenantId,
      role: 'employee',
    });
    tokenUnlinked = sUnlinked.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  // ===========================================================================
  // 1. MÓDULO ORGANIZACIONAL (/api/v1/org)
  // ===========================================================================
  it('1. GET /api/v1/org/companies - deve listar empresas ativas', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/org/companies',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((c: any) => c.id === companyId)).toBe(true);
  });

  it('2. POST /api/v1/org/departments - deve criar departamento com Zod e permissão manage_org_structure', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/org/departments',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        companyId,
        name: 'Recursos Humanos e DP',
        code: 'RH-DP',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Recursos Humanos e DP');
  });

  it('3. POST /api/v1/org/departments - deve bloquear colaborador comum sem permissão', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/org/departments',
      headers: { authorization: `Bearer ${tokenEmployee}` },
      payload: {
        companyId,
        name: 'Departamento Inválido',
      },
    });

    expect(res.statusCode).toBe(403);
  });

  // ===========================================================================
  // 2. MÓDULO DE FÉRIAS CLT (/api/v1/vacations)
  // ===========================================================================
  it('4. POST /api/v1/vacations/schedules - deve rejeitar período menor que 5 dias (CLT Art. 134)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vacations/schedules',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId,
        vacationPeriodId,
        startDate: '2026-07-01',
        endDate: '2026-07-04',
        daysCount: 4, // Menor que 5 dias
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
  });

  it('5. POST /api/v1/vacations/schedules - deve rejeitar abono pecuniário superior a 10 dias (CLT Art. 143)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vacations/schedules',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId,
        vacationPeriodId,
        startDate: '2026-07-01',
        endDate: '2026-07-15',
        daysCount: 15,
        sellDaysCount: 15, // Mais que 1/3 (10 dias)
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
  });

  it('6. POST /api/v1/vacations/schedules - deve aprovar programação válida de 15 dias e decrementar saldo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vacations/schedules',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId,
        vacationPeriodId,
        startDate: '2026-07-01',
        endDate: '2026-07-15',
        daysCount: 15,
        sellDaysCount: 5,
        wantsThirteenthAdvance: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.days_count).toBe(15);
    expect(body.data.sell_days_count).toBe(5);
    expect(body.data.status).toBe('REQUESTED');

    // Verifica se decrementou o saldo em vacation_periods
    const pRes = await app.inject({
      method: 'GET',
      url: `/api/v1/vacations/periods?contractId=${contractId}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });
    expect(pRes.statusCode).toBe(200);
    const pBody = pRes.json();
    const period = pBody.data.find((p: any) => p.id === vacationPeriodId);
    expect(period.days_taken).toBe(20); // 15 + 5
    expect(period.days_remaining).toBe(10);
  });

  // ===========================================================================
  // 3. PORTAL DO COLABORADOR (/api/v1/portal)
  // ===========================================================================
  it('7. GET /api/v1/portal/me - deve retornar dados do próprio trabalhador e contrato', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/me',
      headers: { authorization: `Bearer ${tokenEmployee}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.worker.id).toBe(workerId);
    expect(body.data.contract.id).toBe(contractId);
    expect(body.data.contract.position_title).toBe('Engenheiro Full Stack');
  });

  it('8. GET /api/v1/portal/me - deve retornar 404 WORKER_NOT_LINKED se usuário não possuir trabalhador', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/me',
      headers: { authorization: `Bearer ${tokenUnlinked}` },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe('WORKER_NOT_LINKED');
  });

  // ===========================================================================
  // 4. DATA & RPC COMPATIBILITY BRIDGE (/api/v1/data e /api/v1/rpc)
  // ===========================================================================
  it('9. GET /api/v1/data/departments - deve permitir que frontend apiClient.from("departments") consulte com RLS', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/data/departments?select=id,name,code',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((d: any) => d.id === departmentId)).toBe(true);
  });

  it('10. GET /api/v1/data/users - deve bloquear acesso a tabelas fora da whitelist por segurança', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/data/users',
      headers: { authorization: `Bearer ${tokenEmployee}` },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('TABLE_ACCESS_DENIED');
  });
});
