import pg from 'pg';
import { MailerService } from '../../shared/mailer/MailerService.js';
import { buildVacationAlertEmail, buildTimePunchClosingEmail } from '../../shared/mailer/templates/emailTemplates.js';

export type NotificationType =
  | 'VACATION_ALERT'
  | 'ASO_EXAM_ALERT'
  | 'TIME_BANK_ALERT'
  | 'TIMESHEET_CLOSURE'
  | 'PAYSLIP_RELEASED'
  | 'ESOCIAL_ALERT'
  | 'SYSTEM_ALERT'
  | 'SECURITY_ALERT';

export type NotificationSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  severity?: NotificationSeverity;
  metadata?: Record<string, any>;
  sendEmail?: boolean;
  userEmail?: string;
  userName?: string;
}

export interface UserNotificationRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  severity: NotificationSeverity;
  is_read: boolean;
  read_at: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

export class NotificationService {
  private mailerService: MailerService;

  constructor(mailerService?: MailerService) {
    this.mailerService = mailerService || new MailerService();
  }

  /**
   * Cria uma notificação in-app e opcionalmente envia e-mail transacional
   */
  public async createNotification(
    client: pg.PoolClient | pg.Pool,
    tenantId: string,
    input: CreateNotificationInput
  ): Promise<UserNotificationRecord> {
    const query = `
      INSERT INTO public.user_notifications (
        tenant_id, user_id, type, title, message, link, severity, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const res = await client.query(query, [
      tenantId,
      input.userId,
      input.type,
      input.title,
      input.message,
      input.link || null,
      input.severity || 'INFO',
      JSON.stringify(input.metadata || {}),
    ]);

    const created = res.rows[0];

    // Disparo opcional de e-mail corporativo
    if (input.sendEmail && input.userEmail) {
      try {
        if (input.type === 'VACATION_ALERT' && input.metadata) {
          const emailTpl = buildVacationAlertEmail({
            managerName: 'Gestor',
            employeeName: input.userName || 'Colaborador',
            companyName: 'coupleRH',
            acquisitionPeriod: input.metadata.acquisitionEnd || 'Período Aquisitivo',
            concessiveLimitDate: input.metadata.concessiveEnd || '',
            daysRemaining: input.metadata.remainingDays || 30,
            portalActionUrl: input.link ? `https://couplerh.com.br${input.link}` : 'https://couplerh.com.br/vacations',
          });
          await this.mailerService.sendQueued({
            to: input.userEmail,
            subject: emailTpl.subject,
            html: emailTpl.html,
          });
        } else if (input.type === 'TIMESHEET_CLOSURE' && input.metadata) {
          const emailTpl = buildTimePunchClosingEmail({
            employeeName: input.userName || 'Colaborador',
            competenceMonthYear: input.metadata.competence || '',
            reviewUrl: input.link ? `https://couplerh.com.br${input.link}` : 'https://couplerh.com.br/portal',
            deadlineDate: input.metadata.closingDate || '',
          });
          await this.mailerService.sendQueued({
            to: input.userEmail,
            subject: emailTpl.subject,
            html: emailTpl.html,
          });
        }
      } catch (err) {
        // Falha no envio do e-mail não aborta a notificação in-app
        console.error('Falha ao enviar e-mail de notificação:', err);
      }
    }

    return created;
  }

  /**
   * Lista notificações do usuário ordenadas pelas mais recentes
   */
  public async getUserNotifications(
    client: pg.PoolClient | pg.Pool,
    tenantId: string,
    userId: string,
    options?: { limit?: number; onlyUnread?: boolean }
  ): Promise<UserNotificationRecord[]> {
    const limit = Math.min(100, Math.max(1, options?.limit || 20));
    let query = `
      SELECT * FROM public.user_notifications
      WHERE tenant_id = $1::uuid AND user_id = $2::uuid
    `;
    const params: any[] = [tenantId, userId];

    if (options?.onlyUnread) {
      query += ` AND is_read = FALSE`;
    }

    query += ` ORDER BY created_at DESC LIMIT $3;`;
    params.push(limit);

    const res = await client.query(query, params);
    return res.rows;
  }

  /**
   * Retorna a contagem de notificações não lidas
   */
  public async getUnreadCount(
    client: pg.PoolClient | pg.Pool,
    tenantId: string,
    userId: string
  ): Promise<number> {
    const query = `
      SELECT COUNT(*)::int AS count
      FROM public.user_notifications
      WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND is_read = FALSE;
    `;
    const res = await client.query(query, [tenantId, userId]);
    return Number(res.rows[0]?.count || 0);
  }

  /**
   * Marca uma notificação específica como lida
   */
  public async markAsRead(
    client: pg.PoolClient | pg.Pool,
    tenantId: string,
    userId: string,
    notificationId: string
  ): Promise<boolean> {
    const query = `
      UPDATE public.user_notifications
      SET is_read = TRUE, read_at = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND user_id = $3::uuid;
    `;
    const res = await client.query(query, [notificationId, tenantId, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Marca todas as notificações do usuário como lidas
   */
  public async markAllAsRead(
    client: pg.PoolClient | pg.Pool,
    tenantId: string,
    userId: string
  ): Promise<number> {
    const query = `
      UPDATE public.user_notifications
      SET is_read = TRUE, read_at = NOW()
      WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND is_read = FALSE;
    `;
    const res = await client.query(query, [tenantId, userId]);
    return res.rowCount ?? 0;
  }

  /**
   * Rotina periódica de varredura de passivos e alertas automáticos (CONF-04)
   * Disparada via Cron/pg-boss ou chamada sob demanda por administradores
   */
  public async runPeriodicAlertScan(
    client: pg.PoolClient | pg.Pool,
    tenantId: string
  ): Promise<{
    vacationAlertsCreated: number;
    timeBankAlertsCreated: number;
    esocialAlertsCreated: number;
  }> {
    let vacationAlertsCreated = 0;
    let timeBankAlertsCreated = 0;
    let esocialAlertsCreated = 0;

    // 1. Busca usuários de RH/DP para receber notificações operacionais
    const { rows: dpUsers } = await client.query(`
      SELECT u.id, u.email, u.full_name
      FROM public.users u
      JOIN public.tenant_users tu ON tu.user_id = u.id
      WHERE tu.tenant_id = $1::uuid
        AND tu.role IN ('system_admin', 'tenant_admin', 'dp_analyst')
        AND u.status = 'ACTIVE';
    `, [tenantId]);

    // 2. Alerta de Férias: Concessivo vencendo em até 60 dias (Art. 137 CLT)
    const { rows: expiringVacations } = await client.query(`
      SELECT vp.id, vp.concessive_end, vp.days_remaining, vp.acquisition_end,
             p.full_name, c.id as contract_id, c.worker_id
      FROM public.vacation_periods vp
      JOIN public.contracts c ON c.id = vp.contract_id
      JOIN public.workers w ON w.id = c.worker_id
      JOIN public.people p ON p.id = w.person_id
      WHERE c.tenant_id = $1::uuid
        AND c.status = 'ACTIVE'
        AND vp.days_remaining > 0
        AND vp.lost_by_leave = FALSE
        AND vp.status IN ('OPEN', 'PARTIALLY_TAKEN')
        AND vp.concessive_end <= (CURRENT_DATE + INTERVAL '60 days')
      ORDER BY vp.concessive_end ASC;
    `, [tenantId]);

    for (const vac of expiringVacations) {
      const daysUntilDeadline = Math.ceil(
        (new Date(vac.concessive_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      const isCritical = daysUntilDeadline <= 30;
      const severity: NotificationSeverity = isCritical ? 'CRITICAL' : 'WARNING';
      const title = isCritical
        ? `🚨 RISCO DE DOBRA: Férias de ${vac.full_name}`
        : `⚠️ Prazo Concessivo de Férias: ${vac.full_name}`;
      const message = `O prazo concessivo de férias de ${vac.full_name} (${vac.days_remaining} dias restantes) encerra em ${vac.concessive_end.toISOString().slice(0, 10)} (${daysUntilDeadline} dias restantes). Agende o gozo imediatamente para evitar a dobra do Art. 137 da CLT.`;

      // Notifica todos os analistas de DP do tenant
      for (const dpUser of dpUsers) {
        // Evita duplicidade de alerta no mesmo dia
        const { rows: exists } = await client.query(`
          SELECT id FROM public.user_notifications
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND type = 'VACATION_ALERT'
            AND (metadata->>'vacationPeriodId') = $3
            AND created_at >= (NOW() - INTERVAL '3 days');
        `, [tenantId, dpUser.id, vac.id]);

        if (exists.length === 0) {
          await this.createNotification(client, tenantId, {
            userId: dpUser.id,
            type: 'VACATION_ALERT',
            title,
            message,
            link: '/vacations',
            severity,
            metadata: {
              vacationPeriodId: vac.id,
              contractId: vac.contract_id,
              remainingDays: vac.days_remaining,
              concessiveEnd: vac.concessive_end.toISOString().slice(0, 10),
              acquisitionEnd: vac.acquisition_end.toISOString().slice(0, 10),
            },
            sendEmail: isCritical,
            userEmail: dpUser.email,
            userName: dpUser.full_name,
          });
          vacationAlertsCreated++;
        }
      }
    }

    // 3. Alerta de Banco de Horas Excedente (> 40h acumuladas)
    const { rows: highTimeBanks } = await client.query(`
      SELECT tba.id, tba.current_balance_minutes, p.full_name, c.id as contract_id
      FROM public.time_bank_accounts tba
      JOIN public.contracts c ON c.id = tba.contract_id
      JOIN public.workers w ON w.id = c.worker_id
      JOIN public.people p ON p.id = w.person_id
      WHERE c.tenant_id = $1::uuid
        AND c.status = 'ACTIVE'
        AND tba.current_balance_minutes >= 2400 -- 40 horas
      LIMIT 20;
    `, [tenantId]);

    for (const tb of highTimeBanks) {
      const hours = Math.floor(tb.current_balance_minutes / 60);
      for (const dpUser of dpUsers) {
        const { rows: exists } = await client.query(`
          SELECT id FROM public.user_notifications
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND type = 'TIME_BANK_ALERT'
            AND (metadata->>'accountId') = $3
            AND created_at >= (NOW() - INTERVAL '7 days');
        `, [tenantId, dpUser.id, tb.id]);

        if (exists.length === 0) {
          await this.createNotification(client, tenantId, {
            userId: dpUser.id,
            type: 'TIME_BANK_ALERT',
            title: `⏳ Banco de Horas Elevado: ${tb.full_name}`,
            message: `O colaborador ${tb.full_name} acumulou ${hours}h no Banco de Horas. Planeje compensação ou verifique o limite estipulado em CCT.`,
            link: '/ponto',
            severity: 'INFO',
            metadata: {
              accountId: tb.id,
              contractId: tb.contract_id,
              balanceMinutes: tb.current_balance_minutes,
            },
          });
          timeBankAlertsCreated++;
        }
      }
    }

    return {
      vacationAlertsCreated,
      timeBankAlertsCreated,
      esocialAlertsCreated,
    };
  }
}
