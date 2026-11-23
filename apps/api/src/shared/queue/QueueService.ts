import PgBoss from 'pg-boss';
import { env } from '../../config/env.js';

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

export class QueueService {
  private static instance: QueueService | null = null;
  private boss: PgBoss | null = null;
  private isStarted = false;

  private constructor() {}

  public static getInstance(): QueueService {
    if (!QueueService.instance) {
      QueueService.instance = new QueueService();
    }
    return QueueService.instance;
  }

  /**
   * Inicializa o pg-boss conectado ao PostgreSQL
   */
  public async start(): Promise<void> {
    if (this.isStarted && this.boss) {
      return;
    }

    try {
      this.boss = new PgBoss({
        connectionString: env.DATABASE_URL,
        schema: 'public',
        application_name: 'couplerh_pg_boss',
        max: 5,
      });

      this.boss.on('error', (err) => {
        console.error('[PG-BOSS ERROR] Erro na fila assíncrona:', err);
      });

      await this.boss.start();
      this.isStarted = true;
      console.log('[PG-BOSS] Fila transacional inicializada com sucesso.');
    } catch (err) {
      console.warn('[PG-BOSS WARNING] Não foi possível iniciar pg-boss no momento (operando em modo direto):', err);
      this.isStarted = false;
    }
  }

  /**
   * Enfileira envio de e-mail com retentativas automáticas
   */
  public async enqueueEmail(data: SendEmailJobData, options?: { delaySeconds?: number; priority?: number }): Promise<string | null> {
    if (!this.isStarted || !this.boss) {
      return null;
    }

    const jobId = await this.boss.send('send-email', data, {
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

    await this.boss.work<SendEmailJobData>('send-email', { batchSize: 5 }, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
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
      console.log('[PG-BOSS] Fila encerrada com sucesso.');
    }
  }

  public get isRunning(): boolean {
    return this.isStarted && this.boss !== null;
  }
}
