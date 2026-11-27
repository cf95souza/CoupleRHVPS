import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { runPayrollWatchdog } from '../src/modules/payroll/payrollJobService.js';

/**
 * FASE V5 — FOLHA-01: Worker Assíncrono em Lotes (chunks de 50), Simulação What-If,
 * Watchdog Anti-Deadlock, Isolamento RLS e Benchmark de 1.000 Contratos (< 5s).
 */
describe('FOLHA-01: Worker em Lotes, Simulação What-If & Watchdog', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let tokenTenantA: string;
  let tokenTenantB: string;

  const tenantAId = 'f5010000-0000-0000-0000-000000000001';
  const tenantBId = 'f5010000-0000-0000-0000-000000000002';

  const companyAId = 'f5010000-0000-0000-0000-000000000011';
  const companyBId = 'f5010000-0000-0000-0000-000000000012';
  const estAId = 'f5010000-0000-0000-0000-000000000021';
  const posAId = 'f5010000-0000-0000-0000-000000000031';
  const wpAId = 'f5010000-0000-0000-0000-000000000041';

  const deptTiId = 'f5010000-0000-0000-0000-000000000051';
  const deptRhId = 'f5010000-0000-0000-0000-000000000052';

  const userAdminAId = 'f5010000-0000-0000-0000-000000000101';
  const userAdminBId = 'f5010000-0000-0000-0000-000000000102';

  const periodBatchId = 'f5010000-0000-0000-0000-000000000501';
  const periodClosedId = 'f5010000-0000-0000-0000-000000000502';
  const periodWatchdogId = 'f5010000-0000-0000-0000-000000000503';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      // Limpeza idempotente de Tenant B e Tenant A sob seus respectivos contextos RLS
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantBId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantBId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(
        `DELETE FROM public.system_operational_alerts WHERE metadata->>'tenant_id' = $1;`,
        [tenantAId]
      );
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.users WHERE id IN ($1::uuid, $2::uuid);`, [
        userAdminAId,
        userAdminBId,
      ]);

      const passHash = await hashPassword('Folha01@2026!');

      await client.query(
        `INSERT INTO public.users (id, email, password_hash, full_name, is_active)
         VALUES
           ($1, 'admin.a.f501@couplerh.test', $3, 'Admin Tenant A', TRUE),
           ($2, 'admin.b.f501@couplerh.test', $3, 'Admin Tenant B', TRUE);`,
        [userAdminAId, userAdminBId, passHash]
      );

      // Tenant B
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(
        `INSERT INTO public.tenants (id, name, status) VALUES ($1, 'Tenant Beta F501', 'ACTIVE');`,
        [tenantBId]
      );
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1, $2, 'system_admin', 'ALL', TRUE);`,
        [tenantBId, userAdminBId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1, $2, 'Beta Serviços Ltda', '52222222000152', 'SIMPLES_NACIONAL', 'ACTIVE');`,
        [companyBId, tenantBId]
      );

      // Tenant A
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(
        `INSERT INTO public.tenants (id, name, status) VALUES ($1, 'Tenant Alpha F501', 'ACTIVE');`,
        [tenantAId]
      );
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1, $2, 'system_admin', 'ALL', TRUE);`,
        [tenantAId, userAdminAId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1, $2, 'Alpha Tecnologia SA', '51111111000151', 'LUCRO_PRESUMIDO', 'ACTIVE');`,
        [companyAId, tenantAId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1, $2, $3, 'Matriz SP', '51111111000151');`,
        [estAId, tenantAId, companyAId]
      );

      await client.query(
        `INSERT INTO public.departments (id, tenant_id, company_id, name, code)
         VALUES
           ($1, $3, $4, 'Tecnologia da Informação', 'TI'),
           ($2, $3, $4, 'Recursos Humanos', 'RH');`,
        [deptTiId, deptRhId, tenantAId, companyAId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, company_id, title, cbo)
         VALUES ($1, $2, $3, 'Engenheiro de Software', '212405');`,
        [posAId, tenantAId, companyAId]
      );

      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1, $2, $3, 'Sede Paulista', 'SP', '3550308');`,
        [wpAId, tenantAId, companyAId]
      );

      // Inserção em lote de 65 trabalhadores e contratos (40 no TI, 25 no RH -> 2 chunks de 50 + 15)
      await client.query(
        `WITH seq AS (SELECT generate_series(1, 65) AS n)
         INSERT INTO public.workers (id, tenant_id, full_name, cpf, pis, is_apprentice, is_active)
         SELECT
           ('f5010000-0000-0000-0001-' || LPAD(n::text, 12, '0'))::uuid,
           $1::uuid,
           'Colaborador Lote ' || LPAD(n::text, 3, '0'),
           LPAD((55000000000 + n)::text, 11, '0'),
           LPAD((15000000000 + n)::text, 11, '0'),
           FALSE,
           TRUE
         FROM seq;`,
        [tenantAId]
      );

      await client.query(
        `WITH seq AS (SELECT generate_series(1, 65) AS n)
         INSERT INTO public.contracts (
           id, tenant_id, worker_id, company_id, establishment_id, department_id,
           position_id, workplace_id, registration_number, admission_date,
           base_salary, monthly_hours, weekly_hours, regime, status
         )
         SELECT
           ('f5010000-0000-0000-0002-' || LPAD(n::text, 12, '0'))::uuid,
           $1::uuid,
           ('f5010000-0000-0000-0001-' || LPAD(n::text, 12, '0'))::uuid,
           $2::uuid,
           $3::uuid,
           CASE WHEN n <= 40 THEN $4::uuid ELSE $5::uuid END,
           $6::uuid,
           $7::uuid,
           'MAT-F5-' || LPAD(n::text, 4, '0'),
           '2024-01-10',
           CASE WHEN n <= 40 THEN 4000.00 ELSE 3000.00 END,
           220,
           44,
           'CLT',
           'ACTIVE'
         FROM seq;`,
        [tenantAId, companyAId, estAId, deptTiId, deptRhId, posAId, wpAId]
      );

      await client.query(
        `INSERT INTO public.payroll_periods (id, tenant_id, company_id, year, month, type, status, payment_date, competence_date)
         VALUES
           ($1, $4, $5, 2026, 10, 'MONTHLY', 'OPEN', '2026-11-06', '2026-10-01'),
           ($2, $4, $5, 2026, 9,  'MONTHLY', 'CLOSED', '2026-10-06', '2026-09-01'),
           ($3, $4, $5, 2026, 8,  'MONTHLY', 'OPEN', '2026-09-05', '2026-08-01');`,
        [periodBatchId, periodClosedId, periodWatchdogId, tenantAId, companyAId]
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
      email: 'admin.a.f501@couplerh.test',
      tenantId: tenantAId,
      role: 'system_admin',
      aal: 'aal2',
    });
    tokenTenantA = tokA.accessToken;

    const tokB = await tokenService.createSession({
      userId: userAdminBId,
      email: 'admin.b.f501@couplerh.test',
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
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantBId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantBId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(
        `DELETE FROM public.system_operational_alerts WHERE metadata->>'tenant_id' = $1;`,
        [tenantAId]
      );
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

  it('1. deve processar 65 contratos em chunks de 50 (modo REAL), gravar heartbeat e persistir holerites em transação única', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/jobs',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        period_id: periodBatchId,
        mode: 'REAL',
        execute_sync: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.job.status).toBe('COMPLETED');
    expect(body.job.total_contracts).toBe(65);
    expect(body.job.processed_contracts).toBe(65);
    expect(body.job.heartbeat_at).toBeTruthy();
    expect(body.job.summary_json.chunks_processed).toBe(2); // 50 + 15

    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/jobs/${body.job.id}`,
      headers: { Authorization: `Bearer ${tokenTenantA}` },
    });
    expect(statusRes.statusCode).toBe(200);
    const statusBody = JSON.parse(statusRes.body);
    expect(statusBody.job.progress_pct).toBe(100);

    const ctxA = { tenantId: tenantAId, userId: userAdminAId, role: 'system_admin' };
    const slipCount = await withTenantContext(ctxA, async (client) => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM public.payslips WHERE payroll_period_id = $1::uuid;`,
        [periodBatchId]
      );
      return rows[0].cnt;
    });
    expect(slipCount).toBe(65);

    const periodCheck = await withTenantContext(ctxA, async (client) => {
      const { rows } = await client.query(
        `SELECT status, locked_at, heartbeat_at FROM public.payroll_periods WHERE id = $1::uuid;`,
        [periodBatchId]
      );
      return rows[0];
    });
    expect(periodCheck.status).toBe('CALCULATED');
    expect(periodCheck.locked_at).toBeNull();
  });

  it('2. deve bloquear concorrência (409) no mesmo período e bloquear modo REAL em período CLOSED', async () => {
    const ctxA = { tenantId: tenantAId, userId: userAdminAId, role: 'system_admin' };

    // Tenta rodar modo REAL em competência CLOSED -> 400/422
    const closedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/jobs',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        period_id: periodClosedId,
        mode: 'REAL',
      },
    });
    expect([400, 422]).toContain(closedRes.statusCode);

    // Simula período já travado em CALCULATING sob contexto RLS e verifica 409
    await withTenantContext(ctxA, async (client) => {
      await client.query(
        `UPDATE public.payroll_periods SET status = 'CALCULATING', locked_at = NOW(), heartbeat_at = NOW() WHERE id = $1::uuid;`,
        [periodWatchdogId]
      );
    });

    const concurrentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/jobs',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        period_id: periodWatchdogId,
        mode: 'REAL',
      },
    });
    expect(concurrentRes.statusCode).toBe(409);

    // Restaura estado limpo sob contexto RLS
    await withTenantContext(ctxA, async (client) => {
      await client.query(
        `UPDATE public.payroll_periods SET status = 'OPEN', locked_at = NULL, heartbeat_at = NULL WHERE id = $1::uuid;`,
        [periodWatchdogId]
      );
    });
  });

  it('3. deve simular cenário What-If (6,5% + bônus R$ 500 apenas em TI) sem tocar em payslips ou payroll_periods', async () => {
    const ctxA = { tenantId: tenantAId, userId: userAdminAId, role: 'system_admin' };
    const beforeSlips = await withTenantContext(ctxA, async (client) => {
      const { rows } = await client.query(
        `SELECT id, total_earnings, net_salary, version FROM public.payslips WHERE payroll_period_id = $1::uuid ORDER BY id;`,
        [periodBatchId]
      );
      return rows;
    });

    const simRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/simulate',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        period_id: periodBatchId,
        execute_sync: true,
        scenario_params: {
          label: 'Dissídio TI 6,5% + Bônus 500',
          salary_increase_pct: 6.5,
          bonus_amount: 500,
          department_id: deptTiId,
        },
      },
    });

    expect(simRes.statusCode).toBe(200);
    const body = JSON.parse(simRes.body);
    expect(body.success).toBe(true);
    expect(body.job.mode).toBe('SIMULATION');
    expect(body.job.status).toBe('COMPLETED');

    const summary = body.job.summary_json;
    expect(summary.total_contracts).toBe(65);
    expect(summary.affected_contracts).toBe(40); // Apenas os 40 do TI

    // Cada um dos 40 contratos de TI (R$ 4.000) ganha +6,5% (R$ 260) + R$ 500 bônus = +R$ 760 -> 40 * 760 = R$ 30.400
    expect(summary.delta.total_earnings).toBe(30400);
    expect(summary.delta.employer_taxes.total_taxes).toBeGreaterThan(0);

    const tiDept = summary.by_department.find((d: any) => d.department_id === deptTiId);
    const rhDept = summary.by_department.find((d: any) => d.department_id === deptRhId);
    expect(tiDept.affected_contracts).toBe(40);
    expect(tiDept.delta_earnings).toBe(30400);
    expect(rhDept.affected_contracts).toBe(0);
    expect(rhDept.delta_earnings).toBe(0);

    // Garante integridade absoluta: nenhum holerite oficial alterado
    const afterSlips = await withTenantContext(ctxA, async (client) => {
      const { rows } = await client.query(
        `SELECT id, total_earnings, net_salary, version FROM public.payslips WHERE payroll_period_id = $1::uuid ORDER BY id;`,
        [periodBatchId]
      );
      return rows;
    });
    expect(afterSlips).toEqual(beforeSlips);
  });

  it('4. deve destravar job e competência presos em CALCULATING via Watchdog e registrar alerta CRITICAL', async () => {
    const ctxA = { tenantId: tenantAId, userId: userAdminAId, role: 'system_admin' };
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/jobs',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        period_id: periodWatchdogId,
        mode: 'REAL',
        execute_sync: true,
      },
    });
    expect(createRes.statusCode).toBe(200);
    const createdJobId = JSON.parse(createRes.body).job.id;

    // Simula deadlock com heartbeat expirado há 10 minutos
    await withTenantContext(ctxA, async (client) => {
      await client.query(
        `UPDATE public.payroll_calculation_jobs
         SET status = 'RUNNING',
             locked_at = NOW() - INTERVAL '10 minutes',
             heartbeat_at = NOW() - INTERVAL '10 minutes',
             finished_at = NULL
         WHERE id = $1::uuid;`,
        [createdJobId]
      );
      await client.query(
        `UPDATE public.payroll_periods
         SET status = 'CALCULATING',
             locked_at = NOW() - INTERVAL '10 minutes',
             heartbeat_at = NOW() - INTERVAL '10 minutes'
         WHERE id = $1::uuid;`,
        [periodWatchdogId]
      );
    });

    const watchdogRes = await runPayrollWatchdog(dbPool, 5);
    expect(watchdogRes.recovered_jobs.some((j: any) => j.job_id === createdJobId)).toBe(true);
    expect(watchdogRes.recovered_periods.some((p: any) => p.period_id === periodWatchdogId)).toBe(true);
    expect(watchdogRes.alerts_created).toBeGreaterThanOrEqual(1);

    const jobRow = await withTenantContext(ctxA, async (client) => {
      const { rows } = await client.query(
        `SELECT status, errors_json FROM public.payroll_calculation_jobs WHERE id = $1::uuid;`,
        [createdJobId]
      );
      return rows[0];
    });
    expect(jobRow.status).toBe('FAILED');
    expect(JSON.stringify(jobRow.errors_json)).toContain('WATCHDOG_TIMEOUT');

    const pRow = await withTenantContext(ctxA, async (client) => {
      const { rows } = await client.query(
        `SELECT status, locked_at, heartbeat_at FROM public.payroll_periods WHERE id = $1::uuid;`,
        [periodWatchdogId]
      );
      return rows[0];
    });
    expect(pRow.status).not.toBe('CALCULATING');
    expect(pRow.locked_at).toBeNull();

    const { rows: alertRows } = await dbPool.query(
      `SELECT severity, category, title FROM public.system_operational_alerts
       WHERE metadata->>'job_id' = $1
       ORDER BY created_at DESC LIMIT 1;`,
      [createdJobId]
    );
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].severity).toBe('CRITICAL');
    expect(alertRows[0].category).toBe('QUEUE');
  });

  it('5. deve garantir isolamento estrito multi-tenant via RLS em payroll_calculation_jobs', async () => {
    const listResA = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodBatchId}/jobs`,
      headers: { Authorization: `Bearer ${tokenTenantA}` },
    });
    expect(listResA.statusCode).toBe(200);
    const jobAId = JSON.parse(listResA.body).jobs[0].id;

    // Tenant B não pode enxergar job do Tenant A
    const getByB = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/jobs/${jobAId}`,
      headers: { Authorization: `Bearer ${tokenTenantB}` },
    });
    expect(getByB.statusCode).toBe(404);
  });

  it('6. Benchmark Aceite: deve processar/simular 1.000 contratos em chunks de 50 em menos de 5 segundos', async () => {
    // Expande de 65 para 1.000 contratos no Tenant A em um único INSERT SQL set-based
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query(
        `WITH seq AS (SELECT generate_series(66, 1000) AS n)
         INSERT INTO public.workers (id, tenant_id, full_name, cpf, pis, is_apprentice, is_active)
         SELECT
           ('f5010000-0000-0000-0001-' || LPAD(n::text, 12, '0'))::uuid,
           $1::uuid,
           'Colaborador Bench ' || LPAD(n::text, 4, '0'),
           LPAD((55000000000 + n)::text, 11, '0'),
           LPAD((15000000000 + n)::text, 11, '0'),
           FALSE,
           TRUE
         FROM seq;`,
        [tenantAId]
      );

      await client.query(
        `WITH seq AS (SELECT generate_series(66, 1000) AS n)
         INSERT INTO public.contracts (
           id, tenant_id, worker_id, company_id, establishment_id, department_id,
           position_id, workplace_id, registration_number, admission_date,
           base_salary, monthly_hours, weekly_hours, regime, status
         )
         SELECT
           ('f5010000-0000-0000-0002-' || LPAD(n::text, 12, '0'))::uuid,
           $1::uuid,
           ('f5010000-0000-0000-0001-' || LPAD(n::text, 12, '0'))::uuid,
           $2::uuid,
           $3::uuid,
           CASE WHEN n % 2 = 0 THEN $4::uuid ELSE $5::uuid END,
           $6::uuid,
           $7::uuid,
           'MAT-F5-' || LPAD(n::text, 4, '0'),
           '2024-02-01',
           3500.00,
           220,
           44,
           'CLT',
           'ACTIVE'
         FROM seq;`,
        [tenantAId, companyAId, estAId, deptTiId, deptRhId, posAId, wpAId]
      );
      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    // Cria e executa job de simulação sobre os 1.000 contratos (20 chunks de 50)
    const startMs = Date.now();
    const createSimRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/simulate',
      headers: { Authorization: `Bearer ${tokenTenantA}` },
      payload: {
        period_id: periodBatchId,
        execute_sync: true,
        scenario_params: {
          label: 'Benchmark 1.000 Contratos',
          salary_increase_pct: 5,
          department_id: deptTiId,
        },
      },
    });
    const elapsedMs = Date.now() - startMs;
    expect(createSimRes.statusCode).toBe(200);
    const finalJob = JSON.parse(createSimRes.body).job;

    console.log(`[BENCHMARK FOLHA-01] 1.000 contratos (20 chunks de 50) processados em ${elapsedMs}ms`);

    expect(finalJob.status).toBe('COMPLETED');
    expect(finalJob.total_contracts).toBe(1000);
    expect(finalJob.processed_contracts).toBe(1000);
    expect(finalJob.summary_json.chunks_processed).toBe(20);
    expect(elapsedMs).toBeLessThan(5000);
  }, 20000);
});
