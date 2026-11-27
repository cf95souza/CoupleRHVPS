import PgBoss from 'pg-boss';
import { env } from '../../config/env.js';

export const QUEUE_EMAIL = 'send-email';
export const QUEUE_PAYROLL_CALCULATION = 'payroll-calculation-job';
export const QUEUE_PAYROLL_WATCHDOG = 'payroll-watchdog-cron';
export const QUEUE_ESOCIAL_SEND_BATCH = 'esocial-send-batch';
export const QUEUE_ESOCIAL_POLL_BATCH = 'esocial-poll-batch';
export const QUEUE_ESOCIAL_CERT_EXPIRY = 'esocial-cert-expiry-cron';
export const QUEUE_ALERT_SCAN = 'alert-scan-cron';

export interface EsocialBatchQueueData {
  batchId: string;
  tenantId: string;
  userId: string | null;
  role: string | null;
  sendUrl?: string;
  queryUrl?: string;
}

export interface SendEmailJobData {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content?: string; // base64
    path?: string;
    contentType?: string;
  }>;
}

export interface PayrollJobQueuePayload {
  jobId: string;
  tenantId: string;
  userId: string | null;
  role: string | null;
}

export class QueueService {
  private static instance: QueueService | null = null;
  private boss: PgBoss | null = null;
  private isStarted = false;
  private ensuredQueues = new Set<string>();

  private constructor() {}

  public static getInstance(): QueueService {
    if (!QueueService.instance) {
      QueueService.instance = new QueueService();
    }
    return QueueService.instance;
  }

  private async ensureQueue(name: string, options?: PgBoss.Queue): Promise<void> {
    if (!this.boss || this.ensuredQueues.has(name)) {
      return;
    }
    await this.boss.createQueue(name, options);
    this.ensuredQueues.add(name);
  }

  /**
   * Inicializa o pg-boss conectado ao PostgreSQL no schema dedicado `pgboss`
   */
  public async start(): Promise<void> {
    if (this.isStarted && this.boss) {
      return;
    }

    try {
      this.boss = new PgBoss({
        connectionString: env.DATABASE_URL,
        schema: 'pgboss',
        application_name: 'couplerh_pg_boss',
        max: 5,
      });

      this.boss.on('error', (err) => {
        console.error('[PG-BOSS ERROR] Erro na fila assíncrona:', err);
      });

      await this.boss.start();
      this.isStarted = true;
      this.ensuredQueues.clear();
      console.log('[PG-BOSS] Fila transacional inicializada com sucesso (schema pgboss).');
    } catch (err) {
      console.warn('[PG-BOSS WARNING] Não foi possível iniciar pg-boss no momento (operando em modo direto):', err);
      this.isStarted = false;
    }
  }

  /**
   * Enfileira envio de e-mail com retentativas automáticas
   */
  public async enqueueEmail(
    data: SendEmailJobData,
    options?: { delaySeconds?: number; priority?: number }
  ): Promise<string | null> {
    if (!this.isStarted || !this.boss) {
      return null;
    }

    await this.ensureQueue(QUEUE_EMAIL);

    const jobId = await this.boss.send(QUEUE_EMAIL, data, {
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true,
      startAfter: options?.delaySeconds ? options.delaySeconds : 0,
      priority: options?.priority ?? 0,
    });

    return jobId;
  }

  /**
   * Registra worker para consumo da fila de e-mails
   */
  public async registerEmailWorker(handler: (data: SendEmailJobData) => Promise<void>): Promise<void> {
    if (!this.isStarted || !this.boss) {
      return;
    }

    await this.ensureQueue(QUEUE_EMAIL);

    await this.boss.work<SendEmailJobData>(QUEUE_EMAIL, { batchSize: 5 }, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }

  /**
   * Enfileira um job de processamento/simulação de folha de pagamento
   */
  public async enqueuePayrollJob(data: PayrollJobQueuePayload): Promise<string | null> {
    if (!this.isStarted || !this.boss) {
      return null;
    }

    await this.ensureQueue(QUEUE_PAYROLL_CALCULATION);

    return this.boss.send(QUEUE_PAYROLL_CALCULATION, data, {
      singletonKey: data.jobId,
      retryLimit: 1,
      expireInSeconds: 1800,
    });
  }

  /**
   * Registra o worker responsável por processar lotes de cálculo e simulação de folha
   */
  public async registerPayrollJobWorker(
    handler: (data: PayrollJobQueuePayload) => Promise<void>
  ): Promise<void> {
    if (!this.isStarted || !this.boss) {
      return;
    }

    await this.ensureQueue(QUEUE_PAYROLL_CALCULATION);

    await this.boss.work<PayrollJobQueuePayload>(
      QUEUE_PAYROLL_CALCULATION,
      { batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          await handler(job.data);
        }
      }
    );
  }

