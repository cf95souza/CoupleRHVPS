import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import forge from 'node-forge';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { buildSampleTotalizerXml } from '@couplerh/payroll-core';

function createCertPfx(cnpj: string, password: string) {
  const { publicKey: pubPem, privateKey: privPem } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keys = {
    publicKey: forge.pki.publicKeyFromPem(pubPem),
    privateKey: forge.pki.privateKeyFromPem(privPem),
  };
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01234567';
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 86400000);
  cert.validity.notAfter = new Date(now.getTime() + 180 * 86400000);
  const attrs = [{ name: 'commonName', value: `HOMOLOG EMPRESA:${cnpj}` }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return {
    pfxBuffer: Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary'),
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe('ESOC-04 & ESOC-05: Totalizadores (S-5001..S-5013) + Gate de Homologacao em Producao Restrita', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;

  const tenantId = 'f9020000-0000-0000-0000-000000000001';
  const companyId = 'f9020000-0000-0000-0000-000000000011';
  const estId = 'f9020000-0000-0000-0000-000000000021';
  const posId = 'f9020000-0000-0000-0000-000000000031';
  const wpId = 'f9020000-0000-0000-0000-000000000041';
  const ccId = 'f9020000-0000-0000-0000-000000000051';
  const userId = 'f9020000-0000-0000-0000-000000000101';
  const workerId = 'f9020000-0000-0000-0000-000000000201';
  const contractId = 'f9020000-0000-0000-0000-000000000301';
  const periodId = 'f9020000-0000-0000-0000-000000000401';
  const payslipId = 'f9020000-0000-0000-0000-000000000501';

  let mtlsServer: https.Server;
  let mtlsPort = 0;

  const cleanup = async (client: any) => {
    await client.query(`DELETE FROM public.esocial_homologation_cycles WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.esocial_totalizers WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.esocial_events WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.esocial_batches WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.esocial_certificates WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.stored_files WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.payroll_company_taxes WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.payslip_items WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.payslips WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.workers WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.cost_centers WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.workplaces WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.positions WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.establishments WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.companies WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.users WHERE id = $1::uuid`, [userId]);
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('EsocHomolog!2026');

    const srvCert = createCertPfx('90300000000133', 'srv');
    mtlsServer = https.createServer(
      { key: srvCert.keyPem, cert: srvCert.certPem, requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
          if (body.includes('EnviarLoteEventos')) {
            res.end(
              `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><EnviarLoteEventosResponse><EnviarLoteEventosResult><eSocial><retornoEnvioLoteEventos><status><cdResposta>201</cdResposta><descResposta>Recebido</descResposta></status><dadosRecepcaoLote><protocoloEnvio>1.2.202611.HOMOLOG999</protocoloEnvio></dadosRecepcaoLote></retornoEnvioLoteEventos></eSocial></EnviarLoteEventosResult></EnviarLoteEventosResponse></soapenv:Body></soapenv:Envelope>`
            );
            return;
          }
          res.end(`<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body></soapenv:Body></soapenv:Envelope>`);
        });
      }
    );
    await new Promise<void>((resolve) => {
      mtlsServer.listen(0, '127.0.0.1', () => {
        mtlsPort = (mtlsServer.address() as any).port;
        resolve();
      });
    });

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await cleanup(client);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active) VALUES ($1::uuid, 'homolog.v9@couplerh.test', 'Homolog Admin', $2, TRUE)`,
        [userId, pwHash]
      );
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V9 Homolog', 'ACTIVE')`, [tenantId]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active) VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, primary_cnae, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Homologacao Ltda', '90300000000133', '6201501', 'LUCRO_REAL', 'ACTIVE')`,
        [companyId, tenantId]
      );
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz Homolog', '90300000000133')`,
        [estId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sede')`,
        [wpId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.cost_centers (id, tenant_id, company_id, code, name, esocial_lotacao_code, esocial_tp_lotacao)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CC01', 'Operacoes', 'LOT01', '01')`,
        [ccId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo) VALUES ($1::uuid, $2::uuid, 'Analista', '252105')`,
        [posId, tenantId]
      );
      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES ($1::uuid, $2::uuid, 'Ana Homologacao', '90300000001', '1990-01-15', TRUE)`,
        [workerId, tenantId]
      );
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id, cost_center_id,
           worker_id, registration_number, admission_date, base_salary, salary_type, monthly_hours, weekly_hours, regime, status, esocial_category_code
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
           $8::uuid, 'MAT-HOM-01', '2026-01-02', 5000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', '101'
         )`,
        [contractId, tenantId, companyId, estId, posId, wpId, ccId, workerId]
      );

      await client.query(
        `INSERT INTO public.payroll_periods (id, tenant_id, company_id, year, month, type, status, payment_date, competence_date, total_earnings, total_deductions, total_net)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 2026, 11, 'MONTHLY', 'CALCULATED', '2026-12-05', '2026-11-01', 5000.00, 900.00, 4100.00)`,
        [periodId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.payslips (id, tenant_id, payroll_period_id, contract_id, worker_id, gross_salary, total_earnings, total_deductions, net_salary, base_inss, base_irrf, base_fgts, fgts_month, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 5000.00, 5000.00, 900.00, 4100.00, 5000.00, 4490.00, 5000.00, 400.00, 'CALCULATED')`,
        [payslipId, tenantId, periodId, contractId, workerId]
      );

      // Rubricas 101, 901 (INSS 510.00), 902 (IRRF 390.00)
      const rubRows = await client.query<{ id: string; code: string; name: string; type: string }>(
        `SELECT id, code, name, type FROM public.rubrics WHERE code IN ('101', '901', '902')`
      );
      const rubMap = new Map(rubRows.rows.map((r) => [r.code, r]));
      const r101 = rubMap.get('101')!;
      const r901 = rubMap.get('901')!;
      const r902 = rubMap.get('902')!;

      await client.query(
        `INSERT INTO public.payslip_items (tenant_id, payslip_id, rubric_id, rubric_code, rubric_name, type, amount) VALUES
         ($1::uuid, $2::uuid, $3::uuid, '101', $4, 'EARNING', 5000.00),
         ($1::uuid, $2::uuid, $5::uuid, '901', $6, 'DEDUCTION', 510.00),
         ($1::uuid, $2::uuid, $7::uuid, '902', $8, 'DEDUCTION', 390.00)`,
        [tenantId, payslipId, r101.id, r101.name, r901.id, r901.name, r902.id, r902.name]
      );

      await client.query(
        `INSERT INTO public.payroll_company_taxes (tenant_id, payroll_period_id, company_id, establishment_id, inss_patronal, rat_amount, fap_factor, other_entities_amount, fgts_total, total_cost)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1000.00, 100.00, 1.0, 290.00, 400.00, 1790.00)`,
        [tenantId, periodId, companyId, estId]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    tokenAdmin = (
      await tokenService.createSession({
        userId,
        tenantId,
        role: 'system_admin',
        email: 'homolog.v9@couplerh.test',
        aal: 'aal2',
      })
    ).accessToken;

    // Instalar certificado A1 em HOMOLOGATION
    const cert = createCertPfx('90300000000133', 'HomologSecret26');
    const up = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/certificates',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        environment: 'HOMOLOGATION',
        filename: 'homolog.pfx',
        password: 'HomologSecret26',
        pfx_base64: cert.pfxBuffer.toString('base64'),
      },
    });
    expect(up.statusCode).toBe(201);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mtlsServer.close(() => resolve()));
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await cleanup(client);
      await client.query('COMMIT;');
    } finally {
      client.release();
    }
    await app.close();
  });

  it('1. ESOC-05: deve bloquear envio em PRODUCTION antes da homologacao oficial em Producao Restrita', async () => {
    const gen = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/events/generate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        event_type: 'S-1000',
        environment: 'PRODUCTION',
        layout_version: 'S-1.3',
      },
    });
    expect(gen.statusCode).toBe(201);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/batches/send',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        event_ids: [gen.json().event.id],
        environment: 'PRODUCTION',
        async: false,
      },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('PRODUCTION_NOT_HOMOLOGATED');
  });

  it('2. ESOC-04: deve detectar divergencia de centavos nos totalizadores e bloquear homologacao ate bater R$ 0,00', async () => {
    const divergentXml = buildSampleTotalizerXml({
      eventType: 'S-5011',
      perApur: '2026-11',
      nrInsc: '90300000',
      inssBase: 5000,
      inssSegurados: 510.05, // R$ 0,05 divergente do motor (510.00)
      inssPatronal: 1390,
      inssRat: 100,
      inssTerceiros: 290,
    });

    const ingestDiv = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/totalizers/ingest',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        payroll_period_id: periodId,
        environment: 'HOMOLOGATION',
        xml_content: divergentXml,
      },
    });
    expect(ingestDiv.statusCode).toBe(201);
    expect(ingestDiv.json().reconciliation.reconciliationStatus).toBe('DIVERGENT');
    expect(ingestDiv.json().reconciliation.diffInssSegurados).toBe(0.05);

    const verifyFail = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/homologation/verify-cycle',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        payroll_period_id: periodId,
      },
    });
    expect(verifyFail.statusCode).toBe(422);
    expect(verifyFail.json().code).toBe('HOMOLOGATION_INCOMPLETE');
  });

  it('3. ESOC-05: deve homologar ciclo completo em Producao Restrita com recibos e confronto R$ 0,00 liberando Producao', async () => {
    // Limpar totalizador divergente anterior dentro do contexto RLS
    await withTenantContext({ userId, tenantId, role: 'system_admin' }, (client) =>
      client.query(`DELETE FROM public.esocial_totalizers WHERE tenant_id = $1::uuid`, [tenantId])
    );

    const cycleEvents = ['S-1000', 'S-1005', 'S-1010', 'S-1020', 'S-2200', 'S-1200', 'S-1210', 'S-1299'] as const;
    const generatedIds: string[] = [];

    for (const evt of cycleEvents) {
      const gen = await app.inject({
        method: 'POST',
        url: '/api/v1/esocial/events/generate',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        payload: {
          company_id: companyId,
          event_type: evt,
          environment: 'HOMOLOGATION',
          layout_version: 'S-1.3',
          payroll_period_id: periodId,
        },
      });
      expect(gen.statusCode).toBe(201);
      generatedIds.push(gen.json().event.id);

      const signed = await app.inject({
        method: 'POST',
        url: `/api/v1/esocial/events/${gen.json().event.id}/sign`,
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      expect(signed.statusCode).toBe(200);
    }

    // Enviar grupo 1 (tabela) via mTLS real
    const sendG1 = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/batches/send',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        event_ids: generatedIds.slice(0, 4),
        environment: 'HOMOLOGATION',
        async: false,
        endpoint_url: `https://127.0.0.1:${mtlsPort}/EnviarLoteEventos.svc`,
        reject_unauthorized: false,
      },
    });
    expect(sendG1.statusCode).toBe(200);

    // Registrar recibos oficiais retornados em Producao Restrita dentro do contexto RLS
    await withTenantContext({ userId, tenantId, role: 'system_admin' }, async (client) => {
      for (let i = 0; i < generatedIds.length; i++) {
        await client.query(
          `UPDATE public.esocial_events
           SET status = 'ACCEPTED', receipt_number = $2, accepted_at = NOW()
           WHERE id = $1::uuid`,
          [generatedIds[i], `1.2.0000000000000${i + 1}`]
        );
      }
    });

    // Ingerir S-5001, S-5002, S-5003, S-5011, S-5012, S-5013 batendo R$ 0,00 com o motor
    const totalizerPayloads = [
      buildSampleTotalizerXml({ eventType: 'S-5001', perApur: '2026-11', nrInsc: '90300000', cpfTrab: '90300000001', inssBase: 5000, inssSegurados: 510 }),
      buildSampleTotalizerXml({ eventType: 'S-5002', perApur: '2026-11', nrInsc: '90300000', cpfTrab: '90300000001', irrfRetido: 390 }),
      buildSampleTotalizerXml({ eventType: 'S-5003', perApur: '2026-11', nrInsc: '90300000', cpfTrab: '90300000001', fgtsBase: 5000, fgtsTotal: 400 }),
      buildSampleTotalizerXml({ eventType: 'S-5011', perApur: '2026-11', nrInsc: '90300000', inssBase: 5000, inssSegurados: 510, inssPatronal: 1390, inssRat: 100, inssTerceiros: 290 }),
      buildSampleTotalizerXml({ eventType: 'S-5012', perApur: '2026-11', nrInsc: '90300000', irrfRetido: 390 }),
      buildSampleTotalizerXml({ eventType: 'S-5013', perApur: '2026-11', nrInsc: '90300000', fgtsBase: 5000, fgtsTotal: 400 }),
    ];

    for (const xml of totalizerPayloads) {
      const ing = await app.inject({
        method: 'POST',
        url: '/api/v1/esocial/totalizers/ingest',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        payload: {
          company_id: companyId,
          payroll_period_id: periodId,
          environment: 'HOMOLOGATION',
          xml_content: xml,
        },
      });
      expect(ing.statusCode).toBe(201);
      expect(ing.json().reconciliation.reconciliationStatus).toBe('MATCHED');
      expect(ing.json().reconciliation.maxAbsDiff).toBe(0);
    }

    const verifyOk = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/homologation/verify-cycle',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        payroll_period_id: periodId,
      },
    });
    expect(verifyOk.statusCode).toBe(200);
    expect(verifyOk.json().approved).toBe(true);
    expect(verifyOk.json().maxDiff).toBe(0);

    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/esocial/homologation/status?companyId=${companyId}`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().company.esocial_production_enabled).toBe(true);
  });

  it('4. Guarda Arquitetural V9: zero supabase ou esocialSimulation no modulo eSocial e Certificados A1', () => {
    const webRoot = path.resolve(process.cwd(), '..', 'web', 'src');
    const filesToCheck = [
      'services/esocial/esocialService.ts',
      'services/settings/certificateService.ts',
      'pages/Settings/components/CertificatesTab.tsx',
      'pages/Settings/components/UploadCertificateModal.tsx',
      'pages/eSocial/Dashboard.tsx',
    ];
    for (const rel of filesToCheck) {
      const content = fs.readFileSync(path.join(webRoot, rel), 'utf8');
      expect(content).not.toMatch(/supabase|esocialSimulation|tenant_certificates|esocial_transmissions/);
    }
  });
});
