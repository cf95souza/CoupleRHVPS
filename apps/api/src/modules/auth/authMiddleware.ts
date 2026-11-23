import { FastifyRequest, FastifyReply } from 'fastify';
import { TokenService, AuthTokenPayload } from './tokenService.js';
import { dbPool } from '../../shared/db/pool.js';

// Estende a interface do FastifyRequest para tipar request.user
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthTokenPayload;
  }
}

const tokenService = new TokenService(dbPool);

/**
 * Middleware de Autenticação Fastify
 * Valida o JWT Access Token do header Authorization: Bearer <token>
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

  try {
    const payload = tokenService.verifyAccessToken(token);
    request.user = payload;
  } catch (err: any) {
    return reply.status(401).send({
      success: false,
      error: err.message || 'Token de acesso inválido ou expirado.',
    });
  }
}
