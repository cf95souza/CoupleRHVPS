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
import { checkExpiringCertificates } from '../src/modules/esocial/certificateVaultService.js';
import { verifyXmlDsigSignature } from '../src/modules/esocial/xmlDsigSigner.js';
import { buildSampleTotalizerXml } from '@couplerh/payroll-core';
import { env } from '../src/config/env.js';

function createTestPkcs12(options: {
  commonName: string;
  cnpj?: string;
  daysBefore?: number;
  daysAfter?: number;
  password: string;
}): { pfxBuffer: Buffer; certPem: string; keyPem: string } {
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
  cert.serialNumber = String(Date.now()).slice(-10);

  const now = new Date();
  const notBefore = new Date(now.getTime() + (options.daysBefore ?? -5) * 86400000);
  const notAfter = new Date(now.getTime() + (options.daysAfter ?? 365) * 86400000);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const cnValue = options.cnpj ? `${options.commonName}:${options.cnpj}` : options.commonName;
  const attrs = [
    { name: 'commonName', value: cnValue },
    { name: 'organizationName', value: 'AC TESTE ICP-BRASIL' },
    { name: 'countryName', value: 'BR' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true, serverAuth: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], options.password, {
    algorithm: '3des',
    friendlyName: 'Test A1',
  });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  return {
    pfxBuffer: Buffer.from(p12Der, 'binary'),
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe('ESOC-01 a 03: Cofre A1 AES-256-GCM, XML S-1.2/S-1.3, XML-DSig RSA-SHA256 & mTLS Real', () => {
  let app: FastifyInstance;
  let tokenAdminA: string;
  let tokenAdminB: string;
  let tokenEmployeeA: string;

  const tenantA = 'f9010000-0000-0000-0000-000000000001';
  const tenantB = 'f9010000-0000-0000-0000-000000000002';
  const companyA = 'f9010000-0000-0000-0000-000000000011';
  const companyB = 'f9010000-0000-0000-0000-000000000012';
  const estA = 'f9010000-0000-0000-0000-000000000021';
  const posA = 'f9010000-0000-0000-0000-000000000031';
  const wpA = 'f9010000-0000-0000-0000-000000000041';
  const ccA = 'f9010000-0000-0000-0000-000000000051';
  const userAdminA = 'f9010000-0000-0000-0000-000000000101';
  const userAdminB = 'f9010000-0000-0000-0000-000000000102';
  const userEmpA = 'f9010000-0000-0000-0000-000000000103';
  const workerA = 'f9010000-0000-0000-0000-000000000201';
  const contractA = 'f9010000-0000-0000-0000-000000000301';

  let mtlsServer: https.Server;
  let mtlsPort = 0;
  let capturedPeerCn: string | null = null;
  let lastCreatedEventId = '';
  let lastCreatedBatchId = '';

  const cleanup = async (client: any) => {
    for (const tid of [tenantA, tenantB]) {
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true);`, [tid]);
      await client.query(`DELETE FROM public.system_operational_alerts WHERE metadata->>'tenant_id' = $1`, [tid]);
      await client.query(`DELETE FROM public.esocial_homologation_cycles WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.esocial_totalizers WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.esocial_events WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.esocial_batches WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.esocial_certificates WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.stored_files WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.workers WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.cost_centers WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.workplaces WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.positions WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.establishments WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.companies WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid`, [tid]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tid]);
    }
    await client.query(`DELETE FROM public.users WHERE id = ANY($1::uuid[])`, [[userAdminA, userAdminB, userEmpA]]);
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('EsocV9!2026');

    // Subir servidor HTTPS mTLS real simulando o SERPRO/Gov.br
    const serverCert = createTestPkcs12({
      commonName: 'webservices.producaorestrita.esocial.local',
      password: 'srv',
    });
    mtlsServer = https.createServer(
      {
        key: serverCert.keyPem,
        cert: serverCert.certPem,
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const socket = req.socket as any;
          const peer = socket.getPeerCertificate?.();
          capturedPeerCn = peer?.subject?.CN || null;

          res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
          if (body.includes('EnviarLoteEventos')) {
            res.end(
              `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><EnviarLoteEventosResponse><EnviarLoteEventosResult><eSocial xmlns="http://www.esocial.gov.br/schema/lote/eventos/retornoEnvio/v1_1_0"><retornoEnvioLoteEventos><status><cdResposta>201</cdResposta><descResposta>Lote recebido com sucesso.</descResposta></status><dadosRecepcaoLote><protocoloEnvio>1.2.202611.99000012345</protocoloEnvio></dadosRecepcaoLote></retornoEnvioLoteEventos></eSocial></EnviarLoteEventosResult></EnviarLoteEventosResponse></soapenv:Body></soapenv:Envelope>`
            );
            return;
          }

          // ConsultarLoteEventos: extrair Ids enviados
          const idMatches = Array.from(body.matchAll(/protocoloEnvio>([^<]+)</g));
          const totXml = buildSampleTotalizerXml({
            eventType: 'S-5001',
            perApur: '2026-11',
            nrInsc: '90100000',
            cpfTrab: '90100000001',
            inssBase: 0,
            inssSegurados: 0,
          });
          res.end(
            `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ConsultarLoteEventosResponse><ConsultarLoteEventosResult><eSocial xmlns="http://www.esocial.gov.br/schema/lote/eventos/retornoProcessamento/v1_3_0"><retornoProcessamentoLoteEventos><status><cdResposta>201</cdResposta><descResposta>Lote processado com sucesso (${idMatches.length}).</descResposta></status><retornoEventos><evento Id="${lastCreatedEventId}"><retornoEvento><eSocial><retornoEvento><recepcao><tpAmb>2</tpAmb></recepcao><processamento><cdResposta>201</cdResposta><descResposta>Sucesso.</descResposta></processamento><recibo><nrRecibo>1.2.0000000999888777</nrRecibo></recibo></retornoEvento></eSocial></retornoEvento><tot tipo="S5001">${totXml}</tot></evento></retornoEventos></retornoProcessamentoLoteEventos></eSocial></ConsultarLoteEventosResult></ConsultarLoteEventosResponse></soapenv:Body></soapenv:Envelope>`
          );
        });
      }
    );
    await new Promise<void>((resolve) => {
      mtlsServer.listen(0, '127.0.0.1', () => {
        const addr = mtlsServer.address() as any;
        mtlsPort = addr.port;
        resolve();
      });
    });

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await cleanup(client);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active) VALUES
         ($1::uuid, 'admin.a.v9@couplerh.test', 'Admin V9 A', $4, TRUE),
         ($2::uuid, 'admin.b.v9@couplerh.test', 'Admin V9 B', $4, TRUE),
         ($3::uuid, 'emp.a.v9@couplerh.test', 'Emp V9 A', $4, TRUE)`,
        [userAdminA, userAdminB, userEmpA, pwHash]
      );

      await client.query(`SELECT set_config('app.current_tenant_id', $1, true);`, [tenantA]);
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V9 A', 'ACTIVE')`, [tenantA]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active) VALUES
         ($1::uuid, $2::uuid, 'system_admin', TRUE),
         ($1::uuid, $3::uuid, 'employee', TRUE)`,
        [tenantA, userAdminA, userEmpA]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, primary_cnae, tax_regime, status) VALUES
         ($1::uuid, $2::uuid, 'Alpha Esocial V9 Ltda', '90100000000111', '6201501', 'LUCRO_REAL', 'ACTIVE')`,
        [companyA, tenantA]
      );

      await client.query(`SELECT set_config('app.current_tenant_id', $1, true);`, [tenantB]);
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V9 B', 'ACTIVE')`, [tenantB]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active) VALUES
         ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantB, userAdminB]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, primary_cnae, tax_regime, status) VALUES
         ($1::uuid, $2::uuid, 'Beta Esocial V9 Ltda', '90200000000122', '6201501', 'LUCRO_REAL', 'ACTIVE')`,
        [companyB, tenantB]
      );

      await client.query(`SELECT set_config('app.current_tenant_id', $1, true);`, [tenantA]);
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz Alpha', '90100000000111')`,
        [estA, tenantA, companyA]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sede')`,
        [wpA, tenantA, companyA]
      );
      await client.query(
        `INSERT INTO public.cost_centers (id, tenant_id, company_id, code, name, esocial_lotacao_code, esocial_tp_lotacao)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CC01', 'Tecnologia', 'LOT-TECH-01', '01')`,
        [ccA, tenantA, companyA]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo) VALUES ($1::uuid, $2::uuid, 'Engenheiro', '212405')`,
        [posA, tenantA]
      );
      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES ($1::uuid, $2::uuid, 'Joao Esocial', '90100000001', '1991-04-12', TRUE)`,
        [workerA, tenantA]
      );
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id, cost_center_id,
           worker_id, registration_number, admission_date, base_salary, salary_type, monthly_hours, weekly_hours, regime, status, esocial_category_code
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
           $8::uuid, 'MAT-V9-01', '2026-01-05', 6000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', '101'
         )`,
        [contractA, tenantA, companyA, estA, posA, wpA, ccA, workerA]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    tokenAdminA = (
      await tokenService.createSession({
        userId: userAdminA,
        tenantId: tenantA,
        role: 'system_admin',
        email: 'admin.a.v9@couplerh.test',
        aal: 'aal2',
      })
    ).accessToken;

    tokenAdminB = (
      await tokenService.createSession({
        userId: userAdminB,
        tenantId: tenantB,
        role: 'system_admin',
        email: 'admin.b.v9@couplerh.test',
        aal: 'aal2',
      })
    ).accessToken;

    tokenEmployeeA = (
      await tokenService.createSession({
        userId: userEmpA,
        tenantId: tenantA,
        role: 'employee',
        email: 'emp.a.v9@couplerh.test',
        aal: 'aal1',
      })
    ).accessToken;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mtlsServer.close(() => resolve()));
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await cleanup(client);
      await client.query('COMMIT;');
    } finally {
      client.release();
    }
    await app.close();
  });

  it('1. Seguranca: deve bloquear acesso anonimo (401) e perfil colaborador (403)', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/esocial/certificates' });
    expect(anon.statusCode).toBe(401);

    const emp = await app.inject({
      method: 'GET',
      url: '/api/v1/esocial/certificates',
      headers: { Authorization: `Bearer ${tokenEmployeeA}` },
    });
    expect(emp.statusCode).toBe(403);
  });

  it('2. ESOC-01: deve rejeitar senha invalida, certificado expirado e CNPJ divergente', async () => {
    const expired = createTestPkcs12({
      commonName: 'ALPHA ESOCIAL V9 LTDA',
      cnpj: '90100000000111',
      daysBefore: -380,
      daysAfter: -2,
      password: 'SecretPassword123',
    });

    const resWrongPw = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/certificates',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        company_id: companyA,
        environment: 'HOMOLOGATION',
        filename: 'expired.pfx',
        password: 'WRONG_PASSWORD',
        pfx_base64: expired.pfxBuffer.toString('base64'),
      },
    });
    expect(resWrongPw.statusCode).toBe(422);

    const resExpired = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/certificates',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        company_id: companyA,
        environment: 'HOMOLOGATION',
        filename: 'expired.pfx',
        password: 'SecretPassword123',
        pfx_base64: expired.pfxBuffer.toString('base64'),
      },
    });
    expect(resExpired.statusCode).toBe(422);
    expect(resExpired.json().code).toBe('CERTIFICATE_EXPIRED');

    const mismatch = createTestPkcs12({
      commonName: 'OUTRA EMPRESA LTDA',
      cnpj: '11222333000199',
      daysAfter: 120,
      password: 'SecretPassword123',
    });

    const resMismatch = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/certificates',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        company_id: companyA,
        environment: 'HOMOLOGATION',
        filename: 'mismatch.pfx',
        password: 'SecretPassword123',
        pfx_base64: mismatch.pfxBuffer.toString('base64'),
      },
    });
    expect(resMismatch.statusCode).toBe(422);
    expect(resMismatch.json().code).toBe('CERTIFICATE_CNPJ_MISMATCH');
  });

  it('3. ESOC-01: deve instalar A1 real, criptografar com envelope AES-256-GCM, isolar cross-tenant e gerar alerta de vencimento', async () => {
    const secretPw = 'MegaUltraPfxSecret#2026';
    const valid = createTestPkcs12({
      commonName: 'ALPHA ESOCIAL V9 LTDA',
      cnpj: '90100000000111',
      daysAfter: 14, // dispara alerta tier 15d!
      password: secretPw,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/certificates',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        company_id: companyA,
        environment: 'HOMOLOGATION',
        filename: 'alpha_a1.pfx',
        password: secretPw,
        pfx_base64: valid.pfxBuffer.toString('base64'),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.certificate.cnpj).toBe('90100000000111');
    expect(body.certificate.subject_name).toContain('ALPHA ESOCIAL V9 LTDA');

    // Verificar no banco (via contexto RLS) e disco que nem a senha nem o PFX estao em texto claro
    const dbCheck = await withTenantContext(
      { userId: userAdminA, tenantId: tenantA, role: 'system_admin' },
      (client) =>
        client.query(
          `SELECT c.encrypted_pfx_envelope, c.certificate_encrypted_password, sf.storage_rel_path
           FROM public.esocial_certificates c
           JOIN public.stored_files sf ON sf.id = c.file_id
           WHERE c.id = $1::uuid`,
          [body.certificate.id]
        )
    );
    const row = dbCheck.rows[0];
    expect(row).toBeDefined();
    expect(row.encrypted_pfx_envelope).not.toContain(secretPw);
    expect(row.certificate_encrypted_password).not.toContain(secretPw);

    const diskPath = path.resolve(env.STORAGE_BASE_PATH, row.storage_rel_path);
    const diskBytes = fs.readFileSync(diskPath);
    expect(diskBytes.equals(valid.pfxBuffer)).toBe(false);

    // Isolamento cross-tenant: Tenant B nao enxerga certificado de Tenant A
    const listB = await app.inject({
      method: 'GET',
      url: '/api/v1/esocial/certificates',
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().certificates).toHaveLength(0);

    // Alertas de vencimento (60/30/15/7d): cert vence em 14d -> tier 15
    const alerts = await checkExpiringCertificates(dbPool);
    const hit = alerts.find((a) => a.certificateId === body.certificate.id);
    expect(hit).toBeDefined();
    expect(hit?.tier).toBe(15);
  });

  it('4. ESOC-02 & ESOC-03: deve gerar XML S-1.3, validar XSD, assinar XML-DSig (RSA-SHA256) e transmitir via mTLS gravando recibo e S-5001', async () => {
    const genRes = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/events/generate',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        company_id: companyA,
        event_type: 'S-1000',
        environment: 'HOMOLOGATION',
        layout_version: 'S-1.3',
      },
    });
    expect(genRes.statusCode).toBe(201);
    const genBody = genRes.json();
    expect(genBody.validation.valid).toBe(true);
    expect(genBody.event.status).toBe('VALIDATED');
    lastCreatedEventId = genBody.event.event_id;
    const dbEventUuid = genBody.event.id;

    // Assinatura XML-DSig RSA-SHA256
    const signRes = await app.inject({
      method: 'POST',
      url: `/api/v1/esocial/events/${dbEventUuid}/sign`,
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    expect(signRes.statusCode).toBe(200);
    const signedXml: string = signRes.json().event.signed_xml;
    expect(signedXml).toContain('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
    expect(verifyXmlDsigSignature(signedXml).valid).toBe(true);

    // Adulteracao de 1 byte deve quebrar a verificacao XML-DSig
    const tampered = signedXml.replace('<classTrib>99</classTrib>', '<classTrib>01</classTrib>');
    expect(verifyXmlDsigSignature(tampered).valid).toBe(false);

    // Envio do lote via HTTPS mTLS real para o servidor local
    const sendRes = await app.inject({
      method: 'POST',
      url: '/api/v1/esocial/batches/send',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        company_id: companyA,
        event_ids: [dbEventUuid],
        environment: 'HOMOLOGATION',
        async: false,
        endpoint_url: `https://127.0.0.1:${mtlsPort}/EnviarLoteEventos.svc`,
        reject_unauthorized: false,
      },
    });
    expect(sendRes.statusCode).toBe(200);
    const sendBody = sendRes.json();
    expect(sendBody.execution.status).toBe('SENT');
    expect(sendBody.execution.protocolNumber).toBe('1.2.202611.99000012345');
    expect(capturedPeerCn).toContain('ALPHA ESOCIAL V9 LTDA');
    lastCreatedBatchId = sendBody.batch.id;

    // Polling do lote gravando recibo oficial e ingerindo S-5001
    const pollRes = await app.inject({
      method: 'POST',
      url: `/api/v1/esocial/batches/${lastCreatedBatchId}/poll`,
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        endpoint_url: `https://127.0.0.1:${mtlsPort}/ConsultarLoteEventos.svc`,
        reject_unauthorized: false,
      },
    });
    expect(pollRes.statusCode).toBe(200);
    const pollBody = pollRes.json();
    expect(pollBody.execution.status).toBe('PROCESSED');
    expect(pollBody.execution.acceptedCount).toBe(1);
    expect(pollBody.execution.ingestedTotalizersCount).toBe(1);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/v1/esocial/events/${dbEventUuid}`,
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().event.status).toBe('ACCEPTED');
    expect(detailRes.json().event.receipt_number).toBe('1.2.0000000999888777');
  });
});
