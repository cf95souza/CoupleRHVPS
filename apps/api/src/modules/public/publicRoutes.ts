import { FastifyPluginAsync } from 'fastify';
import { dbPool } from '../../shared/db/pool.js';

/**
 * Rotas Públicas de Verificação com Mascaramento Estrito LGPD
 * São as ÚNICAS rotas do sistema acessíveis sem cabeçalho de autenticação (ponto e documentos).
 * Não expõem dados sensíveis (zero salários, zero PIS, CPFs mascarados e nomes abreviados).
 */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  // Verificação Pública de Documentos Trabalhistas
  app.get('/verify-document/:code', async (request, reply) => {
    const { code } = request.params as { code: string };

    if (!code || code.trim().length === 0) {
      return reply.status(400).send({
        success: false,
        error: 'Código de verificação do documento é obrigatório.',
      });
    }

    try {
      const { rows } = await dbPool.query(
        'SELECT public.verify_public_document($1) AS data;',
        [code.trim()]
      );

      const result = rows[0]?.data;
      if (!result || !result.valid) {
        return reply.status(404).send({
          success: false,
          error: result?.error || 'Documento não localizado ou chancela inválida.',
        });
      }

      return reply.send({
        success: true,
        document: result,
      });
    } catch (err: any) {
      request.log.error(err, '[PUBLIC_VERIFY_DOCUMENT] Erro ao consultar documento público');
      return reply.status(500).send({
        success: false,
        error: 'Erro interno ao validar autenticidade do documento.',
      });
    }
  });

  // Verificação Pública de Comprovantes de Ponto Eletrônico (Portaria MTP 671/2021)
  app.get('/verify-punch/:code', async (request, reply) => {
    const { code } = request.params as { code: string };

    if (!code || code.trim().length === 0) {
      return reply.status(400).send({
        success: false,
        error: 'Código ou hash SHA-256 do comprovante de ponto é obrigatório.',
      });
    }

    try {
      const { rows } = await dbPool.query(
        'SELECT public.verify_public_punch($1) AS data;',
        [code.trim()]
      );

      const result = rows[0]?.data;
      if (!result || !result.valid) {
        return reply.status(404).send({
          success: false,
          error: result?.error || 'Comprovante de ponto não localizado ou hash inválido.',
        });
      }

      return reply.send({
        success: true,
        punch: result,
      });
    } catch (err: any) {
      request.log.error(err, '[PUBLIC_VERIFY_PUNCH] Erro ao consultar comprovante de ponto público');
      return reply.status(500).send({
        success: false,
        error: 'Erro interno ao validar autenticidade do comprovante de ponto.',
      });
    }
  });
};
