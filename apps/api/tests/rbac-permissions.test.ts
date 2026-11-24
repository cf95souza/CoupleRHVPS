import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { authenticate } from '../src/modules/auth/authMiddleware.js';
import { requirePermission, requireAnyPermission } from '../src/modules/auth/rbacMiddleware.js';

describe('RBAC Dinâmico, Matriz de Permissões e Middleware has_permission (RBAC-01)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;

  // Tenants de Teste
  const tenantAlphaId = 'd0000000-0000-0000-0000-000000000001';
  const tenantBetaId = 'd0000000-0000-0000-0000-000000000002';

  // Usuários de Teste
  const userAdminId = 'd0000000-0000-0000-0000-000000000010';
  const userDpId = 'd0000000-0000-0000-0000-000000000020';
  const userManagerId = 'd0000000-0000-0000-0000-000000000030';
  const userEmployeeId = 'd0000000-0000-0000-0000-000000000040';
  const userCustomId = 'd0000000-0000-0000-0000-000000000050';
  const userInactiveId = 'd0000000-0000-0000-0000-000000000060';

  // Role customizada
  let customRoleId: string;

  beforeAll(async () => {
    app = await buildApp();

    // Rotas de teste simuladas com middlewares de RBAC
    app.get(
      '/test/rbac/payroll',
      { preHandler: [authenticate, requirePermission('calculate_payroll')] },
      async () => ({ success: true, message: 'Cálculo de folha autorizado' })
    );

    app.get(
      '/test/rbac/users-mgmt',
      { preHandler: [authenticate, requirePermission('manage_users')] },
      async () => ({ success: true, message: 'Gestão de usuários autorizada' })
    );

    app.get(
      '/test/rbac/time-or-payroll',
      { preHandler: [authenticate, requireAnyPermission(['manage_time_tracking', 'calculate_payroll'])] },
      async () => ({ success: true, message: 'Ponto ou folha autorizados' })
    );

    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');

      // 1. Criar Tenants respeitando RLS
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Alpha Enterprise', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, name = EXCLUDED.name;
      `, [tenantAlphaId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBetaId]);
      await client.query(`
        INSERT INTO public.tenants (id, name, status, settings)
        VALUES ($1, 'Beta Corp', 'ACTIVE', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, name = EXCLUDED.name;
      `, [tenantBetaId]);

      const defaultHash = await hashPassword('SenhaSegura123!');

      // Define contexto de tenantAlpha para criar dados associados
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);
      await client.query("SELECT set_config('app.current_user_id', $1, true);", [userAdminId]);

      // 2. Criar Usuários
      await client.query(`
        INSERT INTO public.users (id, full_name, email, password_hash, is_active)
        VALUES
          ('${userAdminId}', 'Super Admin Alpha', 'superadmin@alpha.com', '${defaultHash}', TRUE),
          ('${userDpId}', 'Analista DP Alpha', 'dp@alpha.com', '${defaultHash}', TRUE),
          ('${userManagerId}', 'Gestor Equipe Alpha', 'gestor@alpha.com', '${defaultHash}', TRUE),
          ('${userEmployeeId}', 'Colaborador Alpha', 'colab@alpha.com', '${defaultHash}', TRUE),
          ('${userCustomId}', 'Operador Ponto Alpha', 'custom@alpha.com', '${defaultHash}', TRUE),
          ('${userInactiveId}', 'Inativo Alpha', 'inativo@alpha.com', '${defaultHash}', TRUE)
        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, is_active = EXCLUDED.is_active;
      `);

      // 3. Obter IDs das roles de sistema padrão
      const rolesRes = await client.query(`
        SELECT id, slug FROM public.roles WHERE is_system = TRUE AND tenant_id IS NULL;
      `);
      const roleMap = new Map<string, string>();
      rolesRes.rows.forEach((r: { id: string; slug: string }) => roleMap.set(r.slug, r.id));

      // 4. Criar Role Customizada para tenantAlpha: 'Assistente de Ponto'
      const customRoleRes = await client.query(`
        INSERT INTO public.roles (tenant_id, name, slug, description, is_system)
        VALUES ('${tenantAlphaId}', 'Assistente de Ponto', 'assistente_ponto', 'Operador de ponto eletrônico', FALSE)
        ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id;
      `);
      customRoleId = customRoleRes.rows[0].id;

      // 5. Vincular 3 permissões à Role Customizada: view_time_tracking, manage_time_tracking, close_time_period
      await client.query(`
        INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT '${customRoleId}', p.id
        FROM public.permissions p
        WHERE p.slug IN ('view_time_tracking', 'manage_time_tracking', 'close_time_period')
        ON CONFLICT DO NOTHING;
      `);

      // 6. Vincular Usuários aos Tenants com seus respectivos papéis
      await client.query(`
        INSERT INTO public.tenant_users (tenant_id, user_id, role, role_id, is_active)
        VALUES
          ('${tenantAlphaId}', '${userAdminId}', 'system_admin', '${roleMap.get('system_admin')}', TRUE),
          ('${tenantAlphaId}', '${userDpId}', 'dp_analyst', '${roleMap.get('dp_analyst')}', TRUE),
          ('${tenantAlphaId}', '${userManagerId}', 'manager', '${roleMap.get('manager')}', TRUE),
          ('${tenantAlphaId}', '${userEmployeeId}', 'employee', '${roleMap.get('employee')}', TRUE),
          ('${tenantAlphaId}', '${userCustomId}', 'custom_operator', '${customRoleId}', TRUE),
          ('${tenantAlphaId}', '${userInactiveId}', 'dp_analyst', '${roleMap.get('dp_analyst')}', FALSE)
        ON CONFLICT (tenant_id, user_id) DO UPDATE 
        SET role = EXCLUDED.role, role_id = EXCLUDED.role_id, is_active = EXCLUDED.is_active;
      `);

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Função SQL public.has_permission(p_tenant_id, p_slug)', () => {
    it('deve conceder qualquer permissão para system_admin (acesso universal)', async () => {
      await withTenantContext(
        { userId: userAdminId, tenantId: tenantAlphaId, role: 'system_admin' },
        async (client) => {
          const res1 = await client.query("SELECT public.has_permission($1, 'calculate_payroll') AS allowed;", [tenantAlphaId]);
          const res2 = await client.query("SELECT public.has_permission($1, 'qualquer_slug_inexistente') AS allowed;", [tenantAlphaId]);
          expect(res1.rows[0].allowed).toBe(true);
          expect(res2.rows[0].allowed).toBe(true);
        }
      );
    });

    it('deve validar permissões do papel dp_analyst corretamente', async () => {
      await withTenantContext(
        { userId: userDpId, tenantId: tenantAlphaId, role: 'dp_analyst' },
        async (client) => {
          // Permissões que DP analyst TEM
          const canCalc = await client.query("SELECT public.has_permission($1, 'calculate_payroll') AS allowed;", [tenantAlphaId]);
          const canVacation = await client.query("SELECT public.has_permission($1, 'manage_vacations') AS allowed;", [tenantAlphaId]);
          expect(canCalc.rows[0].allowed).toBe(true);
          expect(canVacation.rows[0].allowed).toBe(true);

          // Permissões que DP analyst NÃO tem (ex: gestão de usuários do sistema, reabertura)
          const canManageUsers = await client.query("SELECT public.has_permission($1, 'manage_users') AS allowed;", [tenantAlphaId]);
          const canManageRoles = await client.query("SELECT public.has_permission($1, 'manage_roles') AS allowed;", [tenantAlphaId]);
          expect(canManageUsers.rows[0].allowed).toBe(false);
          expect(canManageRoles.rows[0].allowed).toBe(false);
        }
      );
    });

    it('deve validar permissões do papel manager (gestor) corretamente', async () => {
      await withTenantContext(
        { userId: userManagerId, tenantId: tenantAlphaId, role: 'manager' },
        async (client) => {
          const canApprove = await client.query("SELECT public.has_permission($1, 'approve_team_requests') AS allowed;", [tenantAlphaId]);
          const canViewPonto = await client.query("SELECT public.has_permission($1, 'view_time_tracking') AS allowed;", [tenantAlphaId]);
          expect(canApprove.rows[0].allowed).toBe(true);
          expect(canViewPonto.rows[0].allowed).toBe(true);

          // Gestor não pode fechar folha nem gerenciar rubricas
          const canClosePayroll = await client.query("SELECT public.has_permission($1, 'close_payroll') AS allowed;", [tenantAlphaId]);
          expect(canClosePayroll.rows[0].allowed).toBe(false);
        }
      );
    });

    it('deve validar permissões do papel employee (portal do colaborador)', async () => {
      await withTenantContext(
        { userId: userEmployeeId, tenantId: tenantAlphaId, role: 'employee' },
        async (client) => {
          const canPortal = await client.query("SELECT public.has_permission($1, 'self_service_portal') AS allowed;", [tenantAlphaId]);
          const canViewDash = await client.query("SELECT public.has_permission($1, 'view_dashboard') AS allowed;", [tenantAlphaId]);
          expect(canPortal.rows[0].allowed).toBe(true);
          expect(canViewDash.rows[0].allowed).toBe(false);
        }
      );
    });

    it('deve validar permissões para PERFIL CUSTOMIZADO criado pelo tenant (sem enums hardcoded)', async () => {
      await withTenantContext(
        { userId: userCustomId, tenantId: tenantAlphaId, role: 'custom_operator' },
        async (client) => {
          // As 3 permissões configuradas na role customizada
          const canManageTime = await client.query("SELECT public.has_permission($1, 'manage_time_tracking') AS allowed;", [tenantAlphaId]);
          const canCloseTime = await client.query("SELECT public.has_permission($1, 'close_time_period') AS allowed;", [tenantAlphaId]);
          expect(canManageTime.rows[0].allowed).toBe(true);
          expect(canCloseTime.rows[0].allowed).toBe(true);

          // Permissão não atribuída à role customizada
          const canViewSalaries = await client.query("SELECT public.has_permission($1, 'view_salaries') AS allowed;", [tenantAlphaId]);
          const canCalcPayroll = await client.query("SELECT public.has_permission($1, 'calculate_payroll') AS allowed;", [tenantAlphaId]);
          expect(canViewSalaries.rows[0].allowed).toBe(false);
          expect(canCalcPayroll.rows[0].allowed).toBe(false);
        }
      );
    });

    it('deve negar qualquer permissão se o vínculo do usuário no tenant estiver inativo (is_active = FALSE)', async () => {
      // Usuário inativo tenta checar permissão
      const client = await dbPool.connect();
      try {
        await client.query("SELECT set_config('app.current_user_id', $1, true);", [userInactiveId]);
        await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAlphaId]);
        const res = await client.query("SELECT public.has_permission($1, 'calculate_payroll') AS allowed;", [tenantAlphaId]);
        expect(res.rows[0].allowed).toBe(false);
      } finally {
        client.release();
      }
    });

    it('deve negar permissão se o tenant consultado for diferente do tenant vinculado (isolamento multi-tenant)', async () => {
      await withTenantContext(
        { userId: userDpId, tenantId: tenantAlphaId, role: 'dp_analyst' },
        async (client) => {
          // userDp tem permissão em tenantAlphaId, mas consulta tenantBetaId
          const res = await client.query("SELECT public.has_permission($1, 'calculate_payroll') AS allowed;", [tenantBetaId]);
          expect(res.rows[0].allowed).toBe(false);
        }
      );
    });
  });

  describe('2. Middlewares Fastify requirePermission e requireAnyPermission', () => {
    it('deve permitir acesso à rota para quem possui a permissão exigida', async () => {
      const session = await tokenService.createSession({
        userId: userDpId,
        role: 'dp_analyst',
        tenantId: tenantAlphaId,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test/rbac/payroll',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, message: 'Cálculo de folha autorizado' });
    });

    it('deve bloquear com 403 FORBIDDEN_PERMISSION usuário sem a permissão exigida', async () => {
      const session = await tokenService.createSession({
        userId: userDpId,
        role: 'dp_analyst',
        tenantId: tenantAlphaId,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test/rbac/users-mgmt',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe('FORBIDDEN_PERMISSION');
      expect(body.error).toContain('Acesso negado: Perfil não possui a permissão');
      expect(body.requiredPermission).toBe('manage_users');
    });

    it('deve permitir acesso para role customizada em rota que exige sua permissão', async () => {
      const session = await tokenService.createSession({
        userId: userCustomId,
        role: 'custom_operator',
        tenantId: tenantAlphaId,
      });

      // Role customizada tem manage_time_tracking -> rota time-or-payroll deve permitir
      const response = await app.inject({
        method: 'GET',
        url: '/test/rbac/time-or-payroll',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    it('deve permitir bypass imediato para system_admin em rotas restritas', async () => {
      const session = await tokenService.createSession({
        userId: userAdminId,
        role: 'system_admin',
        tenantId: tenantAlphaId,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test/rbac/users-mgmt',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });
  });

  describe('3. Endpoints de RBAC e Catálogo (/api/v1/auth/*)', () => {
    it('GET /api/v1/auth/permissions deve retornar os slugs do usuário logado', async () => {
      const session = await tokenService.createSession({
        userId: userDpId,
        role: 'dp_analyst',
        tenantId: tenantAlphaId,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/permissions',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.role).toBe('dp_analyst');
      expect(Array.isArray(body.permissions)).toBe(true);
      expect(body.permissions).toContain('calculate_payroll');
      expect(body.permissions).toContain('view_payslips');
      expect(body.permissions).not.toContain('manage_users');
    });

    it('GET /api/v1/auth/permissions/catalog deve retornar todas as ~34 permissões do sistema', async () => {
      const session = await tokenService.createSession({
        userId: userDpId,
        role: 'dp_analyst',
        tenantId: tenantAlphaId,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/permissions/catalog',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.count).toBeGreaterThanOrEqual(28);
      expect(body.permissions.some((p: any) => p.slug === 'calculate_payroll')).toBe(true);
      expect(body.permissions.some((p: any) => p.slug === 'self_service_portal')).toBe(true);
    });

    it('GET /api/v1/auth/roles deve listar roles de sistema e a role customizada do tenant', async () => {
      const session = await tokenService.createSession({
        userId: userDpId,
        role: 'dp_analyst',
        tenantId: tenantAlphaId,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/roles',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.roles.some((r: any) => r.slug === 'system_admin' && r.is_system === true)).toBe(true);
      expect(body.roles.some((r: any) => r.slug === 'assistente_ponto' && r.is_system === false)).toBe(true);
    });
  });
});
