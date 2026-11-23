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

const REFRESH_COOKIE_NAME = 'couplerh_refresh_token';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const authService = new AuthService(dbPool);

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

      // Define cookie HttpOnly protegido com o refresh token rotativo
      reply.setCookie(REFRESH_COOKIE_NAME, result.tokens.refreshToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60,
      });

      return {
        success: true,
        user: result.user,
        tenant: result.tenant,
        accessToken: result.tokens.accessToken,
        expiresInSeconds: result.tokens.expiresInSeconds,
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
   * POST /api/v1/auth/refresh
   * Rotação segura do Refresh Token (detecção de replay attack)
   */
  app.post('/refresh', async (request, reply) => {
    // Busca token prioritariamente no cookie HttpOnly, com fallback para o body
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
      const result = await authService.refreshToken(
        refreshToken,
        request.ip,
        request.headers['user-agent'] as string
      );

      // Atualiza cookie com o novo refresh token rotativo
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
      // Limpa cookie comprometido
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
