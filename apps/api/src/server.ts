import { buildApp } from './app.js';
import { env } from './config/env.js';
import { QueueService } from './shared/queue/QueueService.js';
import { processPayrollCalculationJob, runPayrollWatchdog } from './modules/payroll/payrollJobService.js';
import { registerEsocialWorkers } from './modules/esocial/esocialTransmissionWorker.js';
import { checkExpiringCertificates } from './modules/esocial/certificateVaultService.js';
import { NotificationService } from './modules/notifications/NotificationService.js';
import { dbPool } from './shared/db/pool.js';

async function main() {
  const app = await buildApp();
  const queueService = QueueService.getInstance();

  const closeListeners = ['SIGINT', 'SIGTERM'];
  closeListeners.forEach((signal) => {
    process.on(signal, async () => {
      app.log.info({ signal }, 'Sinal de encerramento recebido. Fechando aplicacao graciosamente...');
      await queueService.stop().catch(() => undefined);
      await app.close();
      process.exit(0);
    });
  });

  try {
    await queueService.start();
    if (queueService.isRunning) {
      await queueService.registerPayrollJobWorker(async (payload) => {
        await processPayrollCalculationJob(payload);
      });
      await queueService.schedulePayrollWatchdog(async () => {
        const res = await runPayrollWatchdog();
        if (res.recovered_jobs.length > 0 || res.recovered_periods.length > 0) {
          app.log.warn(res, '[WATCHDOG] Destravamento automatico de calculo de folha executado');
        }
      }, '*/2 * * * *');
      await registerEsocialWorkers(queueService);
      await queueService.scheduleEsocialCertExpiryCheck(async () => {
        await checkExpiringCertificates();
      }, '0 8 * * *');
      await queueService.scheduleAlertScan(async () => {
        try {
          const tenantsRes = await dbPool.query('SELECT DISTINCT tenant_id FROM public.companies WHERE is_active = true');
          const notifService = new NotificationService();
          for (const row of tenantsRes.rows) {
            await notifService.runPeriodicAlertScan(dbPool, row.tenant_id).catch(() => undefined);
          }
        } catch (scanErr) {
          app.log.error(scanErr, '[NOTIFICATION CRON] Erro na varredura matinal de alertas');
        }
      }, '0 7 * * *');
      app.log.info('[QUEUE] Worker de lotes de folha, eSocial mTLS, Watchdog e Varredura de Alertas ativos.');
    }

    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`[SERVER] coupleRH API v2.0 executando em http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err, '[SERVER FATAL] Erro ao iniciar servidor Fastify');
    process.exit(1);
  }
}

main();
