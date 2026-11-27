import crypto from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { generateRotatingScheduleCalendar } from '@couplerh/payroll-core';
import { env } from '../../config/env.js';
import { StorageService } from '../../shared/storage/StorageService.js';
import { authenticate } from '../auth/authMiddleware.js';

const vacationRequestSchema = z.object({
  vacationPeriodId: z.string().uuid('ID do período aquisitivo inválido.'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de início inválida (AAAA-MM-DD).'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de término inválida (AAAA-MM-DD).'),
  daysCount: z.number().int().min(5).max(30),
  sellDaysCount: z.number().int().min(0).max(10).default(0),
  wantsThirteenthAdvance: z.boolean().default(false),
});

const dayOffRequestSchema = z.object({
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requestedMinutes: z.number().int().min(30).max(720),
  justification: z.string().min(3).max(500),
});

const timesheetSignSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
});

const timesheetContestSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  affectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().min(5).max(1000),
});

const justificationSchema = z.object({
  adjustmentType: z
    .enum(['INSERT_PUNCH', 'JUSTIFY_ABSENCE', 'FORGIVE_DELAY', 'OVERTIME_AUTHORIZATION', 'MEDICAL_CERTIFICATE'])
    .default('JUSTIFY_ABSENCE'),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  justification: z.string().min(3).max(1000),
  cid10Code: z.string().max(20).optional().nullable(),
  doctorCrm: z.string().max(30).optional().nullable(),
  requestedPunches: z.any().optional().nullable(),
  fileName: z.string().max(255).optional().nullable(),
  mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']).optional(),
  fileBase64: z.string().optional().nullable(),
});

const lgpdConsentSchema = z.object({
  consentCategory: z.enum([
    'BIOMETRIC_SELFIE_PUNCH',
    'GEOLOCATION_PUNCH',
    'MEDICAL_DATA_PROCESSING',
    'WHATSAPP_NOTIFICATIONS',
    'THIRD_PARTY_BENEFITS',
  ]),
  granted: z.boolean().default(true),
  version: z.string().max(20).optional().default('1.0'),
});

const lgpdRequestSchema = z.object({
  requestType: z.string().min(3).max(100),
  justification: z.string().max(1000).optional().nullable(),
});

function formatEntryTypePtBr(raw?: string | null): string {
  switch (String(raw || '').toUpperCase()) {
    case 'IN':
    case 'ENTRY':
      return 'Entrada';
    case 'BREAK_START':
    case 'INTERVAL_START':
      return 'Saída Almoço';
    case 'BREAK_END':
    case 'INTERVAL_END':
      return 'Retorno Almoço';
    case 'OUT':
    case 'EXIT':
      return 'Saída';
    default:
      return raw || 'Marcação';
  }
}

