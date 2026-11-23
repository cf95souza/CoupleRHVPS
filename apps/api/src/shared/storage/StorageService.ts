import crypto from 'crypto';
import path from 'path';
import { Pool } from 'pg';
import { env } from '../../config/env.js';
import { dbPool as defaultPool } from '../db/pool.js';
import { FileCategory, IStorageAdapter, StoredFileRecord } from './IStorageAdapter.js';
import { LocalFsStorageAdapter } from './LocalFsStorageAdapter.js';

export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/x-pkcs12', // Certificados A1 (.pfx / .p12)
  'application/xml',
  'text/xml',
  'text/plain', // Arquivos AFD / relatórios em texto
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // XLSX
  'application/vnd.ms-excel', // XLS
]);

export interface UploadFileInput {
  tenantId?: string | null;
  workerId?: string | null;
  category: FileCategory;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy?: string | null;
  isPrivate?: boolean;
}

export class StorageService {
  private readonly adapter: IStorageAdapter;
  private readonly db: Pool;
  private readonly hmacSecret: string;
  private readonly publicUrl: string;

  constructor(options?: {
    adapter?: IStorageAdapter;
    db?: Pool;
    hmacSecret?: string;
    publicUrl?: string;
  }) {
    this.adapter = options?.adapter || new LocalFsStorageAdapter(env.STORAGE_BASE_PATH);
    this.db = options?.db || defaultPool;
    this.hmacSecret = options?.hmacSecret || env.STORAGE_HMAC_SECRET;
    this.publicUrl = options?.publicUrl || env.APP_PUBLIC_URL;
  }

  /**
   * Faz upload de arquivo, calculando SHA-256 e salvando metadados no banco
   */
  public async upload(input: UploadFileInput): Promise<StoredFileRecord> {
    // 1. Validação de MIME Type
    if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
      throw new Error(`[STORAGE ERROR] Tipo de arquivo (MIME) nao permitido: ${input.mimeType}`);
    }

    // 2. Cálculo do Hash SHA-256 e Tamanho
    const sha256Hash = crypto.createHash('sha256').update(input.buffer).digest('hex');
    const byteSize = input.buffer.length;

    // 3. Sanitização do nome do arquivo
    const safeExt = path.extname(input.originalName).toLowerCase();
    const safeBaseName = path
      .basename(input.originalName, safeExt)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 100);

    const fileId = crypto.randomUUID();
    const filename = `${safeBaseName}_${fileId.slice(0, 8)}${safeExt}`;

    // 4. Estrutura do path: {tenantId}/{workerId}/{filename}
    const tenantFolder = input.tenantId || 'global';
    const workerFolder = input.workerId || 'general';
    const relPath = path.join(tenantFolder, workerFolder, filename).replace(/\\/g, '/');

    // 5. Gravação no disco físico (via adapter seguro)
    await this.adapter.save(relPath, input.buffer);

    // 6. Registro no banco de dados (public.stored_files) sob contexto RLS
    const query = `
      INSERT INTO public.stored_files (
        id, tenant_id, worker_id, category, original_name,
        mime_type, byte_size, sha256_hash, storage_rel_path,
        is_private, uploaded_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *;
    `;

    const values = [
      fileId,
      input.tenantId || null,
      input.workerId || null,
      input.category,
      input.originalName,
      input.mimeType,
      byteSize,
      sha256Hash,
      relPath,
      input.isPrivate ?? true,
      input.uploadedBy || null,
    ];

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      if (input.tenantId) {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true);`, [input.tenantId]);
      }
      const result = await client.query<StoredFileRecord>(query, values);
      await client.query('COMMIT');
      const row = result.rows[0];
      return {
        ...row,
        byte_size: Number(row.byte_size),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Gera uma URL de download segura assinada com HMAC-SHA256 e tempo de expiração
   */
  public generateSignedDownloadUrl(
    fileId: string,
    expiresInSeconds = 300,
    inline = false
  ): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const payload = `${fileId}:${expiresAt}:${inline ? '1' : '0'}`;

    const signature = crypto
      .createHmac('sha256', this.hmacSecret)
      .update(payload)
      .digest('hex');

    const baseUrl = this.publicUrl.replace(/\/+$/, '');
    return `${baseUrl}/api/v1/storage/download/${fileId}?expires=${expiresAt}&signature=${signature}&inline=${inline ? '1' : '0'}`;
  }

  /**
   * Valida a assinatura HMAC de uma URL de download
   */
  public verifySignature(
    fileId: string,
    expiresAt: number,
    signature: string,
    inline = false
  ): boolean {
    const currentTimestamp = Math.floor(Date.now() / 1000);

    // 1. Checa expiração
    if (currentTimestamp > expiresAt) {
      return false;
    }

    // 2. Recalcula o HMAC esperado
    const payload = `${fileId}:${expiresAt}:${inline ? '1' : '0'}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.hmacSecret)
      .update(payload)
      .digest('hex');

    // 3. Comparação com timingSafeEqual para evitar Timing Attacks
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  }

  /**
   * Obtém os metadados do arquivo registrado no banco de dados
   */
  public async getFileById(fileId: string, tenantId?: string): Promise<StoredFileRecord | null> {
    const client = await this.db.connect();
    try {
      if (tenantId) {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true);`, [tenantId]);
      }
      const result = await client.query<StoredFileRecord>(
        'SELECT * FROM public.get_stored_file_by_id($1)',
        [fileId]
      );
      if (!result.rows[0]) return null;
      return {
        ...result.rows[0],
        byte_size: Number(result.rows[0].byte_size),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Obtém a stream para download/leitura segura
   */
  public async getFileStream(file: StoredFileRecord) {
    return this.adapter.readStream(file.storage_rel_path);
  }
}
