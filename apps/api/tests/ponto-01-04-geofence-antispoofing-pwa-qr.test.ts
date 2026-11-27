import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V8 — PONTO-01 a PONTO-04 (Integração API + PostgreSQL Real)
 *
 * Validações E2E:
 * 1. PONTO-01: Ownership IDOR (403), contrato inativo (422), debounce 60s (429),
 *    IP real (x-forwarded-for), anti-spoofing (mock GPS, accuracy=0, teletransporte > 120 km/h).
 * 2. PONTO-02: Múltiplos locais permitidos (`contract_allowed_workplaces`) e auditoria GPS RH (`GET /punches/audit`).
 * 3. PONTO-03: Sincronização Offline PWA (`POST /punch/sync-offline`) com `sync_origin = 'OFFLINE_PWA'`,
 *    `device_timestamp` separado de `server_received_at` e idempotência por `clientUuid`.
 * 4. PONTO-04: QR Code REP-P (PNG DataURL sem CPF na URL), verificação pública `/api/v1/public/verify-punch/:code`
 *    e captura opcional de selfie condicionada a consentimento ativo em `lgpd_consents`.
 */
describe('PONTO-01 a 04: Endpoint Único GPS Anti-Spoofing, Multi-Locais, Offline PWA & QR/Selfie', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;
  let tokenEmp1: string;
  let tokenEmp2: string;
  let tokenInactive: string;

  const tenantId = 'f8010000-0000-0000-0000-000000000001';
  const companyId = 'f8010000-0000-0000-0000-000000000011';
  const estId = 'f8010000-0000-0000-0000-000000000021';
  const posId = 'f8010000-0000-0000-0000-000000000031';
  const wpMatrizId = 'f8010000-0000-0000-0000-000000000041';
  const wpFilialId = 'f8010000-0000-0000-0000-000000000042';
  const wpExternalId = 'f8010000-0000-0000-0000-000000000043';

  const runSuffix = crypto.randomBytes(4).toString('hex');
  const adminUserId = crypto.randomUUID();
  const emp1UserId = crypto.randomUUID();
  const emp2UserId = crypto.randomUUID();
  const inactiveUserId = crypto.randomUUID();

  const worker1Id = crypto.randomUUID();
  const worker2Id = crypto.randomUUID();
  const workerInactiveId = crypto.randomUUID();
  const workerExtId = crypto.randomUUID();

  const contract1Id = crypto.randomUUID();
  const contract2Id = crypto.randomUUID();
  const contractInactiveId = crypto.randomUUID();
  const contractExtId = crypto.randomUUID();

  const cpf1 = `8011${String(Math.floor(Math.random() * 9000000 + 1000000))}`;
  const cpf2 = `8012${String(Math.floor(Math.random() * 9000000 + 1000000))}`;
  const cpfInact = `8013${String(Math.floor(Math.random() * 9000000 + 1000000))}`;
  const cpfExt = `8014${String(Math.floor(Math.random() * 9000000 + 1000000))}`;

  let generatedReceiptCode = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Ponto0104!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(
        `INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V8 Ponto GPS', 'ACTIVE')
         ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';`,
        [tenantId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Ponto Enterprise V8 Ltda', '80100000000108', 'LUCRO_REAL', 'ACTIVE')
         ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';`,
        [companyId, tenantId]
      );
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz V8', '80100000000108')
         ON CONFLICT (id) DO NOTHING;`,
        [estId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1::uuid, $2::uuid, 'Consultor de Campo', '252105')
         ON CONFLICT (id) DO NOTHING;`,
        [posId, tenantId]
      );

      // Locais de trabalho: Matriz SP, Filial Paulista (cerca ativa) e Externo Auditável
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, latitude, longitude, radius_meters, enforce_geofence, max_accuracy_meters, allow_external_audit)
         VALUES
           ($1::uuid, $4::uuid, $5::uuid, 'Matriz Centro SP', -23.55052, -46.633308, 100, TRUE, 150, FALSE),
           ($2::uuid, $4::uuid, $5::uuid, 'Filial Paulista', -23.561414, -46.655881, 150, TRUE, 150, FALSE),
           ($3::uuid, $4::uuid, $5::uuid, 'Atendimento Externo', -23.55052, -46.633308, 100, FALSE, 150, TRUE)
         ON CONFLICT (id) DO UPDATE SET
           latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           radius_meters = EXCLUDED.radius_meters,
           enforce_geofence = EXCLUDED.enforce_geofence,
           allow_external_audit = EXCLUDED.allow_external_audit;`,
        [wpMatrizId, wpFilialId, wpExternalId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active) VALUES
           ($1::uuid, $5, 'Admin V8 Ponto', $9, TRUE),
           ($2::uuid, $6, 'Colab Um V8', $9, TRUE),
           ($3::uuid, $7, 'Colab Dois V8', $9, TRUE),
           ($4::uuid, $8, 'Colab Inativo V8', $9, TRUE);`,
        [
          adminUserId,
          emp1UserId,
          emp2UserId,
          inactiveUserId,
          `adm.v8.${runSuffix}@couplerh.test`,
          `emp1.v8.${runSuffix}@couplerh.test`,
          `emp2.v8.${runSuffix}@couplerh.test`,
          `inact.v8.${runSuffix}@couplerh.test`,
          pwHash,
        ]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, user_id, full_name, cpf, birth_date, is_active) VALUES
           ($1::uuid, $5::uuid, $6::uuid, 'Eduardo Silva Ponto', $9, '1991-03-10', TRUE),
           ($2::uuid, $5::uuid, $7::uuid, 'Fernanda Lima Ponto', $10, '1993-07-20', TRUE),
           ($3::uuid, $5::uuid, $8::uuid, 'Marcos Suspenso', $11, '1988-01-05', TRUE),
           ($4::uuid, $5::uuid, NULL, 'Camila Campo Externo', $12, '1992-11-11', TRUE);`,
        [worker1Id, worker2Id, workerInactiveId, workerExtId, tenantId, emp1UserId, emp2UserId, inactiveUserId, cpf1, cpf2, cpfInact, cpfExt]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, worker_id, is_active) VALUES
           ($1::uuid, $2::uuid, 'system_admin', NULL, TRUE),
           ($1::uuid, $3::uuid, 'employee', $6::uuid, TRUE),
           ($1::uuid, $4::uuid, 'employee', $7::uuid, TRUE),
           ($1::uuid, $5::uuid, 'employee', $8::uuid, TRUE);`,
        [tenantId, adminUserId, emp1UserId, emp2UserId, inactiveUserId, worker1Id, worker2Id, workerInactiveId]
      );

      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, registration_number, admission_date, base_salary, salary_type,
           monthly_hours, weekly_hours, regime, status
         ) VALUES
           ($1::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $11::uuid, $15, '2025-01-01', 4000, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE'),
           ($2::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $12::uuid, $16, '2025-01-01', 4000, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE'),
           ($3::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $13::uuid, $17, '2025-01-01', 4000, 'MONTHLY', 220, 44, 'CLT', 'SUSPENDED'),
           ($4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $10::uuid, $14::uuid, $18, '2025-01-01', 4000, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE');`,
        [
          contract1Id,
          contract2Id,
          contractInactiveId,
          contractExtId,
          tenantId,
          companyId,
          estId,
          posId,
          wpMatrizId,
          wpExternalId,
          worker1Id,
          worker2Id,
          workerInactiveId,
          workerExtId,
          `MAT-V8-1-${runSuffix}`,
          `MAT-V8-2-${runSuffix}`,
          `MAT-V8-3-${runSuffix}`,
          `MAT-V8-4-${runSuffix}`,
        ]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const [sAdm, sE1, sE2, sInact] = await Promise.all([
      tokenService.createSession({ userId: adminUserId, tenantId, role: 'system_admin', aal: 'aal2' }),
      tokenService.createSession({ userId: emp1UserId, tenantId, role: 'employee', workerId: worker1Id }),
      tokenService.createSession({ userId: emp2UserId, tenantId, role: 'employee', workerId: worker2Id }),
      tokenService.createSession({ userId: inactiveUserId, tenantId, role: 'employee', workerId: workerInactiveId }),
    ]);

    tokenAdmin = sAdm.accessToken;
    tokenEmp1 = sE1.accessToken;
    tokenEmp2 = sE2.accessToken;
    tokenInactive = sInact.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. PONTO-01: Deve bloquear IDOR (403) e contrato inativo (422), além de bloquear Mock GPS e Accuracy 0', async () => {
    const idorRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch',
      headers: { Authorization: `Bearer ${tokenEmp2}` },
      payload: { workerId: worker1Id, punchType: 'ENTRY', latitude: -23.55052, longitude: -46.633308, accuracy: 15 },
    });
    expect(idorRes.statusCode).toBe(403);
    expect(idorRes.json().code).toBe('FORBIDDEN_PUNCH_OWNERSHIP');

    const inactiveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch',
      headers: { Authorization: `Bearer ${tokenInactive}` },
      payload: { punchType: 'ENTRY', latitude: -23.55052, longitude: -46.633308, accuracy: 15 },
    });
    expect(inactiveRes.statusCode).toBe(422);
    expect(inactiveRes.json().code).toBe('INACTIVE_CONTRACT');

    const mockRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch',
      headers: { Authorization: `Bearer ${tokenEmp1}` },
      payload: { punchType: 'ENTRY', latitude: -23.55052, longitude: -46.633308, accuracy: 15, isMockLocation: true },
    });
    expect(mockRes.statusCode).toBe(403);
    expect(mockRes.json().code).toBe('SPOOF_DETECTED');
    expect(mockRes.json().fraudFlags).toContain('MOCK_GPS');

    const zeroAccRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch',
      headers: { Authorization: `Bearer ${tokenEmp1}` },
      payload: { punchType: 'ENTRY', latitude: -23.55052, longitude: -46.633308, accuracy: 0 },
    });
    expect(zeroAccRes.statusCode).toBe(403);
    expect(zeroAccRes.json().code).toBe('SPOOF_DETECTED');
    expect(zeroAccRes.json().fraudFlags).toContain('ZERO_ACCURACY');
  });

  it('2. PONTO-02 & PONTO-04: Deve autorizar 2º local permitido (Filial), gerar QR Code sem CPF, validar debounce 60s e /verify-punch público', async () => {
    const putWp = await app.inject({
      method: 'PUT',
      url: `/api/v1/time-tracking/contracts/${contract1Id}/allowed-workplaces`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        workplaces: [
          { workplaceId: wpMatrizId, isPrimary: true },
          { workplaceId: wpFilialId, isPrimary: false },
        ],
      },
    });
    expect(putWp.statusCode).toBe(200);
    expect(putWp.json().data).toHaveLength(2);

    // Bate ponto dentro da Filial Paulista (fora da Matriz) com X-Forwarded-For real
    const punchRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch',
      headers: {
        Authorization: `Bearer ${tokenEmp1}`,
        'x-forwarded-for': '177.20.30.40, 10.0.0.1',
      },
      payload: {
        punchType: 'ENTRY',
        latitude: -23.56145,
        longitude: -46.6559,
        accuracy: 12,
        deviceFingerprint: 'vitest-pwa',
      },
    });
    expect(punchRes.statusCode).toBe(201);
    const pData = punchRes.json().data;
    expect(pData.geofence_status).toBe('INSIDE');
    expect(pData.receipt_code).toMatch(/^RCP-\d{8}-[A-F0-9]{8}$/);
    expect(pData.qr_code_data_url).toMatch(/^data:image\/png;base64,/);
    expect(pData.verification_url).toContain(`/verificar-ponto/${pData.receipt_code}`);
    expect(pData.verification_url).not.toContain(cpf1);
    generatedReceiptCode = pData.receipt_code;

    // Debounce server-side 60s deve bloquear batida consecutiva imediata
    const debounceRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch',
      headers: { Authorization: `Bearer ${tokenEmp1}` },
      payload: { punchType: 'INTERVAL_START', latitude: -23.56145, longitude: -46.6559, accuracy: 12 },
    });
    expect(debounceRes.statusCode).toBe(429);
    expect(debounceRes.json().code).toBe('PUNCH_DEBOUNCE_60S');

    // Verificação pública sem token JWT -> CPF e nome estritamente mascarados
    const pubRes = await app.inject({
      method: 'GET',
      url: `/api/v1/public/verify-punch/${generatedReceiptCode}`,
    });
    expect(pubRes.statusCode).toBe(200);
    const pubPunch = pubRes.json().punch;
    expect(pubPunch.valid).toBe(true);
    expect(pubPunch.receipt_code).toBe(generatedReceiptCode);
    expect(pubPunch.worker_cpf_masked).not.toBe(cpf1);
    expect(pubPunch.worker_cpf_masked).toContain('***');
  });

  it('3. PONTO-03 & Anti-Spoofing: Deve sincronizar fila offline PWA idempotente preservando timestamps e detectar teletransporte (> 120 km/h)', async () => {
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const baseMs = Date.now() - 25 * 60 * 1000;
    const t1 = new Date(baseMs).toISOString();
    const t2 = new Date(baseMs + 5 * 60 * 1000).toISOString(); // 5 min depois em outra cidade (~357 km -> > 4000 km/h)

    const syncRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch/sync-offline',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        punches: [
          {
            workerId: workerExtId,
            punchType: 'ENTRY',
            latitude: -22.9068, // RJ
            longitude: -43.1729,
            accuracy: 18,
            deviceTimestamp: t1,
            clientUuid: u1,
          },
          {
            workerId: workerExtId,
            punchType: 'EXIT',
            latitude: -23.55052, // SP (teletransporte em 5 min)
            longitude: -46.633308,
            accuracy: 20,
            deviceTimestamp: t2,
            clientUuid: u2,
          },
        ],
      },
    });
    expect(syncRes.statusCode).toBe(200);
    const sData = syncRes.json().data;
    expect(sData.syncedCount).toBe(2);
    expect(sData.results[0].data.sync_origin).toBe('OFFLINE_PWA');
    expect(sData.results[1].data.fraud_flags).toContain('IMPOSSIBLE_SPEED');
    expect(Number(sData.results[1].data.speed_kmh)).toBeGreaterThan(120);

    // Reenvio dos mesmos clientUuids deve ser 100% idempotente
    const replayRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch/sync-offline',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        punches: [
          { workerId: workerExtId, punchType: 'ENTRY', deviceTimestamp: t1, clientUuid: u1 },
          { workerId: workerExtId, punchType: 'EXIT', deviceTimestamp: t2, clientUuid: u2 },
        ],
      },
    });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.json().data.duplicateCount).toBe(2);
    expect(replayRes.json().data.syncedCount).toBe(0);
  });

  it('4. PONTO-04 Selfie LGPD & PONTO-02 Auditoria: Deve exigir consentimento LGPD para selfie, armazenar no cofre privado e listar na auditoria GPS', async () => {
    const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString('base64');

    // Tentativa sem consentimento -> bloqueada (403 LGPD_SELFIE_CONSENT_REQUIRED)
    const noConsentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch',
      headers: { Authorization: `Bearer ${tokenEmp2}` },
      payload: {
        punchType: 'ENTRY',
        latitude: -23.55052,
        longitude: -46.633308,
        accuracy: 14,
        selfieBase64: fakeJpg,
        selfieMimeType: 'image/jpeg',
      },
    });
    expect(noConsentRes.statusCode).toBe(403);
    expect(noConsentRes.json().code).toBe('LGPD_SELFIE_CONSENT_REQUIRED');

    // Concede consentimento via Portal
    const consentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/lgpd/consents',
      headers: { Authorization: `Bearer ${tokenEmp2}` },
      payload: { consentCategory: 'BIOMETRIC_SELFIE_PUNCH', granted: true },
    });
    expect(consentRes.statusCode).toBe(201);

    // Nova batida com selfie -> aceita e persiste no StorageService privado
    const okSelfieRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch',
      headers: { Authorization: `Bearer ${tokenEmp2}` },
      payload: {
        punchType: 'ENTRY',
        latitude: -23.55052,
        longitude: -46.633308,
        accuracy: 14,
        selfieBase64: fakeJpg,
        selfieMimeType: 'image/jpeg',
      },
    });
    expect(okSelfieRes.statusCode).toBe(201);
    expect(okSelfieRes.json().data.selfie_file_id).toBeTruthy();

    // Auditoria GPS no RH deve exibir URL assinada da selfie e os alertas anti-spoofing
    const auditRes = await app.inject({
      method: 'GET',
      url: `/api/v1/time-tracking/punches/audit?companyId=${companyId}`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const list = auditRes.json().data as any[];
    expect(list.some((r) => r.selfie_signed_url && r.selfie_signed_url.includes('signature='))).toBe(true);
    expect(list.some((r) => Array.isArray(r.fraud_flags) && r.fraud_flags.includes('IMPOSSIBLE_SPEED'))).toBe(true);

    // Limpeza apenas de permissões de locais/consentimentos sem tocar em time_punch_records (imutável)
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows } = await client.query(`SELECT ip_address FROM public.time_punch_records WHERE receipt_code = $1`, [
        generatedReceiptCode,
      ]);
      expect(String(rows[0].ip_address)).toContain('177.20.30.40');
    });
  });
});
