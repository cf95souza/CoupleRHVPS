import crypto from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/authMiddleware.js';
import { dbPool } from '../../shared/db/pool.js';
import { withTenantContext } from '../../shared/db/context.js';

const mobilePunchSchema = z.object({
  workerId: z.string().uuid(),
  punchType: z.enum(['ENTRY', 'INTERVAL_START', 'INTERVAL_END', 'EXIT']).default('ENTRY'),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  accuracy: z.number().optional(),
  isMockLocation: z.boolean().default(false),
  deviceFingerprint: z.string().optional(),
  sha256Hash: z.string().optional(),
});

const repIngestSchema = z.object({
  records: z.array(
    z.object({
      nsr: z.number().int().positive(),
      pis: z.string().min(11).max(14),
      punchedAt: z.string(),
      punchType: z.enum(['ENTRY', 'INTERVAL_START', 'INTERVAL_END', 'EXIT']).optional(),
      sha256Hash: z.string().optional(),
    })
  ).min(1, 'Lote deve conter pelo menos uma batida.'),
});

export const timeTrackingRoutes: FastifyPluginAsync = async (app) => {
  // Ponto Mobile Seguro (Portal do Colaborador)
  app.post(
    '/mobile/punch',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parseResult = mobilePunchSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados de marcação inválidos.',
          details: parseResult.error.format(),
        });
      }

      const {
        workerId,
        punchType,
        latitude,
        longitude,
        accuracy,
        isMockLocation,
        deviceFingerprint,
        sha256Hash,
      } = parseResult.data;

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows } = await client.query(
            'SELECT public.register_mobile_punch($1, $2, $3, $4, $5, $6, $7, $8) AS res;',
            [
              workerId,
              punchType,
              latitude ?? null,
              longitude ?? null,
              accuracy ?? null,
              isMockLocation,
              deviceFingerprint ?? null,
              sha256Hash ?? null,
            ]
          );
          return rows[0]?.res;
        });

        return reply.send({
          success: true,
          data: result,
        });
      } catch (err: any) {
        request.log.warn(err, '[MOBILE_PUNCH] Erro no registro de ponto mobile');
        const message = err.message || 'Erro ao registrar ponto.';

        if (message.includes('Acesso negado') || message.includes('outro colaborador')) {
          return reply.status(403).send({
            success: false,
            code: 'FORBIDDEN_PUNCH_OWNERSHIP',
            error: message,
          });
        }

        if (message.includes('contrato de trabalho ativo') || message.includes('bloqueado')) {
          return reply.status(422).send({
            success: false,
            code: 'INACTIVE_CONTRACT',
            error: message,
          });
        }

        if (message.includes('nao localizado')) {
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

  // Ingestão Segura de Relógios Físicos REP com Autenticação de Dispositivo (timingSafeEqual) e Lookup em workers.pis_pasep
  app.post('/rep/ingest', async (request, reply) => {
    const serial = request.headers['x-rep-serial'] as string;
    const apiKey = request.headers['x-rep-api-key'] as string;

    if (!serial || !apiKey) {
      return reply.status(401).send({
        success: false,
        code: 'REP_AUTH_REQUIRED',
        error: 'Cabeçalhos x-rep-serial e x-rep-api-key são obrigatórios.',
      });
    }

    // 1. Busca dispositivo e hash cadastrado via função SECURITY DEFINER (lookup pré-tenant)
    const { rows: devRows } = await dbPool.query<{
      id: string;
      tenant_id: string;
      company_id: string;
      api_key_hash: string | null;
      status: string;
    }>(
      'SELECT id, tenant_id, company_id, api_key_hash, status FROM public.auth_get_rep_device_by_serial($1);',
      [serial.trim()]
    );

    if (devRows.length === 0 || devRows[0].status !== 'ACTIVE') {
      return reply.status(401).send({
        success: false,
        code: 'REP_DEVICE_UNKNOWN_OR_INACTIVE',
        error: 'Dispositivo REP não cadastrado ou inativo.',
      });
    }

    const device = devRows[0];
    if (!device.api_key_hash) {
      return reply.status(401).send({
        success: false,
        code: 'REP_NO_API_KEY_CONFIGURED',
        error: 'Chave de autenticação não configurada para este dispositivo.',
      });
    }

    // 2. Validação timing-safe da API Key
    const providedHash = crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
    const expectedHashBuf = Buffer.from(device.api_key_hash, 'utf-8');
    const providedHashBuf = Buffer.from(providedHash, 'utf-8');

    if (
      expectedHashBuf.length !== providedHashBuf.length ||
      !crypto.timingSafeEqual(expectedHashBuf, providedHashBuf)
    ) {
      return reply.status(401).send({
        success: false,
        code: 'REP_INVALID_CREDENTIALS',
        error: 'Chave de autenticação do coletor REP inválida.',
      });
    }

    // 3. Validação do lote de registros
    const parseResult = repIngestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'Estrutura do lote de ponto AFD inválida.',
        details: parseResult.error.format(),
      });
    }

    const { records } = parseResult.data;

    // 4. Ingestão transacional no escopo do tenant do dispositivo
    try {
      const summary = await withTenantContext(
        { tenantId: device.tenant_id, role: 'system_admin' },
        async (client) => {
          let processed = 0;
          let orphans = 0;

          for (const rec of records) {
            const cleanPis = rec.pis.replace(/\D/g, '');

            // Procura estritamente em workers.pis (garantindo saneamento do bug histórico)
            const { rows: workerRows } = await client.query<{ id: string; contract_id: string }>(
              `SELECT w.id, c.id AS contract_id
               FROM public.workers w
               LEFT JOIN public.contracts c ON c.worker_id = w.id AND c.status = 'ACTIVE'
               WHERE w.tenant_id = $1 
                 AND regexp_replace(COALESCE(w.pis, ''), '[^0-9]', '', 'g') = $2
               ORDER BY c.admission_date DESC
               LIMIT 1;`,
              [device.tenant_id, cleanPis]
            );

            const worker = workerRows[0];
            const workerId = worker ? worker.id : null;
            const contractId = worker ? worker.contract_id : null;

            if (!workerId) {
              orphans++;
            }

            const punchHash = rec.sha256Hash || crypto.createHash('sha256').update(
              `${device.tenant_id}:${serial}:${rec.nsr}:${rec.punchedAt}`
            ).digest('hex');

            await client.query(
              `INSERT INTO public.time_punch_records (
                tenant_id, company_id, contract_id, worker_id, device_id,
                nsr, record_type, punched_at, punch_type, source, sha256_hash
              ) VALUES ($1, $2, $3, $4, $5, $6, 3, $7, $8, 'REP', $9)
              ON CONFLICT (id) DO NOTHING;`,
              [
                device.tenant_id,
                device.company_id,
                contractId,
                workerId,
                device.id,
                rec.nsr,
                rec.punchedAt,
                rec.punchType || 'ENTRY',
                punchHash,
              ]
            );

            processed++;
          }

          // Atualiza último NSR do REP
          const maxNsr = Math.max(...records.map((r) => r.nsr));
          await client.query(
            `UPDATE public.time_devices 
             SET last_nsr = GREATEST(last_nsr, $1), updated_at = NOW() 
             WHERE id = $2;`,
            [maxNsr, device.id]
          );

          return { processed, orphans };
        }
      );

      return reply.send({
        success: true,
        message: 'Lote de marcações REP processado com sucesso.',
        ...summary,
      });
    } catch (err: any) {
      request.log.error(err, '[REP_INGEST] Falha ao processar lote de ponto');
      return reply.status(500).send({
        success: false,
        error: 'Erro interno ao processar lote de ponto do dispositivo REP.',
      });
    }
  });
};
