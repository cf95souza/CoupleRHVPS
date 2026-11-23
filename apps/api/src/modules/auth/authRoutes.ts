import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuthService } from './authService.js';
import { authenticate } from './authMiddleware.js';
import { dbPool } from '../../shared/db/pool.js';
import { env } from '../../config/env.js';

const loginAdminSchema = z.object({
  email: z.string().email('E-mail em formato inválido.'),
  password: z.string().min(1, 'A senha é obrigatória.'),
});

const loginPortalSchema = z.object({
  cpf: z.string().min(11, 'O CPF é obrigatório.'),
  birthDateOrPassword: z.string().min(4, 'A data de nascimento ou senha é obrigatória.'),
});

const mfaVerifySchema = z.object({
  factorId: z.string().uuid('ID do fator inválido.'),
  code: z.string().min(6).max(6, 'O código TOTP deve ter 6 dígitos.'),
});

const mfaChallengeSchema = z.object({
  challengeToken: z.string().optional(),
  code: z.string().min(6, 'O código deve ter pelo menos 6 dígitos ou ser um código de recuperação.'),
});

const mfaUnenrollSchema = z.object({
  currentPassword: z.string().min(1, 'A senha atual é obrigatória.'),
  code: z.string().min(6, 'O código TOTP ou de recuperação é obrigatório.'),
});

