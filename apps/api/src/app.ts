import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import os from 'os';
import { env, allowedOriginsList } from './config/env.js';
import { pinoLoggerConfig } from './shared/logger/pinoLogger.js';
import { dbPool } from './shared/db/pool.js';
import { storageRoutes } from './modules/storage/storageRoutes.js';
import { observabilityRoutes } from './modules/observability/observabilityRoutes.js';
import { authRoutes } from './modules/auth/authRoutes.js';
import { publicRoutes } from './modules/public/publicRoutes.js';
import { userAccessRoutes } from './modules/users/userAccessRoutes.js';
import { payrollPeriodRoutes } from './modules/payroll/payrollPeriodRoutes.js';
import { timeTrackingRoutes } from './modules/time-tracking/timeTrackingRoutes.js';
import { documentRoutes } from './modules/documents/documentRoutes.js';
import { terminationRoutes } from './modules/termination/terminationRoutes.js';
import { biRoutes } from './modules/bi/biRoutes.js';
import { employeeRoutes } from './modules/employees/employeeRoutes.js';
import { leaveRoutes } from './modules/leaves/leaveRoutes.js';
import { orgRoutes } from './modules/org/orgRoutes.js';
import { vacationRoutes } from './modules/vacations/vacationRoutes.js';
import { portalRoutes } from './modules/portal/portalRoutes.js';
import { settingsRoutes } from './modules/settings/settingsRoutes.js';
import { benefitRoutes } from './modules/benefits/benefitRoutes.js';
import { unionRoutes } from './modules/unions/unionRoutes.js';
import { dissidioRoutes } from './modules/payroll/dissidioRoutes.js';
import { accountingRoutes } from './modules/accounting/accountingRoutes.js';
import { approvalRoutes } from './modules/approvals/approvalRoutes.js';
import { esocialRoutes } from './modules/esocial/esocialRoutes.js';
import { dataBridgeRoutes } from './modules/data/dataBridgeRoutes.js';
import { migrationRoutes } from './modules/migration/migrationRoutes.js';
import { notificationRoutes } from './modules/notifications/notificationRoutes.js';
import { admissionRoutes } from './modules/admissions/admissionRoutes.js';

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

  // Upload multipart seguro (Certificado A1 .pfx / documentos)
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB
    },
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

  // Rotas Publicas de Verificacao LGPD (Unicas sem exigencia de autenticacao)
  await app.register(publicRoutes, { prefix: '/api/v1/public' });

  // Modulos Protegidos de Seguranca, Folha, Ponto, Documentos, Rescisao e BI
  await app.register(userAccessRoutes, { prefix: '/api/v1/users' });
  await app.register(payrollPeriodRoutes, { prefix: '/api/v1/payroll' });
  await app.register(dissidioRoutes, { prefix: '/api/v1/payroll/dissidio' });
  await app.register(accountingRoutes, { prefix: '/api/v1/accounting' });
  await app.register(approvalRoutes, { prefix: '/api/v1/approvals' });
  await app.register(esocialRoutes, { prefix: '/api/v1/esocial' });
  await app.register(timeTrackingRoutes, { prefix: '/api/v1/time-tracking' });
  await app.register(documentRoutes, { prefix: '/api/v1/documents' });
  await app.register(terminationRoutes, { prefix: '/api/v1/termination' });
  await app.register(biRoutes, { prefix: '/api/v1/bi' });
  await app.register(employeeRoutes, { prefix: '/api/v1/employees' });
  await app.register(leaveRoutes, { prefix: '/api/v1/leaves' });
  await app.register(orgRoutes, { prefix: '/api/v1/org' });
  await app.register(vacationRoutes, { prefix: '/api/v1/vacations' });
  await app.register(portalRoutes, { prefix: '/api/v1/portal' });
  await app.register(settingsRoutes, { prefix: '/api/v1/settings' });
  await app.register(benefitRoutes, { prefix: '/api/v1/benefits' });
  await app.register(unionRoutes, { prefix: '/api/v1' });
  await app.register(dataBridgeRoutes, { prefix: '/api/v1' });
  await app.register(migrationRoutes, { prefix: '/api/v1/migration' });
  await app.register(notificationRoutes, { prefix: '/api/v1/notifications' });
  await app.register(admissionRoutes, { prefix: '/api/v1/admissions' });

  return app;
}