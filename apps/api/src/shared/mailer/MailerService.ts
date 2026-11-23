import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { QueueService, SendEmailJobData } from '../queue/QueueService.js';
import {
  buildWelcomeEmployeeEmail,
  buildPasswordResetEmail,
  buildPayslipAvailableEmail,
  buildVacationAlertEmail,
  buildTimePunchClosingEmail,
} from './templates/emailTemplates.js';

export interface SendMailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
    contentType?: string;
  }>;
}

export interface SendMailResult {
  queued: boolean;
  messageId?: string;
  jobId?: string | null;
  response?: any;
}

export class MailerService {
  private transporter: Transporter;
  private readonly defaultFrom: string;
  private readonly queueService: QueueService;

  constructor(options?: {
    transporter?: Transporter;
    queueService?: QueueService;
  }) {
    this.queueService = options?.queueService || QueueService.getInstance();
    this.defaultFrom = `"${env.SMTP_FROM_NAME}" <${env.SMTP_FROM_EMAIL}>`;

    if (options?.transporter) {
      this.transporter = options.transporter;
    } else {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE, // true para 465, false para 587 (STARTTLS)
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        },
        tls: {
          rejectUnauthorized: env.NODE_ENV === 'production',
        },
      });
    }
  }

  /**
   * Envio direto síncrono de e-mail (usado por rotas urgentes ou pelo worker da fila)
   */
  public async sendDirect(options: SendMailOptions): Promise<SendMailResult> {
    const info = await this.transporter.sendMail({
      from: this.defaultFrom,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
      attachments: options.attachments,
    });

    return {
      queued: false,
      messageId: info.messageId,
      response: info.response || (info as any).message,
    };
  }

  /**
   * Envio assíncrono via fila transacional pg-boss com retentativas automáticas
   * (Fallback para envio direto se a fila não estiver rodando)
   */
  public async sendQueued(options: SendMailOptions): Promise<SendMailResult> {
    if (this.queueService.isRunning) {
      const jobId = await this.queueService.enqueueEmail({
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
        replyTo: options.replyTo,
      });

      if (jobId) {
        return { queued: true, jobId };
      }
    }

    // Fallback para envio direto
    return this.sendDirect(options);
  }

  // ===========================================================================
  // MÉTODOS DE NEGÓCIO COM TEMPLATES CORPORATIVOS EM PORTUGUÊS (BRASIL)
  // ===========================================================================

  /**
   * 1. Envia boas-vindas e ativação de primeiro acesso
   */
  public async sendWelcomeEmployee(to: string, data: Parameters<typeof buildWelcomeEmployeeEmail>[0], async = true) {
    const rendered = buildWelcomeEmployeeEmail(data);
    const mailOptions: SendMailOptions = {
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    return async ? this.sendQueued(mailOptions) : this.sendDirect(mailOptions);
  }

  /**
   * 2. Envia e-mail de redefinição de senha segura
   */
  public async sendPasswordReset(to: string, data: Parameters<typeof buildPasswordResetEmail>[0], async = false) {
    const rendered = buildPasswordResetEmail(data);
    const mailOptions: SendMailOptions = {
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    // Redefinição de senha prioriza envio direto para velocidade imediata
    return async ? this.sendQueued(mailOptions) : this.sendDirect(mailOptions);
  }

  /**
   * 3. Notifica colaborador da liberação do holerite
   */
  public async sendPayslipAvailable(to: string, data: Parameters<typeof buildPayslipAvailableEmail>[0], async = true) {
    const rendered = buildPayslipAvailableEmail(data);
    const mailOptions: SendMailOptions = {
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    return async ? this.sendQueued(mailOptions) : this.sendDirect(mailOptions);
  }

  /**
   * 4. Alerta gestor e RH de prazo limite de férias (risco de dobra CLT)
   */
  public async sendVacationAlert(to: string, data: Parameters<typeof buildVacationAlertEmail>[0], async = true) {
    const rendered = buildVacationAlertEmail(data);
    const mailOptions: SendMailOptions = {
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    return async ? this.sendQueued(mailOptions) : this.sendDirect(mailOptions);
  }

  /**
   * 5. Notifica encerramento e assinatura do espelho de ponto eletrônico
   */
  public async sendTimePunchClosing(to: string, data: Parameters<typeof buildTimePunchClosingEmail>[0], async = true) {
    const rendered = buildTimePunchClosingEmail(data);
    const mailOptions: SendMailOptions = {
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    return async ? this.sendQueued(mailOptions) : this.sendDirect(mailOptions);
  }
}
