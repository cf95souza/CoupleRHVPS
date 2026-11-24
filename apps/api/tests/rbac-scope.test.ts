import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

describe('Escopo Organizacional Multidimensional e can_access_contract (RBAC-02)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;

  // IDs fixos de teste
  const tenantId = 'e0000000-0000-0000-0000-000000000001';
  const companyId = 'e0000000-0000-0000-0000-000000000002';
  const estabSpId = 'e0000000-0000-0000-0000-000000000003';
  const estabRjId = 'e0000000-0000-0000-0000-000000000004';

  const deptoLogisticaId = 'e0000000-0000-0000-0000-000000000010';
  const deptoFinanceiroId = 'e0000000-0000-0000-0000-000000000020';
  const positionAnalistaId = 'e0000000-0000-0000-0000-000000000030';
  const positionDiretorId = 'e0000000-0000-0000-0000-000000000031';

  // Usuários e Trabalhadores
  const userAdminId = 'e0000000-0000-0000-0000-000000000100';
  const userManagerId = 'e0000000-0000-0000-0000-000000000200';
  const workerManagerId = 'e0000000-0000-0000-0000-000000000201';

  const userEmployee1Id = 'e0000000-0000-0000-0000-000000000300';
  const workerEmployee1Id = 'e0000000-0000-0000-0000-000000000301';

  const userEmployee2Id = 'e0000000-0000-0000-0000-000000000400';
  const workerEmployee2Id = 'e0000000-0000-0000-0000-000000000401';

  const userRestrictedId = 'e0000000-0000-0000-0000-000000000500';
  let tenantUserRestrictedId: string;

  const userDiretorId = 'e0000000-0000-0000-0000-000000000600';
  const workerDiretorId = 'e0000000-0000-0000-0000-000000000601';

  // Contratos
  const contractManagerId = 'e0000000-0000-0000-0000-000000001001';
  const contractSubordinadoLogSpId = 'e0000000-0000-0000-0000-000000001002'; // SP + Logística + Manager direto
  const contractSubordinadoLogRjId = 'e0000000-0000-0000-0000-000000001003'; // RJ + Logística
  const contractFinanceiroSpId = 'e0000000-0000-0000-0000-000000001004'; // SP + Financeiro
  const contractConfidencialDiretorId = 'e0000000-0000-0000-0000-000000001005'; // Confidencial (Diretoria)

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');

      // Configura contexto do tenant
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query("SELECT set_config('app.current_user_id', $1, true);", [userAdminId]);

      // 1. Tenant
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ('${tenantId}', 'Enterprise Scopes Corp', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;
      `);

      // 2. Company & Establishments
      await client.query(`
        INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj)
        VALUES ('${companyId}', '${tenantId}', 'Scopes Matrix LTDA', 'Scopes Matrix', '77889900000155')
        ON CONFLICT (id) DO UPDATE SET corporate_name = EXCLUDED.corporate_name;

        INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
        VALUES 
          ('${estabSpId}', '${tenantId}', '${companyId}', 'Filial SP', '77889900000155'),
          ('${estabRjId}', '${tenantId}', '${companyId}', 'Filial RJ', '77889900000233')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
      `);

      // 3. Departments & Positions
      await client.query(`
        INSERT INTO public.departments (id, tenant_id, company_id, name, code)
        VALUES 
          ('${deptoLogisticaId}', '${tenantId}', '${companyId}', 'Logística e Operações', 'LOG'),
          ('${deptoFinanceiroId}', '${tenantId}', '${companyId}', 'Controladoria Financeira', 'FIN')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.positions (id, tenant_id, title, cbo)
        VALUES 
          ('${positionAnalistaId}', '${tenantId}', 'Analista de Operações', '411010'),
          ('${positionDiretorId}', '${tenantId}', 'Diretor Executivo', '121010')
        ON CONFLICT (id) DO NOTHING;
      `);

      const defaultHash = await hashPassword('SenhaSegura123!');

      // 4. Users
      await client.query(`
        INSERT INTO public.users (id, full_name, email, password_hash, is_active)
        VALUES
          ('${userAdminId}', 'Administrador Geral', 'admin.scope@scopes.com', '${defaultHash}', TRUE),
          ('${userManagerId}', 'Gestor de Logística', 'gestor.log@scopes.com', '${defaultHash}', TRUE),
          ('${userEmployee1Id}', 'Colaborador SP 1', 'colab.sp@scopes.com', '${defaultHash}', TRUE),
          ('${userEmployee2Id}', 'Colaborador RJ 2', 'colab.rj@scopes.com', '${defaultHash}', TRUE),
          ('${userRestrictedId}', 'Supervisor Restrito SP', 'supervisor.sp@scopes.com', '${defaultHash}', TRUE),
          ('${userDiretorId}', 'Diretor Executivo Corp', 'diretor.corp@scopes.com', '${defaultHash}', TRUE)
        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
      `);

      // 5. Workers
      await client.query(`
        INSERT INTO public.workers (id, tenant_id, user_id, full_name, cpf, birth_date)
        VALUES
          ('${workerManagerId}', '${tenantId}', '${userManagerId}', 'Gestor de Logística', '11111111111', '1985-05-15'),
          ('${workerEmployee1Id}', '${tenantId}', '${userEmployee1Id}', 'Colaborador SP 1', '22222222222', '1992-08-20'),
          ('${workerEmployee2Id}', '${tenantId}', '${userEmployee2Id}', 'Colaborador RJ 2', '33333333333', '1995-11-10'),
          ('${workerDiretorId}', '${tenantId}', '${userDiretorId}', 'Diretor Executivo Corp', '44444444444', '1975-01-01')
        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
      `);

      // Define Gestor no Departamento de Logística
      await client.query(`
        UPDATE public.departments SET manager_worker_id = '${workerManagerId}' WHERE id = '${deptoLogisticaId}';
      `);

      // 6. Obter roles de sistema
      const rolesRes = await client.query(`
        SELECT id, slug FROM public.roles WHERE is_system = TRUE AND tenant_id IS NULL;
      `);
      const roleMap = new Map<string, string>();
      rolesRes.rows.forEach((r: { id: string; slug: string }) => roleMap.set(r.slug, r.id));

      // 7. Vincular Usuários em tenant_users com seus respectivos scope_mode (antes de contracts para autorização RLS)
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, role_id, worker_id, scope_mode, is_active)
        VALUES
          -- Admin: scope_mode ALL
          ('${tenantId}', '${userAdminId}', 'tenant_admin', '${roleMap.get('tenant_admin')}', NULL, 'ALL', TRUE),
          -- Gestor: scope_mode OWN_TEAM
          ('${tenantId}', '${userManagerId}', 'manager', '${roleMap.get('manager')}', '${workerManagerId}', 'OWN_TEAM', TRUE),
          -- Colaborador 1: scope_mode SELF_ONLY
          ('${tenantId}', '${userEmployee1Id}', 'employee', '${roleMap.get('employee')}', '${workerEmployee1Id}', 'SELF_ONLY', TRUE),
          -- Supervisor Restrito SP: scope_mode RESTRICTED
          ('${tenantId}', '${userRestrictedId}', 'dp_analyst', '${roleMap.get('dp_analyst')}', NULL, 'RESTRICTED', TRUE)
        ON CONFLICT (tenant_id, user_id) DO UPDATE 
        SET role = EXCLUDED.role,
            role_id = EXCLUDED.role_id,
            scope_mode = EXCLUDED.scope_mode,
            worker_id = EXCLUDED.worker_id,
            is_active = EXCLUDED.is_active;
      `);

      const tuRes = await client.query(
        "SELECT id FROM public.tenant_users WHERE tenant_id = $1 AND user_id = $2;",
        [tenantId, userRestrictedId]
      );
      tenantUserRestrictedId = tuRes.rows[0].id;

      // 8. Contracts (executado com userAdmin autorizado com scope_mode ALL)
      await client.query(`
        INSERT INTO public.contracts (
          id, tenant_id, worker_id, company_id, establishment_id, department_id, 
          position_id, registration_number, admission_date, base_salary, status,
          manager_worker_id, is_confidential_payroll
        ) VALUES
          -- Contrato do próprio Gestor
          ('${contractManagerId}', '${tenantId}', '${workerManagerId}', '${companyId}', '${estabSpId}', '${deptoLogisticaId}',
           '${positionAnalistaId}', 'MAT-001', '2020-01-01', 8500.00, 'ACTIVE', NULL, FALSE),
          -- Contrato Subordinado 1 (SP + Logística + Manager direto)
          ('${contractSubordinadoLogSpId}', '${tenantId}', '${workerEmployee1Id}', '${companyId}', '${estabSpId}', '${deptoLogisticaId}',
           '${positionAnalistaId}', 'MAT-002', '2021-03-15', 4200.00, 'ACTIVE', '${workerManagerId}', FALSE),
          -- Contrato Subordinado 2 (RJ + Logística)
          ('${contractSubordinadoLogRjId}', '${tenantId}', '${workerEmployee2Id}', '${companyId}', '${estabRjId}', '${deptoLogisticaId}',
           '${positionAnalistaId}', 'MAT-003', '2022-06-01', 4000.00, 'ACTIVE', NULL, FALSE),
          -- Contrato Financeiro SP (Outro departamento, outro gestor)
          ('${contractFinanceiroSpId}', '${tenantId}', '${workerEmployee1Id}', '${companyId}', '${estabSpId}', '${deptoFinanceiroId}',
           '${positionAnalistaId}', 'MAT-004', '2023-01-10', 5000.00, 'ACTIVE', NULL, FALSE),
          -- Contrato Confidencial da Diretoria
          ('${contractConfidencialDiretorId}', '${tenantId}', '${workerDiretorId}', '${companyId}', '${estabSpId}', '${deptoLogisticaId}',
           '${positionDiretorId}', 'DIR-001', '2019-01-01', 35000.00, 'ACTIVE', NULL, TRUE)
        ON CONFLICT (id) DO UPDATE SET base_salary = EXCLUDED.base_salary;
      `);

      // 9. Configurar Escopos do Supervisor Restrito: Limpar prévios e setar somente Filial SP (ESTABLISHMENT)
      await client.query(
        "DELETE FROM public.tenant_user_scopes WHERE tenant_user_id = $1;",
        [tenantUserRestrictedId]
      );

      await client.query(`
        INSERT INTO public.tenant_user_scopes (tenant_id, tenant_user_id, scope_type, scope_target_id)
        VALUES ('${tenantId}', '${tenantUserRestrictedId}', 'ESTABLISHMENT', '${estabSpId}')
        ON CONFLICT DO NOTHING;
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

  describe('1. Função SQL public.can_access_contract(p_tenant_id, p_contract_id)', () => {
    it('Admin com scope_mode ALL deve acessar contratos comuns do tenant', async () => {
      await withTenantContext(
        { userId: userAdminId, tenantId, role: 'tenant_admin' },
        async (client) => {
          const res1 = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractSubordinadoLogSpId]);
          const res2 = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractSubordinadoLogRjId]);
          const res3 = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractFinanceiroSpId]);
          expect(res1.rows[0].allowed).toBe(true);
          expect(res2.rows[0].allowed).toBe(true);
          expect(res3.rows[0].allowed).toBe(true);
        }
      );
    });

    it('Colaborador com scope_mode SELF_ONLY só pode acessar seu próprio contrato', async () => {
      await withTenantContext(
        { userId: userEmployee1Id, tenantId, role: 'employee', workerId: workerEmployee1Id },
        async (client) => {
          // Próprio contrato (MAT-002)
          const ownContract = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractSubordinadoLogSpId]);
          expect(ownContract.rows[0].allowed).toBe(true);

          // Contrato de outro colaborador (MAT-003)
          const otherContract = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractSubordinadoLogRjId]);
          expect(otherContract.rows[0].allowed).toBe(false);

          // Contrato do gestor (MAT-001)
          const managerContract = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractManagerId]);
          expect(managerContract.rows[0].allowed).toBe(false);
        }
      );
    });

    it('Gestor com scope_mode OWN_TEAM acessa próprio contrato e contratos de sua equipe/depto, mas não de outros departamentos', async () => {
      await withTenantContext(
        { userId: userManagerId, tenantId, role: 'manager', workerId: workerManagerId },
        async (client) => {
          // Próprio contrato
          const own = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractManagerId]);
          expect(own.rows[0].allowed).toBe(true);

          // Subordinado direto com manager_worker_id no contrato
          const directSub = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractSubordinadoLogSpId]);
          expect(directSub.rows[0].allowed).toBe(true);

          // Subordinado do departamento gerenciado pelo gestor (Logística RJ)
          const deptoSub = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractSubordinadoLogRjId]);
          expect(deptoSub.rows[0].allowed).toBe(true);

          // Contrato do Departamento Financeiro (gestor NÃO tem acesso!)
          const outOfScope = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractFinanceiroSpId]);
          expect(outOfScope.rows[0].allowed).toBe(false);
        }
      );
    });

    it('Supervisor com scope_mode RESTRICTED (Filial SP) só acessa contratos de SP, recebendo 0 de RJ', async () => {
      await withTenantContext(
        { userId: userRestrictedId, tenantId, role: 'dp_analyst' },
        async (client) => {
          // Contrato na Filial SP
          const spContract = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractSubordinadoLogSpId]);
          expect(spContract.rows[0].allowed).toBe(true);

          // Contrato na Filial RJ (bloqueado pelo escopo!)
          const rjContract = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractSubordinadoLogRjId]);
          expect(rjContract.rows[0].allowed).toBe(false);
        }
      );
    });

    it('Contrato com is_confidential_payroll = TRUE deve ser bloqueado para quem não tem permissão view_executive_payroll', async () => {
      // Gestor com OWN_TEAM tenta acessar contrato da diretoria (marcado como confidencial)
      await withTenantContext(
        { userId: userManagerId, tenantId, role: 'manager', workerId: workerManagerId },
        async (client) => {
          const res = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractConfidencialDiretorId]);
          // Gestor NÃO possui 'view_executive_payroll' -> Bloqueado!
          expect(res.rows[0].allowed).toBe(false);
        }
      );

      // Admin com permissão deve acessar
      await withTenantContext(
        { userId: userAdminId, tenantId, role: 'tenant_admin' },
        async (client) => {
          const res = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractConfidencialDiretorId]);
          expect(res.rows[0].allowed).toBe(true);
        }
      );
    });
  });

  describe('2. Endpoints REST de Escopo Organizacional (/api/v1/users/*)', () => {
    it('GET /api/v1/users/accessible-contracts deve listar estritamente os contratos do escopo do usuário', async () => {
      // Gestor logado
      const session = await tokenService.createSession({
        userId: userManagerId,
        role: 'manager',
        tenantId,
        workerId: workerManagerId,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/accessible-contracts',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      const contractIds = body.contracts.map((c: any) => c.id);

      // Deve incluir contratos de Logística e próprio
      expect(contractIds).toContain(contractManagerId);
      expect(contractIds).toContain(contractSubordinadoLogSpId);
      expect(contractIds).toContain(contractSubordinadoLogRjId);

      // NÃO deve incluir Financeiro nem Diretoria confidencial
      expect(contractIds).not.toContain(contractFinanceiroSpId);
      expect(contractIds).not.toContain(contractConfidencialDiretorId);
    });

    it('GET /api/v1/users/tenant-access/:id/scopes deve retornar escopos configurados', async () => {
      const session = await tokenService.createSession({
        userId: userAdminId,
        role: 'tenant_admin',
        tenantId,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/tenant-access/${tenantUserRestrictedId}/scopes`,
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.data.scope_mode).toBe('RESTRICTED');
      expect(body.data.scopes.length).toBeGreaterThanOrEqual(1);
      expect(body.data.scopes[0].scope_type).toBe('ESTABLISHMENT');
      expect(body.data.scopes[0].scope_target_id).toBe(estabSpId);
    });

    it('PUT /api/v1/users/tenant-access/:id/scopes deve atualizar scopeMode e alvos granulares', async () => {
      const session = await tokenService.createSession({
        userId: userAdminId,
        role: 'tenant_admin',
        tenantId,
      });

      // Atualiza supervisor para incluir interseção com Departamento Financeiro
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/tenant-access/${tenantUserRestrictedId}/scopes`,
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
        payload: {
          scopeMode: 'RESTRICTED',
          scopes: [
            { scopeType: 'ESTABLISHMENT', scopeTargetId: estabSpId, canViewSalary: false, canViewMedical: false },
            { scopeType: 'DEPARTMENT', scopeTargetId: deptoFinanceiroId, canViewSalary: true, canViewMedical: false },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);

      // Validação no banco: agora o supervisor só deve acessar contratos de SP E Financeiro (MAT-004)
      await withTenantContext(
        { userId: userRestrictedId, tenantId, role: 'dp_analyst' },
        async (client) => {
          const finSp = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractFinanceiroSpId]);
          const logSp = await client.query("SELECT public.can_access_contract($1, $2) AS allowed;", [tenantId, contractSubordinadoLogSpId]);
          expect(finSp.rows[0].allowed).toBe(true);
          // Logística SP agora é negado pois o departamento permitido agora é somente Financeiro
          expect(logSp.rows[0].allowed).toBe(false);
        }
      );
    });
  });
});
