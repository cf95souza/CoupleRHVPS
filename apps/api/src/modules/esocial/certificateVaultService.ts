import crypto from 'node:crypto';
import forge from 'node-forge';
import pg from 'pg';
import { env } from '../../config/env.js';
import { dbPool as defaultPool } from '../../shared/db/pool.js';
import { encryptAesGcm, decryptAesGcm } from '../../shared/security/cryptoHelper.js';
import { StorageService } from '../../shared/storage/StorageService.js';
import { LocalFsStorageAdapter } from '../../shared/storage/LocalFsStorageAdapter.js';
import { AlertService } from '../../shared/observability/AlertService.js';

export interface ParsedA1Certificate {
  subjectDN: string;
  subjectName: string;
  issuerDN: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  thumbprintSha256: string;
  cnpj: string | null;
  certPem: string;
  keyPem: string;
  certDerBase64: string;
}

export interface StoredCertificateSummary {
  id: string;
  tenant_id: string;
  company_id: string;
  environment: 'PRODUCTION' | 'HOMOLOGATION';
  filename: string;
  subject_name: string;
  subject_dn: string;
  cnpj: string;
  issuer_dn: string;
  serial_number: string;
  thumbprint_sha256: string;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
  revoked_at: string | null;
  revocation_reason: string | null;
  days_remaining: number;
  status: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'REVOKED';
  created_at: string;
}

function formatAttributesDN(attrs: forge.pki.CertificateField[]): string {
  return attrs
    .map((a) => `${a.shortName || a.name}=${String(a.value ?? '')}`)
    .join(', ');
}

function extractCnpjFromCertificate(cert: forge.pki.Certificate): string | null {
  // 1. ICP-Brasil OID 2.16.76.1.3.3 no SubjectAltName (Pessoa Juridica)
  const sanExt = cert.getExtension('subjectAltName') as any;
  if (sanExt && Array.isArray(sanExt.altNames)) {
    for (const alt of sanExt.altNames) {
      const rawVal = typeof alt.value === 'string' ? alt.value : '';
      const match14 = rawVal.match(/\d{14}/);
      if (match14) {
        return match14[0];
      }
    }
  }

  // 2. Sufixo no CN (padrao ICP-Brasil: "EMPRESA LTDA:12345678000195")
  const cnAttr = cert.subject.getField('CN');
  if (cnAttr && typeof cnAttr.value === 'string') {
    const matchCn = cnAttr.value.match(/(\d{14})/);
    if (matchCn) {
      return matchCn[1];
    }
  }

  // 3. Campo serialNumber do subject
  const serialAttr = cert.subject.getField('serialNumber');
  if (serialAttr && typeof serialAttr.value === 'string') {
    const matchSer = serialAttr.value.match(/(\d{14})/);
    if (matchSer) {
      return matchSer[1];
    }
  }

  return null;
}

/**
 * Realiza parse X.509 real de um arquivo PKCS#12 (.pfx / .p12) usando node-forge.
 */
export function parsePkcs12Certificate(pfxBuffer: Buffer, password: string): ParsedA1Certificate {
  if (!pfxBuffer || pfxBuffer.length < 32) {
    throw new Error('Arquivo PKCS#12 (.pfx/.p12) invalido ou vazio.');
  }
  if (!password) {
    throw new Error('Senha da chave privada do certificado e obrigatoria.');
  }

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const p12Der = forge.util.createBuffer(pfxBuffer.toString('binary'), 'raw');
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.toLowerCase().includes('mac') || msg.toLowerCase().includes('password') || msg.toLowerCase().includes('decrypt')) {
      throw new Error('Senha do certificado A1 incorreta ou arquivo PKCS#12 corrompido.');
    }
    throw new Error(`Falha ao ler certificado PKCS#12: ${msg || 'formato invalido'}`);
  }

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const shroudedKeyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  const plainKeyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [];

  const cert = certBags.find((b) => b.cert)?.cert;
  const key = shroudedKeyBags.find((b) => b.key)?.key ?? plainKeyBags.find((b) => b.key)?.key;

  if (!cert || !key) {
    throw new Error('O arquivo PKCS#12 nao contem par valido de certificado X.509 e chave privada.');
  }

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(key);
  const derBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const derBuffer = Buffer.from(derBytes, 'binary');
  const certDerBase64 = derBuffer.toString('base64');
  const thumbprintSha256 = crypto.createHash('sha256').update(derBuffer).digest('hex').toUpperCase();

  const cnField = cert.subject.getField('CN');
  const subjectName = cnField?.value ? String(cnField.value) : formatAttributesDN(cert.subject.attributes);
  const subjectDN = formatAttributesDN(cert.subject.attributes);
  const issuerDN = formatAttributesDN(cert.issuer.attributes);
  const serialNumber = String(cert.serialNumber || '').toUpperCase();
  const validFrom = cert.validity.notBefore;
  const validTo = cert.validity.notAfter;
  const cnpj = extractCnpjFromCertificate(cert);

  return {
    subjectDN,
    subjectName,
    issuerDN,
    serialNumber,
    validFrom,
    validTo,
    thumbprintSha256,
    cnpj,
    certPem,
    keyPem,
    certDerBase64,
  };
}

