import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

describe('RBAC-04: Sigilo Salarial, Folha Confidencial de Diretoria e Mascaramento LGPD Real', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;

  const tenantId = 'f0000000-0000-0000-0000-000000000001';
  const companyId = 'f0000000-0000-0000-0000-000000000002';
  const establishmentId = 'f0000000-0000-0000-0000-000000000003';
  const departmentId = 'f0000000-0000-0000-0000-000000000004';
  const positionId = 'f0000000-0000-0000-0000-000000000005';
  const positionDirectorId = 'f0000000-0000-0000-0000-000000000006';

  // Usuários de Teste
  const adminUserId = 'f0000000-0000-0000-0000-000000000010';
  const managerUserId = 'f0000000-0000-0000-0000-000000000020';
  const sstUserId = 'f0000000-0000-0000-0000-000000000030';

  // Colaboradores e Contratos
  const workerNormalId = 'f0000000-0000-0000-0000-000000000040';
  const contractNormalId = 'f0000000-0000-0000-0000-000000000041';

  const workerDirectorId = 'f0000000-0000-0000-0000-000000000050';
  const contractDirectorId = 'f0000000-0000-0000-0000-000000000051';

  const leaveMedicalId = 'f0000000-0000-0000-0000-000000000060';

  let tokenAdmin: string;
  let tokenManager: string;
  let tokenSst: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');

      // Contexto administrativo
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      // 1. Criar Tenant
      await client.query(
        `INSERT INTO public.tenants (id, name, status, settings)
         VALUES ($1, 'Acme Corp LGPD Test', 'ACTIVE', '{}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';`,
        [tenantId]
      );

      // 2. Criar Estrutura Básica
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj)
         VALUES ($1, $2, 'Acme Corp S.A.', 'Acme Corp', '88.888.888/0001-88')
         ON CONFLICT (id) DO NOTHING;`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1, $2, $3, 'Matriz SP', '88.888.888/0001-88')
         ON CONFLICT (id) DO NOTHING;`,
        [establishmentId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.departments (id, tenant_id, company_id, code, name)
         VALUES ($1, $2, $3, 'TI', 'Tecnologia da Informação')
         ON CONFLICT (id) DO NOTHING;`,
        [departmentId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, company_id, title, cbo)
         VALUES ($1, $2, $3, 'Desenvolvedor Senior', '2124-05')
         ON CONFLICT (id) DO NOTHING;`,
        [positionId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, company_id, title, cbo)
         VALUES ($1, $2, $3, 'Diretor Executivo', '1210-10')
         ON CONFLICT (id) DO NOTHING;`,
        [positionDirectorId, tenantId, companyId]
      );

      // 3. Criar Usuários
      const passwordHash = await hashPassword('SenhaSegura123!');

      await client.query(
        `INSERT INTO public.users (id, full_name, email, password_hash, is_active)
         VALUES
           ($1, 'Admin LGPD', 'admin.lgpd@acme.com', $4, TRUE),
           ($2, 'Manager LGPD', 'manager.lgpd@acme.com', $4, TRUE),
           ($3, 'SST LGPD', 'sst.lgpd@acme.com', $4, TRUE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE;`,
        [adminUserId, managerUserId, sstUserId, passwordHash]
      );

      // Vincular Tenant Users com papéis do catálogo
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES
           ($1, $2, 'tenant_admin', 'ALL', TRUE),
           ($1, $3, 'manager', 'ALL', TRUE),
           ($1, $4, 'sst_specialist', 'ALL', TRUE)
         ON CONFLICT (tenant_id, user_id) DO UPDATE
         SET role = EXCLUDED.role, scope_mode = EXCLUDED.scope_mode, is_active = TRUE;`,
        [tenantId, adminUserId, managerUserId, sstUserId]
      );

      // 4. Cadastrar Colaborador Normal
      await client.query(
        `INSERT INTO public.workers (
          id, tenant_id, full_name, cpf, rg, pis, birth_date, gender, email, phone,
          bank_code, bank_agency, bank_account, pix_key, pix_key_type, is_active
        ) VALUES (
          $1, $2, 'Carlos Silva Operacional', '71122233344', '123456789', '12345678901',
          '1990-05-15', 'M', 'carlos.silva@acme.com', '11988887777',
          '001', '1234', '56789', 'carlos.silva@acme.com', 'EMAIL', TRUE
        ) ON CONFLICT (tenant_id, cpf) DO UPDATE
        SET full_name = EXCLUDED.full_name
        RETURNING id;`,
        [workerNormalId, tenantId]
      );

      await client.query(
        `INSERT INTO public.contracts (
          id, tenant_id, worker_id, company_id, establishment_id, department_id,
          position_id, registration_number, admission_date, base_salary, status,
          is_confidential_payroll
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, 'MAT-001', '2023-01-10', 4500.00, 'ACTIVE',
          FALSE
        ) ON CONFLICT (tenant_id, company_id, registration_number) DO UPDATE
        SET base_salary = EXCLUDED.base_salary;`,
        [contractNormalId, tenantId, workerNormalId, companyId, establishmentId, departmentId, positionId]
      );

      // 5. Cadastrar Colaborador de Diretoria (Folha Confidencial)
      await client.query(
        `INSERT INTO public.workers (
          id, tenant_id, full_name, cpf, rg, pis, birth_date, gender, email, phone,
          bank_code, bank_agency, bank_account, pix_key, pix_key_type, is_active
        ) VALUES (
          $1, $2, 'Roberto Diretor Executivo', '79988877766', '987654321', '98765432100',
          '1975-08-20', 'M', 'roberto.diretor@acme.com', '11999990000',
          '237', '4321', '98765', '79988877766', 'CPF', TRUE
        ) ON CONFLICT (tenant_id, cpf) DO UPDATE
        SET full_name = EXCLUDED.full_name
        RETURNING id;`,
        [workerDirectorId, tenantId]
      );

      await client.query(
        `INSERT INTO public.contracts (
          id, tenant_id, worker_id, company_id, establishment_id, department_id,
          position_id, registration_number, admission_date, base_salary, status,
          is_confidential_payroll
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, 'MAT-DIR-001', '2020-01-01', 35000.00, 'ACTIVE',
          TRUE
        ) ON CONFLICT (tenant_id, company_id, registration_number) DO UPDATE
        SET base_salary = EXCLUDED.base_salary;`,
        [contractDirectorId, tenantId, workerDirectorId, companyId, establishmentId, departmentId, positionDirectorId]
      );

      // 6. Cadastrar Afastamento Médico com CID-10 no Contrato Normal
      await client.query(
        `INSERT INTO public.leaves (
          id, tenant_id, contract_id, leave_type, start_date, end_date,
          cid10_code, doctor_crm, doctor_state, is_inss_responsible, status
        ) VALUES (
          $1, $2, $3, 'SICK_LEAVE', '2026-03-01', '2026-03-10',
          'M54.5', '123456', 'SP', FALSE, 'ACTIVE'
        ) ON CONFLICT (id) DO UPDATE
        SET cid10_code = EXCLUDED.cid10_code;`,
        [leaveMedicalId, tenantId, contractNormalId]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    // Gerar Tokens de Acesso JWT
    const sAdmin = await tokenService.createSession({
      userId: adminUserId,
      email: 'admin.lgpd@acme.com',
      tenantId: tenantId,
      role: 'tenant_admin',
    });
    tokenAdmin = sAdmin.accessToken;

    const sManager = await tokenService.createSession({
      userId: managerUserId,
      email: 'manager.lgpd@acme.com',
      tenantId: tenantId,
      role: 'manager',
    });
    tokenManager = sManager.accessToken;

    const sSst = await tokenService.createSession({
      userId: sstUserId,
      email: 'sst.lgpd@acme.com',
      tenantId: tenantId,
      role: 'sst_specialist',
    });
    tokenSst = sSst.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Gestor (manager) sem permissão view_salaries deve receber base_salary nulo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/employees',
      headers: { authorization: `Bearer ${tokenManager}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    const normalEmp = body.data.find((e: any) => e.id === contractNormalId);
    expect(normalEmp).toBeDefined();
    expect(normalEmp.base_salary).toBeNull(); // Sigilo Salarial garantido
  });

  it('2. Gestor (manager) sem permissão view_pii_unmasked deve receber dados pessoais mascarados', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contractNormalId}`,
      headers: { authorization: `Bearer ${tokenManager}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    const worker = body.data.worker;

    expect(worker.cpf).toBe('***.222.333-**'); // Mascaramento de CPF
    expect(worker.rg).toBe('***');
    expect(worker.pis).toBe('***.*****.0-1'); // Mascaramento de PIS
    expect(worker.bank_agency).toBe('***-4');
    expect(worker.bank_account).toBe('*****-9');
    expect(worker.pix_key).toBe('ca***om');
  });

  it('3. Gestor (manager) sem view_executive_payroll NÃO deve ver contrato de diretoria na listagem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/employees',
      headers: { authorization: `Bearer ${tokenManager}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const director = body.data.find((e: any) => e.id === contractDirectorId);
    expect(director).toBeUndefined(); // Folha confidencial oculta
  });

  it('4. Gestor (manager) que tentar acessar contrato de diretoria diretamente recebe bloqueio (403 ou 404 via RLS)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contractDirectorId}`,
      headers: { authorization: `Bearer ${tokenManager}` },
    });

    expect([403, 404]).toContain(res.statusCode);
  });

  it('5. Administrador (tenant_admin) com permissões completas recebe salários e PII desmascarado', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contractNormalId}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    expect(body.data.base_salary).toBe(4500); // Salário visível
    expect(body.data.worker.cpf).toBe('71122233344'); // CPF desmascarado
    expect(body.data.worker.bank_account).toBe('56789');
    expect(body.data.worker.pix_key).toBe('carlos.silva@acme.com');
  });

  it('6. Gestor (manager) sem permissão view_medical_cid deve receber CID-10 e CRM nulos em afastamentos', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/leaves/${leaveMedicalId}`,
      headers: { authorization: `Bearer ${tokenManager}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    // Conformidade com Resolução CFM 1.851/2008 & LGPD Art. 11
    expect(body.data.cid10_code).toBeNull();
    expect(body.data.doctor_crm).toBeNull();
    expect(body.data.doctor_state).toBeNull();
    expect(body.data.certificate_file_id).toBeNull();
  });

  it('7. Especialista SST (sst_specialist) com permissão view_medical_cid deve visualizar CID-10 e CRM', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/leaves/${leaveMedicalId}`,
      headers: { authorization: `Bearer ${tokenSst}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    expect(body.data.cid10_code).toBe('M54.5');
    expect(body.data.doctor_crm).toBe('123456');
    expect(body.data.doctor_state).toBe('SP');
  });

  it('8. Especialista SST (sst_specialist) NÃO deve conseguir ver salários em /employees', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contractNormalId}`,
      headers: { authorization: `Bearer ${tokenSst}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    expect(body.data.base_salary).toBeNull(); // Zero vazamento salarial para SST
  });

  it('9. View SQL view_contracts_masked deve mascarar dados nativamente no PostgreSQL', async () => {
    await withTenantContext(
      { userId: managerUserId, tenantId, role: 'manager' },
      async (client) => {
        const { rows } = await client.query(
          `SELECT id, base_salary, cpf, rg, pis, bank_agency, bank_account, pix_key
           FROM public.view_contracts_masked
           WHERE id = $1::uuid;`,
          [contractNormalId]
        );

        expect(rows.length).toBe(1);
        expect(rows[0].base_salary).toBeNull();
        expect(rows[0].cpf).toBe('***.222.333-**');
        expect(rows[0].rg).toBe('***');
        expect(rows[0].pis).toBe('***.*****.0-1');
        expect(rows[0].bank_agency).toBe('***-4');
        expect(rows[0].bank_account).toBe('*****-9');
      }
    );
  });

  it('10. View SQL view_leaves_masked deve suprimir CID-10 nativamente no PostgreSQL para usuário comum', async () => {
    await withTenantContext(
      { userId: managerUserId, tenantId, role: 'manager' },
      async (client) => {
        const { rows } = await client.query(
          `SELECT id, cid10_code, doctor_crm, doctor_state
           FROM public.view_leaves_masked
           WHERE id = $1::uuid;`,
          [leaveMedicalId]
        );

        expect(rows.length).toBe(1);
        expect(rows[0].cid10_code).toBeNull();
        expect(rows[0].doctor_crm).toBeNull();
        expect(rows[0].doctor_state).toBeNull();
      }
    );
  });
});
