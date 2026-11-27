import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAnyPermission, requirePermission } from '../auth/authMiddleware.js';
import { StorageService } from '../../shared/storage/StorageService.js';

const decisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  notes: z.string().max(1000).optional().nullable(),
});

export const approvalRoutes: FastifyPluginAsync = async (app) => {
  const storageService = new StorageService();

  /**
   * GET /api/v1/approvals/pending
   * Fila unificada para Gestor do Setor (filtrada estritamente por can_access_contract) e DP.
   * Sigilo médico LGPD: oculta cid10_code quando o usuário não possui permissão view_medical_cid.
   */
  app.get(
    '/pending',
    {
      preHandler: [
        authenticate,
        requireAnyPermission(['approve_team_requests', 'manage_time_tracking', 'manage_vacations']),
      ],
    },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      }
      const query = request.query as { scope?: string };
      const includeHistory = query.scope === 'all';
      const tenantId = request.user!.tenant_id!;

      try {
        const result = await request.withContext(async (client) => {
          const { rows: cidPermRows } = await client.query<{ allowed: boolean }>(
            `SELECT public.has_permission($1::uuid, 'view_medical_cid') AS allowed;`,
            [tenantId]
          );
          const canViewMedicalCid = cidPermRows[0]?.allowed === true;

          const statusFilter = includeHistory
            ? `('PENDING', 'PENDING_MANAGER', 'APPROVED_MANAGER', 'REJECTED_MANAGER', 'APPROVED_DP', 'REJECTED_DP', 'APPROVED', 'REJECTED')`
            : `('PENDING', 'PENDING_MANAGER', 'APPROVED_MANAGER')`;

          const { rows: adjustments } = await client.query(
            `SELECT tpa.id,
                    tpa.contract_id,
                    tpa.work_date,
                    tpa.end_date,
                    tpa.adjustment_type,
                    tpa.requested_punches,
                    tpa.requested_minutes,
                    tpa.justification,
                    tpa.attachment_file_id,
                    tpa.cid10_code,
                    tpa.doctor_crm,
                    tpa.status,
                    tpa.manager_id,
                    tpa.manager_decided_at,
                    tpa.manager_notes,
                    tpa.dp_user_id,
                    tpa.dp_decided_at,
                    tpa.dp_notes,
                    tpa.created_at,
                    w.id AS worker_id,
                    w.full_name AS worker_name,
                    c.registration_number,
                    dep.id AS department_id,
                    dep.name AS department_name
             FROM public.time_punch_adjustments tpa
             JOIN public.contracts c ON c.id = tpa.contract_id
             JOIN public.workers w ON w.id = c.worker_id
             LEFT JOIN public.departments dep ON dep.id = c.department_id
             WHERE tpa.tenant_id = $1::uuid
               AND public.can_access_contract(tpa.tenant_id, tpa.contract_id)
               AND tpa.status IN ${statusFilter}
             ORDER BY tpa.created_at DESC
             LIMIT 200;`,
            [tenantId]
          );

          const vacStatusFilter = includeHistory
            ? `('REQUESTED', 'PENDING_MANAGER', 'APPROVED_MANAGER', 'REJECTED_MANAGER', 'APPROVED', 'CANCELLED')`
            : `('REQUESTED', 'PENDING_MANAGER', 'APPROVED_MANAGER')`;

          const { rows: vacations } = await client.query(
            `SELECT vs.id,
                    vs.contract_id,
                    vs.vacation_period_id,
                    vs.start_date,
                    vs.end_date,
                    vs.days_count,
                    vs.sell_days_count,
                    vs.wants_thirteenth_advance,
                    vs.status,
                    vs.manager_id,
                    vs.manager_decided_at,
                    vs.manager_notes,
                    vs.created_at,
                    w.id AS worker_id,
                    w.full_name AS worker_name,
                    c.registration_number,
                    dep.id AS department_id,
                    dep.name AS department_name
             FROM public.vacation_schedules vs
             JOIN public.contracts c ON c.id = vs.contract_id
             JOIN public.workers w ON w.id = c.worker_id
             LEFT JOIN public.departments dep ON dep.id = c.department_id
             WHERE vs.tenant_id = $1::uuid
               AND public.can_access_contract(vs.tenant_id, vs.contract_id)
               AND vs.status IN ${vacStatusFilter}
             ORDER BY vs.created_at DESC
             LIMIT 200;`,
            [tenantId]
          );

          const sanitizedAdjustments = adjustments.map((item: any) => ({
            ...item,
            kind: 'time-adjustment',
            // Proteção estrita LGPD: gestor sem permissão clínica NUNCA visualiza CID-10
            cid10_code: canViewMedicalCid ? item.cid10_code : null,
            doctor_crm: canViewMedicalCid ? item.doctor_crm : null,
            cid_masked: !canViewMedicalCid && Boolean(item.cid10_code),
            attachment_signed_url: item.attachment_file_id
              ? storageService.generateSignedDownloadUrl(item.attachment_file_id, 600, true)
              : null,
          }));

          const mappedVacations = vacations.map((v: any) => ({
            ...v,
            kind: 'vacation',
          }));

          return {
            canViewMedicalCid,
            timeAdjustments: sanitizedAdjustments,
            vacations: mappedVacations,
          };
        });

        return reply.send({ success: true, data: result });
      } catch (err: any) {
        request.log.error(err, '[APPROVALS_PENDING] Erro ao listar fila');
        return reply.status(500).send({ success: false, error: 'Erro ao carregar fila de aprovações.' });
      }
    }
  );

  /**
   * POST /api/v1/approvals/:kind/:id/manager-decision
   * 1ª Etapa: Gestor do setor decide dentro do próprio escopo organizacional (PENDING_MANAGER -> APPROVED_MANAGER / REJECTED_MANAGER)
   */
  app.post(
    '/:kind/:id/manager-decision',
    { preHandler: [authenticate, requirePermission('approve_team_requests')] },
    async (request, reply) => {
      const { kind, id } = request.params as { kind: string; id: string };
      if (!['time-adjustment', 'vacation'].includes(kind)) {
        return reply.status(400).send({ success: false, error: 'Tipo de solicitação inválido.' });
      }

      const parse = decisionSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({ success: false, details: parse.error.format() });
      }
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      }

      const { decision, notes } = parse.data;
      const tenantId = request.user!.tenant_id!;
      const managerUserId = request.user!.sub;
      const nextStatus = decision === 'APPROVE' ? 'APPROVED_MANAGER' : 'REJECTED_MANAGER';

      try {
        const updated = await request.withContext(async (client) => {
          const table = kind === 'time-adjustment' ? 'public.time_punch_adjustments' : 'public.vacation_schedules';
          const { rows: found } = await client.query(
            `SELECT id, contract_id, status, public.can_access_contract(tenant_id, contract_id) AS allowed
             FROM ${table}
             WHERE id = $1::uuid AND tenant_id = $2::uuid
             LIMIT 1;`,
            [id, tenantId]
          );

          if (found.length === 0) return { code: 'NOT_FOUND' as const };
          if (!found[0].allowed) return { code: 'FORBIDDEN_SCOPE' as const };
          if (!['PENDING', 'PENDING_MANAGER', 'REQUESTED'].includes(found[0].status)) {
            return { code: 'INVALID_STATE' as const, status: found[0].status };
          }

          const { rows: upRows } = await client.query(
            `UPDATE ${table}
             SET status = $1,
                 manager_id = $2::uuid,
                 manager_decided_at = NOW(),
                 manager_notes = $3,
                 updated_at = NOW()
             WHERE id = $4::uuid
             RETURNING *;`,
            [nextStatus, managerUserId, notes || null, id]
          );

          return { code: 'OK' as const, row: upRows[0] };
        });

        if (updated.code === 'NOT_FOUND') {
          return reply.status(404).send({ success: false, error: 'Solicitação não encontrada ou fora do seu escopo.' });
        }
        if (updated.code === 'FORBIDDEN_SCOPE') {
          return reply.status(403).send({
            success: false,
            code: 'FORBIDDEN_SCOPE',
            error: 'Acesso negado: colaborador não pertence ao departamento/setor gerenciado.',
          });
        }
        if (updated.code === 'INVALID_STATE') {
          return reply.status(409).send({
            success: false,
            error: `Solicitação já está no status ${updated.status}.`,
          });
        }

        return reply.send({ success: true, data: updated.row });
      } catch (err: any) {
        request.log.error(err, '[APPROVALS_MANAGER] Erro na decisão do gestor');
        return reply.status(400).send({ success: false, error: err.message });
      }
    }
  );

  /**
   * POST /api/v1/approvals/:kind/:id/dp-decision
   * 2ª Etapa: Departamento Pessoal homologa/indefere e efetiva impacto em banco de horas / afastamento / férias.
   */
  app.post(
    '/:kind/:id/dp-decision',
    {
      preHandler: [
        authenticate,
        requireAnyPermission(['manage_time_tracking', 'manage_vacations']),
      ],
    },
    async (request, reply) => {
      const { kind, id } = request.params as { kind: string; id: string };
      if (!['time-adjustment', 'vacation'].includes(kind)) {
        return reply.status(400).send({ success: false, error: 'Tipo de solicitação inválido.' });
      }

      const parse = decisionSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({ success: false, details: parse.error.format() });
      }
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      }

      const { decision, notes } = parse.data;
      const tenantId = request.user!.tenant_id!;
      const dpUserId = request.user!.sub;

      try {
        const res = await request.withContext(async (client) => {
          if (kind === 'vacation') {
            const { rows: permRows } = await client.query<{ allowed: boolean }>(
              `SELECT public.has_permission($1::uuid, 'manage_vacations') AS allowed;`,
              [tenantId]
            );
            if (!permRows[0]?.allowed) return { code: 'FORBIDDEN_PERM' as const };

            const { rows: found } = await client.query(
              `SELECT id, status, public.can_access_contract(tenant_id, contract_id) AS allowed
               FROM public.vacation_schedules
               WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1;`,
              [id, tenantId]
            );
            if (found.length === 0) return { code: 'NOT_FOUND' as const };
            if (!found[0].allowed) return { code: 'FORBIDDEN_SCOPE' as const };

            const nextVacStatus = decision === 'APPROVE' ? 'APPROVED' : 'CANCELLED';
            const { rows: upVac } = await client.query(
              `UPDATE public.vacation_schedules
               SET status = $1,
                   updated_at = NOW()
               WHERE id = $2::uuid
               RETURNING *;`,
              [nextVacStatus, id]
            );
            return { code: 'OK' as const, row: upVac[0] };
          }

          const { rows: permRows } = await client.query<{ allowed: boolean }>(
            `SELECT public.has_permission($1::uuid, 'manage_time_tracking') AS allowed;`,
            [tenantId]
          );
          if (!permRows[0]?.allowed) return { code: 'FORBIDDEN_PERM' as const };

          const { rows: found } = await client.query(
            `SELECT *, public.can_access_contract(tenant_id, contract_id) AS allowed
             FROM public.time_punch_adjustments
             WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1;`,
            [id, tenantId]
          );
          if (found.length === 0) return { code: 'NOT_FOUND' as const };
          if (!found[0].allowed) return { code: 'FORBIDDEN_SCOPE' as const };

          const adj = found[0];
          const nextStatus = decision === 'APPROVE' ? 'APPROVED_DP' : 'REJECTED_DP';

          const { rows: upAdj } = await client.query(
            `UPDATE public.time_punch_adjustments
             SET status = $1,
                 dp_user_id = $2::uuid,
                 dp_decided_at = NOW(),
                 dp_notes = $3,
                 approved_by = $2::uuid,
                 decided_at = NOW(),
                 rejection_reason = CASE WHEN $4 = 'REJECT' THEN COALESCE($3, rejection_reason) ELSE rejection_reason END,
                 updated_at = NOW()
             WHERE id = $5::uuid
             RETURNING *;`,
            [nextStatus, dpUserId, notes || null, decision, id]
          );

          // Efeitos colaterais exclusivamente na homologação final pelo DP
          if (decision === 'APPROVE') {
            if (adj.adjustment_type === 'TIME_BANK_DAY_OFF') {
              const debitMinutes = Math.abs(Number(adj.requested_minutes || 480));
              let { rows: accRows } = await client.query(
                `SELECT id, balance_minutes FROM public.time_bank_accounts
                 WHERE tenant_id = $1::uuid AND contract_id = $2::uuid LIMIT 1;`,
                [tenantId, adj.contract_id]
              );
              if (accRows.length === 0) {
                const insertedAcc = await client.query(
                  `INSERT INTO public.time_bank_accounts (tenant_id, contract_id, balance_minutes)
                   VALUES ($1::uuid, $2::uuid, 0) RETURNING id, balance_minutes;`,
                  [tenantId, adj.contract_id]
                );
                accRows = insertedAcc.rows;
              }
              const accId = accRows[0].id;

              await client.query(
                `INSERT INTO public.time_bank_transactions (
                   tenant_id, account_id, contract_id, transaction_type, minutes, reference_date, description, created_by
                 ) VALUES (
                   $1::uuid, $2::uuid, $3::uuid, 'COMPENSATION', $4, $5::date, $6, $7::uuid
                 );`,
                [
                  tenantId,
                  accId,
                  adj.contract_id,
                  -debitMinutes,
                  adj.work_date,
                  `Folga compensatória homologada DP (${debitMinutes} min)`,
                  dpUserId,
                ]
              );

              await client.query(
                `UPDATE public.time_bank_accounts
                 SET balance_minutes = balance_minutes - $1, updated_at = NOW()
                 WHERE id = $2::uuid;`,
                [debitMinutes, accId]
              );
            } else if (adj.adjustment_type === 'MEDICAL_CERTIFICATE') {
              const start = new Date(`${String(adj.work_date).slice(0, 10)}T00:00:00Z`);
              const end = new Date(`${String(adj.end_date || adj.work_date).slice(0, 10)}T00:00:00Z`);
              const cursor = new Date(start.getTime());
              let guard = 0;
              while (cursor <= end && guard < 60) {
                const isoDay = cursor.toISOString().slice(0, 10);
                await client.query(
                  `INSERT INTO public.time_punch_daily_summaries (
                     tenant_id, contract_id, work_date, status, absence_hours, delay_hours
                   ) VALUES ($1::uuid, $2::uuid, $3::date, 'LEAVE', 0, 0)
                   ON CONFLICT (tenant_id, contract_id, work_date) DO UPDATE SET
                     status = 'LEAVE',
                     absence_hours = 0,
                     delay_hours = 0,
                     updated_at = NOW();`,
                  [tenantId, adj.contract_id, isoDay]
                );
                cursor.setUTCDate(cursor.getUTCDate() + 1);
                guard++;
              }
            }
          }

          return { code: 'OK' as const, row: upAdj[0] };
        });

        if (res.code === 'FORBIDDEN_PERM') {
          return reply.status(403).send({ success: false, error: 'Permissão insuficiente para homologação do DP.' });
        }
        if (res.code === 'NOT_FOUND') {
          return reply.status(404).send({ success: false, error: 'Solicitação não encontrada.' });
        }
        if (res.code === 'FORBIDDEN_SCOPE') {
          return reply.status(403).send({ success: false, error: 'Acesso negado fora do escopo.' });
        }

        return reply.send({ success: true, data: res.row });
      } catch (err: any) {
        request.log.error(err, '[APPROVALS_DP] Erro na homologação do DP');
        return reply.status(400).send({ success: false, error: err.message });
      }
    }
  );
};