const REFRESH_COOKIE_NAME = 'couplerh_refresh_token';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const authService = new AuthService(dbPool);
  const tokenService = authService.getTokenService();
  const mfaService = authService.getMfaService();

  /**
   * POST /api/v1/auth/login
   * Login corporativo para RH, Departamento Pessoal e Gestão (E-mail + Senha)
   */
  app.post('/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const parseResult = loginAdminSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: parseResult.error.errors[0]?.message || 'Dados inválidos.',
      });
    }

    try {
      const result = await authService.loginAdmin({
        email: parseResult.data.email,
        password: parseResult.data.password,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string,
      });

      // Se MFA for obrigatório ou já estiver ativo
      if (result.mfaRequired) {
        if (result.mfaEnrolled) {
          // Desafio pendente: retorna challengeToken para resolver em /auth/mfa/challenge
          return {
            success: true,
            mfaRequired: true,
            mfaEnrolled: true,
            challengeToken: result.challengeToken,
            user: result.user,
            tenant: result.tenant,
          };
        } else {
          // Setup obrigatório pendente: emite token mfa_setup_only
          return {
            success: true,
            mfaRequired: true,
            mfaEnrolled: false,
            accessToken: result.accessToken,
            expiresInSeconds: result.expiresInSeconds,
            user: result.user,
            tenant: result.tenant,
          };
        }
      }

      // Login normal sem MFA: emite par de tokens
      reply.setCookie(REFRESH_COOKIE_NAME, result.tokens!.refreshToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60,
      });

      return {
        success: true,
        mfaRequired: false,
        user: result.user,
        tenant: result.tenant,
        accessToken: result.tokens!.accessToken,
        expiresInSeconds: result.tokens!.expiresInSeconds,
      };
    } catch (err: any) {
      const status = err.message.includes('bloqueada') ? 423 : 401;
      return reply.status(status).send({
        success: false,
        error: err.message || 'Erro na autenticação.',
      });
    }
  });

  /**
   * POST /api/v1/auth/portal/login
   * Login prático do Portal do Colaborador (CPF + Data de Nascimento como Senha)
   * Isento de MFA por design para máxima usabilidade operacional
   */
  app.post('/portal/login', {
    config: {
      rateLimit: {
        max: 15,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const parseResult = loginPortalSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: parseResult.error.errors[0]?.message || 'Dados inválidos.',
      });
    }

    try {
      const result = await authService.loginPortal({
        cpf: parseResult.data.cpf,
        birthDateOrPassword: parseResult.data.birthDateOrPassword,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string,
      });

      // Cookie seguro com Refresh Token
      reply.setCookie(REFRESH_COOKIE_NAME, result.tokens.refreshToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60,
      });

      return {
        success: true,
        worker: result.worker,
        tenantId: result.tenantId,
        accessToken: result.tokens.accessToken,
        expiresInSeconds: result.tokens.expiresInSeconds,
      };
    } catch (err: any) {
      return reply.status(401).send({
        success: false,
        error: err.message || 'CPF ou data de nascimento incorretos.',
      });
    }
  });

  /**
   * POST /api/v1/auth/mfa/enroll
   * Inicia o setup de MFA TOTP: gera segredo, QR Code SVG e códigos de contingência
   */
  app.post('/mfa/enroll', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const result = await mfaService.enroll({
        userId: request.user!.sub,
        userEmail: request.user!.email || 'usuario@couplerh.com.br',
      });

      return {
        success: true,
        factorId: result.factorId,
        secret: result.secret,
        otpauthUri: result.otpauthUri,
        qrCodeSvg: result.qrCodeSvg,
        recoveryCodes: result.recoveryCodes,
      };
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err.message || 'Falha ao iniciar cadastro de MFA.',
      });
    }
  });

  /**
   * POST /api/v1/auth/mfa/verify
   * Conclui o setup de MFA validando o primeiro código TOTP de 6 dígitos
   * Promove o fator para verificado e a sessão para AAL2
   */
  app.post('/mfa/verify', { preHandler: [authenticate] }, async (request, reply) => {
    const parseResult = mfaVerifySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: parseResult.error.errors[0]?.message || 'Dados inválidos.',
      });
    }

    try {
      await mfaService.verify({
        userId: request.user!.sub,
        factorId: parseResult.data.factorId,
        code: parseResult.data.code,
        sessionId: request.user!.session_id,
      });

      // Emite novo token promovido para AAL2
      const newAccessToken = tokenService.issueAccessTokenForSession({
        userId: request.user!.sub,
        sessionId: request.user!.session_id,
        email: request.user!.email,
        cpf: request.user!.cpf,
        tenantId: request.user!.tenant_id,
        role: request.user!.role,
        workerId: request.user!.worker_id,
        aal: 'aal2',
      });

      return {
        success: true,
        aal: 'aal2',
        accessToken: newAccessToken,
        expiresInSeconds: 15 * 60,
      };
    } catch (err: any) {
      return reply.status(401).send({
        success: false,
        error: err.message || 'Código de verificação incorreto.',
      });
    }
  });

  /**
   * POST /api/v1/auth/mfa/challenge
   * Responde ao desafio de MFA do login (com TOTP ou Backup Code)
   * Promove a sessão para AAL2 e emite par final de credenciais
   */
  app.post('/mfa/challenge', async (request, reply) => {
    const parseResult = mfaChallengeSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: parseResult.error.errors[0]?.message || 'Dados inválidos.',
      });
    }

    // Identifica o token do desafio: pelo body ou pelo Bearer header
    const challengeToken =
      parseResult.data.challengeToken ||
      request.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!challengeToken) {
      return reply.status(401).send({
        success: false,
        error: 'Token de desafio de MFA obrigatório.',
      });
    }

    try {
      const payload = tokenService.verifyAccessToken(challengeToken);
      if (payload.scope !== 'mfa_challenge' && payload.aal !== 'aal1') {
        return reply.status(401).send({
          success: false,
          error: 'Token inválido para desafio de MFA.',
        });
      }

      const challengeRes = await mfaService.challenge({
        userId: payload.sub,
        codeOrRecoveryCode: parseResult.data.code,
        sessionId: payload.session_id,
      });

      // Cria a nova sessão completa AAL2 com par de tokens
      const newSession = await tokenService.createSession({
        userId: payload.sub,
        email: payload.email,
        tenantId: payload.tenant_id,
        role: payload.role,
        aal: 'aal2',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string,
      });

      // Define cookie HttpOnly com o refresh token AAL2
      reply.setCookie(REFRESH_COOKIE_NAME, newSession.refreshToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60,
      });

      return {
        success: true,
        aal: 'aal2',
        accessToken: newSession.accessToken,
        expiresInSeconds: newSession.expiresInSeconds,
        recoveryCodeUsed: challengeRes.recoveryCodeUsed,
      };
    } catch (err: any) {
      return reply.status(401).send({
        success: false,
        error: err.message || 'Código de autenticação ou de recuperação incorreto.',
      });
    }
  });

  /**
   * DELETE /api/v1/auth/mfa/:id
   * Desativação de fator MFA (exige senha atual + código de confirmação)
   */
  app.delete('/mfa/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = mfaUnenrollSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: parseResult.error.errors[0]?.message || 'Dados inválidos.',
      });
    }

    try {
      await mfaService.unenroll({
        userId: request.user!.sub,
        factorId: id,
        currentPassword: parseResult.data.currentPassword,
        codeOrRecoveryCode: parseResult.data.code,
      });

      return {
        success: true,
        message: 'Fator de autenticação em dois fatores removido com sucesso.',
      };
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err.message || 'Falha ao desativar MFA.',
      });
    }
  });

  /**
   * GET /api/v1/auth/mfa/factors
   * Lista todos os fatores cadastrados pelo usuário autenticado
   */
  app.get('/mfa/factors', { preHandler: [authenticate] }, async (request) => {
    const factors = await mfaService.listFactors(request.user!.sub);
    return {
      success: true,
      factors,
    };
  });

  /**
   * POST /api/v1/auth/session/heartbeat
   * Atualiza a atividade da sessão (prevenção contra inatividade)
   */
  app.post('/session/heartbeat', { preHandler: [authenticate] }, async (request) => {
    return {
      success: true,
      sessionId: request.user!.session_id,
      lastSeenAt: new Date().toISOString(),
    };
  });

  /**
   * POST /api/v1/auth/refresh
   * Rotação segura do Refresh Token (detecção de replay attack)
   */
  app.post('/refresh', async (request, reply) => {
    const refreshToken =
      request.cookies[REFRESH_COOKIE_NAME] ||
      (request.body as any)?.refreshToken;

    if (!refreshToken) {
      return reply.status(401).send({
        success: false,
        error: 'Refresh token não fornecido.',
      });
    }

    try {
      const result = await tokenService.rotateRefreshToken(
        refreshToken,
        request.ip,
        request.headers['user-agent'] as string
      );

      reply.setCookie(REFRESH_COOKIE_NAME, result.newRefreshToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60,
      });

      return {
        success: true,
        accessToken: result.accessToken,
        expiresInSeconds: 15 * 60,
      };
    } catch (err: any) {
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
      return reply.status(401).send({
        success: false,
        error: err.message || 'Sessão inválida ou expirada.',
      });
    }
  });

  /**
   * POST /api/v1/auth/logout
   * Encerramento da sessão atual
   */
  app.post('/logout', { preHandler: [authenticate] }, async (request, reply) => {
    if (request.user?.session_id && request.user?.sub) {
      await authService.logout(request.user.session_id, request.user.sub);
    }
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
    return {
      success: true,
      message: 'Sessão encerrada com sucesso.',
    };
  });

  /**
   * GET /api/v1/auth/me
   * Retorna os dados completos do usuário autenticado a partir do token
   */
  app.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const userData = await authService.getMe(request.user!.sub);
      const userMfaStatus = await mfaService.getUserMfaStatus(request.user!.sub);
      const tenantSettings = await mfaService.getTenantSettings(request.user!.tenant_id);

      return {
        success: true,
        user: {
          id: userData.id,
          email: userData.email,
          cpf: userData.cpf,
          full_name: userData.full_name,
          phone: userData.phone,
          role: request.user!.role,
          tenant_id: request.user!.tenant_id,
          tenant_name: userData.tenant_name,
          worker_id: request.user!.worker_id || userData.worker_id,
          aal: request.user!.aal,
          mfaEnrolled: userMfaStatus.hasVerifiedMfa,
          mfaRequired: tenantSettings.requireMfaRoles.includes(request.user!.role),
          sessionTimeoutMinutes: tenantSettings.sessionTimeoutMinutes,
        },
      };
    } catch (err: any) {
      return reply.status(404).send({
        success: false,
        error: err.message || 'Usuário não encontrado.',
      });
    }
  });

  /**
   * GET /api/v1/auth/sessions
   * Lista todas as sessões ativas do usuário
   */
  app.get('/sessions', { preHandler: [authenticate] }, async (request) => {
    const sessions = await authService.getTokenService().getActiveSessions(request.user!.sub);
    return {
      success: true,
      currentSessionId: request.user!.session_id,
      sessions,
    };
  });

  /**
   * DELETE /api/v1/auth/sessions/:id
   * Encerra remotamente uma sessão específica do usuário
   */
  app.delete('/sessions/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const success = await authService.getTokenService().revokeSession(id, request.user!.sub);

    if (!success) {
      return reply.status(404).send({
        success: false,
        error: 'Sessão não encontrada ou já encerrada.',
      });
    }

    return {
      success: true,
      message: 'Sessão remota encerrada com sucesso.',
    };
  });
};
