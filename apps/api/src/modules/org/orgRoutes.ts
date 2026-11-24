import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';

const companySchema = z.object({
  corporateName: z.string().min(2, 'Razão social obrigatória.'),
  tradeName: z.string().optional().nullable(),
  cnpj: z.string().min(14, 'CNPJ inválido.'),
  legalNature: z.string().optional().nullable(),
  primaryCnae: z.string().optional().nullable(),
  taxRegime: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
});

const establishmentSchema = z.object({
  companyId: z.string().uuid('ID da empresa inválido.'),
  name: z.string().min(2, 'Nome do estabelecimento obrigatório.'),
  cnpj: z.string().min(14, 'CNPJ inválido.'),
  address: z.string().optional().nullable(),
});

const departmentSchema = z.object({
  companyId: z.string().uuid('ID da empresa inválido.').optional().nullable(),
  name: z.string().min(2, 'Nome do departamento obrigatório.'),
  code: z.string().optional().nullable(),
  costCenterCode: z.string().optional().nullable(),
});

const positionSchema = z.object({
  companyId: z.string().uuid('ID da empresa inválido.').optional().nullable(),
  title: z.string().min(2, 'Título do cargo obrigatório.'),
  cbo: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  level: z.string().optional().nullable(),
});

const costCenterSchema = z.object({
  companyId: z.string().uuid('ID da empresa inválido.').optional().nullable(),
  code: z.string().min(1, 'Código é obrigatório.'),
  name: z.string().min(2, 'Nome do centro de custo é obrigatório.'),
});

const workplaceSchema = z.object({
  companyId: z.string().uuid('ID da empresa inválido.'),
  costCenterId: z.string().uuid().optional().nullable(),
  name: z.string().min(2, 'Nome do local é obrigatório.'),
  address: z.string().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  radiusMeters: z.number().int().default(50),
  enforceGeofence: z.boolean().default(false),
  wifiBssid: z.string().optional().nullable(),
});

