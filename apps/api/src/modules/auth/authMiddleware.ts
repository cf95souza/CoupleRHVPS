import { FastifyRequest, FastifyReply } from 'fastify';
import pg from 'pg';
import { TokenService, AuthTokenPayload } from './tokenService.js';
import { MfaService } from './mfaService.js';
import { dbPool } from '../../shared/db/pool.js';
import { withTenantContext, withReadOnlyTenantContext, TenantContext } from '../../shared/db/context.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthTokenPayload;
    withContext?: <T>(callback: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
  }
}

const tokenService = new TokenService(dbPool);
const mfaService = new MfaService(dbPool);

/**
 * Middleware de Autenticação Fastify
 * Valida o JWT Access Token do header Authorization: Bearer <token>
 * Checa escopos restritos (mfa_challenge, mfa_setup_only) e timeout de inatividade
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      success: false,
      error: 'Autenticação necessária. Token de acesso não fornecido.',
    });
  }

  const token = authHeader.substring(7).trim();

  let payload: AuthTokenPayload;
  try {
    payload = tokenService.verifyAccessToken(token);
  } catch (err: any) {
    return reply.status(401).send({
      success: false,
      error: err.message || 'Token de acesso inválido ou expirado.',
    });
  }

  // 1. Tokens de desafio de MFA (mfa_challenge) são estritamente restritos à rota de challenge
  if (payload.scope === 'mfa_challenge' && !request.url.includes('/auth/mfa/challenge')) {
    return reply.status(403).send({
      success: false,
      code: 'MFA_CHALLENGE_REQUIRED',
      error: 'Segundo fator de autenticação pendente. Responda ao desafio de MFA.',
    });
  }

  // 2. Tokens de setup obrigatório (mfa_setup_only) só podem acessar rotas de MFA e logout
  if (
    payload.scope === 'mfa_setup_only' &&
    !request.url.includes('/auth/mfa') &&
    !request.url.includes('/auth/logout')
  ) {
    return reply.status(403).send({
      success: false,
      code: 'MFA_ENROLL_REQUIRED',
      error: 'Configuração obrigatória de MFA pendente para seu perfil de acesso.',
    });
  }

  // 3. Validação de Timeout Real de Inatividade de Sessão
  if (payload.session_id) {
    let timeoutMinutes = 60;
    if (payload.tenant_id) {
      try {
        const settings = await mfaService.getTenantSettings(payload.tenant_id);
        timeoutMinutes = settings.sessionTimeoutMinutes || 60;
      } catch {
        // Fallback para 60 minutos caso erro transitório
      }
    }

    const activity = await tokenService.touchSessionActivity(payload.session_id, timeoutMinutes);
    if (activity.isExpired) {
      return reply.status(401).send({
        success: false,
        code: 'SESSION_TIMEOUT',
        error: 'Sessão expirada por inatividade. Faça login novamente.',
      });
    }
  }

  request.user = payload;
  request.withContext = <T>(callback: (client: pg.PoolClient) => Promise<T>) => {
    return withTenantContext(
      {
        userId: payload.sub,
        tenantId: payload.tenant_id,
        role: payload.role,
        workerId: payload.worker_id,
      },
      callback
    );
  };
}

/**
 * Middleware para exigir AAL2 (segundo fator verificado) em rotas sensíveis
 */
export async function requireAal2(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.aal !== 'aal2') {
    return reply.status(403).send({
      success: false,
      code: 'AAL2_REQUIRED',
      error: 'Esta operação exige autenticação em dois fatores ativa (AAL2).',
    });
  }
}

/**
 * Middleware para bloquear acesso de perfis estritamente operacionais (employee) ao ambiente RH
 */
export async function requireAdminRole(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.role === 'employee') {
    return reply.status(403).send({
      success: false,
      code: 'FORBIDDEN_EMPLOYEE',
      error: 'Acesso restrito ao Portal do Colaborador. Perfil sem permissão para o ambiente administrativo de RH.',
    });
  }
}

