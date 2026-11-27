import crypto from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  calculateDailyWorkShift,
  evaluateNegativeTimeBankPolicy,
  validateAntiSpoofingAndMultiGeofence,
  type AllowedWorkplaceConfig,
} from '@couplerh/payroll-core';
import { env } from '../../config/env.js';
import { withTenantContext } from '../../shared/db/context.js';
import { dbPool } from '../../shared/db/pool.js';
import { StorageService } from '../../shared/storage/StorageService.js';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';

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

const enterprisePunchSchema = z.object({
  workerId: z.string().uuid().optional(),
  punchType: z
    .enum(['ENTRY', 'INTERVAL_START', 'INTERVAL_END', 'EXIT', 'IN', 'BREAK_START', 'BREAK_END', 'OUT'])
    .default('ENTRY'),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  accuracy: z.number().min(0).optional().nullable(),
  isMockLocation: z.boolean().optional().default(false),
  deviceFingerprint: z.string().max(255).optional().nullable(),
  deviceTimestamp: z.string().optional().nullable(),
  syncOrigin: z.enum(['ONLINE_API', 'OFFLINE_PWA']).optional().default('ONLINE_API'),
  clientUuid: z.string().uuid().optional().nullable(),
  selfieBase64: z.string().optional().nullable(),
  selfieMimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional().default('image/jpeg'),
});

const syncOfflineSchema = z.object({
  punches: z.array(enterprisePunchSchema).min(1).max(100),
});

const allowedWorkplacesSchema = z.object({
  workplaces: z.array(
    z.object({
      workplaceId: z.string().uuid(),
      isPrimary: z.boolean().optional().default(false),
      allowExternalAudit: z.boolean().optional().default(false),
    })
  ),
});

const recalculateDailySchema = z.object({
  contractId: z.string().uuid(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  standbyMinutes: z.number().int().min(0).max(1440).optional().default(0),
  readinessMinutes: z.number().int().min(0).max(1440).optional().default(0),
  isHolidayOrDsr: z.boolean().optional().default(false),
});

const repIngestSchema = z.object({
  records: z
    .array(
      z.object({
        nsr: z.number().int().positive(),
        pis: z.string().min(11).max(14),
        punchedAt: z.string(),
        punchType: z.enum(['ENTRY', 'INTERVAL_START', 'INTERVAL_END', 'EXIT']).optional(),
        sha256Hash: z.string().optional(),
      })
    )
    .min(1, 'Lote deve conter pelo menos uma batida.'),
});

const integratePayrollSchema = z.object({
  periodId: z.string().uuid(),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  contractId: z.string().uuid().optional(),
});

function normalizePunchType(raw: string): 'ENTRY' | 'INTERVAL_START' | 'INTERVAL_END' | 'EXIT' {
  switch (raw) {
    case 'IN':
    case 'ENTRY':
      return 'ENTRY';
    case 'BREAK_START':
    case 'INTERVAL_START':
      return 'INTERVAL_START';
    case 'BREAK_END':
    case 'INTERVAL_END':
      return 'INTERVAL_END';
    case 'OUT':
    case 'EXIT':
      return 'EXIT';
    default:
      return 'ENTRY';
  }
}

function getPunchTypePtBr(punchType: string): string {
  switch (normalizePunchType(punchType)) {
    case 'ENTRY':
      return 'Entrada';
    case 'INTERVAL_START':
      return 'Saída Almoço';
    case 'INTERVAL_END':
      return 'Retorno Almoço';
    case 'EXIT':
      return 'Saída';
  }
}

function extractClientIp(request: any): string | null {
  const xff = request.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  const realIp = request.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return request.ip || null;
}

class PunchDomainError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, any>
  ) {
    super(message);
  }
}

