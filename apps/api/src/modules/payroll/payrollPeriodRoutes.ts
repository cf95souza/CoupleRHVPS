import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdminRole, requirePermission, requireAnyPermission } from '../auth/authMiddleware.js';
import { calculatePayrollPeriod } from './payrollCalculationService.js';
import { addMoney, round2, sumMoney } from '@couplerh/payroll-core';

const calculatePayrollSchema = z.object({
  period_id: z.string().uuid('ID do período inválido.'),
  contract_id: z.string().uuid().optional().nullable(),
});

const closePayrollSchema = z.object({
  notes: z.string().optional(),
});

const reopenPayrollSchema = z.object({
  reason: z.string().min(15, 'A justificativa de reabertura deve conter no mínimo 15 caracteres.'),
});

export const payrollPeriodRoutes: FastifyPluginAsync = async (app) => {
  // Processamento Oficial do Motor de Cálculo de Folha (PostgreSQL 17 + @couplerh/payroll-core)
  app.post(
    '/calculate',
    { preHandler: [authenticate, requireAdminRole, requirePermission('calculate_payroll')] },
    async (request, reply) => {
      const parse = calculatePayrollSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros inválidos para cálculo da folha.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          return calculatePayrollPeriod(client, {
            tenantId: request.user!.tenant_id!,
            periodId: parse.data.period_id,
            contractIdFilter: parse.data.contract_id || null,
          });
        });

        if (!result.success) {
          return reply.status(result.httpStatus || 422).send(result);
        }

        return reply.send(result);
      } catch (err: any) {
        request.log.error(err, '[PAYROLL_CALCULATE] Erro ao calcular folha');
        return reply.status(400).send({
          success: false,
          error: err.message || 'Erro ao processar folha de pagamento.',
        });
      }
    }
  );

  // Guias Tributárias Consolidadas (BUG-09: seleciona ps.id e usa fgts_month real)
  app.get(
    '/periods/:id/tax-guides',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll_accounting', 'calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT id, company_id, month, year, status FROM public.payroll_periods WHERE id = $1::uuid;`,
          [id]
        );
        if (pRows.length === 0) return null;
        const period = pRows[0];

        const { rows: payslips } = await client.query(
          `SELECT id, contract_id, base_inss, base_fgts, base_irrf, fgts_month, total_earnings, total_deductions, net_salary
           FROM public.payslips
           WHERE payroll_period_id = $1::uuid;`,
          [id]
        );

        const payslipIds = payslips.map((p: any) => p.id);
        let inssEmpregados = 0;
        let irrfEmpregados = 0;

        if (payslipIds.length > 0) {
          const { rows: items } = await client.query(
            `SELECT rubric_code, amount
             FROM public.payslip_items
             WHERE payslip_id = ANY($1::uuid[])
               AND rubric_code IN ('901', '902');`,
            [payslipIds]
          );
          for (const it of items) {
            if (it.rubric_code === '901') inssEmpregados = addMoney(inssEmpregados, Number(it.amount || 0));
            if (it.rubric_code === '902') irrfEmpregados = addMoney(irrfEmpregados, Number(it.amount || 0));
          }
        }

        const { rows: taxRows } = await client.query(
          `SELECT * FROM public.payroll_company_taxes WHERE payroll_period_id = $1::uuid LIMIT 1;`,
          [id]
        );
        const companyTax = taxRows[0] || null;

        const totalBaseInss = sumMoney(payslips.map((p: any) => Number(p.base_inss || 0)));
        const totalBaseFgts = sumMoney(payslips.map((p: any) => Number(p.base_fgts || 0)));
        const totalBaseIrrf = sumMoney(payslips.map((p: any) => Number(p.base_irrf || 0)));
        const fgtsTotalReal = sumMoney(payslips.map((p: any) => Number(p.fgts_month || 0)));

        const inssPatronal = Number(companyTax?.inss_patronal || 0);
        const ratAmount = Number(companyTax?.rat_amount || 0);
        const terceirosAmount = Number(companyTax?.other_entities_amount || 0);
        const totalDarfInss = sumMoney([inssEmpregados, inssPatronal, ratAmount, terceirosAmount]);

        return {
          period,
          payslipsCount: payslips.length,
          totalBaseInss,
          totalBaseFgts,
          totalBaseIrrf,
          inssEmpregados,
          irrfEmpregados,
          fgtsTotal: fgtsTotalReal,
          inssPatronal,
          ratAmount,
          terceirosAmount,
          totalDarfPrevidenciario: round2(totalDarfInss),
          totalDarfIrrf: round2(irrfEmpregados),
          totalFgtsDigital: round2(fgtsTotalReal),
        };
      });

      if (!data) {
        return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      }

      return reply.send({ success: true, data });
    }
  );

  // Pré-auditoria de Folha (BUG-09: usa tabela public.leaves filtrando por company_id)
  app.get(
    '/periods/:id/pre-flight-audit',
    { preHandler: [authenticate, requireAnyPermission(['calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const { rows: pRows } = await client.query(
          `SELECT id, company_id, month, year FROM public.payroll_periods WHERE id = $1::uuid;`,
          [id]
        );
        if (pRows.length === 0) return null;
        const period = pRows[0];
        const startOfMonth = `${period.year}-${String(period.month).padStart(2, '0')}-01`;
        const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
        const endOfMonth = `${period.year}-${String(period.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        const { rows: activeLeaves } = await client.query(
          `SELECT l.id, l.contract_id, l.leave_type, l.start_date, l.end_date
           FROM public.leaves l
           JOIN public.contracts c ON c.id = l.contract_id
           WHERE c.company_id = $1::uuid
             AND l.status = 'ACTIVE'
             AND l.start_date <= $2::date
             AND (l.end_date IS NULL OR l.end_date >= $3::date);`,
          [period.company_id, endOfMonth, startOfMonth]
        );

        return {
          period,
          activeLeavesCount: activeLeaves.length,
          activeLeaves,
        };
      });

      if (!data) {
        return reply.status(404).send({ success: false, error: 'Período não encontrado.' });
      }

      return reply.send({ success: true, data });
    }
  );

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
