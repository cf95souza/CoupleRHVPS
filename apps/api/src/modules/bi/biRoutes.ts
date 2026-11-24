import { FastifyPluginAsync } from 'fastify';
import { authenticate, requireAdminRole } from '../auth/authMiddleware.js';

export const biRoutes: FastifyPluginAsync = async (app) => {
  // Dashboard Executivo de BI e Métricas de Folha (Protegido para RH e Admin)
  app.get(
    '/dashboard',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const metrics = await request.withContext(async (client) => {
          // Estatísticas no escopo seguro do tenant ativo (RLS)
          const { rows: contractStats } = await client.query(`
            SELECT 
              count(*) FILTER (WHERE status = 'ACTIVE') AS active_contracts,
              count(*) FILTER (WHERE status = 'INACTIVE') AS inactive_contracts,
              count(*) FILTER (WHERE status = 'SUSPENDED') AS suspended_contracts,
              count(*) FILTER (WHERE status = 'VACATION') AS vacation_contracts,
              COALESCE(avg(base_salary) FILTER (WHERE status = 'ACTIVE'), 0) AS average_salary,
              COALESCE(sum(base_salary) FILTER (WHERE status = 'ACTIVE'), 0) AS total_payroll_base
            FROM public.contracts;
          `);

          const { rows: punchStats } = await client.query(`
            SELECT count(*) AS total_punches_month
            FROM public.time_punch_records
            WHERE punched_at >= date_trunc('month', CURRENT_DATE);
          `);

          return {
            contracts: {
              active: parseInt(contractStats[0]?.active_contracts || '0', 10),
              inactive: parseInt(contractStats[0]?.inactive_contracts || '0', 10),
              suspended: parseInt(contractStats[0]?.suspended_contracts || '0', 10),
              vacation: parseInt(contractStats[0]?.vacation_contracts || '0', 10),
              averageSalary: parseFloat(contractStats[0]?.average_salary || '0'),
              totalPayrollBase: parseFloat(contractStats[0]?.total_payroll_base || '0'),
            },
            timeTracking: {
              punchesMonth: parseInt(punchStats[0]?.total_punches_month || '0', 10),
            },
          };
        });

        return reply.send({
          success: true,
          data: metrics,
        });
      } catch (err: any) {
        request.log.error(err, '[BI_DASHBOARD] Falha ao carregar métricas de BI');
        return reply.status(500).send({
          success: false,
          error: 'Erro interno ao consultar indicadores de BI.',
        });
      }
    }
  );
};