export const orgRoutes: FastifyPluginAsync = async (app) => {
  // 1. EMPRESAS (Companies)
  app.get('/companies', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const result = await request.withContext(async (client) => {
      const { rows } = await client.query('SELECT * FROM public.companies WHERE deleted_at IS NULL ORDER BY corporate_name;');
      return rows;
    });
    return reply.send({ success: true, data: result });
  });

  app.post('/companies', { preHandler: [authenticate, requirePermission('manage_companies')] }, async (request, reply) => {
    const parse = companySchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    const d = parse.data;

    const created = await request.withContext!(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.companies (tenant_id, corporate_name, trade_name, cnpj, legal_nature, primary_cnae, tax_regime, address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;`,
        [request.user!.tenant_id, d.corporateName, d.tradeName, d.cnpj, d.legalNature, d.primaryCnae, d.taxRegime, d.address]
      );
      return rows[0];
    });
    return reply.status(201).send({ success: true, data: created });
  });

  // 2. ESTABELECIMENTOS (Establishments)
  app.get('/establishments', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const result = await request.withContext(async (client) => {
      const { rows } = await client.query('SELECT * FROM public.establishments WHERE deleted_at IS NULL ORDER BY name;');
      return rows;
    });
    return reply.send({ success: true, data: result });
  });

  app.post('/establishments', { preHandler: [authenticate, requirePermission('manage_org_structure')] }, async (request, reply) => {
    const parse = establishmentSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    const d = parse.data;

    const created = await request.withContext!(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.establishments (tenant_id, company_id, name, cnpj, address)
         VALUES ($1, $2, $3, $4, $5) RETURNING *;`,
        [request.user!.tenant_id, d.companyId, d.name, d.cnpj, d.address]
      );
      return rows[0];
    });
    return reply.status(201).send({ success: true, data: created });
  });

  // 3. DEPARTAMENTOS (Departments)
  app.get('/departments', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const result = await request.withContext(async (client) => {
      const { rows } = await client.query('SELECT * FROM public.departments WHERE deleted_at IS NULL ORDER BY name;');
      return rows;
    });
    return reply.send({ success: true, data: result });
  });

  app.post('/departments', { preHandler: [authenticate, requirePermission('manage_org_structure')] }, async (request, reply) => {
    const parse = departmentSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    const d = parse.data;

    const created = await request.withContext!(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.departments (tenant_id, company_id, name, code, cost_center_code)
         VALUES ($1, $2, $3, $4, $5) RETURNING *;`,
        [request.user!.tenant_id, d.companyId, d.name, d.code, d.costCenterCode]
      );
      return rows[0];
    });
    return reply.status(201).send({ success: true, data: created });
  });

  // 4. CARGOS (Positions)
  app.get('/positions', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const result = await request.withContext(async (client) => {
      const { rows } = await client.query('SELECT * FROM public.positions WHERE deleted_at IS NULL ORDER BY title;');
      return rows;
    });
    return reply.send({ success: true, data: result });
  });

  app.post('/positions', { preHandler: [authenticate, requirePermission('manage_org_structure')] }, async (request, reply) => {
    const parse = positionSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    const d = parse.data;

    const created = await request.withContext!(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.positions (tenant_id, company_id, title, cbo, description, level)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`,
        [request.user!.tenant_id, d.companyId, d.title, d.cbo, d.description, d.level]
      );
      return rows[0];
    });
    return reply.status(201).send({ success: true, data: created });
  });

  // 5. CENTROS DE CUSTO (Cost Centers)
  app.get('/cost-centers', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const result = await request.withContext(async (client) => {
      const { rows } = await client.query('SELECT * FROM public.cost_centers WHERE deleted_at IS NULL ORDER BY name;');
      return rows;
    });
    return reply.send({ success: true, data: result });
  });

  app.post('/cost-centers', { preHandler: [authenticate, requirePermission('manage_org_structure')] }, async (request, reply) => {
    const parse = costCenterSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    const d = parse.data;

    const created = await request.withContext!(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.cost_centers (tenant_id, company_id, code, name)
         VALUES ($1, $2, $3, $4) RETURNING *;`,
        [request.user!.tenant_id, d.companyId, d.code, d.name]
      );
      return rows[0];
    });
    return reply.status(201).send({ success: true, data: created });
  });

  // 6. LOCAIS DE TRABALHO / GEOFENCE (Workplaces)
  app.get('/workplaces', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const result = await request.withContext(async (client) => {
      const { rows } = await client.query('SELECT * FROM public.workplaces WHERE deleted_at IS NULL ORDER BY name;');
      return rows;
    });
    return reply.send({ success: true, data: result });
  });

  app.post('/workplaces', { preHandler: [authenticate, requirePermission('manage_org_structure')] }, async (request, reply) => {
    const parse = workplaceSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
    const d = parse.data;

    const created = await request.withContext!(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.workplaces (tenant_id, company_id, cost_center_id, name, address, latitude, longitude, radius_meters, enforce_geofence, wifi_bssid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *;`,
        [request.user!.tenant_id, d.companyId, d.costCenterId, d.name, d.address, d.latitude, d.longitude, d.radiusMeters, d.enforceGeofence, d.wifiBssid]
      );
      return rows[0];
    });
    return reply.status(201).send({ success: true, data: created });
  });

  // 7. TIPOS DE CONTRATO (Contract Types)
  app.get('/contract-types', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const result = await request.withContext(async (client) => {
      const { rows } = await client.query('SELECT * FROM public.contract_types ORDER BY name;');
      return rows;
    });
    return reply.send({ success: true, data: result });
  });

  // 8. ESCALAS DE TRABALHO (Work Shifts)
  app.get('/work-shifts', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    const result = await request.withContext(async (client) => {
      const { rows } = await client.query('SELECT * FROM public.work_shifts ORDER BY name;');
      return rows;
    });
    return reply.send({ success: true, data: result });
  });
};
