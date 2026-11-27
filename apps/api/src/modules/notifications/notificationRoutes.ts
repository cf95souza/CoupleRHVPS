import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotificationService } from './NotificationService.js';
import { authenticate } from '../auth/authMiddleware.js';

export const notificationRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const service = new NotificationService();

  // 1. Lista notificações do usuário autenticado
  app.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const user = (request as any).user;
    const query = request.query as { limit?: string; onlyUnread?: string };

    const limit = query.limit ? parseInt(query.limit, 10) : 20;
    const onlyUnread = query.onlyUnread === 'true';

    const notifications = await request.withContext(async (client) => {
      return service.getUserNotifications(client, user.tenant_id, user.id, {
        limit,
        onlyUnread,
      });
    });

    return reply.send({ success: true, data: notifications });
  });

  // 2. Contador de não-lidas para o badge do sininho
  app.get('/unread-count', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const user = (request as any).user;

    const count = await request.withContext(async (client) => {
      return service.getUnreadCount(client, user.tenant_id, user.id);
    });

    return reply.send({ success: true, data: { unreadCount: count } });
  });

  // 3. Marca uma notificação como lida
  app.patch('/:id/read', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const user = (request as any).user;
    const { id } = request.params as { id: string };

    const success = await request.withContext(async (client) => {
      return service.markAsRead(client, user.tenant_id, user.id, id);
    });

    return reply.send({ success, data: { read: success } });
  });

  // 4. Marca todas as notificações como lidas
  app.post('/read-all', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const user = (request as any).user;

    const count = await request.withContext(async (client) => {
      return service.markAllAsRead(client, user.tenant_id, user.id);
    });

    return reply.send({ success: true, data: { markedCount: count } });
  });

  // 5. Dispara varredura sob demanda de passivos e alertas operacionais
  app.post('/trigger-scan', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const user = (request as any).user;

    const result = await request.withContext(async (client) => {
      return service.runPeriodicAlertScan(client, user.tenant_id);
    });

    return reply.send({ success: true, data: result });
  });
};