export const timeTrackingRoutes: FastifyPluginAsync = async (app) => {
  const storageService = new StorageService();

  const processEnterprisePunch = async (
    request: any,
    payload: z.infer<typeof enterprisePunchSchema>
  ) => {
    const tenantId = request.user!.tenant_id!;
    const userId = request.user!.sub;
    const role = request.user!.role;
    const normPunchType = normalizePunchType(payload.punchType);
    const clientIp = extractClientIp(request);

    // Prepara buffer da selfie se enviada (antes de entrar na transação do banco)
    let selfieFileId: string | null = null;
    let parsedSelfieBuffer: Buffer | null = null;
    if (payload.selfieBase64) {
      const cleaned = payload.selfieBase64.replace(/^data:image\/\w+;base64,/, '');
      parsedSelfieBuffer = Buffer.from(cleaned, 'base64');
      if (parsedSelfieBuffer.length === 0 || parsedSelfieBuffer.length > 5 * 1024 * 1024) {
        throw new PunchDomainError(400, 'INVALID_SELFIE', 'Selfie inválida ou excede 5 MB.');
      }
    }

    const dbRes = await request.withContext(async (client: any) => {
      // 1. Localiza trabalhador e valida ownership (anti-IDOR)
      const targetWorkerId = payload.workerId || request.user!.worker_id || null;
      let wRows: any[];
      if (targetWorkerId) {
        ({ rows: wRows } = await client.query(
          `SELECT id, user_id, full_name FROM public.workers WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1;`,
          [targetWorkerId, tenantId]
        ));
      } else {
        ({ rows: wRows } = await client.query(
          `SELECT id, user_id, full_name FROM public.workers WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1;`,
          [userId, tenantId]
        ));
      }

      if (wRows.length === 0) {
        throw new PunchDomainError(404, 'NOT_FOUND', 'Colaborador não localizado no tenant ativo.');
      }
      const worker = wRows[0];

      if (role === 'employee' && worker.user_id !== userId && request.user!.worker_id !== worker.id) {
        throw new PunchDomainError(
          403,
          'FORBIDDEN_PUNCH_OWNERSHIP',
          'Acesso negado: Não é permitido registrar ponto para outro colaborador.'
        );
      }

      // 2. Idempotência por clientUuid (fundamental para Offline PWA)
      if (payload.clientUuid) {
        const { rows: dupRows } = await client.query(
          `SELECT id, nsr, punched_at, device_timestamp, server_received_at, sync_origin,
                  receipt_code, punch_type, geofence_status, distance_meters, speed_kmh,
                  fraud_flags, sha256_hash, selfie_file_id
           FROM public.time_punch_records
           WHERE tenant_id = $1::uuid AND client_uuid = $2::uuid
           LIMIT 1;`,
          [tenantId, payload.clientUuid]
        );
        if (dupRows.length > 0) {
          return { duplicate: true, record: dupRows[0] };
        }
      }

      // 3. Valida contrato de trabalho ACTIVE
      const { rows: cRows } = await client.query(
        `SELECT id, company_id, workplace_id, regime
         FROM public.contracts
         WHERE worker_id = $1::uuid AND tenant_id = $2::uuid AND status = 'ACTIVE' AND deleted_at IS NULL
         ORDER BY admission_date DESC
         LIMIT 1;`,
        [worker.id, tenantId]
      );
      if (cRows.length === 0) {
        throw new PunchDomainError(
          422,
          'INACTIVE_CONTRACT',
          'Registro de ponto bloqueado: Colaborador não possui contrato de trabalho ativo.'
        );
      }
      const contract = cRows[0];

      // 4. Valida consentimento LGPD ativo caso haja captura de selfie
      if (parsedSelfieBuffer) {
        const { rows: consentRows } = await client.query(
          `SELECT id FROM public.lgpd_consents
           WHERE tenant_id = $1::uuid
             AND worker_id = $2::uuid
             AND consent_category = 'BIOMETRIC_SELFIE_PUNCH'
             AND granted = TRUE
             AND revoked_at IS NULL
           LIMIT 1;`,
          [tenantId, worker.id]
        );
        if (consentRows.length === 0) {
          throw new PunchDomainError(
            403,
            'LGPD_SELFIE_CONSENT_REQUIRED',
            'Consentimento LGPD ativo para captura de selfie na marcação de ponto não encontrado.'
          );
        }
      }

      // 5. Debounce server-side de 60 segundos + busca de última batida com GPS
      const effectiveTimestamp =
        payload.syncOrigin === 'OFFLINE_PWA' && payload.deviceTimestamp
          ? new Date(payload.deviceTimestamp)
          : new Date();
      if (Number.isNaN(effectiveTimestamp.getTime())) {
        throw new PunchDomainError(400, 'INVALID_TIMESTAMP', 'deviceTimestamp inválido.');
      }

      const { rows: prevRows } = await client.query(
        `SELECT punched_at, latitude, longitude
         FROM public.time_punch_records
         WHERE tenant_id = $1::uuid AND contract_id = $2::uuid
         ORDER BY punched_at DESC
         LIMIT 1;`,
        [tenantId, contract.id]
      );
      const prevPunch = prevRows[0] || null;
      if (prevPunch && payload.syncOrigin === 'ONLINE_API') {
        const diffMs = Math.abs(effectiveTimestamp.getTime() - new Date(prevPunch.punched_at).getTime());
        if (diffMs < 60_000) {
          throw new PunchDomainError(
            429,
            'PUNCH_DEBOUNCE_60S',
            'Aguarde ao menos 60 segundos entre marcações consecutivas.'
          );
        }
      }

      // 6. Carrega múltiplos locais permitidos (PONTO-02) ou fallback para workplace_id do contrato
      const { rows: allowedWpRows } = await client.query(
        `SELECT wp.id, wp.name, wp.latitude, wp.longitude, wp.radius_meters,
                wp.enforce_geofence, wp.max_accuracy_meters,
                COALESCE(caw.allow_external_audit, wp.allow_external_audit, FALSE) AS allow_external_audit,
                caw.is_primary
         FROM public.contract_allowed_workplaces caw
         JOIN public.workplaces wp ON wp.id = caw.workplace_id
         WHERE caw.tenant_id = $1::uuid AND caw.contract_id = $2::uuid AND caw.is_active = TRUE
           AND wp.deleted_at IS NULL
         ORDER BY caw.is_primary DESC, wp.name ASC;`,
        [tenantId, contract.id]
      );

      let workplaces: AllowedWorkplaceConfig[] = allowedWpRows.map((r: any) => ({
        id: r.id,
        name: r.name,
        latitude: r.latitude !== null ? Number(r.latitude) : null,
        longitude: r.longitude !== null ? Number(r.longitude) : null,
        radius_meters: Number(r.radius_meters || 50),
        enforce_geofence: Boolean(r.enforce_geofence),
        max_accuracy_meters: Number(r.max_accuracy_meters || 150),
        allow_external_audit: Boolean(r.allow_external_audit),
        is_primary: Boolean(r.is_primary),
      }));

      if (workplaces.length === 0 && contract.workplace_id) {
        const { rows: singleWp } = await client.query(
          `SELECT id, name, latitude, longitude, radius_meters, enforce_geofence,
                  max_accuracy_meters, allow_external_audit
           FROM public.workplaces
           WHERE id = $1::uuid AND deleted_at IS NULL LIMIT 1;`,
          [contract.workplace_id]
        );
        if (singleWp.length > 0) {
          const w = singleWp[0];
          workplaces = [
            {
              id: w.id,
              name: w.name,
              latitude: w.latitude !== null ? Number(w.latitude) : null,
              longitude: w.longitude !== null ? Number(w.longitude) : null,
              radius_meters: Number(w.radius_meters || 50),
              enforce_geofence: Boolean(w.enforce_geofence),
              max_accuracy_meters: Number(w.max_accuracy_meters || 150),
              allow_external_audit: Boolean(w.allow_external_audit),
              is_primary: true,
            },
          ];
        }
      }

      // 7. Validação Anti-Spoofing & Multi-Geofence
      const geoEval = validateAntiSpoofingAndMultiGeofence({
        userLat: payload.latitude ?? null,
        userLon: payload.longitude ?? null,
        userAccuracy: payload.accuracy ?? null,
        isMockGps: Boolean(payload.isMockLocation),
        workplaces,
        isTelework: contract.regime === 'TELEWORK',
        previousPunch:
          prevPunch && prevPunch.latitude !== null && prevPunch.longitude !== null
            ? {
                latitude: Number(prevPunch.latitude),
                longitude: Number(prevPunch.longitude),
                punchedAt: prevPunch.punched_at,
              }
            : null,
        currentTimestamp: effectiveTimestamp,
      });

      if (!geoEval.isAllowed) {
        const errCode = geoEval.status === 'SPOOF_SUSPECT' ? 'SPOOF_DETECTED' : 'GEOFENCE_VIOLATION';
        throw new PunchDomainError(403, errCode, geoEval.message, {
          geofenceStatus: geoEval.status,
          fraudFlags: geoEval.fraudFlags,
          distanceMeters: geoEval.distanceMeters,
        });
      }

      // 8. Persiste selfie criptografada no storage privado caso tenha sido enviada
      if (parsedSelfieBuffer) {
        const stored = await storageService.upload({
          tenantId,
          workerId: worker.id,
          category: 'PUNCH_SELFIE',
          originalName: `selfie_ponto_${Date.now()}.jpg`,
          mimeType: payload.selfieMimeType || 'image/jpeg',
          buffer: parsedSelfieBuffer,
          uploadedBy: userId,
          isPrivate: true,
        });
        selfieFileId = stored.id;
      }

      // 9. Provisiona dispositivo móvel virtual e incrementa NSR atomicamente
      let { rows: devRows } = await client.query(
        `SELECT id FROM public.time_devices
         WHERE tenant_id = $1::uuid AND kind = 'REP_P_MOBILE' AND status = 'ACTIVE'
         LIMIT 1;`,
        [tenantId]
      );
      let deviceId: string;
      if (devRows.length === 0) {
        const insDev = await client.query(
          `INSERT INTO public.time_devices (tenant_id, company_id, name, kind, status)
           VALUES ($1::uuid, $2::uuid, 'REP-P Mobile CoupleRH', 'REP_P_MOBILE', 'ACTIVE')
           RETURNING id;`,
          [tenantId, contract.company_id]
        );
        deviceId = insDev.rows[0].id;
      } else {
        deviceId = devRows[0].id;
      }

      const { rows: nsrRows } = await client.query(
        `UPDATE public.time_devices SET last_nsr = last_nsr + 1, updated_at = NOW() WHERE id = $1::uuid RETURNING last_nsr;`,
        [deviceId]
      );
      const nextNsr = Number(nsrRows[0].last_nsr);

      const datePart = effectiveTimestamp.toISOString().slice(0, 10).replace(/-/g, '');
      const receiptCode = `RCP-${datePart}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const sha256Hash = crypto
        .createHash('sha256')
        .update(`${tenantId}:${contract.id}:${nextNsr}:${effectiveTimestamp.toISOString()}:${receiptCode}`)
        .digest('hex');

      const { rows: insertedRows } = await client.query(
        `INSERT INTO public.time_punch_records (
           tenant_id, company_id, contract_id, worker_id, device_id, workplace_id,
           nsr, record_type, punched_at, device_timestamp, server_received_at, sync_origin,
           punch_type, source, latitude, longitude, accuracy, is_mock_location,
           geofence_status, distance_meters, speed_kmh, fraud_flags, ip_address,
           device_fingerprint, receipt_code, selfie_file_id, client_uuid, sha256_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7, 3, $8::timestamptz, $9::timestamptz, NOW(), $10,
           $11, 'MOBILE', $12, $13, $14, $15,
           $16, $17, $18, $19::jsonb, $20::inet,
           $21, $22, $23::uuid, $24::uuid, $25
         )
         RETURNING id, nsr, punched_at, device_timestamp, server_received_at, sync_origin,
                   receipt_code, punch_type, geofence_status, distance_meters, speed_kmh,
                   fraud_flags, sha256_hash, selfie_file_id;`,
        [
          tenantId,
          contract.company_id,
          contract.id,
          worker.id,
          deviceId,
          geoEval.matchedWorkplaceId || contract.workplace_id || null,
          nextNsr,
          effectiveTimestamp.toISOString(),
          payload.deviceTimestamp ? new Date(payload.deviceTimestamp).toISOString() : effectiveTimestamp.toISOString(),
          payload.syncOrigin || 'ONLINE_API',
          normPunchType,
          payload.latitude ?? null,
          payload.longitude ?? null,
          payload.accuracy ?? null,
          Boolean(payload.isMockLocation),
          geoEval.status,
          geoEval.distanceMeters,
          geoEval.speedKmh,
          JSON.stringify(geoEval.fraudFlags),
          clientIp,
          payload.deviceFingerprint || null,
          receiptCode,
          selfieFileId,
          payload.clientUuid || null,
          sha256Hash,
        ]
      );

      return { duplicate: false, record: insertedRows[0], geoEval };
    });

    const rec = dbRes.record;
    const basePublic = env.APP_PUBLIC_URL.replace(/\/+$/, '');
    const verificationUrl = `${basePublic}/verificar-ponto/${rec.receipt_code || rec.id}`;
    const qrCodeDataUrl = await QRCode.toDataURL(verificationUrl, { margin: 1, width: 220 });

    return {
      duplicate: dbRes.duplicate,
      data: {
        ...rec,
        punch_id: rec.id,
        entry_type_label: getPunchTypePtBr(rec.punch_type),
        verification_url: verificationUrl,
        qr_code_data_url: qrCodeDataUrl,
      },
    };
  };

  /**
   * PONTO-01 a PONTO-04: Endpoint Único de Marcação de Ponto Enterprise
   * JWT + Ownership + Contrato ACTIVE + Debounce 60s + Multi-Geofence + Anti-Spoofing + Selfie LGPD + QR Code
   */
  app.post('/punch', { preHandler: [authenticate] }, async (request, reply) => {
    const parse = enterprisePunchSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.status(400).send({
        success: false,
        error: 'Dados de marcação inválidos.',
        details: parse.error.format(),
      });
    }
    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    try {
      const result = await processEnterprisePunch(request, parse.data);
      return reply.status(result.duplicate ? 200 : 201).send({
        success: true,
        duplicate: result.duplicate,
        data: result.data,
      });
    } catch (err: any) {
      if (err instanceof PunchDomainError) {
        return reply.status(err.statusCode).send({
          success: false,
          code: err.code,
          error: err.message,
          ...(err.extra || {}),
        });
      }
      request.log.error(err, '[ENTERPRISE_PUNCH] Falha ao registrar ponto');
      return reply.status(400).send({ success: false, error: err.message || 'Erro ao registrar ponto.' });
    }
  });

  /**
   * PONTO-03: Sincronização de Lote Offline PWA (IndexedDB -> API) com idempotência por clientUuid
   */
  app.post('/punch/sync-offline', { preHandler: [authenticate] }, async (request, reply) => {
    const parse = syncOfflineSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.status(400).send({ success: false, details: parse.error.format() });
    }
    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
    }

    const sorted = [...parse.data.punches].sort((a, b) => {
      const ta = a.deviceTimestamp ? Date.parse(a.deviceTimestamp) : 0;
      const tb = b.deviceTimestamp ? Date.parse(b.deviceTimestamp) : 0;
      return ta - tb;
    });

    let syncedCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;
    const results: any[] = [];

    for (const item of sorted) {
      try {
        const res = await processEnterprisePunch(request, {
          ...item,
          syncOrigin: 'OFFLINE_PWA',
        });
        if (res.duplicate) duplicateCount++;
        else syncedCount++;
        results.push({ clientUuid: item.clientUuid || null, status: res.duplicate ? 'DUPLICATE' : 'SYNCED', data: res.data });
      } catch (err: any) {
        errorCount++;
        results.push({
          clientUuid: item.clientUuid || null,
          status: 'ERROR',
          code: err instanceof PunchDomainError ? err.code : 'SYNC_ERROR',
          error: err.message,
        });
      }
    }

    return reply.send({
      success: true,
      data: { syncedCount, duplicateCount, errorCount, results },
    });
  });

  /**
   * PONTO-02: Gestão de Múltiplos Locais Permitidos por Contrato (contract_allowed_workplaces)
   */
  app.get(
    '/contracts/:contractId/allowed-workplaces',
    { preHandler: [authenticate, requirePermission('view_time_tracking')] },
    async (request, reply) => {
      const { contractId } = request.params as { contractId: string };
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const rows = await request.withContext(async (client) => {
        const { rows: list } = await client.query(
          `SELECT caw.*, wp.name, wp.address, wp.latitude, wp.longitude, wp.radius_meters, wp.enforce_geofence
           FROM public.contract_allowed_workplaces caw
           JOIN public.workplaces wp ON wp.id = caw.workplace_id
           WHERE caw.contract_id = $1::uuid AND caw.is_active = TRUE
           ORDER BY caw.is_primary DESC, wp.name ASC;`,
          [contractId]
        );
        return list;
      });
      return reply.send({ success: true, data: rows });
    }
  );

  app.put(
    '/contracts/:contractId/allowed-workplaces',
    { preHandler: [authenticate, requirePermission('manage_time_tracking')] },
    async (request, reply) => {
      const { contractId } = request.params as { contractId: string };
      const parse = allowedWorkplacesSchema.safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const tenantId = request.user!.tenant_id!;
      const saved = await request.withContext(async (client) => {
        await client.query(
          `DELETE FROM public.contract_allowed_workplaces WHERE tenant_id = $1::uuid AND contract_id = $2::uuid;`,
          [tenantId, contractId]
        );
        const inserted: any[] = [];
        for (const wp of parse.data.workplaces) {
          const { rows } = await client.query(
            `INSERT INTO public.contract_allowed_workplaces (
               tenant_id, contract_id, workplace_id, is_primary, allow_external_audit
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
             RETURNING *;`,
            [tenantId, contractId, wp.workplaceId, wp.isPrimary, wp.allowExternalAudit]
          );
          inserted.push(rows[0]);
        }
        return inserted;
      });

      return reply.send({ success: true, data: saved });
    }
  );

  /**
   * PONTO-02: Auditoria GPS e Anti-Spoofing para o RH (Mapa Leaflet, precisão, distância e fraud_flags)
   */
  app.get(
    '/punches/audit',
    { preHandler: [authenticate, requirePermission('view_time_tracking')] },
    async (request, reply) => {
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });
      const query = request.query as {
        companyId?: string;
        contractId?: string;
        startDate?: string;
        endDate?: string;
        onlyFlagged?: string;
      };
      const tenantId = request.user!.tenant_id!;

      const rows = await request.withContext(async (client) => {
        const { rows: list } = await client.query(
          `SELECT tpr.id, tpr.contract_id, tpr.worker_id, tpr.workplace_id,
                  tpr.nsr, tpr.punched_at, tpr.device_timestamp, tpr.server_received_at,
                  tpr.sync_origin, tpr.punch_type, tpr.source,
                  tpr.latitude, tpr.longitude, tpr.accuracy, tpr.is_mock_location,
                  tpr.geofence_status, tpr.distance_meters, tpr.speed_kmh,
                  tpr.fraud_flags, tpr.ip_address, tpr.receipt_code, tpr.selfie_file_id,
                  w.full_name AS worker_name, c.registration_number,
                  wp.name AS workplace_name, wp.latitude AS workplace_latitude,
                  wp.longitude AS workplace_longitude, wp.radius_meters AS workplace_radius_meters
           FROM public.time_punch_records tpr
           LEFT JOIN public.contracts c ON c.id = tpr.contract_id
           LEFT JOIN public.workers w ON w.id = tpr.worker_id
           LEFT JOIN public.workplaces wp ON wp.id = COALESCE(tpr.workplace_id, c.workplace_id)
           WHERE tpr.tenant_id = $1::uuid
             AND (tpr.contract_id IS NULL OR public.can_access_contract(tpr.tenant_id, tpr.contract_id))
             AND ($2::uuid IS NULL OR tpr.company_id = $2::uuid)
             AND ($3::uuid IS NULL OR tpr.contract_id = $3::uuid)
             AND ($4::date IS NULL OR (tpr.punched_at AT TIME ZONE 'America/Sao_Paulo')::date >= $4::date)
             AND ($5::date IS NULL OR (tpr.punched_at AT TIME ZONE 'America/Sao_Paulo')::date <= $5::date)
             AND (
               $6::boolean = FALSE
               OR jsonb_array_length(COALESCE(tpr.fraud_flags, '[]'::jsonb)) > 0
               OR tpr.geofence_status IN ('OUTSIDE', 'SPOOF_SUSPECT', 'AUDIT_ONLY')
             )
           ORDER BY tpr.punched_at DESC
           LIMIT 250;`,
          [
            tenantId,
            query.companyId || null,
            query.contractId || null,
            query.startDate || null,
            query.endDate || null,
            query.onlyFlagged === 'true',
          ]
        );
        return list.map((r: any) => ({
          ...r,
          entry_type_label: getPunchTypePtBr(r.punch_type),
          selfie_signed_url: r.selfie_file_id
            ? storageService.generateSignedDownloadUrl(r.selfie_file_id, 600, true)
            : null,
        }));
      });

      return reply.send({ success: true, data: rows });
    }
  );

  /**
   * PONTO-07: Recálculo Diário de Jornada Avançada (OJ 97 Noturna Composta, Sobreaviso, Prontidão e Banco CCT)
   */
  app.post(
    '/daily-summary/recalculate',
    { preHandler: [authenticate, requirePermission('manage_time_tracking')] },
    async (request, reply) => {
      const parse = recalculateDailySchema.safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext) return reply.status(500).send({ success: false, error: 'Contexto não inicializado.' });

      const d = parse.data;
      const tenantId = request.user!.tenant_id!;

      const saved = await request.withContext(async (client) => {
        const { rows: cRows } = await client.query(
          `SELECT c.id, c.company_id, c.collective_agreement_id,
                  ws.shift_type, ws.schedule_data, ws.night_start_hour, ws.night_end_hour,
                  ws.night_extended_prorrogation,
                  ca.time_bank_allow_negative, ca.time_bank_max_negative_minutes, ca.time_bank_negative_deduction_rule
           FROM public.contracts c
           LEFT JOIN public.contract_work_shifts cws ON cws.contract_id = c.id AND cws.valid_from <= $2::date AND (cws.valid_to IS NULL OR cws.valid_to >= $2::date)
           LEFT JOIN public.work_shifts ws ON ws.id = cws.work_shift_id
           LEFT JOIN public.collective_agreements ca ON ca.id = c.collective_agreement_id
           WHERE c.id = $1::uuid AND c.tenant_id = $3::uuid
           ORDER BY cws.valid_from DESC LIMIT 1;`,
          [d.contractId, d.workDate, tenantId]
        );
        if (cRows.length === 0) return null;
        const cfg = cRows[0];

        const { rows: punchRows } = await client.query(
          `SELECT punched_at
           FROM public.time_punch_records
           WHERE tenant_id = $1::uuid AND contract_id = $2::uuid
             AND punched_at >= ($3::date::timestamp - interval '4 hours')
             AND punched_at <= ($3::date::timestamp + interval '36 hours')
           ORDER BY punched_at ASC;`,
          [tenantId, d.contractId, d.workDate]
        );

        // Mantém batidas do dia civil + encerramentos da madrugada até 08:00 quando começou no dia
        const dayStartMs = Date.parse(`${d.workDate}T00:00:00`);
        const nextMorningLimitMs = dayStartMs + 34 * 3600 * 1000;
        const punchesIso = punchRows
          .map((p: any) => new Date(p.punched_at))
          .filter((dt: Date) => dt.getTime() >= dayStartMs && dt.getTime() <= nextMorningLimitMs)
          .map((dt: Date) => dt.toISOString());

        const shiftType = String(cfg.shift_type || 'WEEKLY');
        const summary = calculateDailyWorkShift({
          date: d.workDate,
          contract_id: d.contractId,
          tenant_id: tenantId,
          company_id: cfg.company_id,
          punches: punchesIso,
          schedule: {
            schedule_type: shiftType.includes('12X36') ? 'SHIFT_12X36' : 'FIXED',
            expected_work_minutes: shiftType.includes('12X36') ? 720 : 480,
            expected_break_minutes: 60,
          },
          isHolidayOrDsr: d.isHolidayOrDsr,
          overtime_regime: 'TIME_BANK',
          standbyMinutes: d.standbyMinutes,
          readinessMinutes: d.readinessMinutes,
          nightStartHour: Number(cfg.night_start_hour ?? 22),
          nightEndHour: Number(cfg.night_end_hour ?? 5),
          nightExtendedProrrogation: Boolean(cfg.night_extended_prorrogation ?? true),
        });

        let timeBankEval = null;
        if (summary.delay_minutes > 0) {
          const { rows: bankRows } = await client.query(
            `SELECT balance_minutes FROM public.time_bank_accounts WHERE tenant_id = $1::uuid AND contract_id = $2::uuid LIMIT 1;`,
            [tenantId, d.contractId]
          );
          const currentBalance = Number(bankRows[0]?.balance_minutes || 0);
          timeBankEval = evaluateNegativeTimeBankPolicy({
            currentBalanceMinutes: currentBalance,
            requestedDebitMinutes: summary.delay_minutes,
            allowNegative: cfg.time_bank_allow_negative !== false,
            maxNegativeMinutes: Number(cfg.time_bank_max_negative_minutes ?? 2400),
            deductionRule: (cfg.time_bank_negative_deduction_rule || 'COMPENSATE_ONLY') as any,
            eventContext: 'DAILY',
          });
        }

        const { rows: upRows } = await client.query(
          `INSERT INTO public.time_punch_daily_summaries (
             tenant_id, contract_id, work_date, expected_hours, worked_hours,
             overtime_50_hours, overtime_100_hours, night_hours,
             night_overtime_50_hours, night_overtime_100_hours, standby_hours, readiness_hours,
             delay_hours, time_bank_balance_hours, inconsistencies_json, punches
           ) VALUES (
             $1::uuid, $2::uuid, $3::date, $4, $5,
             $6, $7, $8,
             $9, $10, $11, $12,
             $13, $14, $15::jsonb, $16::jsonb
           )
           ON CONFLICT (tenant_id, contract_id, work_date) DO UPDATE SET
             worked_hours = EXCLUDED.worked_hours,
             overtime_50_hours = EXCLUDED.overtime_50_hours,
             overtime_100_hours = EXCLUDED.overtime_100_hours,
             night_hours = EXCLUDED.night_hours,
             night_overtime_50_hours = EXCLUDED.night_overtime_50_hours,
             night_overtime_100_hours = EXCLUDED.night_overtime_100_hours,
             standby_hours = EXCLUDED.standby_hours,
             readiness_hours = EXCLUDED.readiness_hours,
             delay_hours = EXCLUDED.delay_hours,
             time_bank_balance_hours = EXCLUDED.time_bank_balance_hours,
             inconsistencies_json = EXCLUDED.inconsistencies_json,
             punches = EXCLUDED.punches,
             updated_at = NOW()
           RETURNING *;`,
          [
            tenantId,
            d.contractId,
            d.workDate,
            Math.round((summary.expected_work_minutes / 60) * 100) / 100,
            Math.round((summary.worked_minutes / 60) * 100) / 100,
            Math.round((summary.overtime_50_minutes / 60) * 100) / 100,
            Math.round((summary.overtime_100_minutes / 60) * 100) / 100,
            Math.round((summary.night_shift_minutes / 60) * 100) / 100,
            Math.round((summary.night_overtime_minutes / 60) * 100) / 100,
            Math.round(((summary.night_overtime_100_minutes || 0) / 60) * 100) / 100,
            Math.round(((summary.standby_minutes || 0) / 60) * 100) / 100,
            Math.round(((summary.readiness_minutes || 0) / 60) * 100) / 100,
            Math.round((summary.delay_minutes / 60) * 100) / 100,
            Math.round(((summary.time_bank_credited_minutes - summary.time_bank_debited_minutes) / 60) * 100) / 100,
            JSON.stringify(summary.inconsistencies),
            JSON.stringify(punchesIso),
          ]
        );

        return { record: upRows[0], summary, timeBankEval };
      });

      if (!saved) return reply.status(404).send({ success: false, error: 'Contrato não encontrado.' });
      return reply.send({ success: true, data: saved });
    }
  );

  // Integração Ponto -> Folha (BUG-04 + PONTO-07: HE Noturna OJ 97, Sobreaviso e Prontidão com manual_value = NULL)
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
          const rHeNight50 = findRubricId(['108']);
          const rHeNight100 = findRubricId(['109']);
          const rNight = findRubricId(['301'], 'ADIC_NOTURNO');
          const rStandby = findRubricId(['124']);
          const rReadiness = findRubricId(['125']);
          const rAbsence = findRubricId(['801'], 'ABSENCE');
          const rLate = findRubricId(['803', '802'], 'LATE');

          let sql = `
            SELECT
              contract_id,
              COALESCE(SUM(overtime_50_hours), 0) AS he50,
              COALESCE(SUM(overtime_100_hours), 0) AS he100,
              COALESCE(SUM(night_overtime_50_hours), 0) AS he_night_50,
              COALESCE(SUM(night_overtime_100_hours), 0) AS he_night_100,
              COALESCE(SUM(night_hours), 0) AS night_hours,
              COALESCE(SUM(standby_hours), 0) AS standby_hours,
              COALESCE(SUM(readiness_hours), 0) AS readiness_hours,
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
              { rubricId: rHeNight50, qty: Number(row.he_night_50), ref: `INTEGRAÇÃO_PONTO: HE Noturna 50% OJ 97 (${row.he_night_50}h)` },
              { rubricId: rHeNight100, qty: Number(row.he_night_100), ref: `INTEGRAÇÃO_PONTO: HE Noturna 100% OJ 97 (${row.he_night_100}h)` },
              { rubricId: rNight, qty: Number(row.night_hours), ref: `INTEGRAÇÃO_PONTO: Adic. Noturno (${row.night_hours}h)` },
              { rubricId: rStandby, qty: Number(row.standby_hours), ref: `INTEGRAÇÃO_PONTO: Sobreaviso 1/3 (${row.standby_hours}h)` },
              { rubricId: rReadiness, qty: Number(row.readiness_hours), ref: `INTEGRAÇÃO_PONTO: Prontidão 2/3 (${row.readiness_hours}h)` },
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

  // Ponto Mobile Seguro legado (mantido para compatibilidade total com suíte SEC-01/P0)
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

  // Ingestão Segura de Relógios Físicos REP com Autenticação de Dispositivo (timingSafeEqual) e Lookup em workers.pis
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

    const parseResult = repIngestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'Estrutura do lote de ponto AFD inválida.',
        details: parseResult.error.format(),
      });
    }

    const { records } = parseResult.data;

    try {
      const summary = await withTenantContext(
        { tenantId: device.tenant_id, role: 'system_admin' },
        async (client) => {
          let processed = 0;
          let orphans = 0;

          for (const rec of records) {
            const cleanPis = rec.pis.replace(/\D/g, '');

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

            if (!workerId) orphans++;

            const punchHash =
              rec.sha256Hash ||
              crypto.createHash('sha256').update(`${device.tenant_id}:${serial}:${rec.nsr}:${rec.punchedAt}`).digest('hex');

            await client.query(
              `INSERT INTO public.time_punch_records (
                tenant_id, company_id, contract_id, worker_id, device_id,
                nsr, record_type, punched_at, punch_type, source, sync_origin, sha256_hash
              ) VALUES ($1, $2, $3, $4, $5, $6, 3, $7, $8, 'REP', 'REP_AFD', $9)
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
