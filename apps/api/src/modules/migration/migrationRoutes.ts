import { FastifyPluginAsync } from 'fastify';
import { authenticate, requireAdminRole } from '../auth/authMiddleware.js';
import { MigrationTemplateService } from './templateService.js';
import { MigrationService } from './migrationService.js';

const templateService = new MigrationTemplateService();
const migrationService = new MigrationService();

export const migrationRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /templates
   * Lista todos os modelos de planilhas oficiais e o guia do RH disponíveis para download
   */
  app.get('/templates', { preHandler: [authenticate, requireAdminRole] }, async (_request, reply) => {
    try {
      const templates = templateService.listTemplates();
      return reply.send({
        success: true,
        templates,
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        error: err.message || 'Erro ao listar modelos de importação.',
      });
    }
  });

  /**
   * GET /templates/:key
   * Download direto do modelo oficial formatado com UTF-8 BOM para Excel PT-BR
   */
  app.get('/templates/:key', { preHandler: [authenticate, requireAdminRole] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    try {
      const { content, info } = templateService.getTemplateContent(key);

      reply.header('Content-Type', info.mimeType);
      reply.header('Content-Disposition', `attachment; filename="${info.filename}"`);
      reply.header('Content-Length', content.length);
      return reply.send(content);
    } catch (err: any) {
      return reply.status(404).send({
        success: false,
        error: err.message || `Modelo "${key}" não encontrado.`,
      });
    }
  });

  /**
   * POST /preview
   * Dry-Run da carga histórica externa com validação sintática, consistência contábil e relatório de reconciliação
   */
  app.post('/preview', { preHandler: [authenticate, requireAdminRole] }, async (request, reply) => {
    const user = request.user;
    if (!user || !request.withContext) {
      return reply.status(401).send({ success: false, error: 'Acesso não autenticado.' });
    }

    let rawWorkersCsv: string | undefined;
    let rawHistoryCsv: string | undefined;
    let rawVacationsCsv: string | undefined;
    let rawLeavesCsv: string | undefined;
    let rawTimeBankCsv: string | undefined;
    let rawLoansAndDebtsCsv: string | undefined;
    const esocialXmls: string[] = [];

    if (request.isMultipart()) {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          const str = buf.toString('utf8');
          const fname = (part.filename || '').toLowerCase();

          if (fname.endsWith('.xml')) {
            esocialXmls.push(str);
          } else if (fname.includes('ferias') || fname.includes('aquisitivo') || part.fieldname === 'vacations') {
            rawVacationsCsv = str;
          } else if (fname.includes('afastamento') || fname.includes('licenca') || part.fieldname === 'leaves') {
            rawLeavesCsv = str;
          } else if (fname.includes('banco') || fname.includes('horas') || part.fieldname === 'timeBank') {
            rawTimeBankCsv = str;
          } else if (fname.includes('consignado') || fname.includes('emprestimo') || fname.includes('debito') || part.fieldname === 'loansAndDebts') {
            rawLoansAndDebtsCsv = str;
          } else if (fname.includes('colaborador') || fname.includes('contrato') || part.fieldname === 'workers') {
            rawWorkersCsv = str;
          } else if (fname.includes('historico') || fname.includes('folha') || fname.includes('ficha') || part.fieldname === 'history') {
            rawHistoryCsv = str;
          } else {
            // Heurística de cabeçalhos
            if (str.includes('limite_concessivo') || str.includes('dias_direito')) {
              rawVacationsCsv = str;
            } else if (str.includes('codigo_motivo_esocial') || str.includes('cid10_sigiloso')) {
              rawLeavesCsv = str;
            } else if (str.includes('saldo_minutos_liquido') || str.includes('saldo_horas_hhmm')) {
              rawTimeBankCsv = str;
            } else if (str.includes('saldo_restante_debito') || str.includes('instituicao_financeira')) {
              rawLoansAndDebtsCsv = str;
            } else if (str.includes('salario_base') || str.includes('matricula')) {
              rawWorkersCsv = str;
            } else if (str.includes('tipo_folha') || str.includes('codigo_rubrica')) {
              rawHistoryCsv = str;
            }
          }
        } else {
          // Campos normais
          if (part.fieldname === 'rawWorkersCsv') rawWorkersCsv = String(part.value);
          if (part.fieldname === 'rawHistoryCsv') rawHistoryCsv = String(part.value);
          if (part.fieldname === 'rawVacationsCsv') rawVacationsCsv = String(part.value);
          if (part.fieldname === 'rawLeavesCsv') rawLeavesCsv = String(part.value);
          if (part.fieldname === 'rawTimeBankCsv') rawTimeBankCsv = String(part.value);
          if (part.fieldname === 'rawLoansAndDebtsCsv') rawLoansAndDebtsCsv = String(part.value);
        }
      }
    } else {
      const body = (request.body || {}) as {
        rawWorkersCsv?: string;
        rawHistoryCsv?: string;
        rawVacationsCsv?: string;
        rawLeavesCsv?: string;
        rawTimeBankCsv?: string;
        rawLoansAndDebtsCsv?: string;
        esocialXmls?: string[];
      };
      rawWorkersCsv = body.rawWorkersCsv;
      rawHistoryCsv = body.rawHistoryCsv;
      rawVacationsCsv = body.rawVacationsCsv;
      rawLeavesCsv = body.rawLeavesCsv;
      rawTimeBankCsv = body.rawTimeBankCsv;
      rawLoansAndDebtsCsv = body.rawLoansAndDebtsCsv;
      if (body.esocialXmls) {
        esocialXmls.push(...body.esocialXmls);
      }
    }

    try {
      const tenantId = user.tenant_id;
      if (!tenantId) {
        return reply.status(400).send({ success: false, error: 'Tenant ID obrigatório na sessão' });
      }

      const preview = await request.withContext(async (client) => {
        return migrationService.previewMigration(client, tenantId, {
          rawWorkersCsv,
          rawHistoryCsv,
          rawVacationsCsv,
          rawLeavesCsv,
          rawTimeBankCsv,
          rawLoansAndDebtsCsv,
          esocialXmls,
        });
      });

      return reply.send({
        success: true,
        preview,
      });
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err.message || 'Erro durante a prévia de importação.',
      });
    }
  });

  /**
   * POST /execute
   * Efetivação atômica e idempotente da carga histórica no PostgreSQL 17 sob RLS
   */
  app.post('/execute', { preHandler: [authenticate, requireAdminRole] }, async (request, reply) => {
    const user = request.user;
    if (!user || !request.withContext) {
      return reply.status(401).send({ success: false, error: 'Acesso não autenticado.' });
    }

    let rawWorkersCsv: string | undefined;
    let rawHistoryCsv: string | undefined;
    let rawVacationsCsv: string | undefined;
    let rawLeavesCsv: string | undefined;
    let rawTimeBankCsv: string | undefined;
    let rawLoansAndDebtsCsv: string | undefined;
    const esocialXmls: string[] = [];

    if (request.isMultipart()) {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          const str = buf.toString('utf8');
          const fname = (part.filename || '').toLowerCase();

          if (fname.endsWith('.xml')) {
            esocialXmls.push(str);
          } else if (fname.includes('ferias') || fname.includes('aquisitivo') || part.fieldname === 'vacations') {
            rawVacationsCsv = str;
          } else if (fname.includes('afastamento') || fname.includes('licenca') || part.fieldname === 'leaves') {
            rawLeavesCsv = str;
          } else if (fname.includes('banco') || fname.includes('horas') || part.fieldname === 'timeBank') {
            rawTimeBankCsv = str;
          } else if (fname.includes('consignado') || fname.includes('emprestimo') || fname.includes('debito') || part.fieldname === 'loansAndDebts') {
            rawLoansAndDebtsCsv = str;
          } else if (fname.includes('colaborador') || fname.includes('contrato') || part.fieldname === 'workers') {
            rawWorkersCsv = str;
          } else if (fname.includes('historico') || fname.includes('folha') || fname.includes('ficha') || part.fieldname === 'history') {
            rawHistoryCsv = str;
          } else {
            if (str.includes('limite_concessivo') || str.includes('dias_direito')) {
              rawVacationsCsv = str;
            } else if (str.includes('codigo_motivo_esocial') || str.includes('cid10_sigiloso')) {
              rawLeavesCsv = str;
            } else if (str.includes('saldo_minutos_liquido') || str.includes('saldo_horas_hhmm')) {
              rawTimeBankCsv = str;
            } else if (str.includes('saldo_restante_debito') || str.includes('instituicao_financeira')) {
              rawLoansAndDebtsCsv = str;
            } else if (str.includes('salario_base') || str.includes('matricula')) {
              rawWorkersCsv = str;
            } else if (str.includes('tipo_folha') || str.includes('codigo_rubrica')) {
              rawHistoryCsv = str;
            }
          }
        } else {
          if (part.fieldname === 'rawWorkersCsv') rawWorkersCsv = String(part.value);
          if (part.fieldname === 'rawHistoryCsv') rawHistoryCsv = String(part.value);
          if (part.fieldname === 'rawVacationsCsv') rawVacationsCsv = String(part.value);
          if (part.fieldname === 'rawLeavesCsv') rawLeavesCsv = String(part.value);
          if (part.fieldname === 'rawTimeBankCsv') rawTimeBankCsv = String(part.value);
          if (part.fieldname === 'rawLoansAndDebtsCsv') rawLoansAndDebtsCsv = String(part.value);
        }
      }
    } else {
      const body = (request.body || {}) as {
        rawWorkersCsv?: string;
        rawHistoryCsv?: string;
        rawVacationsCsv?: string;
        rawLeavesCsv?: string;
        rawTimeBankCsv?: string;
        rawLoansAndDebtsCsv?: string;
        esocialXmls?: string[];
      };
      rawWorkersCsv = body.rawWorkersCsv;
      rawHistoryCsv = body.rawHistoryCsv;
      rawVacationsCsv = body.rawVacationsCsv;
      rawLeavesCsv = body.rawLeavesCsv;
      rawTimeBankCsv = body.rawTimeBankCsv;
      rawLoansAndDebtsCsv = body.rawLoansAndDebtsCsv;
      if (body.esocialXmls) {
        esocialXmls.push(...body.esocialXmls);
      }
    }

    try {
      const tenantId = user.tenant_id;
      if (!tenantId) {
        return reply.status(400).send({ success: false, error: 'Tenant ID obrigatório na sessão' });
      }

      const result = await request.withContext(async (client) => {
        return migrationService.executeMigration(client, tenantId, {
          rawWorkersCsv,
          rawHistoryCsv,
          rawVacationsCsv,
          rawLeavesCsv,
          rawTimeBankCsv,
          rawLoansAndDebtsCsv,
          esocialXmls,
        });
      });

      return reply.send({
        success: true,
        result,
      });
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err.message || 'Erro ao efetivar a carga histórica.',
      });
    }
  });
};
