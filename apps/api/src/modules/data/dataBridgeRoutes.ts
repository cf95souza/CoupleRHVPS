import { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../auth/authMiddleware.js';

const ALLOWED_TABLES = new Set([
  'companies',
  'establishments',
  'departments',
  'sectors',
  'positions',
  'cost_centers',
  'workplaces',
  'contract_types',
  'holidays',
  'workers',
  'contracts',
  'dependents',
  'leaves',
  'vacation_periods',
  'vacation_schedules',
  'terminations',
  'work_shifts',
  'time_devices',
  'time_punch_records',
  'time_punch_daily_summaries',
  'time_bank_accounts',
  'time_bank_transactions',
  'inss_parameters',
  'irrf_parameters',
  'general_legal_parameters',
  'benefit_catalogs',
  'employee_benefits',
  'rubrics',
  'payroll_periods',
  'payroll_variable_events',
  'payroll_fixed_events',
  'payslips',
  'payslip_items',
  'employee_documents',
  'tenants',
  'tenant_users',
]);

const ALLOWED_RPC = new Set([
  'calculate_payroll_period',
  'close_payroll_period',
  'reopen_payroll_period',
  'register_time_punch',
  'generate_vacation_periods',
  'update_tenant_user_access',
  'can_access_contract',
  'has_permission',
]);

export const dataBridgeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // 1. Consulta Tipada a Tabelas do Banco de Dados com RLS Ativo
  app.get('/data/:table', async (request, reply) => {
    const { table } = request.params as { table: string };

    if (!ALLOWED_TABLES.has(table)) {
      return reply.status(403).send({
        success: false,
        code: 'TABLE_ACCESS_DENIED',
        error: `Acesso à tabela '${table}' não permitido pela política de segurança.`,
      });
    }

    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const query = request.query as Record<string, any>;
    const selectParam = typeof query.select === 'string' && query.select.length > 0 ? query.select : '*';
    const limitParam = Math.min(1000, Math.max(1, parseInt(query.limit || '100', 10)));

    // Sanitiza colunas no SELECT (permite apenas caracteres alfanuméricos, underscores e vírgulas)
    const sanitizedSelect = selectParam === '*' ? '*' : selectParam.replace(/[^a-zA-Z0-9_,\s]/g, '');

    // Extrai filtros simples (ex.: status=ACTIVE ou status=eq.ACTIVE)
    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    Object.entries(query).forEach(([k, v]) => {
      if (['select', 'order', 'limit', 'offset'].includes(k)) return;
      // Sanitiza nome da coluna
      const colName = k.replace(/[^a-zA-Z0-9_]/g, '');
      if (!colName) return;

      let val = String(v);
      let op = '=';

      if (val.startsWith('eq.')) {
        val = val.substring(3);
      } else if (val.startsWith('neq.')) {
        op = '<>';
        val = val.substring(4);
      } else if (val.startsWith('ilike.')) {
        op = 'ILIKE';
        val = `%${val.substring(6)}%`;
      }

      conditions.push(`"${colName}" ${op} $${idx}`);
      values.push(val);
      idx++;
    });

    // Ordenação
    let orderByClause = '';
    if (query.order && typeof query.order === 'string') {
      const [orderCol, orderDir] = query.order.split(':');
      const cleanCol = (orderCol || '').replace(/[^a-zA-Z0-9_]/g, '');
      const cleanDir = orderDir?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      if (cleanCol) {
        orderByClause = `ORDER BY "${cleanCol}" ${cleanDir}`;
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT ${sanitizedSelect} FROM public."${table}" ${whereClause} ${orderByClause} LIMIT $${idx};`;
    values.push(limitParam);

    try {
      const rows = await request.withContext(async (client) => {
        const { rows: result } = await client.query(sql, values);
        return result;
      });

      return reply.send({
        success: true,
        data: rows,
        count: rows.length,
      });
    } catch (err: any) {
      request.log.error(err, `[DATA_BRIDGE] Erro na consulta da tabela ${table}`);
      return reply.status(500).send({
        success: false,
        error: `Erro ao consultar tabela ${table}: ${err.message}`,
      });
    }
  });

  // 2. Inserção Segura via Data Bridge
  app.post('/data/:table', async (request, reply) => {
    const { table } = request.params as { table: string };

    if (!ALLOWED_TABLES.has(table)) {
      return reply.status(403).send({ success: false, error: 'Acesso negado à tabela.' });
    }

    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const body = request.body as Record<string, any>;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ success: false, error: 'Corpo da requisição inválido.' });
    }

    // Injeta tenant_id do contexto autenticado
    const dataToInsert: Record<string, any> = { ...body, tenant_id: request.user!.tenant_id };
    const cols = Object.keys(dataToInsert).map((k) => k.replace(/[^a-zA-Z0-9_]/g, ''));
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const vals = cols.map((c) => dataToInsert[c]);

    const sql = `INSERT INTO public."${table}" (${cols.map((c) => `"${c}"`).join(', ')})
                 VALUES (${placeholders.join(', ')})
                 RETURNING *;`;

    try {
      const created = await request.withContext(async (client) => {
        const { rows } = await client.query(sql, vals);
        return rows[0];
      });

      return reply.status(201).send({ success: true, data: created });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err.message });
    }
  });

  // 3. Execução Controlada de RPC (Funções do Banco)
  app.post('/rpc/:functionName', async (request, reply) => {
    const { functionName } = request.params as { functionName: string };

    if (!ALLOWED_RPC.has(functionName)) {
      return reply.status(403).send({
        success: false,
        code: 'RPC_NOT_ALLOWED',
        error: `Execução da função '${functionName}' não autorizada.`,
      });
    }

    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const body = (request.body as Record<string, any>) || {};

    try {
      const result = await request.withContext(async (client) => {
        // Constrói chamada SQL para a função
        const keys = Object.keys(body);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `SELECT public."${functionName}"(${placeholders}) AS res;`;
        const { rows } = await client.query(sql, Object.values(body));
        return rows[0]?.res;
      });

      return reply.send({ success: true, data: result });
    } catch (err: any) {
      request.log.error(err, `[RPC_BRIDGE] Erro ao executar ${functionName}`);
      return reply.status(400).send({
        success: false,
        error: err.message || 'Erro na execução da função remota.',
      });
    }
  });
};
