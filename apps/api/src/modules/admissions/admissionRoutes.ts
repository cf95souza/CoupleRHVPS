import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authenticate, requireAdminRole } from '../auth/authMiddleware.js';
import { AdmissionService } from './AdmissionService.js';
import { StorageService } from '../../shared/storage/StorageService.js';
import { dbPool } from '../../shared/db/pool.js';

export const admissionRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const service = new AdmissionService();
  const storage = new StorageService();

  // --------------------------------------------------------------------------
  // ROTAS ADMINISTRATIVAS DO DP (Autenticadas)
  // --------------------------------------------------------------------------

  // 1. Cria um novo convite de admissão digital
  app.post(
    '/invites',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const user = (request as any).user;
      const body = request.body as any;

      if (!body.candidateName || !body.candidateEmail || !body.companyId || !body.proposedSalaryCents) {
        return reply.status(400).send({
          success: false,
          error: 'Campos obrigatórios ausentes (candidateName, candidateEmail, companyId, proposedSalaryCents).',
        });
      }

      const invite = await request.withContext(async (client) => {
        return service.createInvite(client, {
          tenantId: user.tenant_id,
          companyId: body.companyId,
          candidateName: body.candidateName,
          candidateEmail: body.candidateEmail,
          candidatePhone: body.candidatePhone,
          candidateCpf: body.candidateCpf,
          positionId: body.positionId,
          departmentId: body.departmentId,
          proposedSalaryCents: parseInt(body.proposedSalaryCents, 10),
          hireDate: body.hireDate || new Date().toISOString().split('T')[0],
          createdByUserId: user.id,
        });
      });

      return reply.send({ success: true, data: invite });
    }
  );

  // 2. Lista os convites de admissão
  app.get(
    '/invites',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const user = (request as any).user;
      const query = request.query as { company_id?: string };

      const invites = await request.withContext(async (client) => {
        return service.listInvites(client, user.tenant_id, query.company_id);
      });

      return reply.send({ success: true, data: invites });
    }
  );

  // 3. Detalhes completos do convite e submissão do candidato
  app.get(
    '/invites/:id',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const user = (request as any).user;
      const { id } = request.params as { id: string };

      const detail = await request.withContext(async (client) => {
        return service.getInviteById(client, user.tenant_id, id);
      });

      if (!detail) {
        return reply.status(404).send({ success: false, error: 'Convite não encontrado.' });
      }

      return reply.send({ success: true, data: detail });
    }
  );

  // 4. Homologação da admissão pelo DP (Cria Worker e Contract)
  app.post(
    '/invites/:id/approve',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const user = (request as any).user;
      const { id } = request.params as { id: string };
      const body = (request.body as any) || {};

      try {
        const result = await request.withContext(async (client) => {
          return service.approveAdmission(client, user.tenant_id, id, user.id, body.notes);
        });

        return reply.send({ success: true, data: result });
      } catch (err: any) {
        request.log.error(err, '[ADMISSION_APPROVE] Falha ao homologar admissão');
        return reply.status(400).send({ success: false, error: err.message || 'Erro ao homologar admissão.' });
      }
    }
  );

  // 5. Rejeição da admissão para retificação
  app.post(
    '/invites/:id/reject',
    { preHandler: [authenticate, requireAdminRole] },
    async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const user = (request as any).user;
      const { id } = request.params as { id: string };
      const body = (request.body as any) || {};

      if (!body.notes) {
        return reply.status(400).send({ success: false, error: 'Motivo da rejeição é obrigatório.' });
      }

      const result = await request.withContext(async (client) => {
        return service.rejectAdmission(client, user.tenant_id, id, user.id, body.notes);
      });

      return reply.send({ success: true, data: result });
    }
  );

  // --------------------------------------------------------------------------
  // ROTAS PÚBLICAS DE AUTO-ATENDIMENTO DO CANDIDATO (Sem Login)
  // --------------------------------------------------------------------------

  // 6. Consulta convite público pelo token CSPRNG
  app.get('/public/invites/:token', async (request, reply) => {
    const { token } = request.params as { token: string };

    try {
      const invite = await service.getPublicInviteByToken(dbPool, token);
      return reply.send({ success: true, data: invite });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err.message });
    }
  });

  // 7. Candidato submete formulário completo
  app.post('/public/invites/:token/submit', async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = request.body as any;
    const ip = request.ip || '127.0.0.1';
    const userAgent = request.headers['user-agent'] || 'Desconhecido';

    try {
      const submission = await service.submitAdmission(dbPool, {
        inviteToken: token,
        personalData: body.personalData,
        addressData: body.addressData,
        bankData: body.bankData,
        dependentsData: body.dependentsData,
        transportOption: body.transportOption,
        timeBankAgreement: body.timeBankAgreement ?? false,
        documentFileIds: body.documentFileIds || [],
        signatureSvg: body.signatureSvg,
        signatureIp: ip,
        signatureUserAgent: userAgent,
      });

      return reply.send({
        success: true,
        data: submission,
        message: 'Dados e documentos enviados com sucesso! Seu cadastro será avaliado pelo RH.',
      });
    } catch (err: any) {
      request.log.error(err, '[ADMISSION_SUBMIT] Erro no envio de dados pelo candidato');
      return reply.status(400).send({ success: false, error: err.message });
    }
  });

  // 8. Upload público de documento do candidato (salva em stored_files privado)
  app.post('/public/invites/:token/upload-doc', async (request, reply) => {
    const { token } = request.params as { token: string };
    const file = await request.file();

    if (!file) {
      return reply.status(400).send({ success: false, error: 'Nenhum arquivo enviado.' });
    }

    try {
      // Valida o token para obter o tenant_id
      const invite = await service.getPublicInviteByToken(dbPool, token);

      const buffer = await file.toBuffer();
      const stored = await storage.upload({
        tenantId: invite.tenant_id,
        originalName: file.filename,
        mimeType: file.mimetype,
        buffer,
        category: 'DOCUMENT',
      });

      return reply.send({
        success: true,
        data: {
          fileId: stored.id,
          fileName: file.filename,
        },
      });
    } catch (err: any) {
      request.log.error(err, '[ADMISSION_UPLOAD] Erro ao receber documento');
      return reply.status(400).send({ success: false, error: err.message });
    }
  });
};
