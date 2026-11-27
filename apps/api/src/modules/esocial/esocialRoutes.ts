import { FastifyInstance, FastifyRequest } from 'fastify';
import '@fastify/multipart';
import { z } from 'zod';
import {
  getEsocialEventGroup,
  validateEsocialXml,
  type EsocialOutboundEventType,
} from '@couplerh/payroll-core';
import { authenticate, requireAdminRole, requirePermission } from '../auth/authMiddleware.js';
import { env } from '../../config/env.js';
import { QueueService } from '../../shared/queue/QueueService.js';
import {
  checkExpiringCertificates,
  computeCertificateSummary,
  installA1Certificate,
  unlockActiveCertificate,
} from './certificateVaultService.js';
import { generateAndPersistEsocialEvent } from './esocialEventGeneratorService.js';
import { signEsocialXml, verifyXmlDsigSignature } from './xmlDsigSigner.js';
import { executeBatchPoll, executeBatchSend } from './esocialTransmissionWorker.js';
import { ingestAndReconcileTotalizer } from './esocialTotalizerService.js';

const OUTBOUND_EVENT_TYPES = [
  'S-1000',
  'S-1005',
  'S-1010',
  'S-1020',
  'S-2190',
  'S-2200',
  'S-2205',
  'S-2206',
  'S-2230',
  'S-2240',
  'S-2299',
  'S-2300',
  'S-2399',
  'S-1200',
  'S-1210',
  'S-1298',
  'S-1299',
] as const;

function getTenantId(request: FastifyRequest): string {
  const tenantId = request.user?.tenant_id;
  if (!tenantId) {
    const err: any = new Error('Tenant nao identificado na sessao.');
    err.statusCode = 403;
    throw err;
  }
  return tenantId;
}

