import { FastifyPluginAsync } from 'fastify';
import os from 'os';
import { AlertService, AlertCategory } from '../../shared/observability/AlertService.js';
import { dbPool } from '../../shared/db/pool.js';

export const observabilityRoutes: FastifyPluginAsync = async (app) => {
  const alertService = new AlertService(dbPool);

  /**
   * GET /api/v1/system/alerts
   * Retorna os alertas operacionais ativos do sistema
   */
  app.get('/alerts', async (request, reply) => {
    const { category } = request.query as { category?: AlertCategory };
    const alerts = await alertService.getActiveAlerts(category);
    return {
      success: true,
      count: alerts.length,
      alerts,
    };
  });

  /**
   * POST /api/v1/system/alerts/:id/resolve
   * Marca um alerta como resolvido
   */
  app.post('/alerts/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const success = await alertService.resolveAlert(id);
    if (!success) {
      return reply.status(404).send({
        success: false,
        error: 'Alerta operacional não encontrado ou já resolvido.',
      });
    }
    return {
      success: true,
      message: 'Alerta operacional resolvido com sucesso.',
    };
  });

  /**
   * GET /api/v1/system/metrics
   * Retorna métricas detalhadas de processo, memória e banco de dados
   */
  app.get('/metrics', async () => {
    const mem = process.memoryUsage();
    const dbStart = Date.now();
    let dbStatus = 'healthy';
    let dbLatencyMs = 0;

    try {
      await dbPool.query('SELECT 1');
      dbLatencyMs = Date.now() - dbStart;
    } catch {
      dbStatus = 'unreachable';
      dbLatencyMs = -1;
    }

    return {
      timestamp: new Date().toISOString(),
      process: {
        uptime_seconds: Math.floor(process.uptime()),
        pid: process.pid,
        node_version: process.version,
        memory: {
          heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
          heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
          rss_mb: Math.round(mem.rss / 1024 / 1024),
          external_mb: Math.round(mem.external / 1024 / 1024),
        },
      },
      host: {
        platform: os.platform(),
        arch: os.arch(),
        cpu_count: os.cpus().length,
        free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
        total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
      },
      database: {
        status: dbStatus,
        latency_ms: dbLatencyMs,
        total_clients: dbPool.totalCount,
        idle_clients: dbPool.idleCount,
        waiting_clients: dbPool.waitingCount,
      },
    };
  });
};
