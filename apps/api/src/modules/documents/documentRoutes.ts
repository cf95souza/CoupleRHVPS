import crypto from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/authMiddleware.js';

const signDocumentSchema = z.object({
  signatureType: z.enum(['ELECTRONIC_PIN', 'BIOMETRIC_DRAW', 'CERTIFICATE_ICP']).default('ELECTRONIC_PIN'),
  signatureData: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

export const documentRoutes: FastifyPluginAsync = async (app) => {
  // Assinatura Digital de Documentos com Validação de Ownership do Trabalhador
  app.post(
    '/:id/sign',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const parseResult = signDocumentSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados de assinatura inválidos.',
          details: parseResult.error.format(),
        });
      }

      const { signatureType, signatureData, latitude, longitude } = parseResult.data;
      const user = request.user;
      if (!user || !request.withContext) {
        return reply.status(401).send({ success: false, error: 'Usuário não autenticado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          // 1. Busca documento
          const { rows: docRows } = await client.query<{
            id: string;
            worker_id: string;
            status: string;
            tenant_id: string;
          }>(
            'SELECT id, worker_id, status, tenant_id FROM public.employee_documents WHERE id = $1;',
            [id]
          );

          if (docRows.length === 0) {
            throw new Error('DOCUMENT_NOT_FOUND');
          }

          const doc = docRows[0];

          // 2. Bloqueio IDOR: se for perfil employee, deve ser o titular do documento
          if (user.role === 'employee' && user.worker_id !== doc.worker_id) {
            throw new Error('FORBIDDEN_DOCUMENT_OWNER');
          }

          // 3. Busca dados do usuário para a chancela
          const { rows: userRows } = await client.query<{ full_name: string; cpf: string }>(
            'SELECT full_name, cpf FROM public.users WHERE id = $1;',
            [user.sub]
          );
          const signerName = userRows[0]?.full_name || 'Colaborador';
          const signerCpf = userRows[0]?.cpf || '00000000000';

          const signedHash = crypto.createHash('sha256').update(
            `${doc.id}:${signerCpf}:${new Date().toISOString()}`
          ).digest('hex');

          // 4. Registra assinatura
          const { rows: sigRows } = await client.query(
            `INSERT INTO public.document_signatures (
              tenant_id, document_id, signer_user_id, signer_name, signer_cpf,
              signer_role, signature_type, signature_data, latitude, longitude,
              signed_hash_sha256, signed_at, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), 'COMPLETED')
            RETURNING id, signed_at, signed_hash_sha256;`,
            [
              doc.tenant_id,
              doc.id,
              user.sub,
              signerName,
              signerCpf,
              user.role === 'employee' ? 'EMPLOYEE' : 'COMPANY_REP',
              signatureType,
              signatureData || null,
              latitude || null,
              longitude || null,
              signedHash,
            ]
          );

          // 5. Atualiza documento para SIGNED
          await client.query(
            `UPDATE public.employee_documents 
             SET status = 'SIGNED', updated_at = NOW() 
             WHERE id = $1;`,
            [doc.id]
          );

          return {
            documentId: doc.id,
            signatureId: sigRows[0].id,
            signedAt: sigRows[0].signed_at,
            sha256Hash: sigRows[0].signed_hash_sha256,
          };
        });

        return reply.send({
          success: true,
          message: 'Documento assinado digitalmente com sucesso.',
          data: result,
        });
      } catch (err: any) {
        request.log.warn(err, '[DOCUMENT_SIGN] Falha na assinatura digital');
        if (err.message === 'DOCUMENT_NOT_FOUND') {
          return reply.status(404).send({ success: false, error: 'Documento não localizado.' });
        }
        if (err.message === 'FORBIDDEN_DOCUMENT_OWNER') {
          return reply.status(403).send({
            success: false,
            code: 'FORBIDDEN_DOCUMENT_OWNER',
            error: 'Acesso negado: Você não possui autorização para assinar documento de outro colaborador.',
          });
        }
        return reply.status(500).send({ success: false, error: 'Erro ao processar assinatura digital.' });
      }
    }
  );
};
