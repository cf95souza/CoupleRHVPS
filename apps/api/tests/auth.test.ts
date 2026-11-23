import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { hashPassword, verifyPassword, normalizeCpf, normalizeBirthDate } from '../src/shared/security/passwordHasher.js';
import { signJwt, verifyJwt } from '../src/shared/security/jwtHelper.js';
import { AuthService } from '../src/modules/auth/authService.js';

describe('Motor de Autenticação Nativo Open-Source (SEC-01)', () => {
  let app: FastifyInstance;
  let authService: AuthService;

  const testTenantId = 'a0000000-0000-0000-0000-000000000001';
  const testAdminId = 'a0000000-0000-0000-0000-000000000002';
  const testAdminEmail = 'admin.rh@teste.com';
  const testAdminPassword = 'SenhaForte2026!';

  const testWorkerId = 'a0000000-0000-0000-0000-000000000003';
  const testContractId = 'a0000000-0000-0000-0000-000000000004';
  const testWorkerCpf = '12345678901';
  const testWorkerBirthDateIso = '1992-05-14';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    authService = new AuthService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [testTenantId]);

      // 1. Cria Tenant de Teste
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Empresa Teste Auth', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
      `, [testTenantId]);

      // 2. Cria Usuário Admin RH
      const adminHash = await hashPassword(testAdminPassword);
      await client.query(`
        INSERT INTO public.users (id, email, password_hash, full_name, is_active, failed_login_attempts)
        VALUES ($1, $2, $3, 'Gestor do RH Teste', TRUE, 0)
        ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_login_attempts = 0, locked_until = NULL;
      `, [testAdminId, testAdminEmail, adminHash]);

      // 3. Vincula em tenant_users como tenant_admin
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
        VALUES ($1, $2, 'tenant_admin', TRUE)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'tenant_admin', is_active = TRUE;
      `, [testTenantId, testAdminId]);

      // 4. Cria Empresa, Estabelecimento e Cargo para os Contratos
      const companyId = 'a0000000-0000-0000-0000-000000000010';
      const establishmentId = 'a0000000-0000-0000-0000-000000000020';
      const positionId = 'a0000000-0000-0000-0000-000000000030';

      await client.query(`
        INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj)
        VALUES ($1, $2, 'Empresa Teste Ltda', '12345678000199')
        ON CONFLICT (id) DO NOTHING;
      `, [companyId, testTenantId]);

      await client.query(`
        INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
        VALUES ($1, $2, $3, 'Matriz SP', '12345678000199')
        ON CONFLICT (id) DO NOTHING;
      `, [establishmentId, testTenantId, companyId]);

      await client.query(`
        INSERT INTO public.positions (id, tenant_id, title)
        VALUES ($1, $2, 'Operador Geral')
        ON CONFLICT (id) DO NOTHING;
      `, [positionId, testTenantId]);

      // 5. Cria Trabalhador para o Portal do Colaborador
      await client.query(`
        INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date)
        VALUES ($1, $2, 'Carlos Operacional', $3, $4)
        ON CONFLICT (id) DO UPDATE SET birth_date = EXCLUDED.birth_date, cpf = EXCLUDED.cpf;
      `, [testWorkerId, testTenantId, testWorkerCpf, testWorkerBirthDateIso]);

      // 6. Cria Contrato Ativo para o Trabalhador
      await client.query(`
        INSERT INTO public.contracts (
          id, tenant_id, worker_id, company_id, establishment_id, position_id, registration_number, admission_date, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'MAT-001', '2023-01-01', 'ACTIVE')
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

  describe('1. Criptografia Argon2id, Normalização e JWT Helper', () => {
    it('deve gerar e verificar hashes Argon2id com sucesso', async () => {
      const senha = 'MinhaSenhaSecreta123!';
      const hash = await hashPassword(senha);

      expect(hash).toContain('$argon2id$');
      const isValid = await verifyPassword(senha, hash);
      expect(isValid).toBe(true);

      const isInvalid = await verifyPassword('SenhaIncorreta', hash);
      expect(isInvalid).toBe(false);
    });

    it('deve normalizar CPF removendo caracteres não numéricos', () => {
      expect(normalizeCpf('123.456.789-01')).toBe('12345678901');
      expect(normalizeCpf('  12345678901  ')).toBe('12345678901');
    });

    it('deve normalizar datas de nascimento em diversos formatos para YYYY-MM-DD', () => {
      expect(normalizeBirthDate('14/05/1992')).toBe('1992-05-14');
      expect(normalizeBirthDate('14051992')).toBe('1992-05-14');
      expect(normalizeBirthDate('14-05-1992')).toBe('1992-05-14');
      expect(normalizeBirthDate('1992-05-14')).toBe('1992-05-14');
    });

    it('deve assinar e validar JWT com HMAC-SHA256 e expiração', () => {
      const secret = 'super_secret_test_key_min_32_characters_long_123';
      const token = signJwt({ sub: 'user-123', role: 'admin' }, secret, 60);

      const verified = verifyJwt<{ sub: string; role: string }>(token, secret);
      expect(verified.sub).toBe('user-123');
      expect(verified.role).toBe('admin');

      // Teste de adulteração
      const tampered = token.slice(0, -5) + 'xxxxx';
      expect(() => verifyJwt(tampered, secret)).toThrow();
    });
  });

  describe('2. Login Corporativo para RH e Administração (POST /api/v1/auth/login)', () => {
    it('deve realizar login com sucesso, retornar JWT de 15m e cookie HttpOnly', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: testAdminEmail,
          password: testAdminPassword,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.success).toBe(true);
      expect(body.user.email).toBe(testAdminEmail);
      expect(body.user.role).toBe('tenant_admin');
      expect(body.tenant.id).toBe(testTenantId);
      expect(body.accessToken).toBeDefined();
      expect(body.expiresInSeconds).toBe(900); // 15 minutos

      // Verifica presença do cookie HttpOnly com refresh token
      const setCookie = response.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(setCookie?.toString()).toContain('couplerh_refresh_token=');
      expect(setCookie?.toString().toLowerCase()).toContain('httponly');
    });

    it('deve falhar com 401 se a senha estiver incorreta e incrementar tentativas', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: testAdminEmail,
          password: 'SenhaTotalmenteErrada!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toBe('E-mail ou senha incorretos.');
    });

    it('deve bloquear a conta temporariamente com 423 após 5 tentativas falhas consecutivas', async () => {
      // Cria usuário para teste de bloqueio por força bruta
      const bruteUserId = 'a0000000-0000-0000-0000-000000000099';
      const bruteEmail = 'brute.force@teste.com';
      const hash = await hashPassword('SenhaOriginal123!');

      await dbPool.query(`
        INSERT INTO public.users (id, email, password_hash, full_name, is_active, failed_login_attempts)
        VALUES ($1, $2, $3, 'Usuario Brute Force', TRUE, 4)
        ON CONFLICT (id) DO UPDATE SET failed_login_attempts = 4, locked_until = NULL;
      `, [bruteUserId, bruteEmail, hash]);

      // A 5ª tentativa falha dispara o bloqueio
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: bruteEmail,
          password: 'SenhaErrada',
        },
      });

      expect(response.statusCode).toBe(423);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('bloqueada por excesso de tentativas');

      // Tentativa subsequente é imediatamente rejeitada com 423 sem checar senha
      const blockedResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: bruteEmail,
          password: 'SenhaOriginal123!',
        },
      });

      expect(blockedResponse.statusCode).toBe(423);
    });
  });

  describe('3. Login Prático do Portal do Colaborador (POST /api/v1/auth/portal/login)', () => {
    it('deve logar com sucesso usando CPF e Data de Nascimento no formato DDMMAAAA', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: testWorkerCpf,
          birthDateOrPassword: '14051992', // 14/05/1992
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.success).toBe(true);
      expect(body.worker.cpf).toBe(testWorkerCpf);
      expect(body.worker.full_name).toBe('Carlos Operacional');
      expect(body.tenantId).toBe(testTenantId);
      expect(body.accessToken).toBeDefined();

      // Valida o payload do token de acesso
      const decoded = authService.getTokenService().verifyAccessToken(body.accessToken);
      expect(decoded.role).toBe('employee');
      expect(decoded.worker_id).toBe(testWorkerId);
      expect(decoded.tenant_id).toBe(testTenantId);
    });

    it('deve logar com sucesso usando CPF com máscara e Data de Nascimento no formato DD/MM/AAAA', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: '123.456.789-01',
          birthDateOrPassword: '14/05/1992',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('deve rejeitar login do portal quando a data de nascimento estiver incorreta', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: testWorkerCpf,
          birthDateOrPassword: '01011990', // Data errada
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('CPF ou data de nascimento incorretos');
    });
  });

  describe('4. Rotação de Refresh Token e Proteção contra Replay Attack', () => {
    it('deve rotacionar o refresh token e emitir novo par de credenciais', async () => {
      // 1. Faz login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminPassword },
      });

      const setCookie = loginRes.headers['set-cookie']?.toString() || '';
      const match = setCookie.match(/couplerh_refresh_token=([^;]+)/);
      const refreshToken = match ? match[1] : '';
      expect(refreshToken).toBeTruthy();

      // 2. Chama /refresh
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          cookie: `couplerh_refresh_token=${refreshToken}`,
        },
      });

      expect(refreshRes.statusCode).toBe(200);
      const refreshBody = JSON.parse(refreshRes.body);
      expect(refreshBody.success).toBe(true);
      expect(refreshBody.accessToken).toBeDefined();

      // 3. Teste de Replay Attack: reusar o refresh token antigo deve falhar com 401
      const replayRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: {
          cookie: `couplerh_refresh_token=${refreshToken}`,
        },
      });

      expect(replayRes.statusCode).toBe(401);
      const replayBody = JSON.parse(replayRes.body);
      expect(replayBody.error).toMatch(/sessão comprometida|Sessão inválida/i);
    });
  });

  describe('5. Rota Protegida /me e Encerramento de Sessões', () => {
    it('deve retornar dados do usuário autenticado no endpoint GET /api/v1/auth/me', async () => {
      // 1. Login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminPassword },
      });
      const { accessToken } = JSON.parse(loginRes.body);

      // 2. Acesso à rota protegida
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(meRes.statusCode).toBe(200);
      const meBody = JSON.parse(meRes.body);
      expect(meBody.success).toBe(true);
      expect(meBody.user.email).toBe(testAdminEmail);
      expect(meBody.user.role).toBe('tenant_admin');
    });

    it('deve listar sessões ativas e permitir logout', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminPassword },
      });
      const { accessToken } = JSON.parse(loginRes.body);

      // Lista sessões
      const sessionsRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/sessions',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(sessionsRes.statusCode).toBe(200);
      const sessionsBody = JSON.parse(sessionsRes.body);
      expect(sessionsBody.sessions.length).toBeGreaterThanOrEqual(1);

      // Logout
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(logoutRes.statusCode).toBe(200);
      expect(logoutRes.headers['set-cookie']?.toString()).toContain('couplerh_refresh_token=;');
    });
  });
});
