import crypto from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
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

const integratePayrollSchema = z.object({
  periodId: z.string().uuid(),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  contractId: z.string().uuid().optional(),
});

export const timeTrackingRoutes: FastifyPluginAsync = async (app) => {
  // Integração Ponto -> Folha (BUG-04: grava manual_value = NULL para calcular por quantidade)
  app.post(
    '/integrate-payroll',
    { preHandler: [authenticate, requirePermission('manage_time_tracking')] },
    async (request, reply) => {
      const parse = integratePayrollSchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({ success: false, details: parse.error.format() });
      }
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      }

      const { periodId, year, month, contractId } = parse.data;
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

      try {
        const summary = await request.withContext(async (client) => {
          const { rows: rubrics } = await client.query(
            `SELECT id, code, rubric_kind FROM public.rubrics
             WHERE (tenant_id = $1::uuid OR is_system = TRUE) AND deleted_at IS NULL;`,
            [request.user!.tenant_id]
          );
          const findRubricId = (codes: string[], kind?: string) => {
            for (const c of codes) {
              const found = rubrics.find((r: any) => r.code === c);
              if (found) return found.id;
            }
            if (kind) {
              const byKind = rubrics.find((r: any) => r.rubric_kind === kind);
              if (byKind) return byKind.id;
            }
            return null;
          };

          const rHe50 = findRubricId(['102', '150'], 'OVERTIME');
          const rHe100 = findRubricId(['103', '160']);
          const rNight = findRubricId(['301'], 'ADIC_NOTURNO');
          const rAbsence = findRubricId(['801'], 'ABSENCE');
          const rLate = findRubricId(['803', '802'], 'LATE');

          let sql = `
            SELECT
              contract_id,
              COALESCE(SUM(overtime_50_hours), 0) AS he50,
              COALESCE(SUM(overtime_100_hours), 0) AS he100,
              COALESCE(SUM(night_hours), 0) AS night_hours,
              COALESCE(SUM(CASE WHEN status = 'ABSENCE' THEN 1 ELSE 0 END), 0) AS absence_days,
              COALESCE(SUM(delay_hours), 0) AS delay_hours
            FROM public.time_punch_daily_summaries
            WHERE tenant_id = $1::uuid
              AND work_date >= $2::date
              AND work_date <= $3::date
          `;
          const queryParams: any[] = [request.user!.tenant_id, startDate, endDate];
          if (contractId) {
            sql += ` AND contract_id = $4::uuid`;
            queryParams.push(contractId);
          }
          sql += ` GROUP BY contract_id;`;

          const { rows: summaries } = await client.query(sql, queryParams);

          let inserted = 0;
          for (const row of summaries) {
            await client.query(
              `DELETE FROM public.payroll_variable_events
               WHERE tenant_id = $1::uuid AND payroll_period_id = $2::uuid
                 AND contract_id = $3::uuid AND origin = 'TIME_TRACKING';`,
              [request.user!.tenant_id, periodId, row.contract_id]
            );

            const toInsert: Array<{ rubricId: string | null; qty: number; ref: string }> = [
              { rubricId: rHe50, qty: Number(row.he50), ref: `INTEGRAÇÃO_PONTO: HE 50% (${row.he50}h)` },
              { rubricId: rHe100, qty: Number(row.he100), ref: `INTEGRAÇÃO_PONTO: HE 100% (${row.he100}h)` },
              { rubricId: rNight, qty: Number(row.night_hours), ref: `INTEGRAÇÃO_PONTO: Adic. Noturno (${row.night_hours}h)` },
              { rubricId: rAbsence, qty: Number(row.absence_days), ref: `INTEGRAÇÃO_PONTO: Faltas (${row.absence_days}d)` },
              { rubricId: rLate, qty: Number(row.delay_hours), ref: `INTEGRAÇÃO_PONTO: Atrasos (${row.delay_hours}h)` },
            ];

            for (const ev of toInsert) {
              if (ev.rubricId && ev.qty > 0) {
                await client.query(
                  `INSERT INTO public.payroll_variable_events (
                    tenant_id, payroll_period_id, contract_id, rubric_id,
                    quantity, manual_value, force_zero_override, origin, reference
                  ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, NULL, FALSE, 'TIME_TRACKING', $6);`,
                  [request.user!.tenant_id, periodId, row.contract_id, ev.rubricId, ev.qty, ev.ref]
                );
                inserted++;
              }
            }
          }

          return { contractsProcessed: summaries.length, eventsInserted: inserted };
        });

        return reply.send({ success: true, data: summary });
      } catch (err: any) {
        request.log.error(err, '[TIME_INTEGRATE_PAYROLL] Erro ao integrar ponto na folha');
        return reply.status(400).send({ success: false, error: err.message });
      }
    }
  );

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
