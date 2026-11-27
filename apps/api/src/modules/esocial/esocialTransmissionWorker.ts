import pg from 'pg';
import {
  buildEsocialBatchEnvelopeXml,
  buildEsocialBatchQueryXml,
} from '@couplerh/payroll-core';
import { env } from '../../config/env.js';
import { withTenantContext } from '../../shared/db/context.js';
import { QueueService } from '../../shared/queue/QueueService.js';
import { unlockActiveCertificate } from './certificateVaultService.js';
import { signEsocialXml } from './xmlDsigSigner.js';
import {
  parsePollBatchResponse,
  parseSendBatchResponse,
  postSoapWithMtls,
} from './esocialMtlsClient.js';
import { ingestAndReconcileTotalizer } from './esocialTotalizerService.js';

export interface EsocialBatchQueuePayload {
  batchId: string;
  tenantId: string;
  userId: string | null;
  role: string | null;
  sendUrl?: string;
  queryUrl?: string;
}

export interface BatchEndpointOverrides {
  sendUrl?: string;
  queryUrl?: string;
  rejectUnauthorized?: boolean;
}

const SOAP_ACTION_SEND =
  '"http://www.esocial.gov.br/servicos/empregador/lote/eventos/envio/v1_1_0/ServicoEnviarLoteEventos/EnviarLoteEventos"';
const SOAP_ACTION_QUERY =
  '"http://www.esocial.gov.br/servicos/empregador/lote/eventos/consulta/v1_1_0/ServicoConsultarLoteEventos/ConsultarLoteEventos"';

/**
 * Executa o envio de um lote de eventos eSocial assinados (XML-DSig) via HTTPS mTLS.
 */
