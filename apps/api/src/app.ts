import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import os from 'os';
import { env, allowedOriginsList } from './config/env.js';
import { pinoLoggerConfig } from './shared/logger/pinoLogger.js';
import { dbPool } from './shared/db/pool.js';
import { storageRoutes } from './modules/storage/storageRoutes.js';
import { observabilityRoutes } from './modules/observability/observabilityRoutes.js';
import { authRoutes } from './modules/auth/authRoutes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: pinoLoggerConfig,
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
    const dbStart = Date.now();
    let dbStatus = 'healthy';
    let dbLatencyMs = 0;

    try {
      const res = await dbPool.query('SELECT 1 as alive');
      if (!res.rows || res.rows.length === 0) {
        dbStatus = 'degraded';
      }
      dbLatencyMs = Date.now() - dbStart;
    } catch {
      dbStatus = 'unreachable';
      dbLatencyMs = -1;
    }

    const mem = process.memoryUsage();

    return {
      status: dbStatus === 'healthy' ? 'healthy' : 'degraded',
      system: 'coupleRH Enterprise API',
      version: '2.0.0',
      node_env: env.NODE_ENV,
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      checks: {
        database: {
          status: dbStatus,
          latency_ms: dbLatencyMs,
        },
        memory: {
          heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
          heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
          rss_mb: Math.round(mem.rss / 1024 / 1024),
          free_system_ram_mb: Math.round(os.freemem() / 1024 / 1024),
        },
      },
    };
  });

  // Rota de ping para verificacao de conectividade
  app.get('/api/v1/ping', async () => {
    return { pong: true, now: Date.now() };
  });

  // Modulo de Storage Seguro com URLs Assinadas HMAC-SHA256
  await app.register(storageRoutes, { prefix: '/api/v1/storage' });

  // Modulo de Observabilidade e Alertas Operacionais
  await app.register(observabilityRoutes, { prefix: '/api/v1/system' });

  // Modulo de Autenticacao Nativa (RH/Admin e Portal do Colaborador)
  await app.register(authRoutes, { prefix: '/api/v1/auth' });

  return app;
}