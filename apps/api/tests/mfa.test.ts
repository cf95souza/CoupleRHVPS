import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import {
  encryptAesGcm,
  decryptAesGcm,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../src/shared/security/cryptoHelper.js';

describe('MFA TOTP Nativo e Timeout Real de Sessão (SEC-02)', () => {
  let app: FastifyInstance;

  const testTenantId = 'b0000000-0000-0000-0000-000000000001';
  const testAdminId = 'b0000000-0000-0000-0000-000000000002';
  const testAdminEmail = 'mfa.gestor@empresa.com.br';
  const testAdminPassword = 'MfaPassword2026!';

  const testWorkerId = 'b0000000-0000-0000-0000-000000000003';
  const testContractId = 'b0000000-0000-0000-0000-000000000004';
  const testWorkerCpf = '98765432109';
  const testWorkerBirthDateIso = '1988-10-25';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [testTenantId]);

      // 1. Cria Tenant com configurações de segurança e timeout
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Empresa Teste MFA', 'ACTIVE', $2::jsonb)
        ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings;
      `, [
        testTenantId,
        JSON.stringify({
          require_mfa_roles: ['tenant_admin'],
          session_timeout_minutes: 30,
          max_login_attempts: 5,
        }),
      ]);

      // 2. Cria Usuário Admin RH
      const adminHash = await hashPassword(testAdminPassword);
      await client.query(`
        INSERT INTO public.users (id, email, password_hash, full_name, is_active, failed_login_attempts)
        VALUES ($1, $2, $3, 'Gestor Segurança RH', TRUE, 0)
        ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_login_attempts = 0, locked_until = NULL;
      `, [testAdminId, testAdminEmail, adminHash]);

      // 3. Vincula em tenant_users
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
        VALUES ($1, $2, 'tenant_admin', TRUE)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'tenant_admin', is_active = TRUE;
      `, [testTenantId, testAdminId]);

      // 4. Cria Empresa, Estabelecimento e Cargo
      const companyId = 'b0000000-0000-0000-0000-000000000010';
      const establishmentId = 'b0000000-0000-0000-0000-000000000020';
      const positionId = 'b0000000-0000-0000-0000-000000000030';

      await client.query(`
        INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj)
        VALUES ($1, $2, 'Empresa MFA Ltda', '98765432000188')
        ON CONFLICT (id) DO NOTHING;
      `, [companyId, testTenantId]);

      await client.query(`
        INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
        VALUES ($1, $2, $3, 'Matriz MFA', '98765432000188')
        ON CONFLICT (id) DO NOTHING;
      `, [establishmentId, testTenantId, companyId]);

      await client.query(`
        INSERT INTO public.positions (id, tenant_id, title)
        VALUES ($1, $2, 'Operador Logístico')
        ON CONFLICT (id) DO NOTHING;
      `, [positionId, testTenantId]);

      // 5. Trabalhador para o portal do colaborador
      await client.query(`
        INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date)
        VALUES ($1, $2, 'Maria Auxiliar', $3, $4)
        ON CONFLICT (id) DO UPDATE SET birth_date = EXCLUDED.birth_date, cpf = EXCLUDED.cpf;
      `, [testWorkerId, testTenantId, testWorkerCpf, testWorkerBirthDateIso]);

      await client.query(`
        INSERT INTO public.contracts (
          id, tenant_id, worker_id, company_id, establishment_id, position_id, registration_number, admission_date, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'MAT-MFA-01', '2023-01-01', 'ACTIVE')
        ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';
      `, [testContractId, testTenantId, testWorkerId, companyId, establishmentId, positionId]);

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Criptografia AES-256-GCM e Gerenciamento de Códigos de Recuperação', () => {
    it('deve criptografar e decriptografar segredo com AES-256-GCM e integridade via auth tag', () => {
      const segredoOriginal = 'JBSWY3DPEHPK3PXP';
      const cifrado = encryptAesGcm(segredoOriginal);

      expect(cifrado).toContain(':');
      expect(cifrado.split(':').length).toBe(3);

      const decifrado = decryptAesGcm(cifrado);
      expect(decifrado).toBe(segredoOriginal);

      // Teste de adulteração do ciphertext -> deve falhar
      const partes = cifrado.split(':');
      const adulterado = `${partes[0]}:${partes[1]}:${partes[2].slice(0, -2)}aa`;
      expect(() => decryptAesGcm(adulterado)).toThrow();
    });

    it('deve gerar 8 códigos de recuperação e hashear com SHA-256 de forma case-insensitive', () => {
      const codes = generateRecoveryCodes(8);
      expect(codes.length).toBe(8);
      codes.forEach((code) => {
        expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
      });

      const hash1 = hashRecoveryCode(codes[0]);
      const hash2 = hashRecoveryCode(codes[0].toLowerCase());
      const hash3 = hashRecoveryCode(codes[0].replace('-', ' '));

      expect(hash1).toBe(hash2);
      expect(hash1).toBe(hash3);
      expect(hash1.length).toBe(64); // SHA-256 hex
    });
  });

  describe('2. Obrigatoriedade de MFA por Papel (require_mfa_roles) e Setup Wizard', () => {
    let setupOnlyToken: string;
    let enrolledFactorId: string;
    let enrolledSecret: string;
    let savedRecoveryCodes: string[];

    it('deve exigir setup obrigatório quando tenant_admin faz login sem ter MFA cadastrado', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: testAdminEmail,
          password: testAdminPassword,
        },
      });

      expect(loginRes.statusCode).toBe(200);
      const body = JSON.parse(loginRes.body);

      expect(body.success).toBe(true);
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaEnrolled).toBe(false);
      expect(body.accessToken).toBeDefined();

      setupOnlyToken = body.accessToken;

      // Não deve ter definido o cookie de sessão definitiva
      expect(loginRes.headers['set-cookie']).toBeUndefined();
    });

    it('deve bloquear acesso a rotas de negócio com token restrito mfa_setup_only', async () => {
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: `Bearer ${setupOnlyToken}`,
        },
      });

      expect(meRes.statusCode).toBe(403);
      const body = JSON.parse(meRes.body);
      expect(body.code).toBe('MFA_ENROLL_REQUIRED');
    });

    it('deve permitir cadastro de MFA (POST /api/v1/auth/mfa/enroll) usando o token de setup', async () => {
      const enrollRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/enroll',
        headers: {
          authorization: `Bearer ${setupOnlyToken}`,
        },
      });

      expect(enrollRes.statusCode).toBe(200);
      const body = JSON.parse(enrollRes.body);

      expect(body.success).toBe(true);
      expect(body.factorId).toBeDefined();
      expect(body.secret).toBeDefined();
      expect(body.otpauthUri).toContain('otpauth://totp/');
      expect(body.qrCodeSvg).toContain('<svg');
      expect(body.recoveryCodes).toHaveLength(8);

      enrolledFactorId = body.factorId;
      enrolledSecret = body.secret;
      savedRecoveryCodes = body.recoveryCodes;
    });

    it('deve rejeitar verificação de setup com código TOTP inválido', async () => {
      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/verify',
        headers: {
          authorization: `Bearer ${setupOnlyToken}`,
        },
        payload: {
          factorId: enrolledFactorId,
          code: '000000',
        },
      });

      expect(verifyRes.statusCode).toBe(401);
      const body = JSON.parse(verifyRes.body);
      expect(body.error).toContain('incorreto');
    });

    it('deve aprovar verificação com código TOTP válido e promover sessão para AAL2', async () => {
      const validCode = authenticator.generate(enrolledSecret);

      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/verify',
        headers: {
          authorization: `Bearer ${setupOnlyToken}`,
        },
        payload: {
          factorId: enrolledFactorId,
          code: validCode,
        },
      });

      expect(verifyRes.statusCode).toBe(200);
      const body = JSON.parse(verifyRes.body);

      expect(body.success).toBe(true);
      expect(body.aal).toBe('aal2');
      expect(body.accessToken).toBeDefined();

      // Agora o usuário com o novo token promovido consegue acessar rotas de negócio
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: `Bearer ${body.accessToken}`,
        },
      });

      expect(meRes.statusCode).toBe(200);
      const meBody = JSON.parse(meRes.body);
      expect(meBody.user.aal).toBe('aal2');
      expect(meBody.user.mfaEnrolled).toBe(true);
      expect(meBody.user.mfaRequired).toBe(true);
    });

    it('deve listar o fator cadastrado em GET /api/v1/auth/mfa/factors', async () => {
      // Faz login com MFA ativo
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminPassword },
      });
      const challengeToken = JSON.parse(loginRes.body).challengeToken;

      const challengeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/challenge',
        payload: {
          challengeToken,
          code: authenticator.generate(enrolledSecret),
        },
      });
      const aal2Token = JSON.parse(challengeRes.body).accessToken;

      const factorsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/mfa/factors',
        headers: { authorization: `Bearer ${aal2Token}` },
      });

      expect(factorsRes.statusCode).toBe(200);
      const body = JSON.parse(factorsRes.body);
      expect(body.factors.length).toBeGreaterThanOrEqual(1);
      expect(body.factors[0].is_verified).toBe(true);
    });
  });

  describe('3. Login com Desafio de MFA (AAL1 -> Desafio -> AAL2)', () => {
    let challengeToken: string;

    it('deve retornar desafio pendente (mfaEnrolled=true) no login com MFA verificado', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: testAdminEmail,
          password: testAdminPassword,
        },
      });

      expect(loginRes.statusCode).toBe(200);
      const body = JSON.parse(loginRes.body);

      expect(body.success).toBe(true);
      expect(body.mfaRequired).toBe(true);
      expect(body.mfaEnrolled).toBe(true);
      expect(body.challengeToken).toBeDefined();

      challengeToken = body.challengeToken;
    });

    it('deve bloquear acesso com challengeToken em rotas de negócio (MFA_CHALLENGE_REQUIRED)', async () => {
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: `Bearer ${challengeToken}`,
        },
      });

      expect(meRes.statusCode).toBe(403);
      const body = JSON.parse(meRes.body);
      expect(body.code).toBe('MFA_CHALLENGE_REQUIRED');
    });

    it('deve falhar desafio em /auth/mfa/challenge com código TOTP incorreto', async () => {
      const challengeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/challenge',
        payload: {
          challengeToken,
          code: '111111',
        },
      });

      expect(challengeRes.statusCode).toBe(401);
      const body = JSON.parse(challengeRes.body);
      expect(body.error).toContain('incorreto');
    });

    it('deve aprovar desafio com código TOTP válido, promovendo para AAL2 e emitindo Refresh Cookie', async () => {
      // Busca o segredo do banco para gerar TOTP
      const factorRes = await dbPool.query(
        'SELECT secret_encrypted FROM public.user_mfa_factors WHERE user_id = $1 AND is_verified = TRUE LIMIT 1;',
        [testAdminId]
      );
      const plainSecret = decryptAesGcm(factorRes.rows[0].secret_encrypted);
      const totpCode = authenticator.generate(plainSecret);

      const challengeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/challenge',
        payload: {
          challengeToken,
          code: totpCode,
        },
      });

      expect(challengeRes.statusCode).toBe(200);
      const body = JSON.parse(challengeRes.body);

      expect(body.success).toBe(true);
      expect(body.aal).toBe('aal2');
      expect(body.accessToken).toBeDefined();
      expect(body.recoveryCodeUsed).toBe(false);

      // Deve emitir o Refresh Cookie definitivo
      const setCookie = challengeRes.headers['set-cookie']?.toString() || '';
      expect(setCookie).toContain('couplerh_refresh_token=');
      expect(setCookie).toContain('HttpOnly');
    });
  });

  describe('4. Resposta ao Desafio usando Código de Recuperação de Uso Único (Backup Code)', () => {
    it('deve aceitar código de recuperação no login e invalidá-lo para reuso subsequente', async () => {
      // 1. Gera novo login para obter novo challengeToken
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminPassword },
      });
      const challengeToken = JSON.parse(loginRes.body).challengeToken;

      // 2. Busca lista de recovery codes do banco
      const factorRes = await dbPool.query(
        'SELECT recovery_codes_hash FROM public.user_mfa_factors WHERE user_id = $1 AND is_verified = TRUE LIMIT 1;',
        [testAdminId]
      );
      const hashes = factorRes.rows[0].recovery_codes_hash;
      expect(hashes.length).toBeGreaterThan(0);

      // 3. Cadastra um código de teste conhecido
      const testBackupCode = 'RECOV-99999';
      const testBackupHash = hashRecoveryCode(testBackupCode);
      await dbPool.query(`
        UPDATE public.user_mfa_factors 
        SET recovery_codes_hash = recovery_codes_hash || $1::jsonb 
        WHERE user_id = $2;
      `, [JSON.stringify([testBackupHash]), testAdminId]);

      // 4. Utiliza o código de recuperação no challenge
      const challengeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/challenge',
        payload: {
          challengeToken,
          code: testBackupCode,
        },
      });

      expect(challengeRes.statusCode).toBe(200);
      const body = JSON.parse(challengeRes.body);
      expect(body.success).toBe(true);
      expect(body.recoveryCodeUsed).toBe(true);

      // 5. Tenta reutilizar o mesmo código de recuperação -> DEVE SER REJEITADO
      const loginRes2 = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminPassword },
      });
      const challengeToken2 = JSON.parse(loginRes2.body).challengeToken;

      const reuseRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/challenge',
        payload: {
          challengeToken: challengeToken2,
          code: testBackupCode,
        },
      });

      expect(reuseRes.statusCode).toBe(401);
      expect(JSON.parse(reuseRes.body).error).toContain('incorreto');
    });
  });

  describe('5. Remoção de Fator MFA (DELETE /api/v1/auth/mfa/:id)', () => {
    it('deve exigir confirmação de senha e código válido para remover MFA', async () => {
      // 1. Obtém sessão AAL2
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminPassword },
      });
      const challengeToken = JSON.parse(loginRes.body).challengeToken;

      const factorRes = await dbPool.query(
        'SELECT id, secret_encrypted FROM public.user_mfa_factors WHERE user_id = $1 AND is_verified = TRUE LIMIT 1;',
        [testAdminId]
      );
      const factorId = factorRes.rows[0].id;
      const secret = decryptAesGcm(factorRes.rows[0].secret_encrypted);

      const challengeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/challenge',
        payload: {
          challengeToken,
          code: authenticator.generate(secret),
        },
      });
      const aal2Token = JSON.parse(challengeRes.body).accessToken;

      // 2. Falha com senha errada
      const failPwdRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/auth/mfa/${factorId}`,
        headers: { authorization: `Bearer ${aal2Token}` },
        payload: {
          currentPassword: 'SenhaIncorretaErrada!',
          code: authenticator.generate(secret),
        },
      });
      expect(failPwdRes.statusCode).toBe(400);
      expect(JSON.parse(failPwdRes.body).error).toContain('Senha');

      // 3. Sucesso com senha correta e TOTP válido
      const successRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/auth/mfa/${factorId}`,
        headers: { authorization: `Bearer ${aal2Token}` },
        payload: {
          currentPassword: testAdminPassword,
          code: authenticator.generate(secret),
        },
      });
      expect(successRes.statusCode).toBe(200);
      expect(JSON.parse(successRes.body).success).toBe(true);

      // Fator deve ter sido removido
      const checkRes = await dbPool.query(
        'SELECT id FROM public.user_mfa_factors WHERE id = $1;',
        [factorId]
      );
      expect(checkRes.rows.length).toBe(0);
    });
  });

  describe('6. Timeout Real de Inatividade de Sessão e Heartbeat', () => {
    it('deve registrar atividade via endpoint de heartbeat', async () => {
      // Cria sessão normal
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: { cpf: testWorkerCpf, birthDateOrPassword: '25/10/1988' },
      });
      const token = JSON.parse(loginRes.body).accessToken;

      const heartbeatRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/session/heartbeat',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(heartbeatRes.statusCode).toBe(200);
      expect(JSON.parse(heartbeatRes.body).success).toBe(true);
      expect(JSON.parse(heartbeatRes.body).lastSeenAt).toBeDefined();
    });

    it('deve revogar sessão e retornar 401 SESSION_TIMEOUT quando inatividade exceder o limite', async () => {
      // 1. Faz login no portal
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: { cpf: testWorkerCpf, birthDateOrPassword: '25/10/1988' },
      });
      const token = JSON.parse(loginRes.body).accessToken;

      // 2. Simula no banco que a sessão específica ficou inativa há 4 horas
      const tokenPayload = (app as any).authService?.getTokenService?.().verifyAccessToken(token) ||
        JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

      await dbPool.query(`
        UPDATE public.user_sessions 
        SET last_seen_at = NOW() - INTERVAL '4 hours'
        WHERE id = $1;
      `, [tokenPayload.session_id]);

      // 3. Próxima requisição com o token deve falhar por timeout
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(meRes.statusCode).toBe(401);
      const body = JSON.parse(meRes.body);
      expect(body.code).toBe('SESSION_TIMEOUT');
      expect(body.error).toContain('inatividade');
    });
  });

  describe('7. Isenção Absoluta de MFA para o Portal do Colaborador (CPF + Data de Nascimento)', () => {
    it('deve garantir que o colaborador operacional NUNCA receba desafio de MFA', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: testWorkerCpf,
          birthDateOrPassword: '25101988', // 25/10/1988
        },
      });

      expect(loginRes.statusCode).toBe(200);
      const body = JSON.parse(loginRes.body);

      expect(body.success).toBe(true);
      expect(body.mfaRequired).toBeUndefined();
      expect(body.worker.cpf).toBe(testWorkerCpf);
      expect(body.accessToken).toBeDefined();

      // O cookie definitivo de refresh token é emitido imediatamente
      const setCookie = loginRes.headers['set-cookie']?.toString() || '';
      expect(setCookie).toContain('couplerh_refresh_token=');
    });
  });
});
