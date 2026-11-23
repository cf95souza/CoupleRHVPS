import { dbPool as defaultPool } from '../db/pool.js';
import pg from 'pg';

export type AlertSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
export type AlertCategory = 'DATABASE' | 'STORAGE' | 'QUEUE' | 'AUTH' | 'BACKUP' | 'SYSTEM' | 'SECURITY';

export interface CreateAlertInput {
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  message: string;
  metadata?: Record<string, any>;
}

export interface OperationalAlertRecord {
  id: string;
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  message: string;
  metadata: Record<string, any>;
  is_resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

export class AlertService {
  private pool: pg.Pool;

  constructor(pool?: pg.Pool) {
    this.pool = pool || defaultPool;
  }

  /**
   * Registra um novo alerta operacional no sistema
   */
  public async createAlert(input: CreateAlertInput): Promise<OperationalAlertRecord> {
    const query = `
      INSERT INTO public.system_operational_alerts (severity, category, title, message, metadata)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const res = await this.pool.query(query, [
      input.severity,
      input.category,
      input.title,
      input.message,
      JSON.stringify(input.metadata || {}),
    ]);

    return res.rows[0];
  }

  /**
   * Retorna alertas operacionais pendentes/ativos
   */
  public async getActiveAlerts(category?: AlertCategory): Promise<OperationalAlertRecord[]> {
    let query = `
      SELECT * FROM public.system_operational_alerts
      WHERE is_resolved = FALSE
    `;
    const params: any[] = [];
    if (category) {
      params.push(category);
      query += ` AND category = $1`;
    }
    query += ` ORDER BY created_at DESC LIMIT 100;`;

    const res = await this.pool.query(query, params);
    return res.rows;
  }

  /**
   * Marca um alerta operacional como resolvido
   */
  public async resolveAlert(id: string, resolvedByUserId?: string): Promise<boolean> {
    const query = `
      UPDATE public.system_operational_alerts
      SET is_resolved = TRUE, resolved_at = NOW(), resolved_by = $2
      WHERE id = $1;
    `;
    const res = await this.pool.query(query, [id, resolvedByUserId || null]);
    return (res.rowCount ?? 0) > 0;
  }
}
