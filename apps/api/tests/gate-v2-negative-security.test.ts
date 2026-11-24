import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { signJwt } from '../src/shared/security/jwtHelper.js';
import { env } from '../src/config/env.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { StorageService } from '../src/shared/storage/StorageService.js';
import { LocalFsStorageAdapter } from '../src/shared/storage/LocalFsStorageAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

describe('Bateria TDD Negativa de Segurança P0 — Gate V2 Oficial', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let storageService: StorageService;

  // Prefix f0000000 para isolamento de dados do Gate V2
  const tenantAId = 'f0000000-0000-0000-0000-000000000001';
  const tenantBId = 'f0000000-0000-0000-0000-000000000002';
  const companyAId = 'f0000000-0000-0000-0000-000000000010';
  const companyBId = 'f0000000-0000-0000-0000-000000000020';

  // Usuários
  const systemAdminId = 'f0000000-0000-0000-0000-000000000100';
  const tenantAdminId = 'f0000000-0000-0000-0000-000000000200';
  const dpAnalystId = 'f0000000-0000-0000-0000-000000000300';
  const workerAUserId = 'f0000000-0000-0000-0000-000000000400';
  const workerBUserId = 'f0000000-0000-0000-0000-000000000500';
  const replayTestUserId = 'f0000000-0000-0000-0000-000000000700';

  const tenantUserAdminId = 'f0000000-0000-0000-0000-000000001200';
  const tenantUserDpId = 'f0000000-0000-0000-0000-000000001300';

  const workerAId = 'f0000000-0000-0000-0000-000000000401';
  const workerBId = 'f0000000-0000-0000-0000-000000000501';

  const contractAId = 'f0000000-0000-0000-0000-000000000402';
  const contractBId = 'f0000000-0000-0000-0000-000000000502';

  const docBId = 'f0000000-0000-0000-0000-000000000505';

  let tokenSystemAdmin: string;
  let tokenTenantAdmin: string;
  let tokenDpAnalyst: string;
  let tokenWorkerA: string;
  let tokenWorkerB: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const testStorageDir = path.resolve(process.cwd(), 'tmp/test-gate2-storage');
    if (!fs.existsSync(testStorageDir)) {
      fs.mkdirSync(testStorageDir, { recursive: true });
    }
    const adapter = new LocalFsStorageAdapter(testStorageDir);
    storageService = new StorageService(adapter, 'chave-hmac-secreta-gate2-32bytes-ok!!');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');

      // 1. Tenants e Empresas (respeitando RLS por tenant)
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings) VALUES 
          ('${tenantAId}', 'Empresa Gate V2 A', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';

        INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj, status) VALUES
          ('${companyAId}', '${tenantAId}', 'Empresa Gate V2 A LTDA', 'Gate V2 A', '11111111000111', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING;
      `);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings) VALUES 
          ('${tenantBId}', 'Empresa Gate V2 B', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';

        INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj, status) VALUES
          ('${companyBId}', '${tenantBId}', 'Empresa Gate V2 B LTDA', 'Gate V2 B', '22222222000122', 'ACTIVE')
        ON CONFLICT (id) DO NOTHING;
      `);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);

      // 2. Cargos e Estabelecimentos
      const posAId = 'f0000000-0000-0000-0000-000000000410';
      const estAId = 'f0000000-0000-0000-0000-000000000430';

      await client.query(`
        INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj) VALUES
          ('${estAId}', '${tenantAId}', '${companyAId}', 'Matriz Gate V2 A', '11111111000111')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.positions (id, tenant_id, title) VALUES
          ('${posAId}', '${tenantAId}', 'Analista CLT Gate V2')
        ON CONFLICT (id) DO NOTHING;
      `);

      // 3. Usuários e Hashes Argon2id
      const defaultHash = await hashPassword('SenhaSegura2026!@#');
      await client.query(`
        INSERT INTO public.users (id, email, password_hash, full_name, cpf, is_active) VALUES
          ('${systemAdminId}', 'sysadmin.gate2@couplerh.com', '${defaultHash}', 'Sys Admin Gate 2', '99999999999', TRUE),
          ('${tenantAdminId}', 'tenantadmin.gate2@couplerh.com', '${defaultHash}', 'Tenant Admin Gate 2', '88888888888', TRUE),
          ('${dpAnalystId}', 'dp.gate2@couplerh.com', '${defaultHash}', 'DP Analyst Gate 2', '77777777777', TRUE),
          ('${workerAUserId}', 'worker.a.gate2@couplerh.com', '${defaultHash}', 'Colaborador Gate A', '11122233344', TRUE),
          ('${workerBUserId}', 'worker.b.gate2@couplerh.com', '${defaultHash}', 'Colaborador Gate B', '55566677788', TRUE),
          ('${replayTestUserId}', 'replay.test.gate2@couplerh.com', '${defaultHash}', 'Replay Tester', '12312312312', TRUE)
        ON CONFLICT (id) DO UPDATE SET is_active = TRUE, password_hash = EXCLUDED.password_hash;

        INSERT INTO public.tenant_users (id, tenant_id, user_id, role, scope_mode, is_active) VALUES
          ('${tenantUserAdminId}', '${tenantAId}', '${tenantAdminId}', 'tenant_admin', 'ALL', TRUE),
          ('${tenantUserDpId}', '${tenantAId}', '${dpAnalystId}', 'dp_analyst', 'ALL', TRUE),
          ('f0000000-0000-0000-0000-000000001400', '${tenantAId}', '${workerAUserId}', 'employee', 'SELF_ONLY', TRUE),
          ('f0000000-0000-0000-0000-000000001500', '${tenantAId}', '${workerBUserId}', 'employee', 'SELF_ONLY', TRUE),
          ('f0000000-0000-0000-0000-000000001700', '${tenantAId}', '${replayTestUserId}', 'tenant_admin', 'ALL', TRUE)
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, scope_mode = EXCLUDED.scope_mode, is_active = TRUE;
      `);

      // 4. Trabalhadores e Contratos
      await client.query(`
        INSERT INTO public.workers (id, tenant_id, user_id, full_name, cpf, pis, birth_date) VALUES
          ('${workerAId}', '${tenantAId}', '${workerAUserId}', 'Colaborador Gate A', '11122233344', '11122233445', '1990-01-15'),
          ('${workerBId}', '${tenantAId}', '${workerBUserId}', 'Colaborador Gate B', '55566677788', '55566677889', '1992-05-20')
        ON CONFLICT (id) DO UPDATE SET pis = EXCLUDED.pis;

        INSERT INTO public.contracts (id, tenant_id, company_id, worker_id, establishment_id, position_id, registration_number, admission_date, status, base_salary) VALUES
          ('${contractAId}', '${tenantAId}', '${companyAId}', '${workerAId}', '${estAId}', '${posAId}', 'REG-GATE-A', '2025-01-01', 'ACTIVE', 3500.00),
          ('${contractBId}', '${tenantAId}', '${companyAId}', '${workerBId}', '${estAId}', '${posAId}', 'REG-GATE-B', '2025-01-01', 'ACTIVE', 4000.00)
        ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';
      `);

      // 5. Arquivo e Documento Trabalhista pertencente a Colaborador B
      const fileRes = await client.query(`
        INSERT INTO public.stored_files (
          tenant_id, category, original_name, mime_type, byte_size, sha256_hash, storage_rel_path, is_private
        ) VALUES (
          '${tenantAId}', 'DOCUMENT', 'contrato_b.pdf', 'application/pdf', 2048, 'hash_doc_b_sha256', 'contracts/contrato_b_${Date.now()}.pdf', TRUE
        )
        RETURNING id;
      `);

      await client.query(`
        INSERT INTO public.employee_documents (
          id, tenant_id, worker_id, contract_id, file_id, title, category, status, requires_signature
        ) VALUES (
          '${docBId}', '${tenantAId}', '${workerBId}', '${contractBId}', '${fileRes.rows[0].id}', 'Contrato de Trabalho do Colaborador B', 'CONTRACT', 'PENDING', TRUE
        )
        ON CONFLICT (id) DO NOTHING;
      `);

      await client.query('COMMIT;');
    } catch (e) {
      await client.query('ROLLBACK;');
      throw e;
    } finally {
      client.release();
    }

    // Gerar tokens de teste
    const s1 = await tokenService.createSession({ userId: systemAdminId, role: 'system_admin', tenantId: tenantAId });
    tokenSystemAdmin = s1.accessToken;

    const s2 = await tokenService.createSession({ userId: tenantAdminId, role: 'tenant_admin', tenantId: tenantAId });
    tokenTenantAdmin = s2.accessToken;

    const s3 = await tokenService.createSession({ userId: dpAnalystId, role: 'dp_analyst', tenantId: tenantAId });
    tokenDpAnalyst = s3.accessToken;

    const s4 = await tokenService.createSession({ userId: workerAUserId, role: 'employee', tenantId: tenantAId, workerId: workerAId });
    tokenWorkerA = s4.accessToken;

    const s5 = await tokenService.createSession({ userId: workerBUserId, role: 'employee', tenantId: tenantAId, workerId: workerBId });
    tokenWorkerB = s5.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Critério 1: Proteção Anti-Bruteforce & Credenciais RH (Gate V2.1)', () => {
    it('deve bloquear com 401 para credencial inválida e com 423 após 5 tentativas consecutivas', async () => {
      // Garante conta desbloqueada antes do teste
      await dbPool.query(
        'UPDATE public.users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
        [tenantAdminId]
      );

      // 1. Credencial inválida
      const resInvalid = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'tenantadmin.gate2@couplerh.com',
          password: 'SenhaErrada123!',
        },
      });
      expect(resInvalid.statusCode).toBe(401);

      // 2. Executa tentativas subsequentes para atingir o limite de 5
      for (let i = 0; i < 4; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: {
            email: 'tenantadmin.gate2@couplerh.com',
            password: `SenhaErrada_${i}!`,
          },
        });
      }

      // 3. A 6ª tentativa deve retornar 423 Locked
      const resLocked = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'tenantadmin.gate2@couplerh.com',
          password: 'SenhaSegura2026!@#',
        },
      });
      expect(resLocked.statusCode).toBe(423);
      const body = JSON.parse(resLocked.payload);
      expect(body.error).toContain('bloqueada');

      // Limpa o bloqueio no banco para não afetar outros testes
      await dbPool.query(
        'UPDATE public.users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
        [tenantAdminId]
      );
    });
  });

  describe('Critério 2: Portal do Colaborador — Login CPF + Data de Nascimento (Gate V2.2)', () => {
    it('deve bloquear tentativa com CPF inválido ou nascimento incompatível', async () => {
      // CPF inexistente
      const resCpfNotFound = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: '000.000.000-00',
          birthDateOrPassword: '15/01/1990',
        },
      });
      expect(resCpfNotFound.statusCode).toBe(401);

      // CPF correto com Data de Nascimento errada
      const resWrongBirth = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: '111.222.333-44',
          birthDateOrPassword: '01/01/2000',
        },
      });
      expect(resWrongBirth.statusCode).toBe(401);
    });

    it('deve autenticar colaborador com CPF e Data de Nascimento corretos', async () => {
      const resSuccess = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: '111.222.333-44',
          birthDateOrPassword: '15/01/1990',
        },
      });
      expect(resSuccess.statusCode).toBe(200);
      const body = JSON.parse(resSuccess.payload);
      expect(body.accessToken).toBeDefined();
      expect(body.worker.full_name).toBe('Colaborador Gate A');
    });
  });

  describe('Critério 3: Replay Attack de Refresh Token (Gate V2.3)', () => {
    it('deve detectar reuso de refresh token rotacionado e revogar todas as sessões ativas do usuário', async () => {
      // Cria sessão inicial usando usuário isolado replayTestUserId
      const session1 = await tokenService.createSession({
        userId: replayTestUserId,
        ipAddress: '127.0.0.1',
        userAgent: 'GateV2TestAgent',
      });

      const initialRefreshToken = session1.refreshToken;

      // Rotaciona legalmente pela primeira vez
      const rotated = await tokenService.rotateRefreshToken(initialRefreshToken, '127.0.0.1', 'GateV2TestAgent');
      expect(rotated.accessToken).toBeDefined();
      expect(rotated.refreshToken).not.toBe(initialRefreshToken);

      // Tentativa de Replay Attack: reutilizar o initialRefreshToken já consumido
      await expect(
        tokenService.rotateRefreshToken(initialRefreshToken, '127.0.0.1', 'HackerAgent')
      ).rejects.toThrow();

      // Prova de mitigação: todas as sessões do usuário devem ter sido revogadas
      const activeSessions = await dbPool.query(
        'SELECT count(*) FROM public.user_sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [replayTestUserId]
      );
      expect(parseInt(activeSessions.rows[0].count, 10)).toBe(0);
    });
  });

  describe('Critério 4: Exigência de MFA AAL2 para Gestão Administrativa (Gate V2.4)', () => {
    it('deve bloquear token com escopo de mfa_challenge ao tentar acessar rota administrativa', async () => {
      // Gera token temporário com escopo mfa_challenge (AAL1 pendente)
      const tokenMfaPending = signJwt(
        {
          userId: tenantAdminId,
          tenantId: tenantAId,
          role: 'tenant_admin',
          scope: 'mfa_challenge',
        },
        env.JWT_ACCESS_SECRET,
        300
      );

      // Tenta acessar rota de cálculo de rescisão que exige permissão administrativa
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/termination/calculate',
        headers: {
          authorization: `Bearer ${tokenMfaPending}`,
        },
        payload: {
          contract_id: contractAId,
          termination_date: '2026-03-31',
          reason: 'SEM_JUSTA_CAUSA',
        },
      });

      // Deve bloquear com 403 pois não cumpriu o desafio TOTP (AAL2)
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Critério 5: Bloqueio de Escalada de Privilégios (Gate V2.5)', () => {
    it('deve retornar 403 FORBIDDEN_PRIVILEGE_ESCALATION para dp_analyst tentando gerenciar acessos', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/tenant-access/${tenantUserAdminId}`,
        headers: {
          authorization: `Bearer ${tokenDpAnalyst}`,
        },
        payload: {
          role: 'system_admin',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('FORBIDDEN_PRIVILEGE_ESCALATION');
    });

    it('deve retornar 403 se tenant_admin tentar conceder o papel system_admin', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/tenant-access/${tenantUserDpId}`,
        headers: {
          authorization: `Bearer ${tokenTenantAdmin}`,
        },
        payload: {
          role: 'system_admin',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('FORBIDDEN_PRIVILEGE_ESCALATION');
    });

    it('deve bloquear auto-rebaixamento/lockout de administrador de tenant', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/tenant-access/${tenantUserAdminId}`,
        headers: {
          authorization: `Bearer ${tokenTenantAdmin}`,
        },
        payload: {
          role: 'employee',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('FORBIDDEN_SELF_MODIFICATION');
    });
  });

  describe('Critério 6: Bloqueio IDOR Multi-Usuário no Portal do Colaborador (Gate V2.6)', () => {
    it('deve impedir que o Colaborador A registre ponto no worker_id do Colaborador B', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/time-tracking/mobile/punch',
        headers: {
          authorization: `Bearer ${tokenWorkerA}`,
        },
        payload: {
          workerId: workerBId, // IDOR: workerId pertence a B
          punchType: 'ENTRY',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('FORBIDDEN_PUNCH_OWNERSHIP');
    });

    it('deve impedir que o Colaborador A assine documento do Colaborador B', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/${docBId}/sign`,
        headers: {
          authorization: `Bearer ${tokenWorkerA}`,
        },
        payload: {
          signature_hash: 'hash_assinatura_falsa_idor_123',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('FORBIDDEN_DOCUMENT_OWNER');
    });
  });

  describe('Critério 7: Storage Privado com HMAC e Bloqueio de Acesso Cruzado (Gate V2.7)', () => {
    it('deve rejeitar download sem HMAC ou com assinatura HMAC adulterada', async () => {
      const fileId = 'f0000000-0000-0000-0000-000000000999';

      // Sem assinatura (query vazia) -> 400 Parâmetros ausentes
      const resNoSig = await app.inject({
        method: 'GET',
        url: `/api/v1/storage/download/${fileId}`,
      });
      expect(resNoSig.statusCode).toBe(400);

      // Com HMAC falsificado -> 403 Acesso negado
      const resTampered = await app.inject({
        method: 'GET',
        url: `/api/v1/storage/download/${fileId}?expires=9999999999&signature=hmac_invalido_hacker_123`,
      });
      expect(resTampered.statusCode).toBe(403);
    });
  });

  describe('Critério 8: Imutabilidade de Folha Fechada CLOSED (Gate V2.8)', () => {
    it('deve ser impedido pelo PostgreSQL de alterar holerites em folha com status CLOSED', async () => {
      const periodId = 'f0000000-0000-0000-0000-000000000888';
      const payslipId = 'f0000000-0000-0000-0000-000000000889';

      // Cria período fechado e holerite no banco com tenant context
      await withTenantContext({ tenantId: tenantAId, userId: tenantAdminId, role: 'tenant_admin' }, async (client) => {
        await client.query(`
          INSERT INTO public.payroll_periods (
            id, tenant_id, company_id, year, month, type, status, payment_date, competence_date
          ) VALUES (
            '${periodId}', '${tenantAId}', '${companyAId}', 2026, 1, 'MONTHLY', 'CLOSED', '2026-02-05', '2026-01-01'
          )
          ON CONFLICT (tenant_id, company_id, year, month, type) DO UPDATE SET status = 'CLOSED';

          INSERT INTO public.payslips (
            id, tenant_id, payroll_period_id, contract_id, worker_id, status, gross_salary, net_salary, total_earnings, total_deductions
          ) VALUES (
            '${payslipId}', '${tenantAId}', '${periodId}', '${contractAId}', '${workerAId}', 'APPROVED', 3500.00, 3100.00, 3500.00, 400.00
          )
          ON CONFLICT (payroll_period_id, contract_id) DO UPDATE SET status = 'APPROVED';
        `);

        // Tentativa de update no holerite fechado deve disparar trigger trg_block_closed_payroll_modification
        await expect(
          client.query('UPDATE public.payslips SET net_salary = 9999.00 WHERE id = $1', [payslipId])
        ).rejects.toThrow(/FECHADA e auditada/);
      });
    });
  });

  describe('Critério 9: Expurgo Completo de Supabase no Monorepo (Gate V2.9)', () => {
    it('deve validar que @supabase/supabase-js não consta em nenhum package.json do monorepo', () => {
      const rootPkg = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
      const apiPkg = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'apps/api/package.json'), 'utf8'));
      const webPkg = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'apps/web/package.json'), 'utf8'));

      const allDeps = {
        ...rootPkg.dependencies,
        ...rootPkg.devDependencies,
        ...apiPkg.dependencies,
        ...apiPkg.devDependencies,
        ...webPkg.dependencies,
        ...webPkg.devDependencies,
      };

      expect(allDeps['@supabase/supabase-js']).toBeUndefined();
      expect(allDeps['supabase']).toBeUndefined();
    });

    it('deve validar que apps/web/src/lib/supabase.ts foi definitivamente removido', () => {
      const supabaseFile = path.resolve(rootDir, 'apps/web/src/lib/supabase.ts');
      expect(fs.existsSync(supabaseFile)).toBe(false);
    });
  });
});
