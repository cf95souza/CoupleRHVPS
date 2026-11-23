import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { LocalFsStorageAdapter } from '../src/shared/storage/LocalFsStorageAdapter.js';
import { StorageService } from '../src/shared/storage/StorageService.js';
import { dbPool } from '../src/shared/db/pool.js';

describe('StorageService & LocalFsStorageAdapter (URLs Assinadas HMAC-SHA256)', () => {
  const testStorageDir = path.resolve('./temp_test_storage');
  let adapter: LocalFsStorageAdapter;
  let service: StorageService;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (fs.existsSync(testStorageDir)) {
      fs.rmSync(testStorageDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testStorageDir, { recursive: true });

    // Garante que o tenant de teste exista no banco respeitando o RLS
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', 'd0000000-0000-0000-0000-000000000001', true);");
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ('d0000000-0000-0000-0000-000000000001', 'Tenant Teste Storage', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    adapter = new LocalFsStorageAdapter(testStorageDir);
    service = new StorageService({
      adapter,
      hmacSecret: 'test_super_secure_hmac_secret_min_64_characters_for_vitest_testing',
      publicUrl: 'http://localhost:4000',
    });

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (fs.existsSync(testStorageDir)) {
      fs.rmSync(testStorageDir, { recursive: true, force: true });
    }
  });

  describe('1. LocalFsStorageAdapter & Defesa contra Path Traversal', () => {
    it('deve gravar e ler arquivos com sucesso em caminhos seguros', async () => {
      const relPath = 'tenant_1/worker_2/contrato.pdf';
      const buffer = Buffer.from('%PDF-1.4 Mock Contract Content');

      await adapter.save(relPath, buffer);
      expect(await adapter.exists(relPath)).toBe(true);

      const readBuffer = await adapter.read(relPath);
      expect(readBuffer.toString()).toBe('%PDF-1.4 Mock Contract Content');
    });

    it('deve bloquear imediatamente tentativas de Path Traversal', async () => {
      const maliciousPaths = [
        '../../etc/passwd',
        '..\\..\\windows\\win.ini',
        'tenant_1/../../../etc/shadow',
        'tenant_1/worker_2/../../../../config.json',
      ];

      for (const badPath of maliciousPaths) {
        expect(() => adapter.resolvePath(badPath)).toThrow(/Path Traversal/i);
      }
    });

    it('deve excluir arquivos com sucesso', async () => {
      const relPath = 'temp_to_delete.pdf';
      await adapter.save(relPath, Buffer.from('delete me'));
      expect(await adapter.exists(relPath)).toBe(true);

      await adapter.delete(relPath);
      expect(await adapter.exists(relPath)).toBe(false);
    });
  });

  describe('2. StorageService: Hash SHA-256 e Assinaturas HMAC', () => {
    it('deve calcular SHA-256 e gravar arquivo com metadados', async () => {
      const content = Buffer.from('Holerite de Pagamento CLT - 2026-01');
      const expectedSha256 = crypto.createHash('sha256').update(content).digest('hex');

      const uploaded = await service.upload({
        tenantId: 'd0000000-0000-0000-0000-000000000001',
        category: 'PAYSLIP_PDF',
        originalName: 'holerite_jan_2026.pdf',
        mimeType: 'application/pdf',
        buffer: content,
      });

      expect(uploaded.id).toBeDefined();
      expect(uploaded.sha256_hash).toBe(expectedSha256);
      expect(uploaded.byte_size).toBe(content.length);
      expect(uploaded.category).toBe('PAYSLIP_PDF');
      expect(uploaded.mime_type).toBe('application/pdf');

      // Verifica se o arquivo físico foi gravado no disco
      expect(await adapter.exists(uploaded.storage_rel_path)).toBe(true);
    });

    it('deve rejeitar upload com MIME type não permitido', async () => {
      const evilBuffer = Buffer.from('MZ... executable binary');
      await expect(
        service.upload({
          category: 'DOCUMENT',
          originalName: 'virus.exe',
          mimeType: 'application/x-msdownload',
          buffer: evilBuffer,
        })
      ).rejects.toThrow(/MIME.*nao permitido/i);
    });

    it('deve gerar URL assinada HMAC válida e validar com sucesso', () => {
      const fileId = crypto.randomUUID();
      const signedUrl = service.generateSignedDownloadUrl(fileId, 300, true);

      expect(signedUrl).toContain(`/api/v1/storage/download/${fileId}`);
      expect(signedUrl).toContain('expires=');
      expect(signedUrl).toContain('signature=');
      expect(signedUrl).toContain('inline=1');

      // Extrair parâmetros da URL
      const url = new URL(signedUrl);
      const expires = Number(url.searchParams.get('expires'));
      const signature = url.searchParams.get('signature')!;

      // Validação deve ser verdadeira
      const isValid = service.verifySignature(fileId, expires, signature, true);
      expect(isValid).toBe(true);
    });

    it('deve rejeitar URL com assinatura HMAC adulterada', () => {
      const fileId = crypto.randomUUID();
      const signedUrl = service.generateSignedDownloadUrl(fileId, 300, false);
      const url = new URL(signedUrl);
      const expires = Number(url.searchParams.get('expires'));
      const badSignature = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

      const isValid = service.verifySignature(fileId, expires, badSignature, false);
      expect(isValid).toBe(false);
    });

    it('deve rejeitar URL com expiração no passado', () => {
      const fileId = crypto.randomUUID();
      // Gerando expiração com -10 segundos no passado
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 10;
      const signature = crypto
        .createHmac('sha256', 'test_super_secure_hmac_secret_min_64_characters_for_vitest_testing')
        .update(`${fileId}:${expiredTimestamp}:0`)
        .digest('hex');

      const isValid = service.verifySignature(fileId, expiredTimestamp, signature, false);
      expect(isValid).toBe(false);
    });
  });

  describe('3. Rota HTTP de Download Seguro (Fastify)', () => {
    it('deve retornar 403 se a assinatura HMAC for inválida ou ausente', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/storage/download/${crypto.randomUUID()}?expires=${Math.floor(Date.now() / 1000) + 300}&signature=invalid_signature`,
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Acesso negado');
    });

    it('deve retornar 404 se a assinatura for válida mas o arquivo não existir no banco', async () => {
      const nonExistentFileId = crypto.randomUUID();
      const expires = Math.floor(Date.now() / 1000) + 300;
      const signature = crypto
        .createHmac('sha256', (app as any).storageHmacSecret || 'couplerh_storage_hmac_secret_super_secure_key_change_in_production')
        .update(`${nonExistentFileId}:${expires}:0`)
        .digest('hex');

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/storage/download/${nonExistentFileId}?expires=${expires}&signature=${signature}&inline=0`,
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
