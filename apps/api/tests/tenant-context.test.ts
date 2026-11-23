import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext, withReadOnlyTenantContext, InactiveAccountError } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { authenticate } from '../src/modules/auth/authMiddleware.js';

describe('Middleware Transacional withTenantContext, RLS e Auditoria (SEC-04)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;

  // Tenants de Teste
  const tenantAlphaId = 'c0000000-0000-0000-0000-000000000001';
  const tenantBetaId = 'c0000000-0000-0000-0000-000000000002';
  const tenantInactiveId = 'c0000000-0000-0000-0000-000000000003';

  // Usuários de Teste
  const userAlphaId = 'c0000000-0000-0000-0000-000000000010';
  const userBetaId = 'c0000000-0000-0000-0000-000000000020';
  const userInactiveId = 'c0000000-0000-0000-0000-000000000030';
  const userInactiveMembershipId = 'c0000000-0000-0000-0000-000000000040';

  beforeAll(async () => {
    app = await buildApp();

    // Registra rota de teste para validar injeção do decorator request.withContext
    app.get('/test/context-route', { preHandler: [authenticate] }, async (request, reply) => {
      if (!request.withContext) {
        return reply.status(500).send({ error: 'withContext não definido' });
      }

      const data = await request.withContext(async (client) => {
        const { rows } = await client.query(`
          SELECT current_setting('app.current_tenant_id', true) AS tid,
                 current_setting('app.current_user_id', true) AS uid,
                 current_setting('app.current_role_id', true) AS role;
        `);
        return rows[0];
      });

      return reply.send({ success: true, context: data });
    });

    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      // Desativa RLS temporariamente na carga de seed ou seta contexto master
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);

      // 1. Cria Tenants respeitando a RLS de cada tenant (id = current_app_tenant_id)
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Tenant Alpha Corp', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, name = EXCLUDED.name;
      `, [tenantAlphaId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBetaId]);
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Tenant Beta Corp', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, name = EXCLUDED.name;
      `, [tenantBetaId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantInactiveId]);
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Tenant Inativo Corp', 'SUSPENDED', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, name = EXCLUDED.name;
      `, [tenantInactiveId]);

      // 2. Cria Usuários Globais
      const pwdHash = await hashPassword('SenhaSegura2026!');
      await client.query(`
        INSERT INTO public.users (id, email, password_hash, full_name, is_active)
        VALUES 
          ($1, 'admin.alpha@teste.com', $4, 'Admin Alpha', TRUE),
          ($2, 'admin.beta@teste.com', $4, 'Admin Beta', TRUE),
          ($3, 'inativo.global@teste.com', $4, 'Inativo Global', FALSE),
          ($5, 'inativo.membro@teste.com', $4, 'Membro Inativo', TRUE)
        ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active;
      `, [userAlphaId, userBetaId, userInactiveId, pwdHash, userInactiveMembershipId]);

      // 3. Vínculos tenant_users no escopo de cada tenant
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
        VALUES 
          ($1, $2, 'tenant_admin', TRUE),
          ($1, $3, 'tenant_admin', FALSE) -- Membro desativado no Tenant Alpha
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET is_active = EXCLUDED.is_active;
      `, [tenantAlphaId, userAlphaId, userInactiveMembershipId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBetaId]);
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
        VALUES ($1, $2, 'tenant_admin', TRUE)
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET is_active = EXCLUDED.is_active;
      `, [tenantBetaId, userBetaId]);

      await client.query('COMMIT;');
    } catch (e) {
      await client.query('ROLLBACK;');
      throw e;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Isolamento Concorrente Multi-Tenant (RLS Nativa)', () => {
    it('deve garantir que operações paralelas em tenants distintos nunca vazem registros entre si', async () => {
      const deptAlphaId = 'c0000000-0000-0000-0000-000000000101';
      const deptBetaId = 'c0000000-0000-0000-0000-000000000102';

      // Executa escritas em paralelo nos dois tenants
      await Promise.all([
        withTenantContext({ tenantId: tenantAlphaId, userId: userAlphaId, role: 'tenant_admin' }, async (client) => {
          await client.query(`
            INSERT INTO public.departments (id, tenant_id, name, status)
            VALUES ($1, $2, 'Recursos Humanos Alpha', 'ACTIVE')
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
          `, [deptAlphaId, tenantAlphaId]);
        }),
        withTenantContext({ tenantId: tenantBetaId, userId: userBetaId, role: 'tenant_admin' }, async (client) => {
          await client.query(`
            INSERT INTO public.departments (id, tenant_id, name, status)
            VALUES ($1, $2, 'Engenharia Beta', 'ACTIVE')
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
          `, [deptBetaId, tenantBetaId]);
        }),
      ]);

      // Agora consulta no escopo do Tenant Alpha: DEVE ver apenas Alpha e NÃO Beta
      await withTenantContext({ tenantId: tenantAlphaId, userId: userAlphaId }, async (client) => {
        const { rows } = await client.query('SELECT id, name FROM public.departments WHERE id IN ($1, $2)', [
          deptAlphaId,
          deptBetaId,
        ]);
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe(deptAlphaId);
        expect(rows[0].name).toBe('Recursos Humanos Alpha');
      });

      // Agora consulta no escopo do Tenant Beta: DEVE ver apenas Beta e NÃO Alpha
      await withTenantContext({ tenantId: tenantBetaId, userId: userBetaId }, async (client) => {
        const { rows } = await client.query('SELECT id, name FROM public.departments WHERE id IN ($1, $2)', [
          deptAlphaId,
          deptBetaId,
        ]);
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe(deptBetaId);
        expect(rows[0].name).toBe('Engenharia Beta');
      });
    });

    it('não deve vazar configurações de sessão para conexões liberadas ao pool (higiene de conexões)', async () => {
      // Executa uma transação com contexto configurado
      await withTenantContext({ tenantId: tenantAlphaId, userId: userAlphaId }, async (client) => {
        const { rows } = await client.query("SELECT current_setting('app.current_tenant_id', true) AS tid");
        expect(rows[0].tid).toBe(tenantAlphaId);
      });

      // Pega uma conexão diretamente do pool fora de withTenantContext
      const rawClient = await dbPool.connect();
      try {
        const { rows } = await rawClient.query(
          "SELECT current_setting('app.current_tenant_id', true) AS tid, current_setting('app.current_user_id', true) AS uid"
        );
        // O valor local de transação foi resetado ao finalizar a transação (SET LOCAL)
        expect(rows[0].tid === '' || rows[0].tid === null).toBe(true);
        expect(rows[0].uid === '' || rows[0].uid === null).toBe(true);
      } finally {
        rawClient.release();
      }
    });
  });

  describe('2. Validação Atômica de Atividade (Usuário, Tenant e Vínculo)', () => {
    it('deve bloquear execução com USER_INACTIVE se o usuário global estiver inativo', async () => {
      await expect(
        withTenantContext({ tenantId: tenantAlphaId, userId: userInactiveId }, async (client) => {
          await client.query('SELECT 1');
        })
      ).rejects.toThrow(InactiveAccountError);

      try {
        await withTenantContext({ tenantId: tenantAlphaId, userId: userInactiveId }, async () => {});
      } catch (err: any) {
        expect(err.code).toBe('USER_INACTIVE');
      }
    });

    it('deve bloquear execução com TENANT_INACTIVE se a empresa/tenant estiver suspensa', async () => {
      await expect(
        withTenantContext({ tenantId: tenantInactiveId, userId: userAlphaId }, async (client) => {
          await client.query('SELECT 1');
        })
      ).rejects.toThrow(InactiveAccountError);

      try {
        await withTenantContext({ tenantId: tenantInactiveId, userId: userAlphaId }, async () => {});
      } catch (err: any) {
        expect(err.code).toBe('TENANT_INACTIVE');
      }
    });

    it('deve bloquear execução com MEMBERSHIP_INACTIVE se a filiação do usuário no tenant estiver inativa', async () => {
      await expect(
        withTenantContext({ tenantId: tenantAlphaId, userId: userInactiveMembershipId }, async (client) => {
          await client.query('SELECT 1');
        })
      ).rejects.toThrow(InactiveAccountError);

      try {
        await withTenantContext({ tenantId: tenantAlphaId, userId: userInactiveMembershipId }, async () => {});
      } catch (err: any) {
        expect(err.code).toBe('MEMBERSHIP_INACTIVE');
      }
    });
  });

  describe('3. Auditoria Forense Automática (audit.logs)', () => {
    it('deve registrar automaticamente user_id, tenant_id e campos modificados em audit.logs nos disparos de triggers', async () => {
      const auditDeptId = 'c0000000-0000-0000-0000-000000000301';

      // 1. Inserção com contexto de usuário Alpha
      await withTenantContext(
        { tenantId: tenantAlphaId, userId: userAlphaId, role: 'tenant_admin' },
        async (client) => {
          await client.query(`
            INSERT INTO public.departments (id, tenant_id, name, status)
            VALUES ($1, $2, 'Departamento Auditado Inicial', 'ACTIVE')
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
          `, [auditDeptId, tenantAlphaId]);
        }
      );

      // 2. Atualização com contexto de usuário Alpha
      await withTenantContext(
        { tenantId: tenantAlphaId, userId: userAlphaId, role: 'tenant_admin' },
        async (client) => {
          await client.query(`
            UPDATE public.departments
            SET name = 'Departamento Auditado Alterado'
            WHERE id = $1;
          `, [auditDeptId]);
        }
      );

      // 3. Verifica entradas na tabela audit.logs para o registro criado
      await withTenantContext({ tenantId: tenantAlphaId, userId: userAlphaId }, async (client) => {
        const { rows } = await client.query(
          `SELECT action, user_id, tenant_id, changed_fields
           FROM audit.logs
           WHERE record_id = $1
           ORDER BY created_at ASC`,
          [auditDeptId]
        );

        expect(rows.length).toBeGreaterThanOrEqual(2);

        // Primeiro log: INSERT
        const insertLog = rows.find((l) => l.action === 'INSERT');
        expect(insertLog).toBeDefined();
        expect(insertLog.user_id).toBe(userAlphaId);
        expect(insertLog.tenant_id).toBe(tenantAlphaId);

        // Segundo log: UPDATE
        const updateLog = rows.find((l) => l.action === 'UPDATE');
        expect(updateLog).toBeDefined();
        expect(updateLog.user_id).toBe(userAlphaId);
        expect(updateLog.tenant_id).toBe(tenantAlphaId);
        expect(updateLog.changed_fields).toContain('name');
      });
    });
  });

  describe('4. Atomicidade e Rollback Automático em Falhas', () => {
    it('deve realizar ROLLBACK completo e não persistir alterações se a transação lançar erro', async () => {
      const rollbackDeptId = 'c0000000-0000-0000-0000-000000000401';

      await expect(
        withTenantContext({ tenantId: tenantAlphaId, userId: userAlphaId }, async (client) => {
          await client.query(`
            INSERT INTO public.departments (id, tenant_id, name, status)
            VALUES ($1, $2, 'Departamento Que Deve Falhar', 'ACTIVE');
          `, [rollbackDeptId, tenantAlphaId]);

          // Lança erro proposital dentro do bloco transacional
          throw new Error('SIMULATED_TRANSACTION_FAILURE');
        })
      ).rejects.toThrow('SIMULATED_TRANSACTION_FAILURE');

      // Verifica que o registro NÃO foi salvo no banco de dados
      await withTenantContext({ tenantId: tenantAlphaId, userId: userAlphaId }, async (client) => {
        const { rows } = await client.query('SELECT id FROM public.departments WHERE id = $1', [rollbackDeptId]);
        expect(rows.length).toBe(0);
      });
    });
  });

  describe('5. Transações Somente Leitura (withReadOnlyTenantContext)', () => {
    it('deve rejeitar escritas (INSERT/UPDATE/DELETE) com erro nativo do PostgreSQL', async () => {
      const readOnlyDeptId = 'c0000000-0000-0000-0000-000000000501';

      await expect(
        withReadOnlyTenantContext({ tenantId: tenantAlphaId, userId: userAlphaId }, async (client) => {
          await client.query(`
            INSERT INTO public.departments (id, tenant_id, name, status)
            VALUES ($1, $2, 'Departamento ReadOnly', 'ACTIVE');
          `, [readOnlyDeptId, tenantAlphaId]);
        })
      ).rejects.toThrow(/read-only transaction/i);
    });
  });

  describe('6. Integração Fastify request.withContext', () => {
    it('deve disponibilizar request.withContext populado a partir do token de autenticação JWT', async () => {
      // Gera sessão e token JWT de acesso para o usuário Alpha
      const session = await tokenService.createSession({
        userId: userAlphaId,
        email: 'admin.alpha@teste.com',
        role: 'tenant_admin',
        tenantId: tenantAlphaId,
        aal: 'aal1',
      });
      const accessToken = session.accessToken;

      const response = await app.inject({
        method: 'GET',
        url: '/test/context-route',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.context.tid).toBe(tenantAlphaId);
      expect(body.context.uid).toBe(userAlphaId);
      expect(body.context.role).toBe('tenant_admin');
    });
  });
});