function encryptBufferWithDek(plainBuffer: Buffer, dek: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Formato binario: [12B IV][16B AuthTag][Ciphertext]
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptBufferWithDek(encryptedBuffer: Buffer, dek: Buffer): Buffer {
  if (encryptedBuffer.length < 29) {
    throw new Error('Blob criptografado do certificado invalido.');
  }
  const iv = encryptedBuffer.subarray(0, 12);
  const authTag = encryptedBuffer.subarray(12, 28);
  const ciphertext = encryptedBuffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function computeCertificateSummary(row: any): StoredCertificateSummary {
  const now = Date.now();
  const validToMs = new Date(row.valid_to).getTime();
  const daysRemaining = Math.ceil((validToMs - now) / (1000 * 60 * 60 * 24));
  let status: StoredCertificateSummary['status'] = 'VALID';
  if (row.revoked_at || !row.is_active) {
    status = 'REVOKED';
  } else if (daysRemaining < 0) {
    status = 'EXPIRED';
  } else if (daysRemaining <= 30) {
    status = 'EXPIRING_SOON';
  }

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    company_id: row.company_id,
    environment: row.environment,
    filename: row.filename || 'certificado.pfx',
    subject_name: row.subject_name || row.subject_dn,
    subject_dn: row.subject_dn,
    cnpj: row.cnpj || '',
    issuer_dn: row.issuer_dn || '',
    serial_number: row.serial_number || '',
    thumbprint_sha256: row.thumbprint_sha256 || '',
    valid_from: new Date(row.valid_from).toISOString(),
    valid_to: new Date(row.valid_to).toISOString(),
    is_active: Boolean(row.is_active),
    revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revocation_reason: row.revocation_reason || null,
    days_remaining: daysRemaining,
    status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export async function installA1Certificate(
  client: pg.PoolClient,
  params: {
    tenantId: string;
    companyId: string;
    uploadedBy: string | null;
    environment: 'PRODUCTION' | 'HOMOLOGATION';
    filename: string;
    pfxBuffer: Buffer;
    password: string;
  },
  storageService?: StorageService
): Promise<StoredCertificateSummary> {
  // 1. Parse X.509 real
  const parsed = parsePkcs12Certificate(params.pfxBuffer, params.password);

  // 2. Validar expiracao
  if (parsed.validTo.getTime() <= Date.now()) {
    const err: any = new Error(
      `Certificado A1 expirado em ${parsed.validTo.toISOString().slice(0, 10)}. Instale um certificado valido.`
    );
    err.statusCode = 422;
    err.code = 'CERTIFICATE_EXPIRED';
    throw err;
  }

  // 3. Validar CNPJ da empresa (raiz de 8 digitos) contra CNPJ do certificado
  const compRes = await client.query<{ cnpj: string; corporate_name: string }>(
    `SELECT cnpj, corporate_name FROM public.companies WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL`,
    [params.companyId, params.tenantId]
  );
  if (compRes.rows.length === 0) {
    const err: any = new Error('Empresa nao encontrada para o tenant informado.');
    err.statusCode = 404;
    err.code = 'COMPANY_NOT_FOUND';
    throw err;
  }

  const companyCnpj = String(compRes.rows[0].cnpj || '').replace(/\D/g, '');
  if (parsed.cnpj && companyCnpj.length >= 8) {
    const certRoot = parsed.cnpj.replace(/\D/g, '').slice(0, 8);
    const compRoot = companyCnpj.slice(0, 8);
    if (certRoot !== compRoot) {
      const err: any = new Error(
        `CNPJ raiz do certificado (${certRoot}) diverge do CNPJ da empresa (${compRoot}).`
      );
      err.statusCode = 422;
      err.code = 'CERTIFICATE_CNPJ_MISMATCH';
      throw err;
    }
  }

  // 4. Criptografia Envelope AES-256-GCM:
  //    - DEK aleatoria cifra o .pfx antes de gravar no storage privado
  //    - KEK (CERTIFICATE_MASTER_KEY fora do banco) cifra { dekHex, password, thumbprintSha256 }
  const dek = crypto.randomBytes(32);
  const encryptedPfxBlob = encryptBufferWithDek(params.pfxBuffer, dek);

  const storage = storageService || new StorageService({ adapter: new LocalFsStorageAdapter(env.STORAGE_BASE_PATH) });
  const storedFile = await storage.upload({
    tenantId: params.tenantId,
    workerId: null,
    category: 'CERTIFICATE_A1',
    originalName: `${params.filename}.enc`,
    mimeType: 'application/x-pkcs12',
    buffer: encryptedPfxBlob,
    uploadedBy: params.uploadedBy,
    isPrivate: true,
  });

  const envelopePayload = JSON.stringify({
    dekHex: dek.toString('hex'),
    password: params.password,
    thumbprintSha256: parsed.thumbprintSha256,
  });
  const encryptedEnvelope = encryptAesGcm(envelopePayload, env.CERTIFICATE_MASTER_KEY);
  const encryptedPasswordLegacy = encryptAesGcm(params.password, env.CERTIFICATE_MASTER_KEY);

  // 5. Desativar certificados anteriores do mesmo ambiente/empresa
  await client.query(
    `UPDATE public.esocial_certificates
     SET is_active = FALSE,
         revoked_at = COALESCE(revoked_at, NOW()),
         revocation_reason = COALESCE(revocation_reason, 'Substituido por novo certificado A1'),
         updated_at = NOW()
     WHERE tenant_id = $1::uuid
       AND company_id = $2::uuid
       AND environment = $3::text
       AND is_active = TRUE`,
    [params.tenantId, params.companyId, params.environment]
  );

  // 6. Gravar metadados e envelope seguro no banco
  const certCnpj = parsed.cnpj || companyCnpj;
  const insertRes = await client.query(
    `INSERT INTO public.esocial_certificates (
      tenant_id, company_id, file_id, certificate_encrypted_password,
      subject_dn, valid_from, valid_to, is_active,
      environment, filename, subject_name, cnpj, issuer_dn, serial_number,
      thumbprint_sha256, encrypted_pfx_envelope, key_version, uploaded_by, updated_at
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::text,
      $5::text, $6::timestamptz, $7::timestamptz, TRUE,
      $8::text, $9::text, $10::text, $11::text, $12::text, $13::text,
      $14::text, $15::text, 'v1-aes256gcm', $16::uuid, NOW()
    )
    RETURNING *;`,
    [
      params.tenantId,
      params.companyId,
      storedFile.id,
      encryptedPasswordLegacy,
      parsed.subjectDN,
      parsed.validFrom.toISOString(),
      parsed.validTo.toISOString(),
      params.environment,
      params.filename,
      parsed.subjectName,
      certCnpj,
      parsed.issuerDN,
      parsed.serialNumber,
      parsed.thumbprintSha256,
      encryptedEnvelope,
      params.uploadedBy,
    ]
  );

  return computeCertificateSummary(insertRes.rows[0]);
}

export interface UnlockedCertificateMaterial {
  certificate: StoredCertificateSummary;
  certPem: string;
  keyPem: string;
  certDerBase64: string;
  pfxBuffer: Buffer;
}

/**
 * Abre o cofre AES-256-GCM em memoria apenas durante assinatura/mTLS,
 * validando vigencia e status ativo.
 */
export async function unlockActiveCertificate(
  client: pg.PoolClient,
  params: {
    tenantId: string;
    companyId: string;
    environment: 'PRODUCTION' | 'HOMOLOGATION';
    certificateId?: string;
  },
  storageService?: StorageService
): Promise<UnlockedCertificateMaterial> {
  const res = params.certificateId
    ? await client.query(
        `SELECT * FROM public.esocial_certificates
         WHERE id = $1::uuid AND tenant_id = $2::uuid AND company_id = $3::uuid AND is_active = TRUE`,
        [params.certificateId, params.tenantId, params.companyId]
      )
    : await client.query(
        `SELECT * FROM public.esocial_certificates
         WHERE tenant_id = $1::uuid AND company_id = $2::uuid AND environment = $3::text AND is_active = TRUE
         ORDER BY created_at DESC LIMIT 1`,
        [params.tenantId, params.companyId, params.environment]
      );

  if (res.rows.length === 0) {
    const err: any = new Error(
      `Nenhum certificado digital A1 ativo encontrado para o ambiente ${params.environment}.`
    );
    err.statusCode = 422;
    err.code = 'CERTIFICATE_NOT_CONFIGURED';
    throw err;
  }

  const row = res.rows[0];
  if (new Date(row.valid_to).getTime() <= Date.now()) {
    const err: any = new Error('Certificado A1 expirado. Substitua o certificado antes de assinar ou transmitir.');
    err.statusCode = 422;
    err.code = 'CERTIFICATE_EXPIRED';
    throw err;
  }

  if (!row.encrypted_pfx_envelope || !row.file_id) {
    const err: any = new Error('Envelope criptografico do certificado A1 ausente.');
    err.statusCode = 500;
    err.code = 'CERTIFICATE_VAULT_CORRUPTED';
    throw err;
  }

  const envelopeJson = decryptAesGcm(row.encrypted_pfx_envelope, env.CERTIFICATE_MASTER_KEY);
  const { dekHex, password } = JSON.parse(envelopeJson) as { dekHex: string; password: string };
  const dek = Buffer.from(dekHex, 'hex');

  const storage = storageService || new StorageService({ adapter: new LocalFsStorageAdapter(env.STORAGE_BASE_PATH) });
  const storedFile = await storage.getFileById(row.file_id, params.tenantId);
  if (!storedFile) {
    throw new Error('Arquivo criptografado do certificado nao localizado no storage.');
  }

  const stream = await storage.getFileStream(storedFile);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const encryptedBlob = Buffer.concat(chunks);
  const pfxBuffer = decryptBufferWithDek(encryptedBlob, dek);
  const parsed = parsePkcs12Certificate(pfxBuffer, password);

  return {
    certificate: computeCertificateSummary(row),
    certPem: parsed.certPem,
    keyPem: parsed.keyPem,
    certDerBase64: parsed.certDerBase64,
    pfxBuffer,
  };
}

/**
 * Avalia certificados proximos ao vencimento (faixas 60, 30, 15, 7 dias e expirado)
 * e emite alertas operacionais no AlertService sem duplicar o mesmo patamar.
 */
export async function checkExpiringCertificates(
  pool?: pg.Pool,
  alertService?: AlertService,
  tenantId?: string
): Promise<Array<{ certificateId: string; companyId: string; tier: number; daysRemaining: number }>> {
  const db = pool || defaultPool;
  const alerts = alertService || new AlertService(db);
  const triggered: Array<{ certificateId: string; companyId: string; tier: number; daysRemaining: number }> = [];

  const client = await db.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, tenant_id, company_id, subject_name, cnpj, environment, valid_to, last_expiry_alert_tier
       FROM public.esocial_list_expiring_certificates($1::uuid);`,
      [tenantId || null]
    );

    const now = Date.now();
    for (const row of rows) {
      const daysRemaining = Math.ceil((new Date(row.valid_to).getTime() - now) / (1000 * 60 * 60 * 24));
      let tier: number | null = null;
      if (daysRemaining <= 0) tier = 0;
      else if (daysRemaining <= 7) tier = 7;
      else if (daysRemaining <= 15) tier = 15;
      else if (daysRemaining <= 30) tier = 30;
      else if (daysRemaining <= 60) tier = 60;

      if (tier === null || row.last_expiry_alert_tier === tier) {
        continue;
      }

      const severity = tier <= 7 ? 'CRITICAL' : tier <= 30 ? 'WARNING' : 'INFO';
      const title =
        tier === 0
          ? `Certificado A1 eSocial EXPIRADO (${row.cnpj || row.subject_name})`
          : `Certificado A1 eSocial vence em ${daysRemaining} dia(s) (alerta ${tier}d)`;

      await alerts.createAlert({
        severity,
        category: 'SECURITY',
        title,
        message: `Certificado "${row.subject_name}" (${row.environment}) expira em ${new Date(
          row.valid_to
        ).toISOString().slice(0, 10)}.`,
        metadata: {
          certificate_id: row.id,
          tenant_id: row.tenant_id,
          company_id: row.company_id,
          tier_days: tier,
          days_remaining: daysRemaining,
          environment: row.environment,
        },
      });

      await client.query(
        `SELECT public.esocial_mark_certificate_alert_tier($1::uuid, $2::int);`,
        [row.id, tier]
      );

      triggered.push({
        certificateId: row.id,
        companyId: row.company_id,
        tier,
        daysRemaining,
      });
    }
  } finally {
    client.release();
  }

  return triggered;
}
