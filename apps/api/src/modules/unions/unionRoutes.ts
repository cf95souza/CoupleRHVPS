import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAnyPermission } from '../auth/authMiddleware.js';

const createUnionSchema = z.object({
  code: z.string().max(50).optional().nullable(),
  cnpj: z.string().min(14, 'CNPJ deve conter ao menos 14 dígitos.').max(18),
  name: z.string().min(2, 'Nome do sindicato deve conter no mínimo 2 caracteres.'),
  tradeName: z.string().optional().nullable(),
  unionType: z.enum(['EMPLOYEE', 'EMPLOYER']).default('EMPLOYEE'),
  baseMonth: z.number().int().min(1).max(12, 'Mês da data-base deve ser entre 1 e 12.'),
  state: z.string().length(2).optional().nullable(),
  city: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email('E-mail do sindicato inválido.').optional().nullable(),
  website: z.string().url('URL inválida.').optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

const updateUnionSchema = createUnionSchema.partial();

const createAgreementSchema = z.object({
  unionId: z.string().uuid('ID do sindicato inválido.').optional(),
  title: z.string().min(3, 'Título da convenção deve conter no mínimo 3 caracteres.'),
  agreementType: z.enum(['CCT', 'ACT']).default('CCT'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de início inválida (AAAA-MM-DD).'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de fim inválida (AAAA-MM-DD).'),
  baseSalaryFloor: z.number().nonnegative().default(0),
  floorPositions: z
    .array(
      z.object({
        cbo: z.string().optional(),
        position_id: z.string().optional(),
        floor: z.number().nonnegative(),
      })
    )
    .optional()
    .default([]),
  overtimePercentageTier1: z.number().nonnegative().default(50.0),
  overtimePercentageTier2: z.number().nonnegative().default(100.0),
  overtimePercentageSundayHoliday: z.number().nonnegative().default(100.0),
  nightShiftPercentage: z.number().nonnegative().default(20.0),
  nightShiftStartTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Horário início noturno inválido.').default('22:00:00'),
  nightShiftEndTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Horário fim noturno inválido.').default('05:00:00'),
  nightHourReduced: z.boolean().default(true),
  unhealthinessBaseType: z.enum(['MINIMUM_WAGE', 'BASE_SALARY', 'CATEGORY_FLOOR']).default('MINIMUM_WAGE'),
  atsType: z.enum(['NONE', 'ANUENIO', 'BIENIO', 'TRIENIO', 'QUINQUENIO']).default('NONE'),
  atsPercentagePerCycle: z.number().nonnegative().default(0),
  atsMaxPercentage: z.number().nonnegative().optional().nullable(),
  atsBaseType: z.enum(['BASE_SALARY', 'GROSS_SALARY']).default('BASE_SALARY'),
  averageCalculationMonths: z.number().int().min(1).max(24).default(12),
  postVacationStabilityDays: z.number().int().nonnegative().default(0),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

const updateAgreementSchema = createAgreementSchema.partial();

export const unionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // ============================================================================
  // SINDICATOS (public.unions)
  // ============================================================================

  // 1. Listar sindicatos do tenant
  app.get(
    '/unions',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'view_dashboard', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { search, union_type, is_active } = request.query as any;

      return request.withContext!(async (client) => {
        let query = `
          SELECT u.*,
                 (SELECT COUNT(*)::int FROM public.collective_agreements ca WHERE ca.union_id = u.id AND ca.deleted_at IS NULL) AS total_agreements
          FROM public.unions u
          WHERE u.tenant_id = $1::uuid
            AND u.deleted_at IS NULL
        `;
        const params: any[] = [tenantId];

        if (search) {
          params.push(`%${search}%`);
          query += ` AND (u.name ILIKE $${params.length} OR u.trade_name ILIKE $${params.length} OR u.cnpj ILIKE $${params.length} OR u.code ILIKE $${params.length})`;
        }

        if (union_type) {
          params.push(union_type);
          query += ` AND u.union_type = $${params.length}`;
        }

        if (is_active !== undefined) {
          params.push(is_active === 'true' || is_active === true);
          query += ` AND u.is_active = $${params.length}`;
        }

        query += ` ORDER BY u.name ASC;`;

        const { rows } = await client.query(query, params);
        return reply.send({ success: true, data: rows });
      });
    }
  );

  // 2. Cadastrar sindicato
  app.post(
    '/unions',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const parsed = createUnionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados inválidos.',
          details: parsed.error.format(),
        });
      }

      const cleanCnpj = parsed.data.cnpj.replace(/\D/g, '');

      return request.withContext!(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO public.unions (
             tenant_id, code, cnpj, name, trade_name, union_type, base_month,
             state, city, phone, email, website, notes, is_active
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13, $14
           ) RETURNING *;`,
          [
            tenantId,
            parsed.data.code || null,
            cleanCnpj,
            parsed.data.name,
            parsed.data.tradeName || null,
            parsed.data.unionType,
            parsed.data.baseMonth,
            parsed.data.state || null,
            parsed.data.city || null,
            parsed.data.phone || null,
            parsed.data.email || null,
            parsed.data.website || null,
            parsed.data.notes || null,
            parsed.data.isActive,
          ]
        );

        return reply.status(201).send({ success: true, data: rows[0] });
      });
    }
  );

  // 3. Obter sindicato por ID com seus acordos
  app.get(
    '/unions/:id',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'view_dashboard', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { id } = request.params as { id: string };

      return request.withContext!(async (client) => {
        const { rows: unionRows } = await client.query(
          `SELECT * FROM public.unions
           WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL;`,
          [id, tenantId]
        );

        if (unionRows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Sindicato não encontrado.' });
        }

        const { rows: agreementRows } = await client.query(
          `SELECT * FROM public.collective_agreements
           WHERE union_id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL
           ORDER BY start_date DESC;`,
          [id, tenantId]
        );

        return reply.send({
          success: true,
          data: {
            ...unionRows[0],
            agreements: agreementRows,
          },
        });
      });
    }
  );

  // 4. Atualizar sindicato
  app.put(
    '/unions/:id',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { id } = request.params as { id: string };

      const parsed = updateUnionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados inválidos.',
          details: parsed.error.format(),
        });
      }

      return request.withContext!(async (client) => {
        const cleanCnpj = parsed.data.cnpj ? parsed.data.cnpj.replace(/\D/g, '') : undefined;

        const { rows } = await client.query(
          `UPDATE public.unions SET
             code = COALESCE($1, code),
             cnpj = COALESCE($2, cnpj),
             name = COALESCE($3, name),
             trade_name = COALESCE($4, trade_name),
             union_type = COALESCE($5, union_type),
             base_month = COALESCE($6, base_month),
             state = COALESCE($7, state),
             city = COALESCE($8, city),
             phone = COALESCE($9, phone),
             email = COALESCE($10, email),
             website = COALESCE($11, website),
             notes = COALESCE($12, notes),
             is_active = COALESCE($13, is_active),
             updated_at = NOW()
           WHERE id = $14::uuid AND tenant_id = $15::uuid AND deleted_at IS NULL
           RETURNING *;`,
          [
            parsed.data.code,
            cleanCnpj,
            parsed.data.name,
            parsed.data.tradeName,
            parsed.data.unionType,
            parsed.data.baseMonth,
            parsed.data.state,
            parsed.data.city,
            parsed.data.phone,
            parsed.data.email,
            parsed.data.website,
            parsed.data.notes,
            parsed.data.isActive,
            id,
            tenantId,
          ]
        );

        if (rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Sindicato não encontrado.' });
        }

        return reply.send({ success: true, data: rows[0] });
      });
    }
  );

  // 5. Excluir (soft-delete) sindicato
  app.delete(
    '/unions/:id',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { id } = request.params as { id: string };

      return request.withContext!(async (client) => {
        const { rowCount } = await client.query(
          `UPDATE public.unions SET deleted_at = NOW(), is_active = FALSE
           WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL;`,
          [id, tenantId]
        );

        if (!rowCount) {
          return reply.status(404).send({ success: false, error: 'Sindicato não encontrado.' });
        }

        // Desativa acordos vinculados
        await client.query(
          `UPDATE public.collective_agreements SET deleted_at = NOW(), is_active = FALSE
           WHERE union_id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL;`,
          [id, tenantId]
        );

        return reply.send({ success: true, message: 'Sindicato removido com sucesso.' });
      });
    }
  );

  // ============================================================================
  // CONVENÇÕES COLETIVAS (public.collective_agreements)
  // ============================================================================

  // 6. Listar todas as convenções do tenant (atalho global para dropdowns em contratos)
  app.get(
    '/collective-agreements',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'view_dashboard', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { is_active } = request.query as any;

      return request.withContext!(async (client) => {
        let query = `
          SELECT ca.*,
                 u.name AS union_name, u.trade_name AS union_trade_name, u.cnpj AS union_cnpj, u.base_month
          FROM public.collective_agreements ca
          JOIN public.unions u ON u.id = ca.union_id
          WHERE ca.tenant_id = $1::uuid
            AND ca.deleted_at IS NULL
        `;
        const params: any[] = [tenantId];

        if (is_active !== undefined) {
          params.push(is_active === 'true' || is_active === true);
          query += ` AND ca.is_active = $${params.length}`;
        }

        query += ` ORDER BY ca.title ASC;`;

        const { rows } = await client.query(query, params);
        return reply.send({ success: true, data: rows });
      });
    }
  );

  // 7. Listar convenções de um sindicato
  app.get(
    '/unions/:unionId/agreements',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'view_dashboard', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { unionId } = request.params as { unionId: string };

      return request.withContext!(async (client) => {
        const { rows } = await client.query(
          `SELECT * FROM public.collective_agreements
           WHERE union_id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL
           ORDER BY start_date DESC;`,
          [unionId, tenantId]
        );
        return reply.send({ success: true, data: rows });
      });
    }
  );

  // 8. Cadastrar convenção coletiva (CCT / ACT) para um sindicato
  app.post(
    '/unions/:unionId/agreements',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { unionId } = request.params as { unionId: string };

      const parsed = createAgreementSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados inválidos.',
          details: parsed.error.format(),
        });
      }

      return request.withContext!(async (client) => {
        // Verifica existência do sindicato
        const { rows: unionRows } = await client.query(
          `SELECT id FROM public.unions WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL;`,
          [unionId, tenantId]
        );
        if (unionRows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Sindicato não encontrado.' });
        }

        const { rows } = await client.query(
          `INSERT INTO public.collective_agreements (
             tenant_id, union_id, title, agreement_type, start_date, end_date,
             base_salary_floor, floor_positions,
             overtime_percentage_tier1, overtime_percentage_tier2, overtime_percentage_sunday_holiday,
             night_shift_percentage, night_shift_start_time, night_shift_end_time, night_hour_reduced,
             unhealthiness_base_type, ats_type, ats_percentage_per_cycle, ats_max_percentage, ats_base_type,
             average_calculation_months, post_vacation_stability_days, notes, is_active
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5::date, $6::date,
             $7, $8::jsonb,
             $9, $10, $11,
             $12, $13::time, $14::time, $15,
             $16, $17, $18, $19, $20,
             $21, $22, $23, $24
           ) RETURNING *;`,
          [
            tenantId,
            unionId,
            parsed.data.title,
            parsed.data.agreementType,
            parsed.data.startDate,
            parsed.data.endDate,
            parsed.data.baseSalaryFloor,
            JSON.stringify(parsed.data.floorPositions || []),
            parsed.data.overtimePercentageTier1,
            parsed.data.overtimePercentageTier2,
            parsed.data.overtimePercentageSundayHoliday,
            parsed.data.nightShiftPercentage,
            parsed.data.nightShiftStartTime,
            parsed.data.nightShiftEndTime,
            parsed.data.nightHourReduced,
            parsed.data.unhealthinessBaseType,
            parsed.data.atsType,
            parsed.data.atsPercentagePerCycle,
            parsed.data.atsMaxPercentage ?? null,
            parsed.data.atsBaseType,
            parsed.data.averageCalculationMonths,
            parsed.data.postVacationStabilityDays,
            parsed.data.notes || null,
            parsed.data.isActive,
          ]
        );

        return reply.status(201).send({ success: true, data: rows[0] });
      });
    }
  );

  // 9. Obter convenção específica por ID
  app.get(
    '/unions/agreements/:agreementId',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'view_dashboard', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { agreementId } = request.params as { agreementId: string };

      return request.withContext!(async (client) => {
        const { rows } = await client.query(
          `SELECT ca.*, u.name AS union_name, u.cnpj AS union_cnpj
           FROM public.collective_agreements ca
           JOIN public.unions u ON u.id = ca.union_id
           WHERE ca.id = $1::uuid AND ca.tenant_id = $2::uuid AND ca.deleted_at IS NULL;`,
          [agreementId, tenantId]
        );

        if (rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Convenção coletiva não encontrada.' });
        }

        return reply.send({ success: true, data: rows[0] });
      });
    }
  );

  // 10. Atualizar convenção coletiva
  app.put(
    '/unions/agreements/:agreementId',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { agreementId } = request.params as { agreementId: string };

      const parsed = updateAgreementSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados inválidos.',
          details: parsed.error.format(),
        });
      }

      return request.withContext!(async (client) => {
        const { rows } = await client.query(
          `UPDATE public.collective_agreements SET
             title = COALESCE($1, title),
             agreement_type = COALESCE($2, agreement_type),
             start_date = COALESCE($3::date, start_date),
             end_date = COALESCE($4::date, end_date),
             base_salary_floor = COALESCE($5, base_salary_floor),
             floor_positions = COALESCE($6::jsonb, floor_positions),
             overtime_percentage_tier1 = COALESCE($7, overtime_percentage_tier1),
             overtime_percentage_tier2 = COALESCE($8, overtime_percentage_tier2),
             overtime_percentage_sunday_holiday = COALESCE($9, overtime_percentage_sunday_holiday),
             night_shift_percentage = COALESCE($10, night_shift_percentage),
             night_shift_start_time = COALESCE($11::time, night_shift_start_time),
             night_shift_end_time = COALESCE($12::time, night_shift_end_time),
             night_hour_reduced = COALESCE($13, night_hour_reduced),
             unhealthiness_base_type = COALESCE($14, unhealthiness_base_type),
             ats_type = COALESCE($15, ats_type),
             ats_percentage_per_cycle = COALESCE($16, ats_percentage_per_cycle),
             ats_max_percentage = COALESCE($17, ats_max_percentage),
             ats_base_type = COALESCE($18, ats_base_type),
             average_calculation_months = COALESCE($19, average_calculation_months),
             post_vacation_stability_days = COALESCE($20, post_vacation_stability_days),
             notes = COALESCE($21, notes),
             is_active = COALESCE($22, is_active),
             updated_at = NOW()
           WHERE id = $23::uuid AND tenant_id = $24::uuid AND deleted_at IS NULL
           RETURNING *;`,
          [
            parsed.data.title,
            parsed.data.agreementType,
            parsed.data.startDate,
            parsed.data.endDate,
            parsed.data.baseSalaryFloor,
            parsed.data.floorPositions ? JSON.stringify(parsed.data.floorPositions) : null,
            parsed.data.overtimePercentageTier1,
            parsed.data.overtimePercentageTier2,
            parsed.data.overtimePercentageSundayHoliday,
            parsed.data.nightShiftPercentage,
            parsed.data.nightShiftStartTime,
            parsed.data.nightShiftEndTime,
            parsed.data.nightHourReduced,
            parsed.data.unhealthinessBaseType,
            parsed.data.atsType,
            parsed.data.atsPercentagePerCycle,
            parsed.data.atsMaxPercentage,
            parsed.data.atsBaseType,
            parsed.data.averageCalculationMonths,
            parsed.data.postVacationStabilityDays,
            parsed.data.notes,
            parsed.data.isActive,
            agreementId,
            tenantId,
          ]
        );

        if (rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Convenção coletiva não encontrada.' });
        }

        return reply.send({ success: true, data: rows[0] });
      });
    }
  );

  // 11. Excluir (soft-delete) convenção coletiva
  app.delete(
    '/unions/agreements/:agreementId',
    {
      preHandler: [requireAnyPermission(['manage_unions', 'manage_settings', 'manage_employees'])],
    },
    async (request, reply) => {
      const tenantId = request.user!.tenant_id;
      const { agreementId } = request.params as { agreementId: string };

      return request.withContext!(async (client) => {
        const { rowCount } = await client.query(
          `UPDATE public.collective_agreements SET deleted_at = NOW(), is_active = FALSE
           WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL;`,
          [agreementId, tenantId]
        );

        if (!rowCount) {
          return reply.status(404).send({ success: false, error: 'Convenção coletiva não encontrada.' });
        }

        return reply.send({ success: true, message: 'Convenção coletiva removida com sucesso.' });
      });
    }
  );
};
