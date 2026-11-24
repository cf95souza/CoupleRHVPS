import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdminRole } from '../auth/authMiddleware.js';

const updateAccessSchema = z.object({
  role: z.enum([
    'system_admin',
    'tenant_admin',
    'dp_analyst',
    'manager',
    'employee',
    'sst_specialist',
    'auditor',
  ]),
  workerId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
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
};
