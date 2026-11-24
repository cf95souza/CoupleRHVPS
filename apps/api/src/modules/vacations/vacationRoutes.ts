import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';

const scheduleVacationSchema = z.object({
  contractId: z.string().uuid('ID do contrato inválido.'),
  vacationPeriodId: z.string().uuid('ID do período aquisitivo inválido.'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de início inválida (AAAA-MM-DD).'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de término inválida (AAAA-MM-DD).'),
  daysCount: z.number().int().min(5, 'Conforme Art. 134 da CLT, nenhum período fracionado pode ser inferior a 5 dias.').max(30),
  sellDaysCount: z.number().int().min(0).max(10, 'Conforme Art. 143 da CLT, o abono pecuniário é limitado a 1/3 das férias (máximo 10 dias).').default(0),
  wantsThirteenthAdvance: z.boolean().default(false),
});

const updateVacationStatusSchema = z.object({
  status: z.enum(['REQUESTED', 'APPROVED', 'CALCULATED', 'PAID', 'CANCELLED']),
});

export const vacationRoutes: FastifyPluginAsync = async (app) => {
  // 1. Listagem de Períodos Aquisitivos de Férias
  app.get('/periods', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const query = request.query as { contractId?: string };

    const result = await request.withContext(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM public.vacation_periods
         WHERE ($1::uuid IS NULL OR contract_id = $1::uuid)
         ORDER BY acquisition_start DESC;`,
        [query.contractId || null]
      );
      return rows;
    });

    return reply.send({ success: true, data: result });
  });

  // 2. Listagem de Agendamentos de Usufruto de Férias
  app.get('/schedules', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const query = request.query as { contractId?: string; periodId?: string };

    const result = await request.withContext(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM public.vacation_schedules
         WHERE ($1::uuid IS NULL OR contract_id = $1::uuid)
           AND ($2::uuid IS NULL OR vacation_period_id = $2::uuid)
         ORDER BY start_date DESC;`,
        [query.contractId || null, query.periodId || null]
      );
      return rows;
    });

    return reply.send({ success: true, data: result });
  });

  // 3. Programação de Férias (Validação CLT Art. 134 e 143)
  app.post(
    '/schedules',
    { preHandler: [authenticate, requirePermission('manage_vacations')] },
    async (request, reply) => {
      const parse = scheduleVacationSchema.safeParse(request.body);
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      const d = parse.data;

      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      try {
        const created = await request.withContext(async (client) => {
          // Busca saldo do período aquisitivo
          const { rows: pRows } = await client.query(
            `SELECT days_remaining, status FROM public.vacation_periods WHERE id = $1::uuid FOR UPDATE;`,
            [d.vacationPeriodId]
          );

          if (pRows.length === 0) {
            throw new Error('Período aquisitivo não encontrado.');
          }

          const period = pRows[0];
          const totalRequested = d.daysCount + d.sellDaysCount;

          if (totalRequested > period.days_remaining) {
            throw new Error(`Saldo insuficiente. Dias solicitados: ${totalRequested}, saldo disponível: ${period.days_remaining}.`);
          }

          // Insere agendamento
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
              d.contractId,
              d.startDate,
              d.endDate,
              d.daysCount,
              d.sellDaysCount,
              d.wantsThirteenthAdvance,
            ]
          );

          // Atualiza saldo do período aquisitivo
          await client.query(
            `UPDATE public.vacation_periods
             SET days_taken = days_taken + $1,
                 days_remaining = days_remaining - $1,
                 status = CASE WHEN days_remaining - $1 = 0 THEN 'CLOSED' ELSE 'IN_PROGRESS' END,
                 updated_at = NOW()
             WHERE id = $2::uuid;`,
            [totalRequested, d.vacationPeriodId]
          );

          return schRows[0];
        });

        return reply.status(201).send({ success: true, data: created });
      } catch (err: any) {
        request.log.warn(err, '[VACATION_SCHEDULE] Erro ao agendar férias');
        return reply.status(400).send({ success: false, error: err.message || 'Erro ao programar férias.' });
      }
    }
  );

  // 4. Alteração de Status (Aprovação / Pagamento / Cancelamento)
  app.patch(
    '/schedules/:id/status',
    { preHandler: [authenticate, requirePermission('manage_vacations')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parse = updateVacationStatusSchema.safeParse(request.body);
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });

      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      try {
        const updated = await request.withContext(async (client) => {
          const { rows } = await client.query(
            `UPDATE public.vacation_schedules
             SET status = $1, updated_at = NOW()
             WHERE id = $2::uuid RETURNING *;`,
            [parse.data.status, id]
          );
          if (rows.length === 0) throw new Error('Agendamento de férias não encontrado.');
          return rows[0];
        });

        return reply.send({ success: true, data: updated });
      } catch (err: any) {
        return reply.status(400).send({ success: false, error: err.message });
      }
    }
  );
};
