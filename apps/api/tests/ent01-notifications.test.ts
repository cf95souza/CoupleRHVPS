import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { NotificationService } from '../src/modules/notifications/NotificationService.js';

describe('ENT-01: Motor de Notificações, Alertas e Rotinas Periódicas', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. GET /api/v1/notifications deve bloquear requisição sem autenticação (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
    });
    expect(res.statusCode).toBe(401);
  });

  it('2. GET /api/v1/notifications/unread-count deve bloquear requisição sem autenticação (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
    });
    expect(res.statusCode).toBe(401);
  });

  it('3. POST /api/v1/notifications/trigger-scan deve bloquear requisição sem autenticação (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/trigger-scan',
    });
    expect(res.statusCode).toBe(401);
  });

  it('4. NotificationService deve instanciar e expor métodos de auditoria e varredura', () => {
    const service = new NotificationService();
    expect(service.getUserNotifications).toBeDefined();
    expect(service.getUnreadCount).toBeDefined();
    expect(service.markAsRead).toBeDefined();
    expect(service.markAllAsRead).toBeDefined();
    expect(service.createNotification).toBeDefined();
    expect(service.runPeriodicAlertScan).toBeDefined();
  });
});
