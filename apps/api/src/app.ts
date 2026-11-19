import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { env, allowedOriginsList } from './config/env.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          },
        }
      : true,
  });

  // CORS parametrizado via variaveis de ambiente (zero hardcodes)
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOriginsList.includes(origin) || env.NODE_ENV === 'development') {
        cb(null, true);
        return;
      }
      cb(new Error('Origem nao permitida pelas politicas de seguranca CORS.'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Cookies assinados para Refresh Token HttpOnly
  await app.register(cookie, {
    secret: env.JWT_ACCESS_SECRET,
  });

  // Protecao contra forca bruta / rate limit (RFC 6585)
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // Rota de Health Check para observabilidade e Uptime Kuma
  app.get('/health', async () => {
    return {
      status: 'healthy',
      system: 'coupleRH Enterprise API',
      version: '2.0.0',
      node_env: env.NODE_ENV,
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
    };
  });

  // Rota de ping para verificacao de conectividade
  app.get('/api/v1/ping', async () => {
    return { pong: true, now: Date.now() };
  });

  return app;
}