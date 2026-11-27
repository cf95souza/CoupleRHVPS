import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { BiService } from '../src/modules/bi/BiService.js';

describe('ENT-02: BI Executivo e Radar de Risco Trabalhista (Passivos CLT)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. GET /api/v1/bi/dashboard-executive deve exigir autenticação (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/bi/dashboard-executive',
    });
    expect(res.statusCode).toBe(401);
  });

  it('2. GET /api/v1/bi/labor-risk-radar deve exigir autenticação (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/bi/labor-risk-radar',
    });
    expect(res.statusCode).toBe(401);
  });

  it('3. BiService deve instanciar e conter o método de consolidação executiva', () => {
    const service = new BiService();
    expect(service.getExecutiveDashboard).toBeDefined();
    expect(typeof service.getExecutiveDashboard).toBe('function');
  });
});
