import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('Fastify Server Core & Health Endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health deve retornar status 200 com payload healthy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('healthy');
    expect(body.system).toBe('coupleRH Enterprise API');
    expect(body.version).toBe('2.0.0');
    expect(body.timestamp).toBeDefined();
  });

  it('GET /api/v1/ping deve retornar pong true', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ping',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.pong).toBe(true);
  });
});