export async function executeBatchSend(
  batchId: string,
  tenantId: string,
  userId: string | null,
  role: string | null,
  overrides?: BatchEndpointOverrides,
  customPool?: pg.Pool
) {
  return withTenantContext(
    { userId, tenantId, role },
    async (client) => {
      const batchRes = await client.query(
        `SELECT b.*, c.cnpj AS company_cnpj, c.esocial_production_enabled
         FROM public.esocial_batches b
         JOIN public.companies c ON c.id = b.company_id
         WHERE b.id = $1::uuid AND b.tenant_id = $2::uuid
         FOR UPDATE;`,
        [batchId, tenantId]
      );

      if (batchRes.rows.length === 0) {
        throw new Error(`Lote eSocial ${batchId} nao encontrado.`);
      }

      const batch = batchRes.rows[0];
      if (batch.environment === 'PRODUCTION' && !batch.esocial_production_enabled) {
        const err: any = new Error(
          'Ambiente de Producao bloqueado: homologue 1 ciclo completo em Producao Restrita antes de transmitir em Producao.'
        );
        err.statusCode = 422;
        err.code = 'PRODUCTION_NOT_HOMOLOGATED';
        throw err;
      }

      const eventsRes = await client.query(
        `SELECT * FROM public.esocial_events
         WHERE batch_id = $1::uuid AND tenant_id = $2::uuid
         ORDER BY created_at ASC;`,
        [batchId, tenantId]
      );

      if (eventsRes.rows.length === 0) {
        throw new Error(`Lote eSocial ${batchId} nao possui eventos vinculados.`);
      }

      // 1. Abrir cofre A1
      const material = await unlockActiveCertificate(client, {
        tenantId,
        companyId: batch.company_id,
        environment: batch.environment,
        certificateId: batch.certificate_id || undefined,
      });

      // 2. Garantir XML-DSig em todos os eventos do lote
      const signedEvents: Array<{ id: string; eventId: string; signedXml: string }> = [];
      for (const ev of eventsRes.rows) {
        let signedXml = ev.signed_xml as string | null;
        let digest = ev.signature_digest as string | null;
        if (!signedXml) {
          const sig = signEsocialXml(ev.xml_content, material.keyPem, material.certDerBase64);
          signedXml = sig.signedXml;
          digest = sig.digestValue;
          await client.query(
            `UPDATE public.esocial_events
             SET signed_xml = $2::text,
                 signature_digest = $3::text,
                 signed_at = NOW(),
                 status = 'SIGNED',
                 updated_at = NOW()
             WHERE id = $1::uuid`,
            [ev.id, signedXml, digest]
          );
        }
        signedEvents.push({ id: ev.id, eventId: ev.event_id, signedXml });
      }

      // 3. Montar envelope SOAP v1_1_1
      const soapEnvelope = buildEsocialBatchEnvelopeXml({
        tpInscEmpregador: 1,
        nrInscEmpregador: batch.company_cnpj,
        grupo: Number(batch.group_type) as 1 | 2 | 3,
        events: signedEvents.map((s) => ({ eventId: s.eventId, signedXml: s.signedXml })),
      });

      const endpointUrl =
        overrides?.sendUrl ||
        (batch.environment === 'PRODUCTION'
          ? env.ESOCIAL_WS_PROD_SEND_URL
          : env.ESOCIAL_WS_HOMOLOG_SEND_URL);

      const nextAttempt = Number(batch.attempt_count || 0) + 1;

      await client.query(
        `UPDATE public.esocial_batches
         SET status = 'SENDING', attempt_count = $2::int, request_xml = $3::text, updated_at = NOW()
         WHERE id = $1::uuid`,
        [batchId, nextAttempt, soapEnvelope]
      );

      try {
        const res = await postSoapWithMtls({
          endpointUrl,
          soapAction: SOAP_ACTION_SEND,
          xmlBody: soapEnvelope,
          certPem: material.certPem,
          keyPem: material.keyPem,
          rejectUnauthorized: overrides?.rejectUnauthorized ?? env.ESOCIAL_MTLS_REJECT_UNAUTHORIZED,
        });

        const parsed = parseSendBatchResponse(res.responseXml);
        const acceptedByWs = res.httpStatus >= 200 && res.httpStatus < 300 && (parsed.cdResposta === '201' || Boolean(parsed.protocolNumber));
        const newStatus = acceptedByWs ? 'SENT' : 'REJECTED';

        await client.query(
          `UPDATE public.esocial_batches
           SET status = $2::text,
               protocol_number = $3::text,
               response_xml = $4::text,
               http_status = $5::int,
               cd_resposta = $6::text,
               desc_resposta = $7::text,
               sent_at = NOW(),
               error_message = $8::text,
               updated_at = NOW()
           WHERE id = $1::uuid`,
          [
            batchId,
            newStatus,
            parsed.protocolNumber,
            res.responseXml,
            res.httpStatus,
            parsed.cdResposta,
            parsed.descResposta,
            acceptedByWs ? null : JSON.stringify(parsed.ocorrencias),
          ]
        );

        await client.query(
          `UPDATE public.esocial_events
           SET status = $2::text,
               protocol_number = $3::text,
               sent_at = NOW(),
               updated_at = NOW()
           WHERE batch_id = $1::uuid`,
          [batchId, acceptedByWs ? 'SENT' : 'REJECTED', parsed.protocolNumber]
        );

        return {
          batchId,
          status: newStatus,
          protocolNumber: parsed.protocolNumber,
          cdResposta: parsed.cdResposta,
          descResposta: parsed.descResposta,
          httpStatus: res.httpStatus,
        };
      } catch (err: any) {
        const backoffSeconds = Math.min(300, Math.pow(2, nextAttempt) * 5);
        const failedFinal = nextAttempt >= Number(batch.max_attempts || 5);
        await client.query(
          `UPDATE public.esocial_batches
           SET status = $2::text,
               error_message = $3::text,
               next_retry_at = NOW() + ($4::text || ' seconds')::interval,
               updated_at = NOW()
           WHERE id = $1::uuid`,
          [batchId, failedFinal ? 'FAILED' : 'QUEUED', err?.message || 'Erro de rede mTLS', String(backoffSeconds)]
        );
        throw err;
      }
    },
    customPool
  );
}

/**
 * Consulta o resultado de processamento do lote no SERPRO/Gov.br via mTLS,
 * salva recibos oficiais em esocial_events e ingere totalizadores retornados.
 */
