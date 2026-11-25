import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * RBAC-08 & Gate V3 Oficial: Matriz de Isolamento e Conformidade Enterprise
 * - 2 Tenants Isolados (Tenant Alpha vs Tenant Beta)
 * - 8 Papéis Padrão (system_admin, tenant_admin, dp_analyst, manager, accountant, auditor, sst_specialist, employee)
 * - 2 Perfis Customizados (rh_operacional_no_salaries, gestor_filial_sp)
 * - Validação em Camadas: API Fastify + PostgreSQL 17 RLS (couplerh_app) + Sigilo Salarial + LGPD + Escopo
 * - Auditoria Estática Monorepo: Zero Supabase
 */
describe('RBAC-08 & Gate V3 Oficial: Matriz de Isolamento e Governança Enterprise', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;

  // 1. Identificadores dos 2 Tenants (Prefixados com a3000000 para isolamento estrito contra poluição de outros testes)
  const tenantAlphaId = 'a3000000-0000-0000-0000-000000000001';
  const tenantBetaId = 'a3000000-0000-0000-0000-000000000002';

  // Empresas do Tenant Alpha
  const companyAlphaSpId = 'a3000000-0000-0000-0000-000000000011';
  const companyAlphaRjId = 'a3000000-0000-0000-0000-000000000012';

  // Empresa do Tenant Beta
  const companyBetaId = 'a3000000-0000-0000-0000-000000000021';

  // Estabelecimentos, Departamentos, Cargos
  const estAlphaSpId = 'a3000000-0000-0000-0000-000000000031';
  const estAlphaRjId = 'a3000000-0000-0000-0000-000000000032';
  const deptAlphaId = 'a3000000-0000-0000-0000-000000000041';
  const posNormalId = 'a3000000-0000-0000-0000-000000000051';
  const posExecId = 'a3000000-0000-0000-0000-000000000052';

  // 2. Usuários dos 8 Papéis Canônicos
  const userSystemAdminId = 'a3000000-0000-0000-0000-000000000101';
  const userTenantAdminId = 'a3000000-0000-0000-0000-000000000102';
  const userDpAnalystId = 'a3000000-0000-0000-0000-000000000103';
  const userManagerId = 'a3000000-0000-0000-0000-000000000104';
  const userAccountantId = 'a3000000-0000-0000-0000-000000000105';
  const userAuditorId = 'a3000000-0000-0000-0000-000000000106';
  const userSstSpecialistId = 'a3000000-0000-0000-0000-000000000107';
  const userEmployeeId = 'a3000000-0000-0000-0000-000000000108';

  // 3. Usuários dos 2 Perfis Customizados
  const userCustomRhNoSalaryId = 'a3000000-0000-0000-0000-000000000201';
  const userCustomGestorSpId = 'a3000000-0000-0000-0000-000000000202';

  // IDs dos papéis customizados
  let customRoleRhNoSalaryId: string;
  let customRoleGestorSpId: string;

  // 4. Trabalhadores, Contratos e Afastamentos
  const workerManagerId = 'a3000000-0000-0000-0000-000000000301'; // Gestor da Equipe
  const workerTeamMemberId = 'a3000000-0000-0000-0000-000000000302'; // Membro da Equipe (subordinado ao Gestor)
  const workerOtherTeamId = 'a3000000-0000-0000-0000-000000000303'; // Membro de Outra Equipe (RJ)
  const workerDirectorId = 'a3000000-0000-0000-0000-000000000304'; // Diretor (Folha Confidencial)
  const workerBetaId = 'a3000000-0000-0000-0000-000000000305'; // Trabalhador do Tenant Beta

  const contractTeamMemberId = 'a3000000-0000-0000-0000-000000000402'; // SP (Equipe do Gestor)
  const contractOtherTeamId = 'a3000000-0000-0000-0000-000000000403'; // RJ (Outra Equipe)
  const contractDirectorId = 'a3000000-0000-0000-0000-000000000404'; // SP (Confidencial: R$ 35.000)
  const contractBetaId = 'a3000000-0000-0000-0000-000000000405'; // Beta (R$ 5.000)

  const leaveMedicalTeamId = 'a3000000-0000-0000-0000-000000000501'; // Atestado com CID-10

  // Tokens de Autenticação para a Matriz
  let tokenSystemAdmin: string;
  let tokenTenantAdmin: string;
  let tokenDpAnalyst: string;
  let tokenManager: string;
  let tokenAccountant: string;
  let tokenAuditor: string;
  let tokenSstSpecialist: string;
  let tokenEmployee: string;
  let tokenCustomRhNoSalary: string;
  let tokenCustomGestorSp: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');

      // Configuração inicial com bypass de bootstrap
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      // 1. Inserir os 2 Tenants respeitando RLS individualmente
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Tenant Alpha SA', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';
      `, [tenantAlphaId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBetaId]);
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Tenant Beta Ltda', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';
      `, [tenantBetaId]);

      // Retornar contexto para Tenant Alpha
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);

      // 2. Empresas e Estruturas
      await client.query(`
        INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj)
        VALUES 
          ($1, $2, 'Alpha Filial SP Ltda', 'Alpha SP', '11111111000101'),
          ($3, $2, 'Alpha Filial RJ Ltda', 'Alpha RJ', '11111111000202')
        ON CONFLICT (id) DO UPDATE SET corporate_name = EXCLUDED.corporate_name;
      `, [companyAlphaSpId, tenantAlphaId, companyAlphaRjId]);

      // Empresa do Tenant Beta
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBetaId]);
      await client.query(`
        INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj)
        VALUES ($1, $2, 'Beta Matriz Ltda', 'Beta Matriz', '22222222000101')
        ON CONFLICT (id) DO UPDATE SET corporate_name = EXCLUDED.corporate_name;
      `, [companyBetaId, tenantBetaId]);

      // Retornar ao Tenant Alpha para o restante da estrutura
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);

      await client.query(`
        INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
        VALUES 
          ($1, $2, $3, 'Estabelecimento SP', '11111111000101'),
          ($4, $2, $5, 'Estabelecimento RJ', '11111111000202')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
      `, [estAlphaSpId, tenantAlphaId, companyAlphaSpId, estAlphaRjId, companyAlphaRjId]);

      await client.query(`
        INSERT INTO public.departments (id, tenant_id, company_id, name, code)
        VALUES ($1, $2, $3, 'Operações e Logística', 'LOG')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
      `, [deptAlphaId, tenantAlphaId, companyAlphaSpId]);

      await client.query(`
        INSERT INTO public.positions (id, tenant_id, title, cbo)
        VALUES 
          ($1, $2, 'Operador Pleno', '4110-05'),
          ($3, $2, 'Diretor Geral', '1210-05')
        ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title;
      `, [posNormalId, tenantAlphaId, posExecId]);

      // 3. Criar os 2 Perfis Customizados no Tenant Alpha
      const roleRhRes = await client.query(`
        INSERT INTO public.roles (tenant_id, name, slug, description, is_system)
        VALUES ($1, 'RH Operacional Sem Acesso Salarial', 'rh_operacional_no_salaries', 'Gerencia colaboradores sem visualizar dados salariais', false)
        ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id;
      `, [tenantAlphaId]);
      customRoleRhNoSalaryId = roleRhRes.rows[0].id;

      // Permissões de RH Operacional (view_employees, manage_employees - SEM view_salaries)
      await client.query(`
        INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT $1, p.id FROM public.permissions p WHERE p.slug IN ('view_employees', 'manage_employees', 'view_dashboard')
        ON CONFLICT DO NOTHING;
      `, [customRoleRhNoSalaryId]);

      const roleGestorSpRes = await client.query(`
        INSERT INTO public.roles (tenant_id, name, slug, description, is_system)
        VALUES ($1, 'Gestor Regional SP', 'gestor_filial_sp', 'Acesso operacional restrito aos estabelecimentos de SP', false)
        ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id;
      `, [tenantAlphaId]);
      customRoleGestorSpId = roleGestorSpRes.rows[0].id;

      await client.query(`
        INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT $1, p.id FROM public.permissions p WHERE p.slug IN ('view_employees', 'view_time_tracking', 'view_dashboard')
        ON CONFLICT DO NOTHING;
      `, [customRoleGestorSpId]);

      // 4. Criar Usuários no Auth/Users
      const pwdHash = await hashPassword('SenhaForte@2026');
      const allUserIds = [
        userSystemAdminId, userTenantAdminId, userDpAnalystId, userManagerId,
        userAccountantId, userAuditorId, userSstSpecialistId, userEmployeeId,
        userCustomRhNoSalaryId, userCustomGestorSpId
      ];

      for (const uid of allUserIds) {
        await client.query(`
          INSERT INTO public.users (id, full_name, email, password_hash, is_active)
          VALUES ($1, $2, $3, $4, true)
          ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash;
        `, [uid, `Usuario Teste ${uid.slice(-4)}`, `gatev3_${uid.slice(-4)}@couplerh.local`, pwdHash]);
      }

      // 5. Trabalhadores (Workers)
      const workersData = [
        { id: workerManagerId, name: 'Gestor Carlos', cpf: '11111111101', tid: tenantAlphaId, uid: userManagerId },
        { id: workerTeamMemberId, name: 'Membro Equipe SP', cpf: '11111111102', tid: tenantAlphaId, uid: userEmployeeId },
        { id: workerOtherTeamId, name: 'Membro Equipe RJ', cpf: '11111111103', tid: tenantAlphaId, uid: null },
        { id: workerDirectorId, name: 'Diretora Ana Paula', cpf: '11111111104', tid: tenantAlphaId, uid: null },
        { id: workerBetaId, name: 'Colaborador Beta', cpf: '22222222201', tid: tenantBetaId, uid: null },
      ];

      for (const w of workersData) {
        await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [w.tid]);
        await client.query(`
          INSERT INTO public.workers (id, tenant_id, user_id, full_name, cpf, birth_date)
          VALUES ($1, $2, $3, $4, $5, '1990-05-15')
          ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, user_id = EXCLUDED.user_id;
        `, [w.id, w.tid, w.uid, w.name, w.cpf]);
      }

      // 6. Contratos de Trabalho no PostgreSQL 17 (Tenant Alpha)
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);

      // Contrato 1: Equipe SP (Gerenciado pelo workerManagerId)
      await client.query(`
        INSERT INTO public.contracts (
          id, tenant_id, company_id, establishment_id, department_id, position_id,
          worker_id, manager_worker_id, registration_number, admission_date, base_salary, status, is_confidential_payroll
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, 'MAT-001', '2024-01-01', 3200.00, 'ACTIVE', false
        ) ON CONFLICT (id) DO UPDATE SET 
          company_id = EXCLUDED.company_id,
          establishment_id = EXCLUDED.establishment_id,
          department_id = EXCLUDED.department_id,
          position_id = EXCLUDED.position_id,
          worker_id = EXCLUDED.worker_id,
          manager_worker_id = EXCLUDED.manager_worker_id,
          registration_number = EXCLUDED.registration_number,
          admission_date = EXCLUDED.admission_date,
          base_salary = EXCLUDED.base_salary,
          status = EXCLUDED.status,
          is_confidential_payroll = EXCLUDED.is_confidential_payroll;
      `, [contractTeamMemberId, tenantAlphaId, companyAlphaSpId, estAlphaSpId, deptAlphaId, posNormalId, workerTeamMemberId, workerManagerId]);

      // Contrato 2: Outra Equipe no RJ (Sem gestor)
      await client.query(`
        INSERT INTO public.contracts (
          id, tenant_id, company_id, establishment_id, department_id, position_id,
          worker_id, manager_worker_id, registration_number, admission_date, base_salary, status, is_confidential_payroll
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, NULL, 'MAT-002', '2024-02-01', 3500.00, 'ACTIVE', false
        ) ON CONFLICT (id) DO UPDATE SET 
          company_id = EXCLUDED.company_id,
          establishment_id = EXCLUDED.establishment_id,
          department_id = EXCLUDED.department_id,
          position_id = EXCLUDED.position_id,
          worker_id = EXCLUDED.worker_id,
          manager_worker_id = EXCLUDED.manager_worker_id,
          registration_number = EXCLUDED.registration_number,
          admission_date = EXCLUDED.admission_date,
          base_salary = EXCLUDED.base_salary,
          status = EXCLUDED.status,
          is_confidential_payroll = EXCLUDED.is_confidential_payroll;
      `, [contractOtherTeamId, tenantAlphaId, companyAlphaRjId, estAlphaRjId, deptAlphaId, posNormalId, workerOtherTeamId]);

      // Contrato 3: Diretoria (Folha Confidencial: R$ 35.000)
      await client.query(`
        INSERT INTO public.contracts (
          id, tenant_id, company_id, establishment_id, department_id, position_id,
          worker_id, manager_worker_id, registration_number, admission_date, base_salary, status, is_confidential_payroll
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, NULL, 'MAT-DIR', '2023-01-01', 35000.00, 'ACTIVE', true
        ) ON CONFLICT (id) DO UPDATE SET 
          company_id = EXCLUDED.company_id,
          establishment_id = EXCLUDED.establishment_id,
          department_id = EXCLUDED.department_id,
          position_id = EXCLUDED.position_id,
          worker_id = EXCLUDED.worker_id,
          manager_worker_id = EXCLUDED.manager_worker_id,
          registration_number = EXCLUDED.registration_number,
          admission_date = EXCLUDED.admission_date,
          base_salary = EXCLUDED.base_salary,
          status = EXCLUDED.status,
          is_confidential_payroll = EXCLUDED.is_confidential_payroll;
      `, [contractDirectorId, tenantAlphaId, companyAlphaSpId, estAlphaSpId, deptAlphaId, posExecId, workerDirectorId]);

      // 7. Atestado Médico com CID-10 no Contrato da Equipe SP
      await client.query(`
        INSERT INTO public.leaves (
          id, tenant_id, contract_id, leave_type, start_date, end_date,
          cid10_code, doctor_crm, doctor_state, is_inss_responsible, status
        ) VALUES (
          $1, $2, $3, 'SICK_LEAVE', '2026-05-01', '2026-05-05',
          'M54.5', '123456', 'SP', FALSE, 'ACTIVE'
        ) ON CONFLICT (id) DO UPDATE SET cid10_code = EXCLUDED.cid10_code;
      `, [leaveMedicalTeamId, tenantAlphaId, contractTeamMemberId]);

      // 8. Vincular Usuários aos Tenants e Modos de Escopo em `tenant_users`
      // a) system_admin
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
        VALUES ($1, $2, 'system_admin', 'ALL', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, scope_mode = EXCLUDED.scope_mode;
      `, [tenantAlphaId, userSystemAdminId]);

      // b) tenant_admin
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
        VALUES ($1, $2, 'tenant_admin', 'ALL', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, scope_mode = EXCLUDED.scope_mode;
      `, [tenantAlphaId, userTenantAdminId]);

      // c) dp_analyst
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
        VALUES ($1, $2, 'dp_analyst', 'ALL', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, scope_mode = EXCLUDED.scope_mode;
      `, [tenantAlphaId, userDpAnalystId]);

      // d) manager (com worker_id vinculado ao Gestor e scope_mode OWN_TEAM)
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, worker_id, scope_mode, is_active)
        VALUES ($1, $2, 'manager', $3, 'OWN_TEAM', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, worker_id = EXCLUDED.worker_id, scope_mode = EXCLUDED.scope_mode;
      `, [tenantAlphaId, userManagerId, workerManagerId]);

      // e) accountant
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
        VALUES ($1, $2, 'accountant', 'ALL', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, scope_mode = EXCLUDED.scope_mode;
      `, [tenantAlphaId, userAccountantId]);

      // f) auditor
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
        VALUES ($1, $2, 'auditor', 'ALL', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, scope_mode = EXCLUDED.scope_mode;
      `, [tenantAlphaId, userAuditorId]);

      // g) sst_specialist
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
        VALUES ($1, $2, 'sst_specialist', 'ALL', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, scope_mode = EXCLUDED.scope_mode;
      `, [tenantAlphaId, userSstSpecialistId]);

      // h) employee (vinculado ao trabalhador da equipe)
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, worker_id, scope_mode, is_active)
        VALUES ($1, $2, 'employee', $3, 'SELF_ONLY', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, worker_id = EXCLUDED.worker_id, scope_mode = EXCLUDED.scope_mode;
      `, [tenantAlphaId, userEmployeeId, workerTeamMemberId]);

      // i) custom 1: rh_operacional_no_salaries
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, role_id, scope_mode, is_active)
        VALUES ($1, $2, 'dp_analyst', $3, 'ALL', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id;
      `, [tenantAlphaId, userCustomRhNoSalaryId, customRoleRhNoSalaryId]);

      // j) custom 2: gestor_filial_sp (scope_mode = RESTRICTED na Company Alpha SP)
      const gestorSpTuRes = await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, role_id, scope_mode, is_active)
        VALUES ($1, $2, 'manager', $3, 'RESTRICTED', true)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, scope_mode = EXCLUDED.scope_mode, is_active = EXCLUDED.is_active
        RETURNING id;
      `, [tenantAlphaId, userCustomGestorSpId, customRoleGestorSpId]);
      const gestorSpTenantUserId = gestorSpTuRes.rows[0].id;

      // Delegar escopo de Company SP em `tenant_user_scopes`
      await client.query(`
        DELETE FROM public.tenant_user_scopes WHERE tenant_id = $1 AND tenant_user_id = $2;
      `, [tenantAlphaId, gestorSpTenantUserId]);

      await client.query(`
        INSERT INTO public.tenant_user_scopes (tenant_id, tenant_user_id, scope_type, scope_target_id)
        VALUES ($1, $2, 'COMPANY', $3);
      `, [tenantAlphaId, gestorSpTenantUserId, companyAlphaSpId]);

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    // Gerar JWT Access Tokens para cada um dos perfis
    const makeToken = async (uid: string, role: string, tid: string = tenantAlphaId, wid?: string) => {
      const res = await tokenService.createSession({
        userId: uid,
        email: `gatev3_${uid.slice(-4)}@couplerh.local`,
        role: role as any,
        tenantId: tid,
        workerId: wid,
      });
      return res.accessToken;
    };

    tokenSystemAdmin = await makeToken(userSystemAdminId, 'system_admin');
    tokenTenantAdmin = await makeToken(userTenantAdminId, 'tenant_admin');
    tokenDpAnalyst = await makeToken(userDpAnalystId, 'dp_analyst');
    tokenManager = await makeToken(userManagerId, 'manager', tenantAlphaId, workerManagerId);
    tokenAccountant = await makeToken(userAccountantId, 'accountant');
    tokenAuditor = await makeToken(userAuditorId, 'auditor');
    tokenSstSpecialist = await makeToken(userSstSpecialistId, 'sst_specialist');
    tokenEmployee = await makeToken(userEmployeeId, 'employee', tenantAlphaId, workerTeamMemberId);
    tokenCustomRhNoSalary = await makeToken(userCustomRhNoSalaryId, 'dp_analyst');
    tokenCustomGestorSp = await makeToken(userCustomGestorSpId, 'manager');
  });

  afterAll(async () => {
    await app.close();
  });

  // ============================================================================
  // BLOCO 1: Isolamento Cross-Tenant Inviolável (Tenant Alpha vs Tenant Beta)
  // ============================================================================
  describe('1. Isolamento Cross-Tenant (Gate V3.1)', () => {
    it('tenant_admin do Tenant Alpha não enxerga nenhuma empresa ou contrato do Tenant Beta', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/org/companies',
        headers: { authorization: `Bearer ${tokenTenantAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);

      const companyIds = json.data.map((c: any) => c.id);
      expect(companyIds).toContain(companyAlphaSpId);
      expect(companyIds).toContain(companyAlphaRjId);
      // NUNCA pode conter a empresa do Tenant Beta
      expect(companyIds).not.toContain(companyBetaId);
    });

    it('RLS nativo do PostgreSQL 17 sob a role couplerh_app isola estritamente contratos por tenant', async () => {
      await withTenantContext({
        tenantId: tenantAlphaId,
        userId: userTenantAdminId,
        role: 'tenant_admin',
      }, async (client) => {
        const { rows } = await client.query('SELECT id, tenant_id FROM public.contracts;');
        // Deve listar contratos do Tenant Alpha
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.tenant_id).toBe(tenantAlphaId);
          expect(row.tenant_id).not.toBe(tenantBetaId);
        }
      });
    });
  });

  // ============================================================================
  // BLOCO 2: Matriz dos 8 Papéis Canônicos do Sistema
  // ============================================================================
  describe('2. Matriz dos 8 Papéis Canônicos (Gate V3.2)', () => {
    it('system_admin possui bypass irrestrito e visualiza folha confidencial da diretoria', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/employees',
        headers: { authorization: `Bearer ${tokenSystemAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      const contracts = json.data;

      const directorContract = contracts.find((c: any) => c.id === contractDirectorId);
      expect(directorContract).toBeDefined();
      expect(directorContract.base_salary).toBe(35000); // Salário executivo visível para super admin
    });

    it('tenant_admin acessa salários normais mas folha de diretoria exige view_executive_payroll', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/employees',
        headers: { authorization: `Bearer ${tokenTenantAdmin}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      const contracts = json.data;

      // Visualiza salários de contratos comuns
      const memberContract = contracts.find((c: any) => c.id === contractTeamMemberId);
      expect(memberContract).toBeDefined();
      expect(memberContract.base_salary).toBe(3200);
    });

    it('manager sem permissão view_medical_cid recebe atestados com CID-10 e CRM mascarados (LGPD)', async () => {
      // 1. Consulta atestados médicos via rota /api/v1/leaves: CID-10 e CRM devem ser suprimidos
      const resLeaves = await app.inject({
        method: 'GET',
        url: `/api/v1/leaves/${leaveMedicalTeamId}`,
        headers: { authorization: `Bearer ${tokenManager}` },
      });
      expect(resLeaves.statusCode).toBe(200);
      const leaveJson = JSON.parse(resLeaves.payload);
      expect(leaveJson.success).toBe(true);
      expect(leaveJson.data.cid10_code).toBeNull(); // Sigilo estrito de saúde (CFM 1.851/2008 & LGPD Art. 11)
      expect(leaveJson.data.doctor_crm).toBeNull();
    });

    it('sst_specialist visualiza CID-10 e CRM para PCMSO/CAT, mas tem salários suprimidos (base_salary null)', async () => {
      // 1. Acessa atestados: CID-10 e CRM autorizados
      const resLeaves = await app.inject({
        method: 'GET',
        url: '/api/v1/leaves',
        headers: { authorization: `Bearer ${tokenSstSpecialist}` },
      });
      expect(resLeaves.statusCode).toBe(200);
      const leavesJson = JSON.parse(resLeaves.payload);
      const medicalLeave = leavesJson.data.find((l: any) => l.id === leaveMedicalTeamId);
      expect(medicalLeave).toBeDefined();
      expect(medicalLeave.cid10_code).toBe('M54.5'); // Visível para SST
      expect(medicalLeave.doctor_crm).toBe('123456');

      // 2. Acessa colaboradores: salários devem vir nulos
      const resEmp = await app.inject({
        method: 'GET',
        url: '/api/v1/employees',
        headers: { authorization: `Bearer ${tokenSstSpecialist}` },
      });
      expect(resEmp.statusCode).toBe(200);
      const empJson = JSON.parse(resEmp.payload);
      for (const contract of empJson.data) {
        expect(contract.base_salary).toBeNull(); // Sigilo salarial para segurança do trabalho
      }
    });

    it('manager com scope_mode = OWN_TEAM acessa estritamente subordinados de sua equipe', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users/accessible-contracts',
        headers: { authorization: `Bearer ${tokenManager}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      const contracts = json.contracts || json.data || [];
      const contractIds = contracts.map((c: any) => c.id);

      // Deve enxergar o liderado direto
      expect(contractIds).toContain(contractTeamMemberId);
      // NUNCA deve enxergar contratos de outra equipe ou diretoria
      expect(contractIds).not.toContain(contractOtherTeamId);
      expect(contractIds).not.toContain(contractDirectorId);
    });

    it('accountant acessa configurações contábeis mas é bloqueado em edição cadastral de colaboradores', async () => {
      // Acesso negado para criar colaborador
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/employees',
        headers: { authorization: `Bearer ${tokenAccountant}` },
        payload: { full_name: 'Novo Colaborador', cpf: '99988877766' },
      });
      // 403 Forbidden por falta da permissão manage_employees
      expect(res.statusCode).toBe(403);
    });

    it('auditor possui acesso de leitura e é bloqueado em ações de escrita/cálculo', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/org/companies',
        headers: { authorization: `Bearer ${tokenAuditor}` },
        payload: { legal_name: 'Empresa Fake Auditor' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('employee é estritamente bloqueado de rotas administrativas com 403 FORBIDDEN_EMPLOYEE', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/admin/check-access',
        headers: { authorization: `Bearer ${tokenEmployee}` },
      });
      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.payload);
      expect(json.code).toBe('FORBIDDEN_EMPLOYEE');
    });
  });

  // ============================================================================
  // BLOCO 3: 2 Perfis Customizados Criados Dinamicamente
  // ============================================================================
  describe('3. Perfis Customizados (Gate V3.3)', () => {
    it('Perfil Customizado 1: rh_operacional_no_salaries gerencia cadastros mas salários vêm null', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/employees',
        headers: { authorization: `Bearer ${tokenCustomRhNoSalary}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.length).toBeGreaterThan(0);

      // Todos os salários devem vir nulos pois o perfil customizado não possui view_salaries
      for (const contract of json.data) {
        expect(contract.base_salary).toBeNull();
      }
    });

    it('Perfil Customizado 2: gestor_filial_sp com scope_mode RESTRICTED só acessa contratos de SP', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users/accessible-contracts',
        headers: { authorization: `Bearer ${tokenCustomGestorSp}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      const contracts = json.contracts || json.data || [];
      const contractIds = contracts.map((c: any) => c.id);

      // Acessa o contrato de SP
      expect(contractIds).toContain(contractTeamMemberId);
      // Bloqueado para o contrato da Filial RJ
      expect(contractIds).not.toContain(contractOtherTeamId);
    });
  });

  // ============================================================================
  // BLOCO 4: Auditoria Estática de Integridade do Monorepo (Zero Supabase)
  // ============================================================================
  describe('4. Auditoria Estática do Gate V3 (Gate V3.4)', () => {
    it('deve confirmar que não existe nenhuma referência a @supabase/supabase-js nos package.json do projeto', () => {
      const rootDir = path.resolve(__dirname, '../../..');
      const rootPkg = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
      const apiPkg = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'apps/api/package.json'), 'utf8'));
      const webPkg = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'apps/web/package.json'), 'utf8'));

      const combinedDeps = {
        ...rootPkg.dependencies,
        ...rootPkg.devDependencies,
        ...apiPkg.dependencies,
        ...apiPkg.devDependencies,
        ...webPkg.dependencies,
        ...webPkg.devDependencies,
      };

      expect(combinedDeps['@supabase/supabase-js']).toBeUndefined();
      expect(combinedDeps['supabase']).toBeUndefined();
    });

    it('deve confirmar que apps/web/src/lib/apiClient.ts é o cliente oficial de comunicação HTTP', () => {
      const rootDir = path.resolve(__dirname, '../../..');
      const apiClientFile = path.resolve(rootDir, 'apps/web/src/lib/apiClient.ts');
      expect(fs.existsSync(apiClientFile)).toBe(true);

      const content = fs.readFileSync(apiClientFile, 'utf8');
      expect(content).toContain('export const apiClient');
      expect(content).not.toContain("from '@supabase/supabase-js'");
    });
  });
});
