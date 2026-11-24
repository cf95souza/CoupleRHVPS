import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdminRole } from '../auth/authMiddleware.js';

const terminationPreviewSchema = z.object({
  contractId: z.string().uuid(),
  resignationDate: z.string(),
  dismissalType: z.enum([
    'WITHOUT_CAUSE',
    'WITH_CAUSE',
    'RESIGNATION',
    'MUTUAL_AGREEMENT',
    'CONTRACT_EXPIRATION',
  ]),
  noticeType: z.enum(['WORKED', 'INDEMNIFIED', 'WAIVED']),
});

export const terminationRoutes: FastifyPluginAsync = async (app) => {
  // Cálculo e Simulação de Rescisão Contratual (Protegido para RH e Admin)
  app.post(
    '/calculate',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      const parseResult = terminationPreviewSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros de rescisão inválidos.',
          details: parseResult.error.format(),
        });
      }

      const { contractId, resignationDate, dismissalType, noticeType } = parseResult.data;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows } = await client.query<{
            id: string;
            base_salary: string;
            admission_date: string;
            worker_id: string;
          }>(
            `SELECT id, base_salary, admission_date, worker_id
             FROM public.contracts 
             WHERE id = $1 AND status = 'ACTIVE';`,
            [contractId]
          );

          if (rows.length === 0) {
            throw new Error('CONTRACT_NOT_FOUND');
          }

          const contract = rows[0];

          return {
            contractId: contract.id,
            resignationDate,
            dismissalType,
            noticeType,
            baseSalary: contract.base_salary,
            admissionDate: contract.admission_date,
            status: 'SIMULATED',
          };
        });

        return reply.send({
          success: true,
          data: result,
        });
      } catch (err: any) {
        if (err.message === 'CONTRACT_NOT_FOUND') {
          return reply.status(404).send({ success: false, error: 'Contrato ativo não localizado.' });
        }
        return reply.status(500).send({ success: false, error: 'Erro ao simular rescisão.' });
      }
    }
  );
};
