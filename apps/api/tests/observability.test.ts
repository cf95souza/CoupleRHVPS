import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AlertService } from '../src/shared/observability/AlertService.js';
import { LGPD_REDACTED_PATHS } from '../src/shared/logger/pinoLogger.js';
import { dbPool } from '../src/shared/db/pool.js';

describe('Observabilidade, Health Checks e Alertas Operacionais (VPS-06)', () => {
  let app: FastifyInstance;
  let alertService: AlertService;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    alertService = new AlertService(dbPool);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Endpoint de Saúde do Sistema (GET /health)', () => {
    it('deve retornar status 200 com métricas ativas de banco de dados e memória', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.status).toBe('healthy');
      expect(body.system).toBe('coupleRH Enterprise API');
      expect(body.version).toBe('2.0.0');
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);

      // Verificações ativas de observabilidade
      expect(body.checks).toBeDefined();
      expect(body.checks.database).toBeDefined();
      expect(body.checks.database.status).toBe('healthy');
      expect(body.checks.database.latency_ms).toBeGreaterThanOrEqual(0);

      expect(body.checks.memory).toBeDefined();
      expect(body.checks.memory.heap_used_mb).toBeGreaterThan(0);
      expect(body.checks.memory.free_system_ram_mb).toBeGreaterThan(0);
    });
  });

  describe('2. Endpoint de Métricas Detalhadas (GET /api/v1/system/metrics)', () => {
    it('deve retornar métricas completas de processo, host e pool de conexões', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/system/metrics',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.timestamp).toBeDefined();
      expect(body.process.pid).toBeDefined();
      expect(body.process.memory.heap_used_mb).toBeGreaterThan(0);

      expect(body.host.platform).toBeDefined();
      expect(body.host.cpu_count).toBeGreaterThan(0);

      expect(body.database.status).toBe('healthy');
      expect(body.database.latency_ms).toBeGreaterThanOrEqual(0);
      expect(body.database.total_clients).toBeGreaterThanOrEqual(1);
    });
  });

  describe('3. Gerenciamento de Alertas Operacionais (AlertService)', () => {
    let createdAlertId: string;

    it('deve criar um alerta operacional com severidade e metadados JSON', async () => {
      const alert = await alertService.createAlert({
        severity: 'WARNING',
        category: 'DATABASE',
        title: 'Pico de latência momentâneo',
        message: 'A consulta demorou mais que 500ms para responder.',
        metadata: { latency_ms: 620, connection_pool_load: 85 },
      });

      expect(alert.id).toBeDefined();
      expect(alert.severity).toBe('WARNING');
      expect(alert.category).toBe('DATABASE');
      expect(alert.title).toBe('Pico de latência momentâneo');
      expect(alert.is_resolved).toBe(false);

      createdAlertId = alert.id;
    });

    it('deve listar o alerta recém-criado entre os alertas ativos', async () => {
      const activeAlerts = await alertService.getActiveAlerts('DATABASE');
      const found = activeAlerts.find((a) => a.id === createdAlertId);

      expect(found).toBeDefined();
      expect(found?.is_resolved).toBe(false);
    });

    it('deve resolver o alerta operacional com sucesso', async () => {
      const resolved = await alertService.resolveAlert(createdAlertId);
      expect(resolved).toBe(true);

      const activeAlerts = await alertService.getActiveAlerts('DATABASE');
      const found = activeAlerts.find((a) => a.id === createdAlertId);
      expect(found).toBeUndefined(); // Não deve mais estar na lista de ativos
    });
  });

  describe('4. Endpoints REST de Alertas (/api/v1/system/alerts)', () => {
    it('deve listar e resolver alertas operacionais via API HTTP', async () => {
      // 1. Cria alerta
      const alert = await alertService.createAlert({
        severity: 'ERROR',
        category: 'QUEUE',
        title: 'Falha temporária de envio SMTP',
        message: 'Timeout ao conectar no servidor de e-mail.',
        metadata: { attempts: 3 },
      });

      // 2. Consulta via GET /api/v1/system/alerts
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/v1/system/alerts?category=QUEUE',
      });

      expect(getRes.statusCode).toBe(200);
      const getBody = JSON.parse(getRes.body);
      expect(getBody.success).toBe(true);
      expect(getBody.alerts.some((a: any) => a.id === alert.id)).toBe(true);

      // 3. Resolve via POST /api/v1/system/alerts/:id/resolve
      const resolveRes = await app.inject({
        method: 'POST',
        url: `/api/v1/system/alerts/${alert.id}/resolve`,
      });

      expect(resolveRes.statusCode).toBe(200);
      const resolveBody = JSON.parse(resolveRes.body);
      expect(resolveBody.success).toBe(true);
    });
  });

  describe('5. Conformidade de Sanitização LGPD (Pino Logger Redaction)', () => {
    it('deve conter regras estritas de redaction para todos os campos sensíveis e PII', () => {
      const requiredRedactedFields = [
        'password',
        'currentPassword',
        'newPassword',
        'token',
        'refreshToken',
        'totpSecret',
        'cpf',
        'pis',
        'rg',
        'cnh',
        'cid',
        'cid10',
        'baseSalary',
        'base_salary',
        'bankAccount',
        'pixKey',
      ];

      for (const field of requiredRedactedFields) {
        const hasRule = LGPD_REDACTED_PATHS.some((path) => path.includes(field));
        expect(hasRule).toBe(true);
      }
    });
  });
});