export async function esocialRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireAdminRole);
  app.addHook('preHandler', requirePermission('manage_esocial'));

  // --------------------------------------------------------------------------
  // ESOC-01: Cofre Criptografado de Certificados Digitais A1 (.pfx / .p12)
  // --------------------------------------------------------------------------
  app.get('/certificates', async (request, reply) => {
    const tenantId = getTenantId(request);
    const q = request.query as { companyId?: string; environment?: string };

    const rows = await request.withContext!(async (client) => {
      const conds = ['tenant_id = $1::uuid'];
      const params: any[] = [tenantId];
      if (q.companyId) {
        params.push(q.companyId);
        conds.push(`company_id = $${params.length}::uuid`);
      }
      if (q.environment && (q.environment === 'PRODUCTION' || q.environment === 'HOMOLOGATION')) {
        params.push(q.environment);
        conds.push(`environment = $${params.length}::text`);
      }
      const res = await client.query(
        `SELECT id, tenant_id, company_id, environment, filename, subject_name, subject_dn, cnpj,
                issuer_dn, serial_number, thumbprint_sha256, valid_from, valid_to, is_active,
                revoked_at, revocation_reason, created_at
         FROM public.esocial_certificates
         WHERE ${conds.join(' AND ')}
         ORDER BY is_active DESC, created_at DESC;`,
        params
      );
      return res.rows.map(computeCertificateSummary);
    });

    return reply.send({ success: true, certificates: rows });
  });

  app.post('/certificates', async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = request.user!.sub;

    let companyId = '';
    let environment: 'PRODUCTION' | 'HOMOLOGATION' = 'HOMOLOGATION';
    let filename = 'certificado.pfx';
    let password = '';
    let pfxBuffer: Buffer | null = null;

    if (request.isMultipart()) {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          filename = part.filename || 'certificado.pfx';
          pfxBuffer = await part.toBuffer();
        } else {
          const val = String(part.value ?? '');
          if (part.fieldname === 'company_id' || part.fieldname === 'companyId') companyId = val;
          if (part.fieldname === 'environment') {
            environment = val === 'PRODUCTION' || val === 'producao' ? 'PRODUCTION' : 'HOMOLOGATION';
          }
          if (part.fieldname === 'password') password = val;
        }
      }
    } else {
      const bodySchema = z.object({
        company_id: z.string().uuid(),
        environment: z.enum(['PRODUCTION', 'HOMOLOGATION', 'producao', 'restrita']).default('HOMOLOGATION'),
        filename: z.string().min(1).default('certificado.pfx'),
        password: z.string().min(1),
        pfx_base64: z.string().min(10),
      });
      const body = bodySchema.parse(request.body);
      companyId = body.company_id;
      environment = body.environment === 'PRODUCTION' || body.environment === 'producao' ? 'PRODUCTION' : 'HOMOLOGATION';
      filename = body.filename;
      password = body.password;
      pfxBuffer = Buffer.from(body.pfx_base64, 'base64');
    }

    if (!companyId || !pfxBuffer || !password) {
      return reply.status(400).send({
        success: false,
        error: 'Informe company_id, arquivo .pfx/.p12 e senha do certificado.',
      });
    }

    try {
      const certificate = await request.withContext!(async (client) => {
        return installA1Certificate(client, {
          tenantId,
          companyId,
          uploadedBy: userId,
          environment,
          filename,
          pfxBuffer: pfxBuffer!,
          password,
        });
      });

      return reply.status(201).send({ success: true, certificate });
    } catch (err: any) {
      return reply.status(err.statusCode || 422).send({
        success: false,
        code: err.code || 'CERTIFICATE_INSTALL_ERROR',
        error: err.message || 'Falha ao validar e instalar certificado digital A1.',
      });
    }
  });

  app.post('/certificates/:id/revoke', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const body = z.object({ reason: z.string().min(3).default('Revogado pelo administrador') }).parse(request.body || {});

    const updated = await request.withContext!(async (client) => {
      const res = await client.query(
        `UPDATE public.esocial_certificates
         SET is_active = FALSE, revoked_at = NOW(), revocation_reason = $3::text, updated_at = NOW()
         WHERE id = $1::uuid AND tenant_id = $2::uuid
         RETURNING *;`,
        [id, tenantId, body.reason]
      );
      return res.rows[0] ? computeCertificateSummary(res.rows[0]) : null;
    });

    if (!updated) {
      return reply.status(404).send({ success: false, error: 'Certificado nao encontrado.' });
    }
    return reply.send({ success: true, certificate: updated });
  });

  app.post('/certificates/check-expiry', async (request, reply) => {
    const tenantId = getTenantId(request);
    const triggered = await checkExpiringCertificates(undefined, undefined, tenantId);
    return reply.send({ success: true, triggered });
  });

  // --------------------------------------------------------------------------
  // ESOC-02: Geracao e Validacao XSD de Eventos S-1.2 / S-1.3
  // --------------------------------------------------------------------------
  app.get('/events', async (request, reply) => {
    const tenantId = getTenantId(request);
    const q = request.query as { companyId?: string; status?: string; eventType?: string; periodId?: string };

    const events = await request.withContext!(async (client) => {
      const conds = ['e.tenant_id = $1::uuid'];
      const params: any[] = [tenantId];
      if (q.companyId) {
        params.push(q.companyId);
        conds.push(`e.company_id = $${params.length}::uuid`);
      }
      if (q.status) {
        params.push(q.status);
        conds.push(`e.status = $${params.length}::text`);
      }
      if (q.eventType) {
        params.push(q.eventType);
        conds.push(`e.event_type = $${params.length}::text`);
      }
      if (q.periodId) {
        params.push(q.periodId);
        conds.push(`e.payroll_period_id = $${params.length}::uuid`);
      }

      const res = await client.query(
        `SELECT e.id, e.company_id, e.event_type, e.event_id, e.environment, e.layout_version,
                e.batch_id, e.payroll_period_id, e.contract_id, e.worker_id, e.period_year, e.period_month,
                e.xsd_valid, e.xsd_errors, e.status, e.protocol_number, e.receipt_number,
                e.error_details, e.signed_at, e.sent_at, e.accepted_at, e.created_at
         FROM public.esocial_events e
         WHERE ${conds.join(' AND ')}
         ORDER BY e.created_at DESC
         LIMIT 200;`,
        params
      );
      return res.rows;
    });

    return reply.send({ success: true, events });
  });

  app.get('/events/:id', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };

    const event = await request.withContext!(async (client) => {
      const res = await client.query(
        `SELECT * FROM public.esocial_events WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [id, tenantId]
      );
      return res.rows[0] || null;
    });

    if (!event) {
      return reply.status(404).send({ success: false, error: 'Evento eSocial nao encontrado.' });
    }
    return reply.send({ success: true, event });
  });

  app.post('/events/generate', async (request, reply) => {
    const tenantId = getTenantId(request);
    const bodySchema = z.object({
      company_id: z.string().uuid(),
      event_type: z.enum(OUTBOUND_EVENT_TYPES),
      environment: z.enum(['PRODUCTION', 'HOMOLOGATION']).default(env.ESOCIAL_ENVIRONMENT),
      layout_version: z.enum(['S-1.2', 'S-1.3']).default(env.ESOCIAL_LAYOUT_VERSION),
      payroll_period_id: z.string().uuid().optional(),
      contract_id: z.string().uuid().optional(),
      rubric_id: z.string().uuid().optional(),
      leave_id: z.string().uuid().optional(),
      termination_id: z.string().uuid().optional(),
      cost_center_id: z.string().uuid().optional(),
      establishment_id: z.string().uuid().optional(),
      overrides: z.record(z.any()).optional(),
    });
    const body = bodySchema.parse(request.body);

    try {
      const result = await request.withContext!(async (client) => {
        return generateAndPersistEsocialEvent(client, {
          tenantId,
          companyId: body.company_id,
          eventType: body.event_type,
          environment: body.environment,
          layoutVersion: body.layout_version,
          payrollPeriodId: body.payroll_period_id,
          contractId: body.contract_id,
          rubricId: body.rubric_id,
          leaveId: body.leave_id,
          terminationId: body.termination_id,
          costCenterId: body.cost_center_id,
          establishmentId: body.establishment_id,
          overrides: body.overrides,
        });
      });

      return reply.status(201).send({
        success: true,
        event: result.event,
        validation: result.validation,
      });
    } catch (err: any) {
      return reply.status(err.statusCode || 422).send({
        success: false,
        error: err.message || 'Erro ao gerar evento eSocial.',
      });
    }
  });

  app.post('/events/:id/validate', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };

    const result = await request.withContext!(async (client) => {
      const res = await client.query(
        `SELECT * FROM public.esocial_events WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [id, tenantId]
      );
      if (res.rows.length === 0) return null;
      const ev = res.rows[0];
      const validation = validateEsocialXml(
        ev.xml_content,
        ev.event_type as EsocialOutboundEventType,
        ev.layout_version
      );
      const upd = await client.query(
        `UPDATE public.esocial_events
         SET xsd_valid = $2::boolean,
             xsd_errors = $3::jsonb,
             status = CASE WHEN $2::boolean AND status = 'DRAFT' THEN 'VALIDATED' ELSE status END,
             updated_at = NOW()
         WHERE id = $1::uuid
         RETURNING *;`,
        [id, validation.valid, JSON.stringify(validation.errors)]
      );
      return { event: upd.rows[0], validation };
    });

    if (!result) {
      return reply.status(404).send({ success: false, error: 'Evento nao encontrado.' });
    }
    return reply.send({ success: true, ...result });
  });

  // --------------------------------------------------------------------------
  // ESOC-03: Assinatura XML-DSig (RSA-SHA256) & Transmissao mTLS
  // --------------------------------------------------------------------------
  app.post('/events/:id/sign', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };

    try {
      const signed = await request.withContext!(async (client) => {
        const res = await client.query(
          `SELECT * FROM public.esocial_events WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
          [id, tenantId]
        );
        if (res.rows.length === 0) {
          const err: any = new Error('Evento eSocial nao encontrado.');
          err.statusCode = 404;
          throw err;
        }
        const ev = res.rows[0];
        const validation = validateEsocialXml(
          ev.xml_content,
          ev.event_type as EsocialOutboundEventType,
          ev.layout_version
        );
        if (!validation.valid) {
          const err: any = new Error('Evento invalido na validacao XSD antes da assinatura.');
          err.statusCode = 422;
          err.details = validation.errors;
          throw err;
        }

        const material = await unlockActiveCertificate(client, {
          tenantId,
          companyId: ev.company_id,
          environment: ev.environment,
        });

        const sig = signEsocialXml(ev.xml_content, material.keyPem, material.certDerBase64);
        const verify = verifyXmlDsigSignature(sig.signedXml);
        if (!verify.valid) {
          throw new Error(`Falha de integridade XML-DSig: ${verify.reason}`);
        }

        const upd = await client.query(
          `UPDATE public.esocial_events
           SET signed_xml = $2::text,
               signature_digest = $3::text,
               signed_at = NOW(),
               xsd_valid = TRUE,
               status = 'SIGNED',
               updated_at = NOW()
           WHERE id = $1::uuid
           RETURNING *;`,
          [id, sig.signedXml, sig.digestValue]
        );
        return upd.rows[0];
      });

      return reply.send({ success: true, event: signed });
    } catch (err: any) {
      return reply.status(err.statusCode || 422).send({
        success: false,
        code: err.code || 'XMLDSIG_SIGN_ERROR',
        error: err.message,
        details: err.details,
      });
    }
  });

  app.get('/batches', async (request, reply) => {
    const tenantId = getTenantId(request);
    const q = request.query as { companyId?: string };

    const batches = await request.withContext!(async (client) => {
      const conds = ['tenant_id = $1::uuid'];
      const params: any[] = [tenantId];
      if (q.companyId) {
        params.push(q.companyId);
        conds.push(`company_id = $${params.length}::uuid`);
      }
      const res = await client.query(
        `SELECT id, company_id, certificate_id, environment, layout_version, group_type,
                protocol_number, status, attempt_count, http_status, cd_resposta, desc_resposta,
                error_message, sent_at, processed_at, created_at
         FROM public.esocial_batches
         WHERE ${conds.join(' AND ')}
         ORDER BY created_at DESC LIMIT 100;`,
        params
      );
      return res.rows;
    });

    return reply.send({ success: true, batches });
  });

  app.get('/batches/:id', async (request, reply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };

    const data = await request.withContext!(async (client) => {
      const b = await client.query(
        `SELECT * FROM public.esocial_batches WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [id, tenantId]
      );
      if (b.rows.length === 0) return null;
      const evs = await client.query(
        `SELECT id, event_type, event_id, status, receipt_number, error_details
         FROM public.esocial_events WHERE batch_id = $1::uuid AND tenant_id = $2::uuid`,
        [id, tenantId]
      );
      return { batch: b.rows[0], events: evs.rows };
    });

    if (!data) {
      return reply.status(404).send({ success: false, error: 'Lote nao encontrado.' });
    }
    return reply.send({ success: true, ...data });
  });

  app.post('/batches/send', async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = request.user!.sub;
    const role = request.user!.role ?? null;

    const body = z
      .object({
        company_id: z.string().uuid(),
        event_ids: z.array(z.string().uuid()).min(1).max(50),
        environment: z.enum(['PRODUCTION', 'HOMOLOGATION']).default('HOMOLOGATION'),
        async: z.boolean().default(false),
        endpoint_url: z.string().url().optional(),
        reject_unauthorized: z.boolean().optional(),
      })
      .parse(request.body);

    try {
      const batch = await request.withContext!(async (client) => {
        const compRes = await client.query<{ esocial_production_enabled: boolean }>(
          `SELECT esocial_production_enabled FROM public.companies WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL`,
          [body.company_id, tenantId]
        );
        if (compRes.rows.length === 0) {
          const err: any = new Error('Empresa nao encontrada.');
          err.statusCode = 404;
          throw err;
        }
        if (body.environment === 'PRODUCTION' && !compRes.rows[0].esocial_production_enabled) {
          const err: any = new Error(
            'Transmissao em Producao bloqueada: homologue 1 ciclo completo em Producao Restrita (ESOC-05) antes de habilitar Producao.'
          );
          err.statusCode = 422;
          err.code = 'PRODUCTION_NOT_HOMOLOGATED';
          throw err;
        }

        const evRes = await client.query(
          `SELECT id, event_type, xsd_valid, layout_version
           FROM public.esocial_events
           WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid AND company_id = $3::uuid`,
          [body.event_ids, tenantId, body.company_id]
        );

        if (evRes.rows.length !== body.event_ids.length) {
          const err: any = new Error('Um ou mais eventos informados nao pertencem a empresa/tenant.');
          err.statusCode = 404;
          throw err;
        }

        const groups = new Set(evRes.rows.map((r) => getEsocialEventGroup(r.event_type as EsocialOutboundEventType)));
        if (groups.size > 1) {
          const err: any = new Error('Todos os eventos de um mesmo lote eSocial devem pertencer ao mesmo grupo (1=Tabela, 2=Nao Periodicos, 3=Periodicos).');
          err.statusCode = 422;
          throw err;
        }
        const groupType = Array.from(groups)[0];
        const certRes = await client.query<{ id: string }>(
          `SELECT id FROM public.esocial_certificates
           WHERE tenant_id = $1::uuid AND company_id = $2::uuid AND environment = $3::text AND is_active = TRUE
           ORDER BY created_at DESC LIMIT 1`,
          [tenantId, body.company_id, body.environment]
        );
        if (certRes.rows.length === 0) {
          const err: any = new Error(`Nenhum certificado digital A1 ativo para ${body.environment}.`);
          err.statusCode = 422;
          err.code = 'CERTIFICATE_NOT_CONFIGURED';
          throw err;
        }

        const bRes = await client.query(
          `INSERT INTO public.esocial_batches (
            tenant_id, company_id, certificate_id, environment, layout_version, group_type, status, created_by
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::int, 'QUEUED', $7::uuid)
          RETURNING *;`,
          [
            tenantId,
            body.company_id,
            certRes.rows[0].id,
            body.environment,
            evRes.rows[0].layout_version || 'S-1.3',
            groupType,
            userId,
          ]
        );
        const createdBatch = bRes.rows[0];

        await client.query(
          `UPDATE public.esocial_events
           SET batch_id = $2::uuid, status = 'QUEUED', updated_at = NOW()
           WHERE id = ANY($1::uuid[]) AND tenant_id = $3::uuid`,
          [body.event_ids, createdBatch.id, tenantId]
        );

        return createdBatch;
      });

      const queueService = QueueService.getInstance();
      if (body.async && queueService.isRunning) {
        const jobId = await queueService.enqueueEsocialSendBatch({
          batchId: batch.id,
          tenantId,
          userId,
          role,
          sendUrl: body.endpoint_url,
        });
        return reply.status(202).send({ success: true, queued: true, jobId, batch });
      }

      const execution = await executeBatchSend(batch.id, tenantId, userId, role, {
        sendUrl: body.endpoint_url,
        rejectUnauthorized: body.reject_unauthorized,
      });

      return reply.status(200).send({ success: true, batch, execution });
    } catch (err: any) {
      return reply.status(err.statusCode || 422).send({
        success: false,
        code: err.code || 'ESOCIAL_BATCH_SEND_ERROR',
        error: err.message,
      });
    }
  });

  app.post('/batches/:id/poll', async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = request.user!.sub;
    const role = request.user!.role ?? null;
    const { id } = request.params as { id: string };
    const body = z
      .object({
        endpoint_url: z.string().url().optional(),
        reject_unauthorized: z.boolean().optional(),
      })
      .parse(request.body || {});

    try {
      const execution = await executeBatchPoll(id, tenantId, userId, role, {
        queryUrl: body.endpoint_url,
        rejectUnauthorized: body.reject_unauthorized,
      });
      return reply.send({ success: true, execution });
    } catch (err: any) {
      return reply.status(err.statusCode || 422).send({
        success: false,
        error: err.message || 'Erro ao consultar lote eSocial.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // ESOC-04: Ingestao de Totalizadores (S-5001 a S-5013) & Confronto CoupleRH x Governo
  // --------------------------------------------------------------------------
  app.post('/totalizers/ingest', async (request, reply) => {
    const tenantId = getTenantId(request);
    const body = z
      .object({
        company_id: z.string().uuid(),
        payroll_period_id: z.string().uuid().optional(),
        environment: z.enum(['PRODUCTION', 'HOMOLOGATION']).default('HOMOLOGATION'),
        xml_content: z.string().min(20),
      })
      .parse(request.body);

    try {
      const result = await request.withContext!(async (client) => {
        return ingestAndReconcileTotalizer(client, {
          tenantId,
          companyId: body.company_id,
          payrollPeriodId: body.payroll_period_id,
          environment: body.environment,
          rawXml: body.xml_content,
        });
      });

      return reply.status(201).send({ success: true, ...result });
    } catch (err: any) {
      return reply.status(422).send({
        success: false,
        error: err.message || 'Falha ao processar totalizador eSocial.',
      });
    }
  });

  app.get('/totalizers/reconciliation', async (request, reply) => {
    const tenantId = getTenantId(request);
    const q = request.query as { companyId?: string; periodId?: string; year?: string; month?: string };

    const items = await request.withContext!(async (client) => {
      const conds = ['tenant_id = $1::uuid'];
      const params: any[] = [tenantId];
      if (q.companyId) {
        params.push(q.companyId);
        conds.push(`company_id = $${params.length}::uuid`);
      }
      if (q.periodId) {
        params.push(q.periodId);
        conds.push(`payroll_period_id = $${params.length}::uuid`);
      }
      if (q.year) {
        params.push(Number(q.year));
        conds.push(`period_year = $${params.length}::int`);
      }
      if (q.month) {
        params.push(Number(q.month));
        conds.push(`period_month = $${params.length}::int`);
      }

      const res = await client.query(
        `SELECT * FROM public.esocial_totalizers
         WHERE ${conds.join(' AND ')}
         ORDER BY period_year DESC, period_month DESC, event_type ASC, created_at DESC;`,
        params
      );
      return res.rows;
    });

    return reply.send({ success: true, totalizers: items });
  });

  // --------------------------------------------------------------------------
  // ESOC-05: Homologacao em Producao Restrita (Gate de Liberacao de Producao)
  // --------------------------------------------------------------------------
  app.get('/homologation/status', async (request, reply) => {
    const tenantId = getTenantId(request);
    const q = request.query as { companyId?: string };

    const data = await request.withContext!(async (client) => {
      const compQuery = q.companyId
        ? await client.query(
            `SELECT id, corporate_name, cnpj, esocial_production_enabled, esocial_homologated_at
             FROM public.companies WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL`,
            [q.companyId, tenantId]
          )
        : await client.query(
            `SELECT id, corporate_name, cnpj, esocial_production_enabled, esocial_homologated_at
             FROM public.companies WHERE tenant_id = $1::uuid AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
            [tenantId]
          );

      const company = compQuery.rows[0] || null;
      if (!company) return { company: null, cycles: [] };

      const cyclesRes = await client.query(
        `SELECT * FROM public.esocial_homologation_cycles
         WHERE tenant_id = $1::uuid AND company_id = $2::uuid
         ORDER BY created_at DESC LIMIT 20`,
        [tenantId, company.id]
      );

      return { company, cycles: cyclesRes.rows };
    });

    return reply.send({ success: true, ...data });
  });

  app.post('/homologation/verify-cycle', async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = request.user!.sub;

    const body = z
      .object({
        company_id: z.string().uuid(),
        payroll_period_id: z.string().uuid(),
        required_events: z
          .array(z.enum(OUTBOUND_EVENT_TYPES))
          .default(['S-1000', 'S-1005', 'S-1010', 'S-1020', 'S-2200', 'S-1200', 'S-1210', 'S-1299']),
      })
      .parse(request.body);

    const outcome = await request.withContext!(async (client) => {
      // 1. Verificar eventos aceitos com recibo oficial no ambiente HOMOLOGATION
      const evRes = await client.query<{
        event_type: string;
        receipt_number: string;
        payroll_period_id: string | null;
      }>(
        `SELECT event_type, receipt_number, payroll_period_id
         FROM public.esocial_events
         WHERE tenant_id = $1::uuid
           AND company_id = $2::uuid
           AND environment = 'HOMOLOGATION'
           AND status = 'ACCEPTED'
           AND receipt_number IS NOT NULL
           AND (payroll_period_id = $3::uuid OR payroll_period_id IS NULL);`,
        [tenantId, body.company_id, body.payroll_period_id]
      );

      const acceptedByType = new Map<string, string[]>();
      for (const row of evRes.rows) {
        const list = acceptedByType.get(row.event_type) ?? [];
        list.push(row.receipt_number);
        acceptedByType.set(row.event_type, list);
      }

      const missingEvents = body.required_events.filter((t) => !acceptedByType.has(t));

      // 2. Verificar totalizadores reconciliados com divergencia R$ 0,00
      const totRes = await client.query<{
        event_type: string;
        reconciliation_status: string;
        diff_inss_segurados: string;
        diff_inss_patronal: string;
        diff_irrf_retido: string;
        diff_fgts_total: string;
      }>(
        `SELECT event_type, reconciliation_status, diff_inss_segurados, diff_inss_patronal, diff_irrf_retido, diff_fgts_total
         FROM public.esocial_totalizers
         WHERE tenant_id = $1::uuid
           AND company_id = $2::uuid
           AND payroll_period_id = $3::uuid
           AND environment = 'HOMOLOGATION';`,
        [tenantId, body.company_id, body.payroll_period_id]
      );

      let maxDiff = 0;
      const divergentTotalizers: string[] = [];
      for (const tot of totRes.rows) {
        const diffs = [
          Math.abs(Number(tot.diff_inss_segurados)),
          Math.abs(Number(tot.diff_inss_patronal)),
          Math.abs(Number(tot.diff_irrf_retido)),
          Math.abs(Number(tot.diff_fgts_total)),
        ];
        const localMax = Math.max(...diffs);
        if (localMax > maxDiff) maxDiff = localMax;
        if (tot.reconciliation_status !== 'MATCHED' || localMax > 0) {
          divergentTotalizers.push(tot.event_type);
        }
      }

      const approved =
        missingEvents.length === 0 &&
        totRes.rows.length > 0 &&
        divergentTotalizers.length === 0 &&
        maxDiff === 0;

      const acceptedReceipts = Array.from(acceptedByType.entries()).map(([eventType, receipts]) => ({
        eventType,
        receipts,
      }));

      const cycleRes = await client.query(
        `INSERT INTO public.esocial_homologation_cycles (
          tenant_id, company_id, payroll_period_id, environment, status,
          required_events_json, accepted_receipts_json, totalizer_max_diff,
          production_unlocked, unlocked_at, unlocked_by, notes, updated_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, 'HOMOLOGATION', $4::text,
          $5::jsonb, $6::jsonb, $7::numeric,
          $8::boolean, CASE WHEN $8::boolean THEN NOW() ELSE NULL END, CASE WHEN $8::boolean THEN $9::uuid ELSE NULL END,
          $10::text, NOW()
        )
        RETURNING *;`,
        [
          tenantId,
          body.company_id,
          body.payroll_period_id,
          approved ? 'APPROVED' : 'FAILED',
          JSON.stringify(body.required_events),
          JSON.stringify(acceptedReceipts),
          maxDiff,
          approved,
          userId,
          approved
            ? 'Ciclo completo homologado em Producao Restrita com recibos oficiais e diferenca R$ 0,00.'
            : `Pendencias: faltando=[${missingEvents.join(',')}] totalizadores=${totRes.rows.length} divergentes=[${divergentTotalizers.join(',')}]`,
        ]
      );

      if (approved) {
        await client.query(
          `UPDATE public.companies
           SET esocial_production_enabled = TRUE,
               esocial_homologated_at = NOW(),
               updated_at = NOW()
           WHERE id = $1::uuid AND tenant_id = $2::uuid`,
          [body.company_id, tenantId]
        );
      }

      return {
        approved,
        missingEvents,
        divergentTotalizers,
        totalizersChecked: totRes.rows.length,
        maxDiff,
        cycle: cycleRes.rows[0],
      };
    });

    if (!outcome.approved) {
      return reply.status(422).send({
        success: false,
        code: 'HOMOLOGATION_INCOMPLETE',
        ...outcome,
      });
    }

    return reply.send({ success: true, ...outcome });
  });
}