  /**
   * Agenda e registra o cron do Watchdog anti-deadlock (padrão: a cada 2 minutos)
   */
  public async schedulePayrollWatchdog(
    handler: () => Promise<void>,
    cronExpr = '*/2 * * * *'
  ): Promise<void> {
    if (!this.isStarted || !this.boss) {
      return;
    }

    await this.ensureQueue(QUEUE_PAYROLL_WATCHDOG);

    await this.boss.schedule(QUEUE_PAYROLL_WATCHDOG, cronExpr, {}, {
      tz: 'America/Sao_Paulo',
    });

    await this.boss.work(QUEUE_PAYROLL_WATCHDOG, { batchSize: 1 }, async (jobs) => {
      for (const _job of jobs) {
        await handler();
      }
    });
  }

  /**
   * Enfileira envio de lote eSocial via mTLS (retry exponencial 5x)
   */
  public async enqueueEsocialSendBatch(data: EsocialBatchQueueData): Promise<string | null> {
    if (!this.isStarted || !this.boss) return null;
    await this.ensureQueue(QUEUE_ESOCIAL_SEND_BATCH);
    return this.boss.send(QUEUE_ESOCIAL_SEND_BATCH, data, {
      singletonKey: `send-${data.batchId}`,
      retryLimit: 5,
      retryDelay: 15,
      retryBackoff: true,
    });
  }

  /**
   * Enfileira consulta/polling de recibos e totalizadores de lote eSocial
   */
  public async enqueueEsocialPollBatch(
    data: EsocialBatchQueueData,
    options?: { delaySeconds?: number }
  ): Promise<string | null> {
    if (!this.isStarted || !this.boss) return null;
    await this.ensureQueue(QUEUE_ESOCIAL_POLL_BATCH);
    return this.boss.send(QUEUE_ESOCIAL_POLL_BATCH, data, {
      retryLimit: 5,
      retryDelay: 15,
      retryBackoff: true,
      startAfter: options?.delaySeconds ?? 5,
    });
  }

  public async registerEsocialSendWorker(
    handler: (data: EsocialBatchQueueData) => Promise<void>
  ): Promise<void> {
    if (!this.isStarted || !this.boss) return;
    await this.ensureQueue(QUEUE_ESOCIAL_SEND_BATCH);
    await this.boss.work<EsocialBatchQueueData>(QUEUE_ESOCIAL_SEND_BATCH, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }

  public async registerEsocialPollWorker(
    handler: (data: EsocialBatchQueueData) => Promise<void>
  ): Promise<void> {
    if (!this.isStarted || !this.boss) return;
    await this.ensureQueue(QUEUE_ESOCIAL_POLL_BATCH);
    await this.boss.work<EsocialBatchQueueData>(QUEUE_ESOCIAL_POLL_BATCH, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }

  public async scheduleEsocialCertExpiryCheck(
    handler: () => Promise<void>,
    cronExpr = '0 8 * * *'
  ): Promise<void> {
    if (!this.isStarted || !this.boss) return;
    await this.ensureQueue(QUEUE_ESOCIAL_CERT_EXPIRY);
    await this.boss.schedule(QUEUE_ESOCIAL_CERT_EXPIRY, cronExpr, {}, { tz: 'America/Sao_Paulo' });
    await this.boss.work(QUEUE_ESOCIAL_CERT_EXPIRY, { batchSize: 1 }, async (jobs) => {
      for (const _job of jobs) {
        await handler();
      }
    });
  }

  public async scheduleAlertScan(
    handler: () => Promise<void>,
    cronExpr = '0 7 * * *'
  ): Promise<void> {
    if (!this.isStarted || !this.boss) return;
    await this.ensureQueue(QUEUE_ALERT_SCAN);
    await this.boss.schedule(QUEUE_ALERT_SCAN, cronExpr, {}, { tz: 'America/Sao_Paulo' });
    await this.boss.work(QUEUE_ALERT_SCAN, { batchSize: 1 }, async (jobs) => {
      for (const _job of jobs) {
        await handler();
      }
    });
  }

  /**
   * Encerramento controlado da fila
   */
  public async stop(): Promise<void> {
    if (this.boss && this.isStarted) {
      await this.boss.stop({ graceful: true, timeout: 5000 });
      this.isStarted = false;
      this.boss = null;
      this.ensuredQueues.clear();
      console.log('[PG-BOSS] Fila encerrada com sucesso.');
    }
  }

  public get isRunning(): boolean {
    return this.isStarted && this.boss !== null;
  }
}
