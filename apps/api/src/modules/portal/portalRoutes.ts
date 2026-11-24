import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/authMiddleware.js';

const vacationRequestSchema = z.object({
  vacationPeriodId: z.string().uuid('ID do período aquisitivo inválido.'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de início inválida (AAAA-MM-DD).'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de término inválida (AAAA-MM-DD).'),
  daysCount: z.number().int().min(5).max(30),
  sellDaysCount: z.number().int().min(0).max(10).default(0),
  wantsThirteenthAdvance: z.boolean().default(false),
});

export const portalRoutes: FastifyPluginAsync = async (app) => {
  // Middleware global de autoatendimento: Garante que haja um worker vinculado
  app.addHook('preHandler', authenticate);

  // 1. Perfil Completo do Colaborador Logado
  app.get('/me', async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const workerId = request.user.worker_id;

    try {
      const data = await request.withContext(async (client) => {
        // Busca o trabalhador por worker_id ou por user_id
        const { rows: wRows } = await client.query(
          `SELECT w.*, u.email AS user_email
           FROM public.workers w
           LEFT JOIN public.users u ON u.id = w.user_id
           WHERE (w.id = $1::uuid OR w.user_id = $2::uuid)
           LIMIT 1;`,
          [workerId || null, request.user!.sub]
        );

        if (wRows.length === 0) return null;
        const worker = wRows[0];

        // Busca contrato ativo
        const { rows: cRows } = await client.query(
          `SELECT c.*,
                  comp.trade_name AS company_name,
                  dept.name AS department_name,
                  pos.title AS position_title
           FROM public.contracts c
           LEFT JOIN public.companies comp ON comp.id = c.company_id
           LEFT JOIN public.departments dept ON dept.id = c.department_id
           LEFT JOIN public.positions pos ON pos.id = c.position_id
           WHERE c.worker_id = $1::uuid AND c.status = 'ACTIVE'
           ORDER BY c.admission_date DESC
           LIMIT 1;`,
          [worker.id]
        );

        return {
          worker,
          contract: cRows[0] || null,
        };
      });

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
          `SELECT p.*, pp.year, pp.month, pp.period_type
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
          `SELECT p.*, pp.year, pp.month, pp.period_type
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
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: 'Erro ao carregar holerite.' });
    }
  });

  // 4. Espelho de Ponto do Colaborador
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
             AND ($3::timestamptz IS NULL OR tpr.timestamp >= $3::timestamptz)
             AND ($4::timestamptz IS NULL OR tpr.timestamp <= $4::timestamptz)
           ORDER BY tpr.timestamp DESC;`,
          [
            request.user!.worker_id || null,
            request.user!.sub,
            query.startDate ? `${query.startDate}T00:00:00Z` : null,
            query.endDate ? `${query.endDate}T23:59:59Z` : null,
          ]
        );
        return rows;
      });

      return reply.send({ success: true, data: records });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: 'Erro ao carregar registros de ponto.' });
    }
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
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: 'Erro ao consultar férias.' });
    }
  });

  // 6. Solicitação de Férias pelo Colaborador
  app.post('/vacations/request', async (request, reply) => {
    const parse = vacationRequestSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    const d = parse.data;

    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    try {
      const created = await request.withContext(async (client) => {
        // Valida se o período pertence ao colaborador
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
            $6, $7, $8, 'REQUESTED'
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
        message: 'Solicitação de férias enviada com sucesso.',
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
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: 'Erro ao carregar documentos.' });
    }
  });
};
