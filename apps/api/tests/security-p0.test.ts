import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

describe('Blindagem Definitiva de Brechas P0 da Auditoria (SEC-05)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;

  // Tenants
  const tenantId = 'e0000000-0000-0000-0000-000000000001';
  const companyId = 'e0000000-0000-0000-0000-000000000010';

  // Usuários
  const systemAdminId = 'e0000000-0000-0000-0000-000000000100';
  const tenantAdminId = 'e0000000-0000-0000-0000-000000000200';
  const dpAnalystId = 'e0000000-0000-0000-0000-000000000300';
  const employee1UserId = 'e0000000-0000-0000-0000-000000000400';
  const employee2UserId = 'e0000000-0000-0000-0000-000000000500';

  // IDs em tenant_users
  const tenantUserAdminId = 'e0000000-0000-0000-0000-000000001200';
  const tenantUserTargetId = 'e0000000-0000-0000-0000-000000001300'; // registro de dpAnalyst em tenant_users

  // Trabalhadores e Contratos
  const worker1Id = 'e0000000-0000-0000-0000-000000000401';
  const worker2Id = 'e0000000-0000-0000-0000-000000000501';
  const workerInactiveId = 'e0000000-0000-0000-0000-000000000601';
  const workerInactiveUserId = 'e0000000-0000-0000-0000-000000000600';

  const contract1ActiveId = 'e0000000-0000-0000-0000-000000000402';
  const contract2ActiveId = 'e0000000-0000-0000-0000-000000000502';
  const contractInactiveId = 'e0000000-0000-0000-0000-000000000602';

  // Dispositivo REP
  const repDeviceId = 'e0000000-0000-0000-0000-000000000701';
  const repSerial = 'REP-TEST-CONTROLID-2026';
  const repApiKey = 'ChaveSecretaREP2026!@#';
  const repApiKeyHash = crypto.createHash('sha256').update(repApiKey).digest('hex');

  // Tokens JWT
  let tokenSystemAdmin: string;
  let tokenTenantAdmin: string;
  let tokenDpAnalyst: string;
  let tokenEmployee1: string;
  let tokenEmployee2: string;
  let tokenEmployeeInactive: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      // 1. Tenant e Empresa
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Empresa P0 Security', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;
      `, [tenantId]);

      await client.query(`
        INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj)
        VALUES ($1, $2, 'Empresa P0 Seguranca LTDA', 'P0 Security', '12345678000199')
        ON CONFLICT (id) DO NOTHING;
      `, [companyId, tenantId]);

      // 2. Usuários
      const pwdHash = await hashPassword('SenhaSegura2026!');
      await client.query(`
        INSERT INTO public.users (id, email, cpf, password_hash, full_name, is_active)
        VALUES 
          ($1, 'sysadmin@p0.com', '11111111111', $6, 'Super Admin Global', TRUE),
          ($2, 'admin@p0.com', '22222222222', $6, 'Admin Local Tenant', TRUE),
          ($3, 'analista@p0.com', '33333333333', $6, 'Analista de DP', TRUE),
          ($4, 'colab1@p0.com', '44444444444', $6, 'Carlos Colaborador Um', TRUE),
          ($5, 'colab2@p0.com', '55555555555', $6, 'Mariana Colaboradora Dois', TRUE),
          ($7, 'colab.inativo@p0.com', '66666666666', $6, 'Inativo Contratual', TRUE)
        ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active;
      `, [systemAdminId, tenantAdminId, dpAnalystId, employee1UserId, employee2UserId, pwdHash, workerInactiveUserId]);

      // 3. Vínculos em tenant_users
      await client.query(`
        INSERT INTO public.tenant_users (id, tenant_id, user_id, role, is_active)
        VALUES 
          (gen_random_uuid(), $1, $2, 'system_admin', TRUE),
          ($5, $1, $3, 'tenant_admin', TRUE),
          ($6, $1, $4, 'dp_analyst', TRUE),
          (gen_random_uuid(), $1, $7, 'employee', TRUE),
          (gen_random_uuid(), $1, $8, 'employee', TRUE),
          (gen_random_uuid(), $1, $9, 'employee', TRUE)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active;
      `, [tenantId, systemAdminId, tenantAdminId, dpAnalystId, tenantUserAdminId, tenantUserTargetId, employee1UserId, employee2UserId, workerInactiveUserId]);

      // 4. Trabalhadores
      await client.query(`
        INSERT INTO public.workers (id, tenant_id, user_id, full_name, cpf, pis)
        VALUES 
          ($1, $4, $5, 'Carlos Colaborador Um', '44444444444', '12345678901'),
          ($2, $4, $6, 'Mariana Colaboradora Dois', '55555555555', '23456789012'),
          ($3, $4, $7, 'Inativo Contratual', '66666666666', '34567890123')
        ON CONFLICT (id) DO UPDATE SET pis = EXCLUDED.pis;
      `, [worker1Id, worker2Id, workerInactiveId, tenantId, employee1UserId, employee2UserId, workerInactiveUserId]);

      // 4.1. Estabelecimento e Cargo para Contratos
      const establishmentId = 'e0000000-0000-0000-0000-000000000020';
      const positionId = 'e0000000-0000-0000-0000-000000000030';

      await client.query(`
        INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
        VALUES ($1, $2, $3, 'Matriz SP P0', '12345678000199')
        ON CONFLICT (id) DO NOTHING;
      `, [establishmentId, tenantId, companyId]);

      await client.query(`
        INSERT INTO public.positions (id, tenant_id, title)
        VALUES ($1, $2, 'Operador Geral P0')
        ON CONFLICT (id) DO NOTHING;
      `, [positionId, tenantId]);

      // 5. Contratos (Dois ativos e um inativo)
      await client.query(`
        INSERT INTO public.contracts (
          id, tenant_id, company_id, worker_id, establishment_id, position_id,
          registration_number, status, admission_date, base_salary
        )
        VALUES 
          ($1, $4, $5, $6, $7, $8, 'MAT-001', 'ACTIVE', '2024-01-10', 5000.00),
          ($2, $4, $5, $9, $7, $8, 'MAT-002', 'ACTIVE', '2024-02-15', 6500.00),
          ($3, $4, $5, $10, $7, $8, 'MAT-003', 'SUSPENDED', '2023-01-01', 3000.00)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;
      `, [contract1ActiveId, contract2ActiveId, contractInactiveId, tenantId, companyId, worker1Id, establishmentId, positionId, worker2Id, workerInactiveId]);

      // 6. Dispositivo REP com api_key_hash
      await client.query(`
        INSERT INTO public.time_devices (id, tenant_id, company_id, name, kind, serial_number, api_key_hash, status)
        VALUES ($1, $2, $3, 'Relogio Fabrica Control iD', 'REP_C', $4, $5, 'ACTIVE')
        ON CONFLICT (id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash;
      `, [repDeviceId, tenantId, companyId, repSerial, repApiKeyHash]);

      await client.query('COMMIT;');
    } catch (e) {
      await client.query('ROLLBACK;');
      throw e;
    } finally {
      client.release();
    }

    // Emite tokens JWT
    const s1 = await tokenService.createSession({ userId: systemAdminId, role: 'system_admin', tenantId });
    tokenSystemAdmin = s1.accessToken;

    const s2 = await tokenService.createSession({ userId: tenantAdminId, role: 'tenant_admin', tenantId });
    tokenTenantAdmin = s2.accessToken;

    const s3 = await tokenService.createSession({ userId: dpAnalystId, role: 'dp_analyst', tenantId });
    tokenDpAnalyst = s3.accessToken;

    const s4 = await tokenService.createSession({ userId: employee1UserId, role: 'employee', tenantId, workerId: worker1Id });
    tokenEmployee1 = s4.accessToken;

    const s5 = await tokenService.createSession({ userId: employee2UserId, role: 'employee', tenantId, workerId: worker2Id });
    tokenEmployee2 = s5.accessToken;

    const s6 = await tokenService.createSession({ userId: workerInactiveUserId, role: 'employee', tenantId, workerId: workerInactiveId });
    tokenEmployeeInactive = s6.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============================================================================
  // 1. RBAC e Blindagem Anti-Escalada de Privilégios
  // ============================================================================
  describe('1. Anti-Escalada de Privilégios (RBAC)', () => {
    it('deve bloquear dp_analyst de alterar papéis ou convidar usuários com 403 FORBIDDEN_ROLE', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/tenant-access/${tenantUserTargetId}`,
        headers: { authorization: `Bearer ${tokenDpAnalyst}` },
        payload: { role: 'tenant_admin' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.code).toBe('FORBIDDEN_PRIVILEGE_ESCALATION');
    });

    it('deve impedir tenant_admin de promover qualquer usuário para system_admin com 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/tenant-access/${tenantUserTargetId}`,
        headers: { authorization: `Bearer ${tokenTenantAdmin}` },
        payload: { role: 'system_admin' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Escalada de privilegio bloqueada');
    });

    it('deve impedir administrador de rebaixar ou desativar a si próprio para prevenir lockout', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/tenant-access/${tenantUserAdminId}`,
        headers: { authorization: `Bearer ${tokenTenantAdmin}` },
        payload: { role: 'employee', isActive: false },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.code).toBe('FORBIDDEN_SELF_MODIFICATION');
    });

    it('deve permitir a system_admin promover usuário para tenant_admin com sucesso', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/tenant-access/${tenantUserTargetId}`,
        headers: { authorization: `Bearer ${tokenSystemAdmin}` },
        payload: { role: 'tenant_admin' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.role).toBe('tenant_admin');
    });
  });

  // ============================================================================
  // 2. Fechamento e Reabertura de Folha (Correção do NULL NOT IN e Trava CLT)
  // ============================================================================
  describe('2. Fechamento e Reabertura de Folha (Eliminação de NULL NOT IN e Regras CLT)', () => {
    let periodValidId: string;
    let periodWithNetNegativeId: string;

    beforeAll(async () => {
      await withTenantContext({ tenantId, userId: systemAdminId, role: 'system_admin' }, async (client) => {
        // Período 1: Válido para fechamento
        const res1 = await client.query(`
          INSERT INTO public.payroll_periods (
            tenant_id, company_id, year, month, type, status, payment_date, competence_date
          ) VALUES ($1, $2, 2026, 11, 'MONTHLY', 'CALCULATED', '2026-12-05', '2026-11-01')
          ON CONFLICT (tenant_id, company_id, year, month, type) DO UPDATE 
            SET status = 'CALCULATED', closed_at = NULL, closed_by = NULL
          RETURNING id;
        `, [tenantId, companyId]);
        periodValidId = res1.rows[0].id;

        // Holerite válido para Período 1
        await client.query(`
          INSERT INTO public.payslips (
            tenant_id, payroll_period_id, contract_id, worker_id, gross_salary,
            total_earnings, total_deductions, net_salary, status
          ) VALUES ($1, $2, $3, $4, 5000.00, 5000.00, 500.00, 4500.00, 'CALCULATED')
          ON CONFLICT (payroll_period_id, contract_id) DO UPDATE
            SET status = 'CALCULATED', net_salary = 4500.00;
        `, [tenantId, periodValidId, contract1ActiveId, worker1Id]);

        // Período 2: Com colaborador de líquido negativo (infringindo CLT Art. 462)
        const res2 = await client.query(`
          INSERT INTO public.payroll_periods (
            tenant_id, company_id, year, month, type, status, payment_date, competence_date
          ) VALUES ($1, $2, 2026, 10, 'MONTHLY', 'CALCULATED', '2026-11-05', '2026-10-01')
          ON CONFLICT (tenant_id, company_id, year, month, type) DO UPDATE 
            SET status = 'CALCULATED', closed_at = NULL, closed_by = NULL
          RETURNING id;
        `, [tenantId, companyId]);
        periodWithNetNegativeId = res2.rows[0].id;

        await client.query(`
          INSERT INTO public.payslips (
            tenant_id, payroll_period_id, contract_id, worker_id, gross_salary,
            total_earnings, total_deductions, net_salary, status
          ) VALUES ($1, $2, $3, $4, 3000.00, 3000.00, 3500.00, -500.00, 'CALCULATED')
          ON CONFLICT (payroll_period_id, contract_id) DO UPDATE
            SET status = 'CALCULATED', net_salary = -500.00;
        `, [tenantId, periodWithNetNegativeId, contract2ActiveId, worker2Id]);
      });
    });

    it('deve bloquear colaborador (employee) de fechar folha de pagamento com 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/payroll/periods/${periodValidId}/close`,
        headers: { authorization: `Bearer ${tokenEmployee1}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('deve bloquear fechamento de folha quando houver holerite com líquido negativo (CLT Art. 462)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/payroll/periods/${periodWithNetNegativeId}/close`,
        headers: { authorization: `Bearer ${tokenTenantAdmin}` },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('CLT Art. 462');
    });

    it('deve fechar folha válida com sucesso e travar os holerites', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/payroll/periods/${periodValidId}/close`,
        headers: { authorization: `Bearer ${tokenTenantAdmin}` },
        payload: { notes: 'Fechamento homologado com 100% de sucesso contábil' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('CLOSED');
    });

    it('deve rejeitar reabertura de folha com justificativa curta (< 15 caracteres)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/payroll/periods/${periodValidId}/reopen`,
        headers: { authorization: `Bearer ${tokenTenantAdmin}` },
        payload: { reason: 'Curto demais' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('mínimo 15 caracteres');
    });

    it('deve reabrir folha fechada com justificativa legal válida e registrar na trilha de auditoria', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/payroll/periods/${periodValidId}/reopen`,
        headers: { authorization: `Bearer ${tokenTenantAdmin}` },
        payload: { reason: 'Reabertura autorizada para inclusao de atestado medico retroativo homologado' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('OPEN');

      // Verifica se registrou em payroll_period_reopenings no escopo do tenant
      await withTenantContext({ tenantId, userId: systemAdminId, role: 'system_admin' }, async (client) => {
        const { rows } = await client.query(
          'SELECT reason FROM public.payroll_period_reopenings WHERE payroll_period_id = $1;',
          [periodValidId]
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0].reason).toContain('atestado medico');
      });
    });
  });

  // ============================================================================
  // 3. Ponto Mobile e Blindagem IDOR
  // ============================================================================
  describe('3. Ponto Mobile Seguro e Blindagem IDOR', () => {
    it('deve bloquear colaborador de bater ponto para outro worker_id com 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/time-tracking/mobile/punch',
        headers: { authorization: `Bearer ${tokenEmployee1}` },
        payload: {
          workerId: worker2Id, // IDOR: worker1 tentando registrar para worker2
          punchType: 'ENTRY',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('FORBIDDEN_PUNCH_OWNERSHIP');
    });

    it('deve bloquear batida de ponto para colaborador com contrato INACTIVE com 422', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/time-tracking/mobile/punch',
        headers: { authorization: `Bearer ${tokenEmployeeInactive}` },
        payload: {
          workerId: workerInactiveId,
          punchType: 'ENTRY',
        },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INACTIVE_CONTRACT');
    });

    it('deve permitir registro legítimo de ponto mobile com NSR sequencial e hash SHA-256', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/time-tracking/mobile/punch',
        headers: { authorization: `Bearer ${tokenEmployee1}` },
        payload: {
          workerId: worker1Id,
          punchType: 'ENTRY',
          latitude: -23.55052,
          longitude: -46.633308,
          accuracy: 12.5,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.nsr).toBeGreaterThan(0);
      expect(body.data.sha256_hash).toBeDefined();
    });
  });

  // ============================================================================
  // 4. Ingestão Segura de Relógio Físico REP (timingSafeEqual + Lookup workers.pis_pasep)
  // ============================================================================
  describe('4. Ingestão Segura de Coletor Físico REP', () => {
    it('deve rejeitar ingestão sem headers x-rep-serial ou x-rep-api-key com 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/time-tracking/rep/ingest',
        payload: {
          records: [{ nsr: 1, pis: '12345678901', punchedAt: new Date().toISOString() }],
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('REP_AUTH_REQUIRED');
    });

    it('deve rejeitar chave de coletor adulterada com 401 timingSafeEqual', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/time-tracking/rep/ingest',
        headers: {
          'x-rep-serial': repSerial,
          'x-rep-api-key': 'ChaveCompletamenteIncorreta!',
        },
        payload: {
          records: [{ nsr: 1, pis: '12345678901', punchedAt: new Date().toISOString() }],
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('REP_INVALID_CREDENTIALS');
    });

    it('deve processar lote REP com chave válida e localizar colaborador via workers.pis_pasep', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/time-tracking/rep/ingest',
        headers: {
          'x-rep-serial': repSerial,
          'x-rep-api-key': repApiKey,
        },
        payload: {
          records: [
            {
              nsr: 101,
              pis: '123.45678.90-1', // PIS do Worker 1 com formatação
              punchedAt: '2026-11-23T08:00:00.000Z',
              punchType: 'ENTRY',
            },
            {
              nsr: 102,
              pis: '23456789012', // PIS do Worker 2 sem formatação
              punchedAt: '2026-11-23T08:05:00.000Z',
              punchType: 'ENTRY',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.processed).toBe(2);
      expect(body.orphans).toBe(0);
    });
  });

  // ============================================================================
  // 5. Assinatura Digital de Documentos e Ownership
  // ============================================================================
  describe('5. Assinatura Digital de Documentos e Blindagem IDOR', () => {
    let docWorker1Id: string;

    beforeAll(async () => {
      await withTenantContext({ tenantId, userId: systemAdminId, role: 'system_admin' }, async (client) => {
        // Arquivo dummy com caminho único
        const storagePath = `docs/recibo-${Date.now()}-${Math.random().toString(36).substring(7)}.pdf`;
        const fileRes = await client.query(`
          INSERT INTO public.stored_files (
            tenant_id, category, original_name, mime_type, byte_size, sha256_hash, storage_rel_path, is_private
          ) VALUES ($1, 'DOCUMENT', 'recibo.pdf', 'application/pdf', 1024, 'hash123', $2, TRUE)
          RETURNING id;
        `, [tenantId, storagePath]);

        // Documento do Worker 1
        const docRes = await client.query(`
          INSERT INTO public.employee_documents (
            tenant_id, worker_id, contract_id, file_id, title, category, status, requires_signature
          ) VALUES ($1, $2, $3, $4, 'Recibo de Ferias 2026', 'PAYROLL', 'PENDING', TRUE)
          RETURNING id;
        `, [tenantId, worker1Id, contract1ActiveId, fileRes.rows[0].id]);
        docWorker1Id = docRes.rows[0].id;
      });
    });

    it('deve bloquear colaborador 2 de assinar documento pertencente ao colaborador 1 com 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${docWorker1Id}/sign`,
        headers: { authorization: `Bearer ${tokenEmployee2}` },
        payload: { signatureType: 'ELECTRONIC_PIN' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('FORBIDDEN_DOCUMENT_OWNER');
    });

    it('deve permitir ao titular (colaborador 1) assinar seu próprio documento com sucesso', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${docWorker1Id}/sign`,
        headers: { authorization: `Bearer ${tokenEmployee1}` },
        payload: { signatureType: 'ELECTRONIC_PIN' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.sha256Hash).toBeDefined();
    });
  });

  // ============================================================================
  // 6. Proteção Geral contra Acesso Anônimo
  // ============================================================================
  describe('6. Bloqueio Geral de Endpoints sem Autenticação', () => {
    it('deve barrar acesso anônimo em /api/v1/termination/calculate com 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/termination/calculate',
        payload: { contractId: contract1ActiveId },
      });
      expect(res.statusCode).toBe(401);
    });

    it('deve barrar acesso anônimo em /api/v1/bi/dashboard com 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/bi/dashboard',
      });
      expect(res.statusCode).toBe(401);
    });

    it('deve permitir acesso autorizado de RH ao dashboard de BI', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/bi/dashboard',
        headers: { authorization: `Bearer ${tokenTenantAdmin}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.contracts.active).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================================
  // 7. Únicos Endpoints Públicos com Mascaramento Estrito LGPD
  // ============================================================================
  describe('7. Endpoints Públicos de Verificação com Mascaramento Estrito LGPD', () => {
    it('deve responder publicamente na verificação de documento SEM expor dados sensíveis ou CPF desmascarado', async () => {
      let testDocId: string;
      await withTenantContext({ tenantId, userId: systemAdminId, role: 'system_admin' }, async (client) => {
        const { rows } = await client.query('SELECT id FROM public.employee_documents LIMIT 1;');
        testDocId = rows[0]?.id;
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/public/verify-document/${testDocId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.document.valid).toBe(true);
      expect(body.document.signer_cpf_masked).toContain('***');
      expect(body.document.signer_cpf_masked).not.toBe('44444444444'); // Não expõe o CPF real
      expect(body.document.signer_name_masked).toBeDefined();
    });

    it('deve responder publicamente na verificação de ponto SEM expor dados salariais ou CPF desmascarado', async () => {
      let testPunchId: string;
      await withTenantContext({ tenantId, userId: systemAdminId, role: 'system_admin' }, async (client) => {
        const { rows } = await client.query('SELECT id FROM public.time_punch_records LIMIT 1;');
        testPunchId = rows[0]?.id;
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/public/verify-punch/${testPunchId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.punch.valid).toBe(true);
      expect(body.punch.worker_cpf_masked).toContain('***');
      expect(body.punch.worker_cpf_masked).not.toBe('12345678901');
      expect(body.punch.worker_name_masked).toBeDefined();
    });
  });
});
