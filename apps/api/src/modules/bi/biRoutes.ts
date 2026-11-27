import { FastifyPluginAsync } from 'fastify';
import { authenticate, requireAdminRole } from '../auth/authMiddleware.js';
import { BiService } from './BiService.js';

export const biRoutes: FastifyPluginAsync = async (app) => {
  const biService = new BiService();

  // 1. Dashboard Executivo Completo de BI & Custos Reais da Empresa
  app.get(
    '/dashboard-executive',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const user = (request as any).user;
      const query = request.query as { company_id?: string };

      try {
        const data = await request.withContext(async (client) => {
          return biService.getExecutiveDashboard(client, user.tenant_id, query.company_id);
        });

        return reply.send({ success: true, data });
      } catch (err: any) {
        request.log.error(err, '[BI_DASHBOARD_EXECUTIVE] Falha ao carregar dashboard executivo');
        return reply.status(500).send({
          success: false,
          error: 'Erro interno ao consultar indicadores de BI executivo.',
        });
      }
    }
  );

  // 2. Radar de Risco Trabalhista (Art. 137, Art. 66, Art. 71, Art. 59, Banco Excedente)
  app.get(
    '/labor-risk-radar',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const user = (request as any).user;
      const query = request.query as { company_id?: string; article?: string };

      try {
        const fullData = await request.withContext(async (client) => {
          return biService.getExecutiveDashboard(client, user.tenant_id, query.company_id);
        });

        let risks = fullData.laborRiskRadar.risks;
        if (query.article) {
          risks = risks.filter((r) => r.article === query.article);
        }

        return reply.send({
          success: true,
          data: {
            summary: fullData.laborRiskRadar,
            risks,
          },
        });
      } catch (err: any) {
        request.log.error(err, '[BI_LABOR_RISK] Falha ao consultar radar de riscos');
        return reply.status(500).send({
          success: false,
          error: 'Erro ao consultar radar de risco trabalhista.',
        });
      }
    }
  );

  // 3. Endpoint Legado mantido para compatibilidade
  app.get(
    '/dashboard',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const user = (request as any).user;
      try {
        const fullData = await request.withContext(async (client) => {
          return biService.getExecutiveDashboard(client, user.tenant_id);
        });

        return reply.send({
          success: true,
          data: {
            contracts: {
              active: fullData.stats.activeEmployees,
              inactive: 0,
              suspended: fullData.stats.suspendedEmployees,
              vacation: fullData.stats.vacationEmployees,
              averageSalary: Math.round(fullData.costs.grossPayrollCents / Math.max(1, fullData.stats.activeEmployees) / 100),
              totalPayrollBase: fullData.costs.grossPayrollCents / 100,
            },
            timeTracking: {
              punchesMonth: 0,
            },
            fullExecutive: fullData,
          },
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
