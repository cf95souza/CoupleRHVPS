import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { AdmissionService } from '../src/modules/admissions/AdmissionService.js';

describe('ENT-03: Admissão Digital Self-Service', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. POST /api/v1/admissions/invites deve bloquear requisição sem autenticação (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admissions/invites',
      payload: {
        candidateName: 'Fulano da Silva',
        candidateEmail: 'fulano@example.com',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('2. GET /api/v1/admissions/invites deve bloquear requisição sem autenticação (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admissions/invites',
    });
    expect(res.statusCode).toBe(401);
  });

  it('3. GET /api/v1/admissions/public/invites/:token deve retornar 400 para token inexistente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admissions/public/invites/token_inexistente_1234567890',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('4. AdmissionService deve instanciar e conter métodos do ciclo de vida de admissão', () => {
    const service = new AdmissionService();
    expect(service.createInvite).toBeDefined();
    expect(service.listInvites).toBeDefined();
    expect(service.getInviteById).toBeDefined();
    expect(service.getPublicInviteByToken).toBeDefined();
    expect(service.submitAdmission).toBeDefined();
    expect(service.approveAdmission).toBeDefined();
    expect(service.rejectAdmission).toBeDefined();
  });
});
