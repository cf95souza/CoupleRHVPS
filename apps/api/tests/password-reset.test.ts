import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';

describe('Jornadas de Acesso, Recuperação de Senha e Separação RH vs Portal (SEC-03)', () => {
  let app: FastifyInstance;

  const testTenantId = 'c0000000-0000-0000-0000-000000000001';
  const testAdminId = 'c0000000-0000-0000-0000-000000000002';
  const testAdminEmail = 'recuperacao.rh@empresa.com.br';
  const testAdminInitialPassword = 'SenhaAntiga2026!';
  const testAdminNewPassword = 'NovaSenhaUltraForte2026#';

  const testWorkerId = 'c0000000-0000-0000-0000-000000000003';
  const testContractId = 'c0000000-0000-0000-0000-000000000004';
  const testWorkerCpf = '87654321098';
  const testWorkerBirthDateIso = '1995-08-20'; // 20/08/1995

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [testTenantId]);

      // 1. Cria Tenant
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Empresa Teste Recuperacao', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING;
      `, [testTenantId]);

      // 2. Cria Usuário Admin RH
      const adminHash = await hashPassword(testAdminInitialPassword);
      await client.query(`
        INSERT INTO public.users (id, email, password_hash, full_name, is_active, failed_login_attempts)
        VALUES ($1, $2, $3, 'Gestor Recuperação RH', TRUE, 0)
        ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_login_attempts = 0, locked_until = NULL;
      `, [testAdminId, testAdminEmail, adminHash]);

      // 3. Vincula em tenant_users como tenant_admin
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
        VALUES ($1, $2, 'tenant_admin', TRUE)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'tenant_admin', is_active = TRUE;
      `, [testTenantId, testAdminId]);

      // 4. Cria Empresa, Estabelecimento e Cargo
      const companyId = 'c0000000-0000-0000-0000-000000000010';
      const establishmentId = 'c0000000-0000-0000-0000-000000000020';
      const positionId = 'c0000000-0000-0000-0000-000000000030';

      await client.query(`
        INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj)
        VALUES ($1, $2, 'Empresa Recuperacao Ltda', '87654321000177')
        ON CONFLICT (id) DO NOTHING;
      `, [companyId, testTenantId]);

      await client.query(`
        INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
        VALUES ($1, $2, $3, 'Matriz Filial SP', '87654321000177')
        ON CONFLICT (id) DO NOTHING;
      `, [establishmentId, testTenantId, companyId]);

      await client.query(`
        INSERT INTO public.positions (id, tenant_id, title)
        VALUES ($1, $2, 'Assistente de DP')
        ON CONFLICT (id) DO NOTHING;
      `, [positionId, testTenantId]);

      // 5. Trabalhador para o Portal do Colaborador
      await client.query(`
        INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date)
        VALUES ($1, $2, 'Joana Operacional', $3, $4)
        ON CONFLICT (id) DO UPDATE SET birth_date = EXCLUDED.birth_date, cpf = EXCLUDED.cpf;
      `, [testWorkerId, testTenantId, testWorkerCpf, testWorkerBirthDateIso]);

      await client.query(`
        INSERT INTO public.contracts (
          id, tenant_id, worker_id, company_id, establishment_id, position_id, registration_number, admission_date, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'MAT-REC-01', '2023-05-01', 'ACTIVE')
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

  describe('1. Solicitação de Recuperação de Senha (POST /api/v1/auth/forgot-password)', () => {
    it('deve retornar mensagem anti-enumeração idêntica para e-mails cadastrados e não cadastrados', async () => {
      // 1. E-mail existente
      const resExistente = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        payload: { email: testAdminEmail },
      });

      expect(resExistente.statusCode).toBe(200);
      const bodyExistente = JSON.parse(resExistente.body);
      expect(bodyExistente.success).toBe(true);
      expect(bodyExistente.message).toContain('Se o e-mail informado estiver cadastrado');

      // 2. E-mail não existente
      const resInexistente = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        payload: { email: 'email.totalmente.inexistente@empresa.com.br' },
      });

      expect(resInexistente.statusCode).toBe(200);
      const bodyInexistente = JSON.parse(resInexistente.body);
      expect(bodyInexistente.success).toBe(true);

      // Respostas devem ser estritamente idênticas para prevenir enumeração de contas
      expect(bodyExistente.message).toBe(bodyInexistente.message);
    });

    it('deve gerar registro em public.auth_tokens com token_type PASSWORD_RESET e expiração de 30m', async () => {
      const res = await dbPool.query(`
        SELECT token_type, expires_at, used_at 
        FROM public.auth_tokens 
        WHERE user_id = $1 AND token_type = 'PASSWORD_RESET'
        ORDER BY created_at DESC LIMIT 1;
      `, [testAdminId]);

      expect(res.rows.length).toBe(1);
      expect(res.rows[0].token_type).toBe('PASSWORD_RESET');
      expect(res.rows[0].used_at).toBeNull();
      expect(new Date(res.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('2. Validação e Redefinição de Senha (POST /api/v1/auth/reset-password)', () => {
    let resetRawToken: string;

    beforeAll(async () => {
      // Injeta um token conhecido diretamente para testar o ciclo completo
      const crypto = await import('node:crypto');
      resetRawToken = crypto.randomBytes(32).toString('hex');
      const hash = crypto.createHash('sha256').update(resetRawToken).digest('hex');

      await dbPool.query(`
        INSERT INTO public.auth_tokens (user_id, token_type, token_hash, expires_at)
        VALUES ($1, 'PASSWORD_RESET', $2, NOW() + INTERVAL '30 minutes');
      `, [testAdminId, hash]);
    });

    it('deve validar positivamente o token em GET /api/v1/auth/reset-password/verify', async () => {
      const verifyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/reset-password/verify?token=${resetRawToken}`,
      });

      expect(verifyRes.statusCode).toBe(200);
      const body = JSON.parse(verifyRes.body);
      expect(body.valid).toBe(true);
      expect(body.email).toBe(testAdminEmail);
    });

    it('deve rejeitar token falso em GET /api/v1/auth/reset-password/verify', async () => {
      const verifyRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/reset-password/verify?token=token_completamente_falso_e_invalido_123',
      });

      expect(verifyRes.statusCode).toBe(400);
      const body = JSON.parse(verifyRes.body);
      expect(body.valid).toBe(false);
      expect(body.error).toContain('inválido');
    });

    it('deve rejeitar nova senha com menos de 8 caracteres', async () => {
      const resetRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-password',
        payload: {
          token: resetRawToken,
          newPassword: 'curta',
        },
      });

      expect(resetRes.statusCode).toBe(400);
      const body = JSON.parse(resetRes.body);
      expect(body.error).toContain('8 caracteres');
    });

    it('deve redefinir a senha com sucesso, invalidar o token e revogar todas as sessões anteriores', async () => {
      // 1. Cria uma sessão ativa antes da troca de senha
      const loginAntes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminInitialPassword },
      });
      const tokenAntes = JSON.parse(loginAntes.body).accessToken;

      // 2. Executa a redefinição de senha
      const resetRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-password',
        payload: {
          token: resetRawToken,
          newPassword: testAdminNewPassword,
        },
      });

      expect(resetRes.statusCode).toBe(200);
      const body = JSON.parse(resetRes.body);
      expect(body.success).toBe(true);
      expect(body.message).toContain('Senha redefinida com sucesso');

      // 3. A sessão anterior criada antes da troca de senha deve ter sido revogada
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${tokenAntes}` },
      });
      expect(meRes.statusCode).toBe(401); // Sessão revogada

      // 4. Login com senha antiga deve falhar
      const loginSenhaAntiga = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminInitialPassword },
      });
      expect(loginSenhaAntiga.statusCode).toBe(401);

      // 5. Login com nova senha deve ter sucesso imediato
      const loginNovaSenha = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminNewPassword },
      });
      expect(loginNovaSenha.statusCode).toBe(200);
      expect(JSON.parse(loginNovaSenha.body).accessToken).toBeDefined();

      // 6. Tentar reutilizar o mesmo token de redefinição deve ser rejeitado
      const reusoRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-password',
        payload: {
          token: resetRawToken,
          newPassword: 'OutraNovaSenha2026#',
        },
      });
      expect(reusoRes.statusCode).toBe(400);
    });
  });

  describe('3. Portal do Colaborador: Troca de Senha Pessoal Opcional (POST /api/v1/auth/portal/change-password)', () => {
    let portalAccessToken: string;

    it('deve permitir login inicial do colaborador via CPF + Data de Nascimento', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: testWorkerCpf,
          birthDateOrPassword: '20081995', // 20/08/1995
        },
      });

      expect(loginRes.statusCode).toBe(200);
      const body = JSON.parse(loginRes.body);
      portalAccessToken = body.accessToken;
      expect(body.worker.cpf).toBe(testWorkerCpf);
    });

    it('deve rejeitar troca de senha do colaborador se a credencial atual for incorreta', async () => {
      const changeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/change-password',
        headers: { authorization: `Bearer ${portalAccessToken}` },
        payload: {
          currentBirthDateOrPassword: '01011990', // Data errada
          newPassword: 'SenhaColaborador2026!',
        },
      });

      expect(changeRes.statusCode).toBe(400);
      const body = JSON.parse(changeRes.body);
      expect(body.error).toContain('incorreta');
    });

    it('deve permitir ao colaborador cadastrar sua própria senha fornecendo sua data de nascimento correta', async () => {
      const changeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/change-password',
        headers: { authorization: `Bearer ${portalAccessToken}` },
        payload: {
          currentBirthDateOrPassword: '20/08/1995', // Data correta
          newPassword: 'SenhaColaborador2026!',
        },
      });

      expect(changeRes.statusCode).toBe(200);
      const body = JSON.parse(changeRes.body);
      expect(body.success).toBe(true);
      expect(body.message).toContain('Senha pessoal do portal atualizada');

      // Agora o colaborador consegue logar usando sua senha personalizada!
      const loginCustomPwd = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: testWorkerCpf,
          birthDateOrPassword: 'SenhaColaborador2026!',
        },
      });

      expect(loginCustomPwd.statusCode).toBe(200);
      expect(JSON.parse(loginCustomPwd.body).worker.cpf).toBe(testWorkerCpf);
    });
  });

  describe('4. Separação Estrita de Rotas: RH / Administração vs Portal do Colaborador', () => {
    it('deve bloquear usuário com perfil employee de acessar rotas de gestão administrativa do RH com 403 FORBIDDEN_EMPLOYEE', async () => {
      // 1. Faz login como colaborador
      const portalLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/portal/login',
        payload: {
          cpf: testWorkerCpf,
          birthDateOrPassword: 'SenhaColaborador2026!',
        },
      });
      const employeeToken = JSON.parse(portalLogin.body).accessToken;

      // 2. Tenta acessar endpoint de RH administrativo
      const checkAccessRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/admin/check-access',
        headers: { authorization: `Bearer ${employeeToken}` },
      });

      expect(checkAccessRes.statusCode).toBe(403);
      const body = JSON.parse(checkAccessRes.body);
      expect(body.code).toBe('FORBIDDEN_EMPLOYEE');
      expect(body.error).toContain('Portal do Colaborador');
    });

    it('deve permitir acesso normal de perfil administrativo (tenant_admin) à rota administrativa do RH', async () => {
      // 1. Faz login como gestor de RH
      const adminLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: testAdminEmail, password: testAdminNewPassword },
      });
      const adminToken = JSON.parse(adminLogin.body).accessToken;

      // 2. Acessa endpoint de RH
      const checkAccessRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/admin/check-access',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(checkAccessRes.statusCode).toBe(200);
      const body = JSON.parse(checkAccessRes.body);
      expect(body.success).toBe(true);
      expect(body.allowed).toBe(true);
      expect(body.user.role).toBe('tenant_admin');
    });
  });
});
