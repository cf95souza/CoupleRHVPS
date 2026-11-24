import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdminRole, requirePermission } from '../auth/authMiddleware.js';

const updateAccessSchema = z.object({
  role: z.string().min(1, 'O papel é obrigatório.'),
  workerId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
});

const updateScopesSchema = z.object({
  scopeMode: z.enum(['ALL', 'RESTRICTED', 'OWN_TEAM', 'SELF_ONLY']),
  workerId: z.string().uuid().nullable().optional(),
  scopes: z
    .array(
      z.object({
        scopeType: z.enum([
          'COMPANY',
          'ESTABLISHMENT',
          'DEPARTMENT',
          'SECTOR',
          'COST_CENTER',
          'WORKPLACE',
          'TEAM',
        ]),
        scopeTargetId: z.string().uuid('ID do alvo do escopo inválido.'),
        canViewSalary: z.boolean().default(false),
        canViewMedical: z.boolean().default(false),
      })
    )
    .optional()
    .default([]),
});

export const userAccessRoutes: FastifyPluginAsync = async (app) => {
  // Alteração de Papel e Ativação de Usuário no Tenant (Blindagem Anti-Escalada P0)
  app.patch(
    '/tenant-access/:id',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const parseResult = updateAccessSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados de acesso inválidos.',
          details: parseResult.error.format(),
        });
      }

      const { role, workerId, isActive } = parseResult.data;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows } = await client.query(
            'SELECT public.update_tenant_user_access($1, $2, $3, $4) AS res;',
            [id, role, workerId || null, isActive]
          );
          return rows[0]?.res;
        });

        return reply.send({
          success: true,
          data: result,
        });
      } catch (err: any) {
        request.log.warn(err, '[USER_ACCESS] Bloqueio de alteração de papel');
        const message = err.message || 'Erro ao atualizar acesso do usuário.';
        const code = err.code || '42501';

        if (message.includes('Escalada de privilegio bloqueada') || message.includes('Acesso negado')) {
          return reply.status(403).send({
            success: false,
            code: 'FORBIDDEN_PRIVILEGE_ESCALATION',
            error: message,
          });
        }

        if (message.includes('nao encontrado')) {
          return reply.status(404).send({
            success: false,
            code: 'NOT_FOUND',
            error: message,
          });
        }

        if (message.includes('Operacao proibida')) {
          return reply.status(403).send({
            success: false,
            code: 'FORBIDDEN_SELF_MODIFICATION',
            error: message,
          });
        }

        return reply.status(400).send({
          success: false,
          code,
          error: message,
        });
      }
    }
  );

  /**
   * GET /api/v1/users/accessible-contracts
   * Retorna os contratos acessíveis sob o escopo organizacional do usuário logado (RBAC-02)
   */
  app.get('/accessible-contracts', { preHandler: [authenticate] }, async (request, reply) => {
    const tenantId = request.user!.tenant_id;
    if (!tenantId) {
      return reply.status(400).send({
        success: false,
        error: 'Contexto de empresa (tenant) obrigatório.',
      });
    }

    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    try {
      const contracts = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `SELECT 
             c.id, 
             c.worker_id, 
             c.registration_number, 
             c.company_id, 
             c.establishment_id, 
             c.department_id, 
             c.sector_id, 
             c.cost_center_id, 
             c.workplace_id, 
             c.manager_worker_id, 
             c.is_confidential_payroll,
             c.status
           FROM public.contracts c
           WHERE c.tenant_id = $1::uuid
             AND public.can_access_contract($1::uuid, c.id)
           ORDER BY c.registration_number;`,
          [tenantId]
        );
        return rows;
      });

      return reply.send({
        success: true,
        count: contracts.length,
        contracts,
      });
    } catch (err: any) {
      request.log.error(err, '[USER_ACCESS] Erro ao listar contratos acessíveis');
      return reply.status(500).send({
        success: false,
        error: 'Falha ao consultar contratos acessíveis.',
      });
    }
  });

  /**
   * GET /api/v1/users/tenant-access/:id/scopes
   * Retorna o modo de escopo e os alvos organizacionais de um usuário no tenant (RBAC-02)
   */
  app.get(
    '/tenant-access/:id/scopes',
    { preHandler: [authenticate, requirePermission('manage_users')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const tenantId = request.user!.tenant_id;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          // Busca o registro do tenant_user
          const userRes = await client.query(
            `SELECT tu.id, tu.user_id, tu.tenant_id, tu.role, tu.worker_id, tu.scope_mode, tu.is_active,
                    u.full_name, u.email
             FROM public.tenant_users tu
             JOIN public.users u ON u.id = tu.user_id
             WHERE tu.id = $1::uuid AND tu.tenant_id = $2::uuid;`,
            [id, tenantId]
          );

          if (userRes.rows.length === 0) {
            return null;
          }

          const user = userRes.rows[0];

          // Busca os escopos granulares
          const scopesRes = await client.query(
            `SELECT id, scope_type, scope_target_id, can_view_salary, can_view_medical, created_at
             FROM public.tenant_user_scopes
             WHERE tenant_user_id = $1::uuid
             ORDER BY scope_type, created_at;`,
            [id]
          );

          return {
            ...user,
            scopes: scopesRes.rows,
          };
        });

        if (!result) {
          return reply.status(404).send({
            success: false,
            error: 'Usuário do tenant não encontrado.',
          });
        }

        return reply.send({
          success: true,
          data: result,
        });
      } catch (err: any) {
        request.log.error(err, '[USER_ACCESS] Erro ao consultar escopos');
        return reply.status(500).send({
          success: false,
          error: 'Falha ao consultar escopo organizacional do usuário.',
        });
      }
    }
  );

  /**
   * PUT /api/v1/users/tenant-access/:id/scopes
   * Atualiza o modo de escopo e alvos organizacionais do usuário (RBAC-02)
   */
  app.put(
    '/tenant-access/:id/scopes',
    { preHandler: [authenticate, requirePermission('manage_users')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const tenantId = request.user!.tenant_id;

      const parseResult = updateScopesSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados de escopo inválidos.',
          details: parseResult.error.format(),
        });
      }

      const { scopeMode, workerId, scopes } = parseResult.data;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const updated = await request.withContext(async (client) => {
          // 1. Atualizar tenant_users
          const updRes = await client.query(
            `UPDATE public.tenant_users
             SET scope_mode = $1,
                 worker_id = $2,
                 updated_at = NOW()
             WHERE id = $3::uuid AND tenant_id = $4::uuid
             RETURNING id, scope_mode, worker_id;`,
            [scopeMode, workerId || null, id, tenantId]
          );

          if (updRes.rows.length === 0) {
            return null;
          }

          // 2. Limpar escopos anteriores deste tenant_user
          await client.query(
            `DELETE FROM public.tenant_user_scopes WHERE tenant_user_id = $1::uuid;`,
            [id]
          );

          // 3. Se for RESTRICTED e houver novos escopos, inserir
          if (scopeMode === 'RESTRICTED' && scopes && scopes.length > 0) {
            for (const s of scopes) {
              await client.query(
                `INSERT INTO public.tenant_user_scopes 
                   (tenant_id, tenant_user_id, scope_type, scope_target_id, can_view_salary, can_view_medical)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (tenant_user_id, scope_type, scope_target_id) DO NOTHING;`,
                [tenantId, id, s.scopeType, s.scopeTargetId, s.canViewSalary, s.canViewMedical]
              );
            }
          }

          return updRes.rows[0];
        });

        if (!updated) {
          return reply.status(404).send({
            success: false,
            error: 'Usuário do tenant não encontrado.',
          });
        }

        return reply.send({
          success: true,
          message: 'Escopo organizacional atualizado com sucesso.',
          data: updated,
        });
      } catch (err: any) {
        request.log.error(err, '[USER_ACCESS] Erro ao atualizar escopos');
        return reply.status(500).send({
          success: false,
          error: 'Falha ao atualizar escopo organizacional.',
        });
      }
    }
  );
};