export async function executeBatchPoll(
  batchId: string,
  tenantId: string,
  userId: string | null,
  role: string | null,
  overrides?: BatchEndpointOverrides,
  customPool?: pg.Pool
) {
  return withTenantContext(
    { userId, tenantId, role },
    async (client) => {
      const batchRes = await client.query(
        `SELECT * FROM public.esocial_batches
         WHERE id = $1::uuid AND tenant_id = $2::uuid
         FOR UPDATE;`,
        [batchId, tenantId]
      );

      if (batchRes.rows.length === 0) {
        throw new Error(`Lote eSocial ${batchId} nao encontrado.`);
      }

      const batch = batchRes.rows[0];
      if (!batch.protocol_number) {
        const err: any = new Error('Lote ainda nao possui protocol_number para consulta.');
        err.statusCode = 422;
        throw err;
      }

      const material = await unlockActiveCertificate(client, {
        tenantId,
        companyId: batch.company_id,
        environment: batch.environment,
        certificateId: batch.certificate_id || undefined,
      });

      const queryEnvelope = buildEsocialBatchQueryXml(batch.protocol_number);
      const endpointUrl =
        overrides?.queryUrl ||
        (batch.environment === 'PRODUCTION'
          ? env.ESOCIAL_WS_PROD_QUERY_URL
          : env.ESOCIAL_WS_HOMOLOG_QUERY_URL);

      const res = await postSoapWithMtls({
        endpointUrl,
        soapAction: SOAP_ACTION_QUERY,
        xmlBody: queryEnvelope,
        certPem: material.certPem,
        keyPem: material.keyPem,
        rejectUnauthorized: overrides?.rejectUnauthorized ?? env.ESOCIAL_MTLS_REJECT_UNAUTHORIZED,
      });

      const parsed = parsePollBatchResponse(res.responseXml);

      let acceptedCount = 0;
      let rejectedCount = 0;
      const ingestedTotalizers: any[] = [];

      for (const evRes of parsed.events) {
        const isAccepted = evRes.cdResposta === '201' || evRes.cdResposta === '202';
        if (isAccepted) acceptedCount++;
        else rejectedCount++;

        await client.query(
          `UPDATE public.esocial_events
           SET status = $3::text,
               receipt_number = COALESCE($4::text, receipt_number),
               receipt_xml = COALESCE($5::text, receipt_xml),
               error_details = CASE WHEN $3::text = 'REJECTED' THEN $6::jsonb ELSE NULL END,
               accepted_at = CASE WHEN $3::text = 'ACCEPTED' THEN NOW() ELSE accepted_at END,
               updated_at = NOW()
           WHERE batch_id = $1::uuid AND event_id = $2::text;`,
          [
            batchId,
            evRes.eventId,
            isAccepted ? 'ACCEPTED' : 'REJECTED',
            evRes.receiptNumber,
            evRes.receiptXml,
            JSON.stringify({ cdResposta: evRes.cdResposta, descResposta: evRes.descResposta, ocorrencias: evRes.ocorrencias }),
          ]
        );

        for (const totXml of evRes.totalizerXmls) {
          const tot = await ingestAndReconcileTotalizer(client, {
            tenantId,
            companyId: batch.company_id,
            environment: batch.environment,
            rawXml: totXml,
          });
          ingestedTotalizers.push(tot.record);
        }
      }

      let batchStatus = 'POLLING';
      if (parsed.cdResposta === '201' || (parsed.events.length > 0 && rejectedCount === 0 && acceptedCount > 0)) {
        batchStatus = 'PROCESSED';
      } else if (acceptedCount > 0 && rejectedCount > 0) {
        batchStatus = 'PARTIAL';
      } else if (rejectedCount > 0 || parsed.cdResposta.startsWith('4') || parsed.cdResposta.startsWith('5')) {
        batchStatus = 'REJECTED';
      }

      await client.query(
        `UPDATE public.esocial_batches
         SET status = $2::text,
             response_xml = $3::text,
             http_status = $4::int,
             cd_resposta = $5::text,
             desc_resposta = $6::text,
             processed_at = CASE WHEN $2::text IN ('PROCESSED', 'PARTIAL', 'REJECTED') THEN NOW() ELSE processed_at END,
             updated_at = NOW()
         WHERE id = $1::uuid;`,
        [batchId, batchStatus, res.responseXml, res.httpStatus, parsed.cdResposta, parsed.descResposta]
      );

      return {
        batchId,
        status: batchStatus,
        cdResposta: parsed.cdResposta,
        descResposta: parsed.descResposta,
        acceptedCount,
        rejectedCount,
        events: parsed.events,
        ingestedTotalizersCount: ingestedTotalizers.length,
      };
    },
    customPool
  );
}

/**
 * Registra os workers pg-boss de envio e polling de lotes eSocial.
 */
export async function registerEsocialWorkers(queueService: QueueService) {
  if (!queueService.isRunning) return;

  await queueService.registerEsocialSendWorker(async (payload) => {
    const res = await executeBatchSend(
      payload.batchId,
      payload.tenantId,
      payload.userId,
      payload.role,
      { sendUrl: payload.sendUrl }
    );
    if (res.status === 'SENT' && res.protocolNumber) {
      await queueService.enqueueEsocialPollBatch(
        {
          batchId: payload.batchId,
          tenantId: payload.tenantId,
          userId: payload.userId,
          role: payload.role,
          queryUrl: payload.queryUrl,
        },
        { delaySeconds: 5 }
      );
    }
  });

  await queueService.registerEsocialPollWorker(async (payload) => {
    await executeBatchPoll(
      payload.batchId,
      payload.tenantId,
      payload.userId,
      payload.role,
      { queryUrl: payload.queryUrl }
    );
  });
}
