import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';

describe('Políticas RLS Nativas no PostgreSQL 17 e Append-Only Imutável (RBAC-03)', () => {
  let app: FastifyInstance;

  // IDs fixos de teste
  const tenantId = 'e0000000-0000-0000-0000-000000000001';
  const companyId = 'e0000000-0000-0000-0000-000000000002';
  const estabSpId = 'e0000000-0000-0000-0000-000000000003';
  const estabRjId = 'e0000000-0000-0000-0000-000000000004';
  const deptoLogId = 'e0000000-0000-0000-0000-000000000010';
  const positionId = 'e0000000-0000-0000-0000-000000000020';

  // Usuários e Trabalhadores
  const userAdminId = 'e0000000-0000-0000-0000-000000000100';

  const userWorkerAId = 'e0000000-0000-0000-0000-000000000200';
  const workerAId = 'e0000000-0000-0000-0000-000000000201';
  const contractAId = 'e0000000-0000-0000-0000-000000000202';

  const userWorkerBId = 'e0000000-0000-0000-0000-000000000300';
  const workerBId = 'e0000000-0000-0000-0000-000000000301';
  const contractBId = 'e0000000-0000-0000-0000-000000000302';

  const userSupervisorSpId = 'e0000000-0000-0000-0000-000000000400';
  let tenantUserSupervisorId: string;

  // Holerites e Período
  const periodId = 'e0000000-0000-0000-0000-000000000500';
  const payslipAId = 'e0000000-0000-0000-0000-000000000601';
  const payslipBId = 'e0000000-0000-0000-0000-000000000602';

  // Ponto
  const punchAId = 'e0000000-0000-0000-0000-000000000701';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query("SELECT set_config('app.current_user_id', $1, true);", [userAdminId]);

      // 1. Tenant
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ('${tenantId}', 'RLS Hardening Corp', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;
      `);

      // 2. Company & Establishments
      await client.query(`
        INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj)
        VALUES ('${companyId}', '${tenantId}', 'RLS Hardening LTDA', 'RLS Corp', '88990011000144')
        ON CONFLICT (id) DO UPDATE SET corporate_name = EXCLUDED.corporate_name;

        INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
        VALUES 
          ('${estabSpId}', '${tenantId}', '${companyId}', 'Filial SP', '88990011000144'),
          ('${estabRjId}', '${tenantId}', '${companyId}', 'Filial RJ', '88990011000225')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
      `);

      // 3. Departments & Positions
      await client.query(`
        INSERT INTO public.departments (id, tenant_id, company_id, name, code)
        VALUES ('${deptoLogId}', '${tenantId}', '${companyId}', 'Operações RLS', 'OPS')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.positions (id, tenant_id, title, cbo)
        VALUES ('${positionId}', '${tenantId}', 'Especialista RLS', '212405')
        ON CONFLICT (id) DO NOTHING;
      `);

      const defaultHash = await hashPassword('SenhaSegura123!');

      // 4. Users
      await client.query(`
        INSERT INTO public.users (id, full_name, email, password_hash, is_active)
        VALUES
          ('${userAdminId}', 'Admin RLS Master', 'admin.rls@rls.com', '${defaultHash}', TRUE),
          ('${userWorkerAId}', 'Colaborador A (SP)', 'worker.a@rls.com', '${defaultHash}', TRUE),
          ('${userWorkerBId}', 'Colaborador B (RJ)', 'worker.b@rls.com', '${defaultHash}', TRUE),
          ('${userSupervisorSpId}', 'Supervisor SP', 'super.sp@rls.com', '${defaultHash}', TRUE)
        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
      `);

      // 5. Workers
      await client.query(`
        INSERT INTO public.workers (id, tenant_id, user_id, full_name, cpf, birth_date)
        VALUES
          ('${workerAId}', '${tenantId}', '${userWorkerAId}', 'Colaborador A (SP)', '55555555555', '1990-01-01'),
          ('${workerBId}', '${tenantId}', '${userWorkerBId}', 'Colaborador B (RJ)', '66666666666', '1992-02-02')
        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
      `);

      // 6. Obter roles de sistema e vincular Tenant Users
      const rolesRes = await client.query(`
        SELECT id, slug FROM public.roles WHERE is_system = TRUE AND tenant_id IS NULL;
      `);
      const roleMap = new Map<string, string>();
      rolesRes.rows.forEach((r: { id: string; slug: string }) => roleMap.set(r.slug, r.id));

      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, role_id, worker_id, scope_mode, is_active)
        VALUES
          ('${tenantId}', '${userAdminId}', 'tenant_admin', '${roleMap.get('tenant_admin')}', NULL, 'ALL', TRUE),
          ('${tenantId}', '${userWorkerAId}', 'employee', '${roleMap.get('employee')}', '${workerAId}', 'SELF_ONLY', TRUE),
          ('${tenantId}', '${userWorkerBId}', 'employee', '${roleMap.get('employee')}', '${workerBId}', 'SELF_ONLY', TRUE),
          ('${tenantId}', '${userSupervisorSpId}', 'dp_analyst', '${roleMap.get('dp_analyst')}', NULL, 'RESTRICTED', TRUE)
        ON CONFLICT (tenant_id, user_id) DO UPDATE 
        SET role = EXCLUDED.role, role_id = EXCLUDED.role_id, scope_mode = EXCLUDED.scope_mode, worker_id = EXCLUDED.worker_id, is_active = EXCLUDED.is_active;
      `);

      const tuRes = await client.query(
        "SELECT id FROM public.tenant_users WHERE tenant_id = $1 AND user_id = $2;",
        [tenantId, userSupervisorSpId]
      );
      tenantUserSupervisorId = tuRes.rows[0].id;

      // 7. Contracts: Contrato A (SP) e Contrato B (RJ) (agora com userAdmin autorizado via manage_employees)
      await client.query(`
        INSERT INTO public.contracts (
          id, tenant_id, worker_id, company_id, establishment_id, department_id, 
          position_id, registration_number, admission_date, base_salary, status
        ) VALUES
          ('${contractAId}', '${tenantId}', '${workerAId}', '${companyId}', '${estabSpId}', '${deptoLogId}',
           '${positionId}', 'MAT-A', '2021-01-01', 5000.00, 'ACTIVE'),
          ('${contractBId}', '${tenantId}', '${workerBId}', '${companyId}', '${estabRjId}', '${deptoLogId}',
           '${positionId}', 'MAT-B', '2022-01-01', 6000.00, 'ACTIVE')
        ON CONFLICT (id) DO UPDATE SET base_salary = EXCLUDED.base_salary;
      `);

      // 8. Escopo do Supervisor: Apenas Filial SP
      await client.query("DELETE FROM public.tenant_user_scopes WHERE tenant_user_id = $1;", [tenantUserSupervisorId]);
      await client.query(`
        INSERT INTO public.tenant_user_scopes (tenant_id, tenant_user_id, scope_type, scope_target_id)
        VALUES ('${tenantId}', '${tenantUserSupervisorId}', 'ESTABLISHMENT', '${estabSpId}')
        ON CONFLICT DO NOTHING;
      `);

      // 9. Payroll Period e Payslips para A e B
      await client.query(`
        INSERT INTO public.payroll_periods (id, tenant_id, company_id, year, month, type, payment_date, competence_date, status)
        VALUES ('${periodId}', '${tenantId}', '${companyId}', 2026, 11, 'MONTHLY', '2026-12-05', '2026-11-01', 'OPEN')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.payslips (id, tenant_id, payroll_period_id, contract_id, worker_id, gross_salary, net_salary, status)
        VALUES
          ('${payslipAId}', '${tenantId}', '${periodId}', '${contractAId}', '${workerAId}', 5000.00, 4200.00, 'CALCULATED'),
          ('${payslipBId}', '${tenantId}', '${periodId}', '${contractBId}', '${workerBId}', 6000.00, 4900.00, 'CALCULATED')
        ON CONFLICT (id) DO NOTHING;
      `);

      // 10. Ponto original de A
      await client.query(`
        INSERT INTO public.time_punch_records (
          id, tenant_id, company_id, contract_id, worker_id, nsr, punched_at, punch_type, source, sha256_hash
        ) VALUES (
          '${punchAId}', '${tenantId}', '${companyId}', '${contractAId}', '${workerAId}', 1001,
          NOW(), 'ENTRY', 'MOBILE', 'sha256_dummy_hash_test_rls'
        ) ON CONFLICT (id) DO NOTHING;
      `);

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Garantia de Imutabilidade Append-Only (audit.logs, time_punch_records)', () => {
    it('audit.logs deve permitir INSERT e bloquear qualquer tentativa de UPDATE ou DELETE', async () => {
      await withTenantContext(
        { userId: userAdminId, tenantId, role: 'tenant_admin' },
        async (client) => {
          // INSERT é permitido
          const logInsert = await client.query(`
            INSERT INTO audit.logs (tenant_id, action, table_name, record_id, user_id)
            VALUES ($1, 'TEST_RLS_INSERT', 'test_table', 'record-001', $2)
            RETURNING id;
          `, [tenantId, userAdminId]);
          expect(logInsert.rows.length).toBe(1);
          const logId = logInsert.rows[0].id;

          // Tentativa de UPDATE é sumariamente rejeitada pelo PostgreSQL (privilégio e RLS negados)
          await client.query('SAVEPOINT sp_upd;');
          await expect(
            client.query("UPDATE audit.logs SET action = 'HACKED' WHERE id = $1;", [logId])
          ).rejects.toThrow();
          await client.query('ROLLBACK TO SAVEPOINT sp_upd;');

          // Tentativa de DELETE é sumariamente rejeitada pelo PostgreSQL
          await client.query('SAVEPOINT sp_del;');
          await expect(
            client.query("DELETE FROM audit.logs WHERE id = $1;", [logId])
          ).rejects.toThrow();
          await client.query('ROLLBACK TO SAVEPOINT sp_del;');

          // Log continua íntegro no banco
          const checkLog = await client.query("SELECT action FROM audit.logs WHERE id = $1;", [logId]);
          expect(checkLog.rows[0].action).toBe('TEST_RLS_INSERT');
        }
      );
    });

    it('time_punch_records deve permitir INSERT mas bloquear UPDATE e DELETE (Portaria MTP 671/2021)', async () => {
      await withTenantContext(
        { userId: userWorkerAId, tenantId, role: 'employee', workerId: workerAId },
        async (client) => {
          // Tentativa de UPDATE no ponto registrado deve ser bloqueada pela RLS (0 linhas afetadas)
          const updRes = await client.query("UPDATE public.time_punch_records SET punch_type = 'EXIT' WHERE id = $1;", [punchAId]);
          expect(updRes.rowCount).toBe(0);

          // Tentativa de DELETE no ponto deve ser bloqueada pela RLS (0 linhas afetadas)
          const delRes = await client.query("DELETE FROM public.time_punch_records WHERE id = $1;", [punchAId]);
          expect(delRes.rowCount).toBe(0);

          // Ponto original continua íntegro no banco com ENTRY
          const checkPunch = await client.query("SELECT punch_type FROM public.time_punch_records WHERE id = $1;", [punchAId]);
          expect(checkPunch.rows[0].punch_type).toBe('ENTRY');
        }
      );
    });
  });

  describe('2. Políticas RLS de Leitura Cross-Role e Isolamento de Escopo', () => {
    it('Supervisor Restrito SP (RESTRICTED) só enxerga contratos de SP, recebendo 0 linhas da Filial RJ', async () => {
      await withTenantContext(
        { userId: userSupervisorSpId, tenantId, role: 'dp_analyst' },
        async (client) => {
          const { rows } = await client.query("SELECT id FROM public.contracts;");
          const ids = rows.map((r: { id: string }) => r.id);

          // Contrato A (SP) deve estar visível
          expect(ids).toContain(contractAId);
          // Contrato B (RJ) NÃO deve aparecer
          expect(ids).not.toContain(contractBId);
        }
      );
    });

    it('Colaborador A só enxerga seu próprio holerite (payslip A) e recebe 0 linhas do holerite do Colaborador B', async () => {
      await withTenantContext(
        { userId: userWorkerAId, tenantId, role: 'employee', workerId: workerAId },
        async (client) => {
          const { rows } = await client.query("SELECT id FROM public.payslips;");
          const ids = rows.map((r: { id: string }) => r.id);

          // Vê o próprio holerite
          expect(ids).toContain(payslipAId);
          // Zero visibilidade do holerite alheio
          expect(ids).not.toContain(payslipBId);
        }
      );
    });

    it('Colaborador B só enxerga seu próprio holerite (payslip B) e recebe 0 linhas do Colaborador A', async () => {
      await withTenantContext(
        { userId: userWorkerBId, tenantId, role: 'employee', workerId: workerBId },
        async (client) => {
          const { rows } = await client.query("SELECT id FROM public.payslips;");
          const ids = rows.map((r: { id: string }) => r.id);

          expect(ids).toContain(payslipBId);
          expect(ids).not.toContain(payslipAId);
        }
      );
    });

    it('Colaborador A não consegue ver registros de ponto do Colaborador B', async () => {
      await withTenantContext(
        { userId: userWorkerBId, tenantId, role: 'employee', workerId: workerBId },
        async (client) => {
          // Colaborador B consulta pontos
          const { rows } = await client.query("SELECT id FROM public.time_punch_records WHERE id = $1;", [punchAId]);
          expect(rows.length).toBe(0);
        }
      );
    });

    it('Usuário sem permissão manage_employees é bloqueado na escrita em contracts pela RLS', async () => {
      await withTenantContext(
        { userId: userWorkerAId, tenantId, role: 'employee', workerId: workerAId },
        async (client) => {
          // Tentativa de alterar salário do próprio contrato via UPDATE direto
          const res = await client.query(`
            UPDATE public.contracts 
            SET base_salary = 99999.00 
            WHERE id = $1;
          `, [contractAId]);

          // RLS contracts_modify_policy deve filtrar e impedir a modificação (0 linhas afetadas)
          expect(res.rowCount).toBe(0);
        }
      );
    });
  });
});
