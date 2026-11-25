import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';

const updateSettingsSchema = z.object({
  sessionTimeoutMinutes: z.number().int().min(5).max(1440).optional(),
  mfaEnforcement: z.enum(['OPTIONAL', 'REQUIRED_ALL', 'REQUIRED_ADMINS']).optional(),
  allowedOrigins: z.array(z.string()).optional(),
  customBranding: z.record(z.any()).optional(),
});

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // 1. Configurações Gerais do Tenant
  app.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

    const settings = await request.withContext(async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, status, settings, created_at, updated_at
         FROM public.tenants
         WHERE id = $1::uuid;`,
        [request.user!.tenant_id]
      );
      return rows[0] || null;
    });

    return reply.send({ success: true, data: settings });
  });

  // 2. Atualização das Configurações do Tenant
  app.put('/', { preHandler: [authenticate, requirePermission('manage_settings')] }, async (request, reply) => {
    const parse = updateSettingsSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });

    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

    const updated = await request.withContext(async (client) => {
      const { rows } = await client.query(
        `UPDATE public.tenants
         SET settings = settings || $1::jsonb,
             updated_at = NOW()
         WHERE id = $2::uuid
         RETURNING id, name, status, settings, updated_at;`,
        [JSON.stringify(parse.data), request.user!.tenant_id]
      );
      return rows[0];
    });

    return reply.send({ success: true, message: 'Configurações atualizadas com sucesso.', data: updated });
  });

  // 3. Parâmetros Legais (Tabelas INSS, IRRF e Salário Mínimo Vigentes)
  app.get('/legal-parameters', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

    const params = await request.withContext(async (client) => {
      const { rows: versions } = await client.query(
        `SELECT * FROM public.legal_versions
         WHERE is_active = TRUE
         ORDER BY valid_from DESC
         LIMIT 1;`
      );
      const version = versions[0] || null;
      if (!version) {
        return { version: null, inss: [], irrf: [], general: null };
      }

      const { rows: inss } = await client.query(
        `SELECT * FROM public.inss_parameters
         WHERE legal_version_id = $1::uuid
         ORDER BY bracket_number ASC;`,
        [version.id]
      );
      const { rows: irrf } = await client.query(
        `SELECT * FROM public.irrf_parameters
         WHERE legal_version_id = $1::uuid
         ORDER BY bracket_number ASC;`,
        [version.id]
      );
      const { rows: general } = await client.query(
        `SELECT * FROM public.general_legal_parameters
         WHERE legal_version_id = $1::uuid
         LIMIT 1;`,
        [version.id]
      );

      return { version, inss, irrf, general: general[0] || null };
    });

    return reply.send({ success: true, data: params });
  });
};
