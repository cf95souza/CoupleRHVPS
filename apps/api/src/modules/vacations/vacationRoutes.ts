import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
import { VacationEnterpriseCalculator } from '@couplerh/payroll-core';

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
          // Busca saldo do período aquisitivo e contrato
          const { rows: pRows } = await client.query(
            `SELECT vp.days_accrued, vp.days_taken, vp.days_remaining, vp.absences_count, vp.concessive_end,
                    vp.status, vp.lost_by_leave, vp.loss_reason, c.company_id, c.workplace_id,
                    wp.state_code, wp.city_code
             FROM public.vacation_periods vp
             JOIN public.contracts c ON c.id = vp.contract_id
             LEFT JOIN public.workplaces wp ON wp.id = c.workplace_id
             WHERE vp.id = $1::uuid
             FOR UPDATE OF vp;`,
            [d.vacationPeriodId]
          );

          if (pRows.length === 0) {
            throw new Error('Período aquisitivo não encontrado.');
          }

          const period = pRows[0];
          if ((period as any).lost_by_leave || period.status === 'FORFEITED') {
            throw new Error(
              (period as any).loss_reason ||
              'Período aquisitivo perdido por afastamento previdenciário > 180 dias (CLT Art. 133 IV).'
            );
          }

          // CLT Art. 130: Redução automática por faltas no período aquisitivo
          const absencesCount = Number((period as any).absences_count || 0);
          const legalAccruedByAbsences = VacationEnterpriseCalculator.calculateAccruedDaysByAbsences(absencesCount);
          const effectiveAccrued = Math.min(Number(period.days_accrued || 30), legalAccruedByAbsences);
          const effectiveRemaining = Math.max(0, effectiveAccrued - Number(period.days_taken || 0));

          const totalRequested = d.daysCount + d.sellDaysCount;

          if (totalRequested > effectiveRemaining) {
            throw new Error(
              `Saldo insuficiente após apuração CLT Art. 130 (${absencesCount} faltas -> direito ${effectiveAccrued}d). Solicitados: ${totalRequested}d, disponível: ${effectiveRemaining}d.`
            );
          }

          // CLT Art. 134 §§1º e 3º: Valida fracionamento e vedação de 2 dias antes de feriado/DSR
          const { rows: existingSch } = await client.query(
            `SELECT days_count FROM public.vacation_schedules
             WHERE vacation_period_id = $1::uuid AND status <> 'CANCELLED';`,
            [d.vacationPeriodId]
          );

          const { rows: holRows } = await client.query(
            `SELECT date, type, state_code, city_code, company_id
             FROM public.holidays
             WHERE (tenant_id IS NULL OR tenant_id = $1::uuid)
               AND status = 'ACTIVE'
               AND date >= $2::date
               AND date <= ($2::date + INTERVAL '5 days');`,
            [request.user!.tenant_id, d.startDate]
          );
          const applicableHolidays = holRows
            .filter((h: any) => {
              if (h.company_id && h.company_id !== period.company_id) return false;
              if (h.type === 'NATIONAL') return true;
              if (h.type === 'STATE') return h.state_code === period.state_code;
              if (h.type === 'MUNICIPAL') return h.city_code === period.city_code;
              return true;
            })
            .map((h: any) =>
              h.date instanceof Date
                ? `${h.date.getUTCFullYear()}-${String(h.date.getUTCMonth() + 1).padStart(2, '0')}-${String(h.date.getUTCDate()).padStart(2, '0')}`
                : String(h.date).slice(0, 10)
            );

          const fracCheck = VacationEnterpriseCalculator.validateVacationFractionation({
            startDate: d.startDate,
            endDate: d.endDate,
            daysCount: d.daysCount,
            sellDaysCount: d.sellDaysCount,
            daysRemaining: effectiveRemaining,
            existingSplitsDays: existingSch.map((s: any) => Number(s.days_count || 0)),
            holidays: applicableHolidays,
          });
          if (!fracCheck.valid) {
            throw new Error(fracCheck.errors[0]);
          }

          const concEndStr = period.concessive_end
            ? period.concessive_end instanceof Date
              ? `${period.concessive_end.getUTCFullYear()}-${String(period.concessive_end.getUTCMonth() + 1).padStart(2, '0')}-${String(period.concessive_end.getUTCDate()).padStart(2, '0')}`
              : String(period.concessive_end).slice(0, 10)
            : null;
          const doubleRes = VacationEnterpriseCalculator.calculateDoubleVacationDays(
            d.startDate,
            d.endDate,
            concEndStr
          );
          const monthSplits = VacationEnterpriseCalculator.splitVacationAcrossMonths(
            d.startDate,
            d.endDate,
            0,
            0
          );

          // Insere agendamento
          const { rows: schRows } = await client.query(
            `INSERT INTO public.vacation_schedules (
              tenant_id, vacation_period_id, contract_id, start_date, end_date,
              days_count, sell_days_count, wants_thirteenth_advance, status,
              double_vacation_days, split_months_json, validation_warnings
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, 'REQUESTED',
              $9, $10::jsonb, $11::jsonb
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
              doubleRes.doubleDays,
              JSON.stringify(monthSplits),
              JSON.stringify(fracCheck.warnings),
            ]
          );

          // Atualiza saldo do período aquisitivo (já sincronizando eventual redução Art. 130)
          const newRemaining = Math.max(0, effectiveRemaining - totalRequested);
          await client.query(
            `UPDATE public.vacation_periods
             SET days_accrued = $1,
                 days_taken = days_taken + $2,
                 days_remaining = $3,
                 status = CASE WHEN $3 = 0 THEN 'CLOSED' ELSE 'IN_PROGRESS' END,
                 updated_at = NOW()
             WHERE id = $4::uuid;`,
            [effectiveAccrued, totalRequested, newRemaining, d.vacationPeriodId]
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

  // 5. Férias Coletivas em Lote (CLT Arts. 139–140 com reinício de aquisitivo para < 1 ano)
  app.post(
    '/collective',
    { preHandler: [authenticate, requirePermission('manage_vacations')] },
    async (request, reply) => {
      const schema = z.object({
        companyId: z.string().uuid(),
        departmentId: z.string().uuid().optional().nullable(),
        title: z.string().min(3).max(160),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        daysCount: z.number().int().min(10).max(30),
        noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
        notes: z.string().optional().nullable(),
        contractIds: z.array(z.string().uuid()).optional(),
      });

      const parse = schema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({ success: false, details: parse.error.format() });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      }

      const d = parse.data;
      const tenantId = request.user!.tenant_id!;

      try {
        const result = await request.withContext(async (client) => {
          const { rows: batchRows } = await client.query(
            `INSERT INTO public.collective_vacation_batches (
               tenant_id, company_id, department_id, title, start_date, end_date,
               days_count, notice_date, status, notes, created_by
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date,
               $7, $8::date, 'APPROVED', $9, $10::uuid
             ) RETURNING *;`,
            [
              tenantId,
              d.companyId,
              d.departmentId || null,
              d.title,
              d.startDate,
              d.endDate,
              d.daysCount,
              d.noticeDate || null,
              d.notes || null,
              request.user!.sub,
            ]
          );
          const batch = batchRows[0];

          let contractSql = `
            SELECT id, admission_date, base_salary
            FROM public.contracts
            WHERE tenant_id = $1::uuid
              AND company_id = $2::uuid
              AND deleted_at IS NULL
              AND status = 'ACTIVE'
          `;
          const params: any[] = [tenantId, d.companyId];
          if (d.departmentId) {
            contractSql += ` AND department_id = $${params.length + 1}::uuid`;
            params.push(d.departmentId);
          }
          if (d.contractIds && d.contractIds.length > 0) {
            contractSql += ` AND id = ANY($${params.length + 1}::uuid[])`;
            params.push(d.contractIds);
          }

          const { rows: targetContracts } = await client.query(contractSql, params);
          const items: any[] = [];

          for (const c of targetContracts) {
            const admStr =
              c.admission_date instanceof Date
                ? `${c.admission_date.getUTCFullYear()}-${String(c.admission_date.getUTCMonth() + 1).padStart(2, '0')}-${String(c.admission_date.getUTCDate()).padStart(2, '0')}`
                : String(c.admission_date).slice(0, 10);

            const evalCol = VacationEnterpriseCalculator.evaluateCollectiveVacationContract({
              admissionDate: admStr,
              collectiveStartDate: d.startDate,
              collectiveDays: d.daysCount,
              monthlySalary: Number(c.base_salary || 0),
            });

            // Busca ou cria período aquisitivo aberto para o contrato
            let { rows: vpRows } = await client.query(
              `SELECT * FROM public.vacation_periods
               WHERE contract_id = $1::uuid AND status IN ('DRAFT', 'OPEN', 'IN_PROGRESS')
               ORDER BY acquisition_start ASC LIMIT 1;`,
              [c.id]
            );

            let vpId = vpRows[0]?.id;
            if (!vpId) {
              const admY = Number(admStr.slice(0, 4));
              const admRest = admStr.slice(4);
              const { rows: newVp } = await client.query(
                `INSERT INTO public.vacation_periods (
                   tenant_id, contract_id, acquisition_start, acquisition_end, concessive_end,
                   days_accrued, days_taken, days_remaining, status
                 ) VALUES (
                   $1::uuid, $2::uuid, $3::date, ($3::date + INTERVAL '1 year - 1 day')::date,
                   ($3::date + INTERVAL '2 years - 1 day')::date,
                   $4, 0, $4, 'OPEN'
                 ) RETURNING *;`,
                [
                  tenantId,
                  c.id,
                  admStr,
                  evalCol.isUnderOneYear ? evalCol.proportionalVacationDays : 30,
                ]
              );
              vpId = newVp[0].id;
            }

            const daysForSchedule = evalCol.isUnderOneYear
              ? Math.max(1, evalCol.proportionalVacationDays || d.daysCount)
              : d.daysCount;

            const { rows: schRows } = await client.query(
              `INSERT INTO public.vacation_schedules (
                 tenant_id, vacation_period_id, contract_id, start_date, end_date,
                 days_count, sell_days_count, wants_thirteenth_advance, status,
                 is_collective, collective_batch_id, gross_amount
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::date, $5::date,
                 $6, 0, FALSE, 'APPROVED',
                 TRUE, $7::uuid, $8
               ) RETURNING *;`,
              [
                tenantId,
                vpId,
                c.id,
                d.startDate,
                d.endDate,
                daysForSchedule,
                batch.id,
                evalCol.vacationPayAmount + evalCol.vacationOneThirdAmount,
              ]
            );

            if (evalCol.isUnderOneYear && evalCol.resetAcquisitionStartDate) {
              // Fecha o período proporcional consumido pelas coletivas e inicia novo período aquisitivo
              await client.query(
                `UPDATE public.vacation_periods
                 SET days_accrued = $1, days_taken = $1, days_remaining = 0, status = 'CLOSED', updated_at = NOW()
                 WHERE id = $2::uuid;`,
                [evalCol.proportionalVacationDays, vpId]
              );
              await client.query(
                `INSERT INTO public.vacation_periods (
                   tenant_id, contract_id, acquisition_start, acquisition_end, concessive_end,
                   days_accrued, days_taken, days_remaining, status
                 ) VALUES (
                   $1::uuid, $2::uuid, $3::date, $4::date, $5::date,
                   30, 0, 30, 'OPEN'
                 );`,
                [
                  tenantId,
                  c.id,
                  evalCol.resetAcquisitionStartDate,
                  evalCol.resetAcquisitionEndDate,
                  evalCol.resetConcessiveEndDate,
                ]
              );
            } else {
              await client.query(
                `UPDATE public.vacation_periods
                 SET days_taken = days_taken + $1,
                     days_remaining = GREATEST(0, days_remaining - $1),
                     status = CASE WHEN GREATEST(0, days_remaining - $1) = 0 THEN 'CLOSED' ELSE 'IN_PROGRESS' END,
                     updated_at = NOW()
                 WHERE id = $2::uuid;`,
                [d.daysCount, vpId]
              );
            }

            items.push({
              contractId: c.id,
              scheduleId: schRows[0].id,
              evaluation: evalCol,
            });
          }

          return { batch, contractsProcessed: items.length, items };
        });

        return reply.status(201).send({ success: true, data: result });
      } catch (err: any) {
        request.log.warn(err, '[COLLECTIVE_VACATIONS] Erro ao processar férias coletivas');
        return reply.status(400).send({ success: false, error: err.message || 'Erro ao lançar férias coletivas.' });
      }
    }
  );
};
