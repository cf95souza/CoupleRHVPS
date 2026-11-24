import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAnyPermission } from '../auth/authMiddleware.js';
import { getUserPermissions } from '../auth/rbacMiddleware.js';
import { serializeMedicalLeave, UserPermissionContext } from '../../shared/serializers/entitySerializers.js';

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
            l.id,
            l.tenant_id,
            l.contract_id,
            l.leave_type,
            l.esocial_reason_code,
            l.start_date,
            l.end_date,
            l.return_date,
            l.cid10_code,
            l.doctor_crm,
            l.doctor_state,
            l.is_inss_responsible,
            l.certificate_file_id,
            l.status,
            l.created_at,
            l.updated_at
          FROM public.leaves l
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
        const created = await request.withContext(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO public.leaves (
              tenant_id, contract_id, leave_type, esocial_reason_code,
              start_date, end_date, return_date, cid10_code, doctor_crm,
              doctor_state, is_inss_responsible, certificate_file_id, status
            ) VALUES (
              $1, $2, $3, $4,
              $5, $6, $7, $8, $9,
              $10, $11, $12, $13
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

          return rows[0];
        });

        return reply.status(201).send({
          success: true,
          message: 'Afastamento registrado com sucesso.',
          data: created,
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
        await request.withContext(async (client) => {
          await client.query(
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
                 certificate_file_id = COALESCE($10, certificate_file_id),
                 status = COALESCE($11, status),
                 updated_at = NOW()
             WHERE id = $12::uuid;`,
            [
              data.leaveType,
              data.esocialReasonCode,
              data.startDate,
              data.endDate,
              data.returnDate,
              data.cid10Code,
              data.doctorCrm,
              data.doctorState,
              data.isInssResponsible,
              data.certificateFileId,
              data.status,
              id,
            ]
          );
        });

        return reply.send({
          success: true,
          message: 'Afastamento atualizado com sucesso.',
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
};
