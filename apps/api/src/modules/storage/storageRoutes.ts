import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { StorageService } from '../../shared/storage/StorageService.js';

const downloadQuerySchema = z.object({
  expires: z.coerce.number(),
  signature: z.string().min(10),
  inline: z.enum(['0', '1', 'true', 'false']).optional().default('0'),
});

export const storageRoutes: FastifyPluginAsync = async (app) => {
  const storageService = new StorageService();

  /**
   * GET /api/v1/storage/download/:fileId
   * Rota pública para download via URL assinada HMAC-SHA256 (Zero bucket público)
   */
  app.get('/download/:fileId', async (request, reply) => {
    const { fileId } = request.params as { fileId: string };

    const parsedQuery = downloadQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.status(400).send({
        error: 'Parâmetros de assinatura inválidos ou ausentes.',
        details: parsedQuery.error.format(),
      });
    }

    const { expires, signature, inline: rawInline } = parsedQuery.data;
    const isInline = rawInline === '1' || rawInline === 'true';

    // 1. Validação estrita do HMAC
    const isValid = storageService.verifySignature(fileId, expires, signature, isInline);
    if (!isValid) {
      return reply.status(403).send({
        error: 'Acesso negado: URL de download com assinatura HMAC inválida ou expirada.',
      });
    }

    // 2. Busca dos metadados do arquivo no banco de dados
    const file = await storageService.getFileById(fileId);
    if (!file) {
      return reply.status(404).send({
        error: 'Arquivo solicitado não encontrado ou já expirado.',
      });
    }

    // 3. Obtenção do stream de leitura no disco
    try {
      const stream = await storageService.getFileStream(file);

      const dispositionType = isInline ? 'inline' : 'attachment';
      const encodedFilename = encodeURIComponent(file.original_name);

      reply
        .header('Content-Type', file.mime_type)
        .header('Content-Length', file.byte_size)
        .header(
          'Content-Disposition',
          `${dispositionType}; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`
        )
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=300');

      return reply.send(stream);
    } catch (err) {
      request.log.error(err, `[STORAGE DOWNLOAD ERROR] Falha ao ler arquivo ${fileId}`);
      return reply.status(500).send({
        error: 'Erro interno ao processar stream do arquivo solicitado.',
      });
    }
  });

  /**
   * POST /api/v1/storage/signed-url
   * Gera URL assinada HMAC para um arquivo (chamado internamente por serviços e rotas autenticadas)
   */
  app.post('/signed-url', async (request, reply) => {
    const bodySchema = z.object({
      fileId: z.string().uuid(),
      expiresInSeconds: z.number().int().positive().max(3600).default(300),
      inline: z.boolean().default(false),
    });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Payload inválido para solicitação de URL assinada.',
        details: parsed.error.format(),
      });
    }

    const { fileId, expiresInSeconds, inline } = parsed.data;

    const file = await storageService.getFileById(fileId);
    if (!file) {
      return reply.status(404).send({
        error: 'Arquivo não encontrado.',
      });
    }

    const signedUrl = storageService.generateSignedDownloadUrl(fileId, expiresInSeconds, inline);

    return reply.send({
      fileId,
      signedUrl,
      expiresInSeconds,
      expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
    });
  });
};
