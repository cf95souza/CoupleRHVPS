import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import pg from 'pg';
import {
  buildLeaveTimelineMap,
  computeWorkAccidentStabilityDate,
  LeaveImpactCalculator,
  normalizeCid10,
  resolveCanonicalLeaveCategory,
  type LeaveRecordInput,
} from '@couplerh/payroll-core';
import { authenticate, requireAnyPermission } from '../auth/authMiddleware.js';
import { getUserPermissions } from '../auth/rbacMiddleware.js';
import { serializeMedicalLeave, UserPermissionContext } from '../../shared/serializers/entitySerializers.js';

function toIsoStr(val: any): string | null {
  if (!val) return null;
  if (val instanceof Date) {
    return `${val.getUTCFullYear()}-${String(val.getUTCMonth() + 1).padStart(2, '0')}-${String(val.getUTCDate()).padStart(2, '0')}`;
  }
  return String(val).slice(0, 10);
}

/**
 * Recalcula dias pagos pela empresa, agregação 60d mesma CID, responsabilidade INSS,
 * estabilidade de 12 meses de Acidente de Trabalho e perda de aquisitivo de férias (>180d - CLT art. 133 IV).
 */
async function syncContractLeavesLegalState(
  client: pg.PoolClient,
  tenantId: string,
  contractId: string
): Promise<{ forfeitedVacationPeriods: number }> {
  const { rows: rawLeaves } = await client.query(
    `SELECT * FROM public.leaves
     WHERE tenant_id = $1::uuid AND contract_id = $2::uuid AND status <> 'CANCELLED'
     ORDER BY start_date ASC, created_at ASC;`,
    [tenantId, contractId]
  );

  const normalizedLeaves: LeaveRecordInput[] = rawLeaves.map((l: any) => ({
    id: l.id,
    contract_id: l.contract_id,
    leave_type: l.leave_type,
    esocial_reason_code: l.esocial_reason_code,
    start_date: toIsoStr(l.start_date)!,
    end_date: toIsoStr(l.end_date),
    return_date: toIsoStr(l.return_date),
    cid10_code: l.cid10_code,
    is_inss_responsible: Boolean(l.is_inss_responsible),
    is_same_cid_relapse: Boolean(l.is_same_cid_relapse),
    parent_leave_id: l.parent_leave_id,
    is_extended_maternity: Boolean(l.is_extended_maternity),
    status: l.status,
  }));

  if (normalizedLeaves.length > 0) {
    const horizonDate = normalizedLeaves.reduce((maxD, l) => {
      const candidate = l.end_date || l.start_date;
      return candidate > maxD ? candidate : maxD;
    }, '2026-12-31');

    const { dayMap } = buildLeaveTimelineMap(normalizedLeaves, horizonDate);

    // Identifica vínculo com atestado anterior mesma CID <= 60 dias
    const lastByCid = new Map<string, { id: string; endDt: number }>();

    for (const lv of normalizedLeaves) {
      let companyPaidDays = 0;
      let hasInssDays = false;
      for (const info of dayMap.values()) {
        if (info.leaveId !== lv.id) continue;
        if (info.isEmployerPaidSick) companyPaidDays++;
        if (info.isInssCovered) hasInssDays = true;
      }

      const category = resolveCanonicalLeaveCategory(lv.leave_type, lv.esocial_reason_code);
      const normCid = normalizeCid10(lv.cid10_code);
      let sameCidRelapse = Boolean(lv.is_same_cid_relapse);
      let parentLeaveId = lv.parent_leave_id || null;

      if ((category === 'SICK_LEAVE' || category === 'WORK_ACCIDENT') && normCid) {
        const prev = lastByCid.get(normCid);
        const startMs = Date.parse(`${lv.start_date}T00:00:00Z`);
        if (prev && Math.floor((startMs - prev.endDt) / 86400000) <= 60) {
          sameCidRelapse = true;
          parentLeaveId = parentLeaveId || prev.id;
        }
        const endRef = lv.end_date || lv.start_date;
        lastByCid.set(normCid, { id: lv.id, endDt: Date.parse(`${endRef}T00:00:00Z`) });
      }

      const stabilityUntil = computeWorkAccidentStabilityDate(lv);

      await client.query(
        `UPDATE public.leaves
         SET company_paid_days = $1,
             is_inss_responsible = $2,
             is_same_cid_relapse = $3,
             parent_leave_id = $4::uuid,
             stability_until = $5::date,
             updated_at = NOW()
         WHERE id = $6::uuid;`,
        [companyPaidDays, hasInssDays, sameCidRelapse, parentLeaveId, stabilityUntil, lv.id]
      );
    }
  }

  // Avalia perda de período aquisitivo de férias (> 180 dias INSS - CLT Art. 133 IV)
  const { rows: vacPeriods } = await client.query(
    `SELECT id, acquisition_start, acquisition_end, days_taken, status, lost_by_leave
     FROM public.vacation_periods
     WHERE tenant_id = $1::uuid AND contract_id = $2::uuid
       AND status IN ('DRAFT', 'OPEN', 'IN_PROGRESS', 'FORFEITED');`,
    [tenantId, contractId]
  );

  let forfeitedCount = 0;
  for (const vp of vacPeriods) {
    const evalRes = LeaveImpactCalculator.evaluateVacationAcquisitionLoss({
      acquisitionStart: toIsoStr(vp.acquisition_start)!,
      acquisitionEnd: toIsoStr(vp.acquisition_end)!,
      leaves: normalizedLeaves,
    });

    if (evalRes.lostByLeave) {
      forfeitedCount++;
      await client.query(
        `UPDATE public.vacation_periods
         SET lost_by_leave = TRUE,
             leave_days_in_acquisition = $1,
             days_accrued = 0,
             days_remaining = 0,
             status = 'FORFEITED',
             loss_reason = $2,
             updated_at = NOW()
         WHERE id = $3::uuid;`,
        [evalRes.inssBenefitDays, evalRes.lossReason, vp.id]
      );
    } else if (vp.lost_by_leave || vp.status === 'FORFEITED') {
      await client.query(
        `UPDATE public.vacation_periods
         SET lost_by_leave = FALSE,
             leave_days_in_acquisition = $1,
             days_accrued = 30,
             days_remaining = GREATEST(0, 30 - COALESCE(days_taken, 0)),
             status = 'OPEN',
             loss_reason = NULL,
             updated_at = NOW()
         WHERE id = $2::uuid;`,
        [evalRes.inssBenefitDays, vp.id]
      );
    } else {
      await client.query(
        `UPDATE public.vacation_periods
         SET leave_days_in_acquisition = $1,
             updated_at = NOW()
         WHERE id = $2::uuid;`,
        [evalRes.inssBenefitDays, vp.id]
      );
    }
  }

  return { forfeitedVacationPeriods: forfeitedCount };
}