export const portalRoutes: FastifyPluginAsync = async (app) => {
  const storageService = new StorageService();
  app.addHook('preHandler', authenticate);

  const resolveMyWorkerAndContract = async (client: any, user: any) => {
    const { rows: wRows } = await client.query(
      `SELECT w.*, u.email AS user_email
       FROM public.workers w
       LEFT JOIN public.users u ON u.id = w.user_id
       WHERE (w.id = $1::uuid OR w.user_id = $2::uuid)
       LIMIT 1;`,
      [user.worker_id || null, user.sub]
    );
    if (wRows.length === 0) return null;
    const worker = wRows[0];

    const { rows: cRows } = await client.query(
      `SELECT c.*,
              COALESCE(comp.trade_name, comp.corporate_name) AS company_name,
              comp.cnpj AS company_cnpj,
              dept.name AS department_name,
              pos.title AS position_title
       FROM public.contracts c
       LEFT JOIN public.companies comp ON comp.id = c.company_id
       LEFT JOIN public.departments dept ON dept.id = c.department_id
       LEFT JOIN public.positions pos ON pos.id = c.position_id
       WHERE c.worker_id = $1::uuid AND c.status = 'ACTIVE' AND c.deleted_at IS NULL
       ORDER BY c.admission_date DESC
       LIMIT 1;`,
      [worker.id]
    );
    return { worker, contract: cRows[0] || null };
  };

  // 1. Perfil Completo do Colaborador Logado
  app.get('/me', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    try {
      const data = await request.withContext((client) => resolveMyWorkerAndContract(client, request.user!));
      if (!data) {
        return reply.status(404).send({
          success: false,
          code: 'WORKER_NOT_LINKED',
          error: 'Nenhum cadastro de trabalhador vinculado a esta conta de usuário.',
        });
      }
      return reply.send({ success: true, data });
    } catch (err: any) {
      request.log.error(err, '[PORTAL_ME] Erro ao carregar perfil');
      return reply.status(500).send({ success: false, error: 'Erro ao carregar dados do colaborador.' });
    }
  });

  // 2. Histórico de Holerites do Colaborador
  app.get('/payslips', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    try {
      const payslips = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT p.*, pp.year, pp.month, pp.type AS period_type
           FROM public.payslips p
           JOIN public.payroll_periods pp ON pp.id = p.payroll_period_id
           JOIN public.contracts c ON c.id = p.contract_id
           JOIN public.workers w ON w.id = c.worker_id
           WHERE (w.id = $1::uuid OR w.user_id = $2::uuid)
             AND p.status = 'PUBLISHED'
           ORDER BY pp.year DESC, pp.month DESC;`,
          [request.user!.worker_id || null, request.user!.sub]
        );
        return rows;
      });

      return reply.send({ success: true, data: payslips });
    } catch (err: any) {
      request.log.error(err, '[PORTAL_PAYSLIPS] Erro');
      return reply.status(500).send({ success: false, error: 'Erro ao consultar holerites.' });
    }
  });

  // 3. Detalhe do Holerite com Rubricas
  app.get('/payslips/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    try {
      const payslip = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT p.*, pp.year, pp.month, pp.type AS period_type
           FROM public.payslips p
           JOIN public.payroll_periods pp ON pp.id = p.payroll_period_id
           JOIN public.contracts c ON c.id = p.contract_id
           JOIN public.workers w ON w.id = c.worker_id
           WHERE p.id = $1::uuid
             AND (w.id = $2::uuid OR w.user_id = $3::uuid)
           LIMIT 1;`,
          [id, request.user!.worker_id || null, request.user!.sub]
        );
        if (pRows.length === 0) return null;

        const { rows: items } = await client.query(
          `SELECT pi.*, r.code AS rubric_code, r.name AS rubric_name, r.type AS rubric_type
           FROM public.payslip_items pi
           JOIN public.rubrics r ON r.id = pi.rubric_id
           WHERE pi.payslip_id = $1::uuid
           ORDER BY r.type ASC, r.code ASC;`,
          [id]
        );
        return { ...pRows[0], items };
      });

      if (!payslip) {
        return reply.status(404).send({
          success: false,
          code: 'PAYSLIP_NOT_FOUND',
          error: 'Holerite não encontrado ou acesso não autorizado.',
        });
      }
      return reply.send({ success: true, data: payslip });
    } catch {
      return reply.status(500).send({ success: false, error: 'Erro ao carregar holerite.' });
    }
  });

  // 4. Espelho / Marcações de Ponto do Colaborador (PONTO-05: entry_type_label PT-BR)
  app.get('/time-records', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }
    const query = request.query as { startDate?: string; endDate?: string };

    try {
      const records = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT tpr.*
           FROM public.time_punch_records tpr
           JOIN public.contracts c ON c.id = tpr.contract_id
           JOIN public.workers w ON w.id = c.worker_id
           WHERE (w.id = $1::uuid OR w.user_id = $2::uuid)
             AND ($3::timestamptz IS NULL OR tpr.punched_at >= $3::timestamptz)
             AND ($4::timestamptz IS NULL OR tpr.punched_at <= $4::timestamptz)
           ORDER BY tpr.punched_at DESC
           LIMIT 200;`,
          [
            request.user!.worker_id || null,
            request.user!.sub,
            query.startDate ? `${query.startDate}T00:00:00Z` : null,
            query.endDate ? `${query.endDate}T23:59:59Z` : null,
          ]
        );
        return rows.map((r: any) => ({
          ...r,
          entry_type_label: formatEntryTypePtBr(r.punch_type),
        }));
      });
      return reply.send({ success: true, data: records });
    } catch {
      return reply.status(500).send({ success: false, error: 'Erro ao carregar registros de ponto.' });
    }
  });

  // 4.1 Locais de Trabalho Permitidos do Contrato
  app.get('/workplaces', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }
    const data = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.contract) return { isTelework: false, workplaces: [] };

      const { rows: allowed } = await client.query(
        `SELECT wp.id, wp.name, wp.address, wp.latitude, wp.longitude, wp.radius_meters,
                wp.enforce_geofence, wp.max_accuracy_meters,
                COALESCE(caw.allow_external_audit, wp.allow_external_audit, FALSE) AS allow_external_audit,
                caw.is_primary
         FROM public.contract_allowed_workplaces caw
         JOIN public.workplaces wp ON wp.id = caw.workplace_id
         WHERE caw.contract_id = $1::uuid AND caw.is_active = TRUE AND wp.deleted_at IS NULL
         ORDER BY caw.is_primary DESC, wp.name ASC;`,
        [ctx.contract.id]
      );

      let list = allowed;
      if (list.length === 0 && ctx.contract.workplace_id) {
        const { rows: single } = await client.query(
          `SELECT id, name, address, latitude, longitude, radius_meters, enforce_geofence,
                  max_accuracy_meters, allow_external_audit, TRUE AS is_primary
           FROM public.workplaces WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1;`,
          [ctx.contract.workplace_id]
        );
        list = single;
      }

      return { isTelework: ctx.contract.regime === 'TELEWORK', workplaces: list };
    });

    return reply.send({ success: true, data });
  });

  // 4.2 Comprovante REP-P com QR Code real sem CPF na URL (PONTO-04)
  app.get('/punches/:id/receipt', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const row = await request.withContext(async (client) => {
      const { rows } = await client.query(
        `SELECT tpr.id, tpr.nsr, tpr.punched_at, tpr.device_timestamp, tpr.server_received_at,
                tpr.sync_origin, tpr.punch_type, tpr.source, tpr.receipt_code, tpr.sha256_hash,
                tpr.geofence_status, tpr.latitude, tpr.longitude, tpr.accuracy,
                w.full_name AS worker_name, w.cpf AS worker_cpf,
                COALESCE(co.trade_name, co.corporate_name) AS company_name, co.cnpj AS company_cnpj
         FROM public.time_punch_records tpr
         JOIN public.workers w ON w.id = tpr.worker_id
         LEFT JOIN public.companies co ON co.id = tpr.company_id
         WHERE tpr.id = $1::uuid
           AND (w.id = $2::uuid OR w.user_id = $3::uuid)
         LIMIT 1;`,
        [id, request.user!.worker_id || null, request.user!.sub]
      );
      return rows[0] || null;
    });

    if (!row) return reply.status(404).send({ success: false, error: 'Comprovante não encontrado.' });

    const code = row.receipt_code || row.id;
    const verificationUrl = `${env.APP_PUBLIC_URL.replace(/\/+$/, '')}/verificar-ponto/${code}`;
    const qrCodeDataUrl = await QRCode.toDataURL(verificationUrl, { margin: 1, width: 220 });

    return reply.send({
      success: true,
      data: {
        ...row,
        entry_type_label: formatEntryTypePtBr(row.punch_type),
        verification_url: verificationUrl,
        qr_code_data_url: qrCodeDataUrl,
      },
    });
  });

  // 4.3 Banco de Horas via API Autenticada + Solicitação de Folga sem auto-débito (PONTO-05)
  app.get('/time-bank', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const data = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.contract) return null;

      const { rows: accRows } = await client.query(
        `SELECT * FROM public.time_bank_accounts WHERE contract_id = $1::uuid ORDER BY created_at DESC LIMIT 1;`,
        [ctx.contract.id]
      );
      const account = accRows[0] || {
        id: null,
        contract_id: ctx.contract.id,
        balance_minutes: 0,
        initial_balance_minutes: 0,
        closure_date: null,
      };

      const { rows: txRows } = account.id
        ? await client.query(
            `SELECT * FROM public.time_bank_transactions WHERE account_id = $1::uuid ORDER BY reference_date DESC, created_at DESC LIMIT 100;`,
            [account.id]
          )
        : { rows: [] };

      const { rows: pendingDayOffs } = await client.query(
        `SELECT id, work_date, requested_minutes, justification, status, created_at
         FROM public.time_punch_adjustments
         WHERE contract_id = $1::uuid AND adjustment_type = 'TIME_BANK_DAY_OFF'
         ORDER BY created_at DESC LIMIT 20;`,
        [ctx.contract.id]
      );

      return { account, transactions: txRows, pendingDayOffs };
    });

    if (!data) return reply.status(404).send({ success: false, error: 'Contrato ativo não encontrado.' });
    return reply.send({ success: true, data });
  });

  app.post('/time-bank/request-day-off', async (request, reply) => {
    const parse = dayOffRequestSchema.safeParse(request.body || {});
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const d = parse.data;
    const tenantId = request.user!.tenant_id!;

    try {
      const created = await request.withContext(async (client) => {
        const ctx = await resolveMyWorkerAndContract(client, request.user!);
        if (!ctx?.contract) throw new Error('Colaborador sem contrato ativo.');

        const { rows: accRows } = await client.query(
          `SELECT balance_minutes FROM public.time_bank_accounts WHERE contract_id = $1::uuid LIMIT 1;`,
          [ctx.contract.id]
        );
        const balance = Number(accRows[0]?.balance_minutes || 0);
        if (balance < d.requestedMinutes) {
          throw new Error(`Saldo insuficiente no banco de horas (${balance} min disponíveis).`);
        }

        // Cria solicitação pendente do gestor; NÃO debita saldo no cliente nem antecipadamente!
        const { rows: ins } = await client.query(
          `INSERT INTO public.time_punch_adjustments (
             tenant_id, contract_id, work_date, adjustment_type, requested_minutes, justification, status
           ) VALUES ($1::uuid, $2::uuid, $3::date, 'TIME_BANK_DAY_OFF', $4, $5, 'PENDING_MANAGER')
           RETURNING *;`,
          [tenantId, ctx.contract.id, d.workDate, d.requestedMinutes, d.justification]
        );
        return ins[0];
      });

      return reply.status(201).send({
        success: true,
        message: 'Solicitação de folga enviada para aprovação do gestor e DP.',
        data: created,
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err.message });
    }
  });

  // 4.4 Espelho Multi-Mês do Colaborador (GET /timesheet, POST /timesheet/sign, POST /timesheet/contest)
  app.get('/timesheet', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }
    const q = request.query as { year?: string; month?: string };
    const now = new Date();
    const year = Number(q.year || now.getFullYear());
    const month = Number(q.month || now.getMonth() + 1);
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const data = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.contract) return null;

      const { rows: summaries } = await client.query(
        `SELECT * FROM public.time_punch_daily_summaries
         WHERE contract_id = $1::uuid AND work_date >= $2::date AND work_date <= $3::date
         ORDER BY work_date ASC;`,
        [ctx.contract.id, startDate, endDate]
      );

      const { rows: punches } = await client.query(
        `SELECT id, nsr, punched_at, punch_type, receipt_code, sync_origin, geofence_status
         FROM public.time_punch_records
         WHERE contract_id = $1::uuid
           AND (punched_at AT TIME ZONE 'America/Sao_Paulo')::date >= $2::date
           AND (punched_at AT TIME ZONE 'America/Sao_Paulo')::date <= $3::date
         ORDER BY punched_at ASC;`,
        [ctx.contract.id, startDate, endDate]
      );

      const { rows: closureRows } = await client.query(
        `SELECT * FROM public.timesheet_closures
         WHERE contract_id = $1::uuid AND year = $2 AND month = $3 LIMIT 1;`,
        [ctx.contract.id, year, month]
      );

      return {
        year,
        month,
        startDate,
        endDate,
        contract: {
          id: ctx.contract.id,
          registration_number: ctx.contract.registration_number,
          company_name: ctx.contract.company_name,
          company_cnpj: ctx.contract.company_cnpj,
        },
        closure: closureRows[0] || { status: 'OPEN', year, month },
        summaries,
        punches: punches.map((p: any) => ({ ...p, entry_type_label: formatEntryTypePtBr(p.punch_type) })),
      };
    });

    if (!data) return reply.status(404).send({ success: false, error: 'Contrato ativo não encontrado.' });
    return reply.send({ success: true, data });
  });

  app.post('/timesheet/sign', async (request, reply) => {
    const parse = timesheetSignSchema.safeParse(request.body || {});
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }
    const { year, month } = parse.data;
    const tenantId = request.user!.tenant_id!;

    const row = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.contract) return null;

      const sigHash = crypto
        .createHash('sha256')
        .update(`${tenantId}:${ctx.contract.id}:${year}:${month}:${request.user!.sub}:${Date.now()}`)
        .digest('hex');

      const { rows } = await client.query(
        `INSERT INTO public.timesheet_closures (
           tenant_id, contract_id, year, month, status, employee_signed_at, employee_signature_hash
         ) VALUES ($1::uuid, $2::uuid, $3, $4, 'SIGNED_EMPLOYEE', NOW(), $5)
         ON CONFLICT (tenant_id, contract_id, year, month) DO UPDATE SET
           status = 'SIGNED_EMPLOYEE',
           employee_signed_at = NOW(),
           employee_signature_hash = EXCLUDED.employee_signature_hash,
           updated_at = NOW()
         RETURNING *;`,
        [tenantId, ctx.contract.id, year, month, sigHash]
      );
      return rows[0];
    });

    if (!row) return reply.status(404).send({ success: false, error: 'Contrato não encontrado.' });
    return reply.send({ success: true, data: row });
  });

  app.post('/timesheet/contest', async (request, reply) => {
    const parse = timesheetContestSchema.safeParse(request.body || {});
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }
    const { year, month, affectedDate, reason } = parse.data;
    const tenantId = request.user!.tenant_id!;
    const fallbackDate = affectedDate || `${year}-${String(month).padStart(2, '0')}-01`;

    const res = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.contract) return null;

      const { rows: closureRows } = await client.query(
        `INSERT INTO public.timesheet_closures (
           tenant_id, contract_id, year, month, status, contest_reason, contest_date
         ) VALUES ($1::uuid, $2::uuid, $3, $4, 'CONTESTED', $5, $6::date)
         ON CONFLICT (tenant_id, contract_id, year, month) DO UPDATE SET
           status = 'CONTESTED',
           contest_reason = EXCLUDED.contest_reason,
           contest_date = EXCLUDED.contest_date,
           updated_at = NOW()
         RETURNING *;`,
        [tenantId, ctx.contract.id, year, month, reason, fallbackDate]
      );

      await client.query(
        `INSERT INTO public.time_punch_adjustments (
           tenant_id, contract_id, work_date, adjustment_type, justification, status
         ) VALUES ($1::uuid, $2::uuid, $3::date, 'INSERT_PUNCH', $4, 'PENDING_MANAGER');`,
        [tenantId, ctx.contract.id, fallbackDate, `[CONTESTAÇÃO ESPELHO ${month}/${year}] ${reason}`]
      );

      return closureRows[0];
    });

    if (!res) return reply.status(404).send({ success: false, error: 'Contrato não encontrado.' });
    return reply.send({ success: true, data: res });
  });

  // 4.5 Calendário Visual da Escala / Turno do Colaborador (PONTO-05 e PONTO-07)
  app.get('/schedule', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }
    const q = request.query as { year?: string; month?: string };
    const now = new Date();
    const year = Number(q.year || now.getFullYear());
    const month = Number(q.month || now.getMonth() + 1);
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const data = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.contract) return null;

      const { rows: shiftRows } = await client.query(
        `SELECT ws.*
         FROM public.contract_work_shifts cws
         JOIN public.work_shifts ws ON ws.id = cws.work_shift_id
         WHERE cws.contract_id = $1::uuid AND ws.deleted_at IS NULL
         ORDER BY cws.valid_from DESC LIMIT 1;`,
        [ctx.contract.id]
      );
      const shift = shiftRows[0] || {
        name: 'Jornada Padrão 44h',
        shift_type: 'WEEKLY',
        weekly_hours: 44,
        rotation_anchor_date: null,
        schedule_data: [],
      };

      const { rows: holidayRows } = await client.query(
        `SELECT date, name FROM public.holidays
         WHERE (tenant_id IS NULL OR tenant_id = $1::uuid)
           AND date >= $2::date AND date <= $3::date;`,
        [request.user!.tenant_id!, startDate, endDate]
      );

      const days = generateRotatingScheduleCalendar({
        year,
        month,
        shiftType: shift.shift_type || 'WEEKLY',
        rotationAnchorDate:
          shift.rotation_anchor_date instanceof Date
            ? shift.rotation_anchor_date.toISOString().slice(0, 10)
            : shift.rotation_anchor_date
              ? String(shift.rotation_anchor_date).slice(0, 10)
              : null,
        scheduleData: Array.isArray(shift.schedule_data) ? shift.schedule_data : [],
        holidays: holidayRows.map((h: any) => ({
          date: h.date instanceof Date ? h.date.toISOString().slice(0, 10) : String(h.date).slice(0, 10),
          name: h.name,
        })),
      });

      return { year, month, shift, days };
    });

    if (!data) return reply.status(404).send({ success: false, error: 'Contrato não encontrado.' });
    return reply.send({ success: true, data });
  });

  // 4.6 Benefícios do Colaborador (PONTO-05)
  app.get('/benefits', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const rows = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.contract) return [];

      const { rows: bens } = await client.query(
        `SELECT eb.*, bc.name AS benefit_name, bc.code AS benefit_code,
                bc.benefit_type, bc.default_provider, bc.ans_code,
                COALESCE(
                  (SELECT jsonb_agg(jsonb_build_object(
                    'id', ebd.id, 'dependent_name', ebd.dependent_name,
                    'relationship', ebd.relationship, 'employee_discount', ebd.employee_discount
                  )) FROM public.employee_benefit_dependents ebd
                  WHERE ebd.employee_benefit_id = eb.id AND ebd.is_active = TRUE AND ebd.deleted_at IS NULL),
                  '[]'::jsonb
                ) AS dependents
         FROM public.employee_benefits eb
         JOIN public.benefit_catalogs bc ON bc.id = eb.benefit_catalog_id
         WHERE eb.contract_id = $1::uuid AND eb.is_active = TRUE
         ORDER BY bc.name ASC;`,
        [ctx.contract.id]
      );
      return bens;
    });

    return reply.send({ success: true, data: rows });
  });

  // 4.7 Justificativa de Ponto & Envio de Atestado Médico com Upload Privado (PONTO-05)
  app.post('/justifications', async (request, reply) => {
    const parse = justificationSchema.safeParse(request.body || {});
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const d = parse.data;
    const tenantId = request.user!.tenant_id!;

    let attachmentFileId: string | null = null;
    try {
      const ctx = await request.withContext((client) => resolveMyWorkerAndContract(client, request.user!));
      if (!ctx?.contract) {
        return reply.status(404).send({ success: false, error: 'Contrato ativo não encontrado.' });
      }

      if (d.fileBase64) {
        const cleaned = d.fileBase64.replace(/^data:[\w/+-]+;base64,/, '');
        const buffer = Buffer.from(cleaned, 'base64');
        if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) {
          return reply.status(400).send({ success: false, error: 'Arquivo inválido ou maior que 8 MB.' });
        }
        const stored = await storageService.upload({
          tenantId,
          workerId: ctx.worker.id,
          category: d.adjustmentType === 'MEDICAL_CERTIFICATE' ? 'MEDICAL_CERTIFICATE' : 'DOCUMENT',
          originalName: d.fileName || 'anexo_justificativa.pdf',
          mimeType: d.mimeType || 'application/pdf',
          buffer,
          uploadedBy: request.user!.sub,
          isPrivate: true,
        });
        attachmentFileId = stored.id;
      }

      const created = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO public.time_punch_adjustments (
             tenant_id, contract_id, work_date, end_date, adjustment_type,
             requested_punches, justification, attachment_file_id,
             cid10_code, doctor_crm, status
           ) VALUES (
             $1::uuid, $2::uuid, $3::date, $4::date, $5,
             $6::jsonb, $7, $8::uuid,
             $9, $10, 'PENDING_MANAGER'
           )
           RETURNING *;`,
          [
            tenantId,
            ctx.contract.id,
            d.workDate,
            d.endDate || d.workDate,
            d.adjustmentType,
            d.requestedPunches ? JSON.stringify(d.requestedPunches) : null,
            d.justification,
            attachmentFileId,
            d.cid10Code || null,
            d.doctorCrm || null,
          ]
        );
        return rows[0];
      });

      return reply.status(201).send({ success: true, data: created });
    } catch (err: any) {
      request.log.error(err, '[PORTAL_JUSTIFICATIONS] Erro');
      return reply.status(400).send({ success: false, error: err.message });
    }
  });

  app.get('/justifications', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const rows = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.contract) return [];
      const { rows: list } = await client.query(
        `SELECT * FROM public.time_punch_adjustments WHERE contract_id = $1::uuid ORDER BY created_at DESC LIMIT 50;`,
        [ctx.contract.id]
      );
      return list;
    });

    return reply.send({ success: true, data: rows });
  });

  // 4.8 Dossiê LGPD, Consentimentos e Solicitações do Titular (PONTO-05)
  app.get('/lgpd/dossier', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const dossier = await request.withContext(async (client) => {
      const { rows } = await client.query(`SELECT public.get_my_lgpd_dossier() AS dossier;`);
      return rows[0]?.dossier;
    });

    return reply.send({ success: true, data: dossier });
  });

  app.get('/lgpd/consents', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const rows = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.worker) return [];
      const { rows: list } = await client.query(
        `SELECT * FROM public.lgpd_consents WHERE worker_id = $1::uuid ORDER BY granted_at DESC;`,
        [ctx.worker.id]
      );
      return list;
    });

    return reply.send({ success: true, data: rows });
  });

  app.post('/lgpd/consents', async (request, reply) => {
    const parse = lgpdConsentSchema.safeParse(request.body || {});
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }
    const tenantId = request.user!.tenant_id!;
    const d = parse.data;
    const ip = String(request.headers['x-forwarded-for'] || request.ip || '').split(',')[0].trim() || null;

    const saved = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.worker) return null;

      if (!d.granted) {
        const { rows: rev } = await client.query(
          `UPDATE public.lgpd_consents
           SET granted = FALSE, revoked_at = NOW(), revocation_reason = 'Revogado pelo titular no Portal', updated_at = NOW()
           WHERE tenant_id = $1::uuid AND worker_id = $2::uuid AND consent_category = $3 AND revoked_at IS NULL
           RETURNING *;`,
          [tenantId, ctx.worker.id, d.consentCategory]
        );
        return rev[0] || null;
      }

      const { rows } = await client.query(
        `INSERT INTO public.lgpd_consents (
           tenant_id, worker_id, consent_category, version, granted, ip_address, user_agent
         ) VALUES ($1::uuid, $2::uuid, $3, $4, TRUE, $5::inet, $6)
         RETURNING *;`,
        [tenantId, ctx.worker.id, d.consentCategory, d.version, ip, request.headers['user-agent'] || null]
      );
      return rows[0];
    });

    return reply.status(201).send({ success: true, data: saved });
  });

  app.post('/lgpd/consents/:id/revoke', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }
    const updated = await request.withContext(async (client) => {
      const { rows } = await client.query(
        `UPDATE public.lgpd_consents
         SET granted = FALSE, revoked_at = NOW(), revocation_reason = 'Revogação voluntária no Portal', updated_at = NOW()
         WHERE id = $1::uuid
         RETURNING *;`,
        [id]
      );
      return rows[0] || null;
    });
    if (!updated) return reply.status(404).send({ success: false, error: 'Consentimento não encontrado.' });
    return reply.send({ success: true, data: updated });
  });

  app.post('/lgpd/requests', async (request, reply) => {
    const parse = lgpdRequestSchema.safeParse(request.body || {});
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }
    const tenantId = request.user!.tenant_id!;
    const created = await request.withContext(async (client) => {
      const ctx = await resolveMyWorkerAndContract(client, request.user!);
      if (!ctx?.worker) return null;
      const { rows } = await client.query(
        `INSERT INTO public.lgpd_subject_requests (tenant_id, worker_id, request_type, justification)
         VALUES ($1::uuid, $2::uuid, $3, $4) RETURNING *;`,
        [tenantId, ctx.worker.id, parse.data.requestType, parse.data.justification || null]
      );
      return rows[0];
    });
    if (!created) return reply.status(404).send({ success: false, error: 'Trabalhador não vinculado.' });
    return reply.status(201).send({ success: true, data: created });
  });

  // 5. Períodos e Férias Agendadas do Colaborador
  app.get('/vacations', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    try {
      const data = await request.withContext(async (client) => {
        const { rows: periods } = await client.query(
          `SELECT vp.*
           FROM public.vacation_periods vp
           JOIN public.contracts c ON c.id = vp.contract_id
           JOIN public.workers w ON w.id = c.worker_id
           WHERE (w.id = $1::uuid OR w.user_id = $2::uuid)
           ORDER BY vp.acquisition_start DESC;`,
          [request.user!.worker_id || null, request.user!.sub]
        );

        const { rows: schedules } = await client.query(
          `SELECT vs.*
           FROM public.vacation_schedules vs
           JOIN public.contracts c ON c.id = vs.contract_id
           JOIN public.workers w ON w.id = c.worker_id
           WHERE (w.id = $1::uuid OR w.user_id = $2::uuid)
           ORDER BY vs.start_date DESC;`,
          [request.user!.worker_id || null, request.user!.sub]
        );

        return { periods, schedules };
      });

      return reply.send({ success: true, data });
    } catch {
      return reply.status(500).send({ success: false, error: 'Erro ao consultar férias.' });
    }
  });

  // 6. Solicitação de Férias pelo Colaborador (encaminhada para aprovação do gestor -> DP)
  app.post('/vacations/request', async (request, reply) => {
    const parse = vacationRequestSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    const d = parse.data;

    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    try {
      const created = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT vp.*, c.id AS cid
           FROM public.vacation_periods vp
           JOIN public.contracts c ON c.id = vp.contract_id
           JOIN public.workers w ON w.id = c.worker_id
           WHERE vp.id = $1::uuid
             AND (w.id = $2::uuid OR w.user_id = $3::uuid)
           LIMIT 1;`,
          [d.vacationPeriodId, request.user!.worker_id || null, request.user!.sub]
        );

        if (pRows.length === 0) {
          throw new Error('Período aquisitivo não pertence a este colaborador.');
        }

        const period = pRows[0];
        const total = d.daysCount + d.sellDaysCount;

        if (total > period.days_remaining) {
          throw new Error(`Saldo insuficiente (${period.days_remaining} dias disponíveis).`);
        }

        const { rows: schRows } = await client.query(
          `INSERT INTO public.vacation_schedules (
            tenant_id, vacation_period_id, contract_id, start_date, end_date,
            days_count, sell_days_count, wants_thirteenth_advance, status
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, 'PENDING_MANAGER'
          ) RETURNING *;`,
          [
            request.user!.tenant_id,
            d.vacationPeriodId,
            period.cid,
            d.startDate,
            d.endDate,
            d.daysCount,
            d.sellDaysCount,
            d.wantsThirteenthAdvance,
          ]
        );

        return schRows[0];
      });

      return reply.status(201).send({
        success: true,
        message: 'Solicitação de férias enviada para aprovação do gestor.',
        data: created,
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err.message });
    }
  });

  // 7. Documentos do Colaborador
  app.get('/documents', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    try {
      const documents = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT ed.*
           FROM public.employee_documents ed
           JOIN public.contracts c ON c.id = ed.contract_id
           JOIN public.workers w ON w.id = c.worker_id
           WHERE (w.id = $1::uuid OR w.user_id = $2::uuid)
             AND ed.deleted_at IS NULL
           ORDER BY ed.created_at DESC;`,
          [request.user!.worker_id || null, request.user!.sub]
        );
        return rows;
      });

      return reply.send({ success: true, data: documents });
    } catch {
      return reply.status(500).send({ success: false, error: 'Erro ao carregar documentos.' });
    }
  });
};
