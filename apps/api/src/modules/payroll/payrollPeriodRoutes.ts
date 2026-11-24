import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdminRole } from '../auth/authMiddleware.js';

const closePayrollSchema = z.object({
  notes: z.string().optional(),
});

const reopenPayrollSchema = z.object({
  reason: z.string().min(15, 'A justificativa de reabertura deve conter no mínimo 15 caracteres.'),
});

export const payrollPeriodRoutes: FastifyPluginAsync = async (app) => {
  // Fechamento Formal e Travamento de Folha de Pagamento
  app.post(
    '/periods/:id/close',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const parseResult = closePayrollSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados inválidos para fechamento.',
          details: parseResult.error.format(),
        });
      }

      const { notes } = parseResult.data;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows } = await client.query(
            'SELECT public.close_payroll_period($1, $2) AS res;',
            [id, notes || null]
          );
          return rows[0]?.res;
        });

        return reply.send({
          success: true,
          data: result,
        });
      } catch (err: any) {
        request.log.warn(err, '[PAYROLL_CLOSE] Erro ao fechar folha');
        const message = err.message || 'Erro ao fechar período de folha.';

        if (message.includes('Acesso negado') || message.includes('permissao')) {
          return reply.status(403).send({
            success: false,
            code: 'FORBIDDEN_CLOSE_PAYROLL',
            error: message,
          });
        }

        if (message.includes('bloqueado') || message.includes('Compliance') || message.includes('Art. 462')) {
          return reply.status(400).send({
            success: false,
            code: 'PAYROLL_VALIDATION_ERROR',
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

        return reply.status(400).send({
          success: false,
          error: message,
        });
      }
    }
  );

  // Reabertura Auditada de Folha com Justificativa Legal
  app.post(
    '/periods/:id/reopen',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const parseResult = reopenPayrollSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: parseResult.error.issues[0]?.message || 'Justificativa de reabertura inválida.',
        });
      }

      const { reason } = parseResult.data;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows } = await client.query(
            'SELECT public.reopen_payroll_period($1, $2) AS res;',
            [id, reason]
          );
          return rows[0]?.res;
        });

        return reply.send({
          success: true,
          data: result,
        });
      } catch (err: any) {
        request.log.warn(err, '[PAYROLL_REOPEN] Erro ao reabrir folha');
        const message = err.message || 'Erro ao reabrir período de folha.';

        if (message.includes('Acesso negado') || message.includes('permissao')) {
          return reply.status(403).send({
            success: false,
            code: 'FORBIDDEN_REOPEN_PAYROLL',
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

        return reply.status(400).send({
          success: false,
          error: message,
        });
      }
    }
  );
};