const createLeaveSchema = z.object({
  contractId: z.string().uuid('ID do contrato inválido.'),
  leaveType: z.string().min(1, 'Tipo de afastamento é obrigatório.'),
  esocialReasonCode: z.string().optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inicial inválida (AAAA-MM-DD).'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data final inválida (AAAA-MM-DD).').optional().nullable(),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de retorno inválida (AAAA-MM-DD).').optional().nullable(),
  cid10Code: z.string().optional().nullable(),
  doctorCrm: z.string().optional().nullable(),
  doctorState: z.string().max(2).optional().nullable(),
  isInssResponsible: z.boolean().default(false),
  isExtendedMaternity: z.boolean().default(false),
  notes: z.string().max(1000).optional().nullable(),
  certificateFileId: z.string().uuid('ID do anexo inválido.').optional().nullable(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']).default('ACTIVE'),
});

const updateLeaveSchema = z.object({
  leaveType: z.string().min(1).optional(),
  esocialReasonCode: z.string().optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  cid10Code: z.string().optional().nullable(),
  doctorCrm: z.string().optional().nullable(),
  doctorState: z.string().max(2).optional().nullable(),
  isInssResponsible: z.boolean().optional(),
  isExtendedMaternity: z.boolean().optional(),
  notes: z.string().max(1000).optional().nullable(),
  certificateFileId: z.string().uuid().optional().nullable(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
});

export const leaveRoutes: FastifyPluginAsync = async (app) => {
  // 1. Listagem de Afastamentos com Sigilo de CID-10 (Resolução CFM 1.851/2008 & LGPD Art. 11)
  app.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const query = request.query as {
      contractId?: string;
      status?: string;
      page?: string;
      limit?: string;
    };

    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    try {
      const result = await request.withContext(async (client) => {
        const permsList = await getUserPermissions(
          client,
          request.user!.sub,
          request.user!.tenant_id!,
          request.user!.role
        );
        const permsSet = new Set(permsList);
        const ctx: UserPermissionContext = {
          hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
        };

        const { rows } = await client.query(
          `SELECT
            l.*,
            c.company_id,
            w.full_name AS worker_name
          FROM public.leaves l
          JOIN public.contracts c ON c.id = l.contract_id
          JOIN public.workers w ON w.id = c.worker_id
          WHERE ($1::uuid IS NULL OR l.contract_id = $1::uuid)
            AND ($2::text IS NULL OR l.status = $2::text)
          ORDER BY l.start_date DESC
          LIMIT $3 OFFSET $4;`,
          [query.contractId || null, query.status || null, limit, offset]
        );

        const sanitized = rows.map((row) => serializeMedicalLeave(row, ctx));
        return { list: sanitized, total: sanitized.length };
      });

      return reply.send({
        success: true,
        data: result.list,
        count: result.total,
        page,
        limit,
      });
    } catch (err: any) {
      request.log.error(err, '[LEAVES_LIST] Erro ao listar afastamentos');
      return reply.status(500).send({
        success: false,
        error: 'Erro interno ao consultar afastamentos.',
      });
    }
  });

  // 2. Detalhe de Afastamento por ID
  app.get('/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    try {
      const leave = await request.withContext(async (client) => {
        const permsList = await getUserPermissions(
          client,
          request.user!.sub,
          request.user!.tenant_id!,
          request.user!.role
        );
        const permsSet = new Set(permsList);
        const ctx: UserPermissionContext = {
          hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
        };

        const { rows } = await client.query(
          `SELECT * FROM public.leaves WHERE id = $1::uuid LIMIT 1;`,
          [id]
        );

        if (rows.length === 0) return null;
        return serializeMedicalLeave(rows[0], ctx);
      });

      if (!leave) {
        return reply.status(404).send({
          success: false,
          code: 'LEAVE_NOT_FOUND',
          error: 'Registro de afastamento não encontrado.',
        });
      }

      return reply.send({
        success: true,
        data: leave,
      });
    } catch (err: any) {
      request.log.error(err, '[LEAVE_GET] Erro ao obter afastamento');
      return reply.status(500).send({
        success: false,
        error: 'Erro interno ao consultar afastamento.',
      });
    }
  });

  // 3. Cadastro de Afastamento / Licença Médica
  app.post(
    '/',
    { preHandler: [authenticate, requireAnyPermission(['manage_leaves', 'manage_employees', 'manage_sst'])] },
    async (request, reply) => {
      const parseResult = createLeaveSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados de afastamento inválidos.',
          details: parseResult.error.format(),
        });
      }

      const data = parseResult.data;
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO public.leaves (
              tenant_id, contract_id, leave_type, esocial_reason_code,
              start_date, end_date, return_date, cid10_code, doctor_crm,
              doctor_state, is_inss_responsible, is_extended_maternity, notes,
              certificate_file_id, status
            ) VALUES (
              $1, $2, $3, $4,
              $5, $6, $7, $8, $9,
              $10, $11, $12, $13,
              $14, $15
            ) RETURNING *;`,
            [
              request.user!.tenant_id,
              data.contractId,
              data.leaveType,
              data.esocialReasonCode || null,
              data.startDate,
              data.endDate || null,
              data.returnDate || null,
              data.cid10Code || null,
              data.doctorCrm || null,
              data.doctorState || null,
              data.isInssResponsible,
              data.isExtendedMaternity,
              data.notes || null,
              data.certificateFileId || null,
              data.status,
            ]
          );

          // Atualiza status do contrato para 'LEAVE' se o afastamento for ativo
          if (data.status === 'ACTIVE') {
            await client.query(
              `UPDATE public.contracts SET status = 'LEAVE', updated_at = NOW() WHERE id = $1::uuid;`,
              [data.contractId]
            );
          }

          const syncRes = await syncContractLeavesLegalState(
            client,
            request.user!.tenant_id!,
            data.contractId
          );

          const { rows: refreshed } = await client.query(
            `SELECT * FROM public.leaves WHERE id = $1::uuid;`,
            [rows[0].id]
          );

          const permsList = await getUserPermissions(
            client,
            request.user!.sub,
            request.user!.tenant_id!,
            request.user!.role
          );
          const permsSet = new Set(permsList);
          const ctx: UserPermissionContext = {
            hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
          };

          return {
            leave: serializeMedicalLeave(refreshed[0] || rows[0], ctx),
            forfeitedVacationPeriods: syncRes.forfeitedVacationPeriods,
          };
        });

        return reply.status(201).send({
          success: true,
          message: 'Afastamento registrado com sucesso.',
          data: result.leave,
          forfeitedVacationPeriods: result.forfeitedVacationPeriods,
        });
      } catch (err: any) {
        request.log.error(err, '[LEAVE_CREATE] Erro ao cadastrar afastamento');
        return reply.status(500).send({
          success: false,
          error: 'Erro interno ao cadastrar afastamento.',
        });
      }
    }
  );

  // 4. Atualização de Afastamento
  app.put(
    '/:id',
    { preHandler: [authenticate, requireAnyPermission(['manage_leaves', 'manage_employees', 'manage_sst'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parseResult = updateLeaveSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados de atualização inválidos.',
          details: parseResult.error.format(),
        });
      }

      const data = parseResult.data;
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows } = await client.query(
            `UPDATE public.leaves
             SET leave_type = COALESCE($1, leave_type),
                 esocial_reason_code = COALESCE($2, esocial_reason_code),
                 start_date = COALESCE($3, start_date),
                 end_date = COALESCE($4, end_date),
                 return_date = COALESCE($5, return_date),
                 cid10_code = COALESCE($6, cid10_code),
                 doctor_crm = COALESCE($7, doctor_crm),
                 doctor_state = COALESCE($8, doctor_state),
                 is_inss_responsible = COALESCE($9, is_inss_responsible),
                 is_extended_maternity = COALESCE($10, is_extended_maternity),
                 notes = COALESCE($11, notes),
                 certificate_file_id = COALESCE($12, certificate_file_id),
                 status = COALESCE($13, status),
                 updated_at = NOW()
             WHERE id = $14::uuid
             RETURNING *;`,
            [
              data.leaveType ?? null,
              data.esocialReasonCode ?? null,
              data.startDate ?? null,
              data.endDate ?? null,
              data.returnDate ?? null,
              data.cid10Code ?? null,
              data.doctorCrm ?? null,
              data.doctorState ?? null,
              data.isInssResponsible ?? null,
              data.isExtendedMaternity ?? null,
              data.notes ?? null,
              data.certificateFileId ?? null,
              data.status ?? null,
              id,
            ]
          );
          if (rows.length === 0) return null;

          const syncRes = await syncContractLeavesLegalState(
            client,
            request.user!.tenant_id!,
            rows[0].contract_id
          );
          const { rows: refreshed } = await client.query(
            `SELECT * FROM public.leaves WHERE id = $1::uuid;`,
            [id]
          );

          const permsList = await getUserPermissions(
            client,
            request.user!.sub,
            request.user!.tenant_id!,
            request.user!.role
          );
          const permsSet = new Set(permsList);
          const ctx: UserPermissionContext = {
            hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
          };

          return {
            leave: serializeMedicalLeave(refreshed[0] || rows[0], ctx),
            forfeitedVacationPeriods: syncRes.forfeitedVacationPeriods,
          };
        });

        if (!result) {
          return reply.status(404).send({ success: false, error: 'Afastamento não encontrado.' });
        }

        return reply.send({
          success: true,
          message: 'Afastamento atualizado com sucesso.',
          data: result.leave,
          forfeitedVacationPeriods: result.forfeitedVacationPeriods,
        });
      } catch (err: any) {
        request.log.error(err, '[LEAVE_UPDATE] Erro ao atualizar afastamento');
        return reply.status(500).send({
          success: false,
          error: 'Erro interno ao atualizar afastamento.',
        });
      }
    }
  );

  // 5. Cancelamento Lógico de Afastamento (recalcula carência/férias)
  app.delete(
    '/:id',
    { preHandler: [authenticate, requireAnyPermission(['manage_leaves', 'manage_employees', 'manage_sst'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const cancelled = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `UPDATE public.leaves
           SET status = 'CANCELLED', updated_at = NOW()
           WHERE id = $1::uuid
           RETURNING id, contract_id;`,
          [id]
        );
        if (rows.length === 0) return null;
        await syncContractLeavesLegalState(client, request.user!.tenant_id!, rows[0].contract_id);
        return rows[0];
      });

      if (!cancelled) {
        return reply.status(404).send({ success: false, error: 'Afastamento não encontrado.' });
      }
      return reply.send({ success: true, message: 'Afastamento cancelado e reflexos recalculados.' });
    }
  );
};
