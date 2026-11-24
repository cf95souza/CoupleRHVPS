import { FastifyRequest, FastifyReply } from 'fastify';
import pg from 'pg';
import { withReadOnlyTenantContext } from '../../shared/db/context.js';

export interface UserPermissionResult {
  allowed: boolean;
  role?: string;
  isSystemAdmin?: boolean;
}

/**
 * Consulta a função SQL nativa has_permission(p_tenant_id, p_slug)
 */
export async function checkUserPermission(
  client: pg.PoolClient,
  tenantId: string,
  permissionSlug: string
): Promise<boolean> {
  const { rows } = await client.query(
    'SELECT public.has_permission($1::uuid, $2::text) AS allowed;',
    [tenantId, permissionSlug]
  );
  return rows[0]?.allowed === true;
}

/**
 * Retorna todos os slugs de permissões ativas para o usuário no tenant
 */
export async function getUserPermissions(
  client: pg.PoolClient,
  userId: string,
  tenantId: string,
  userRole?: string
): Promise<string[]> {
  // 1. Super Administrador do Sistema possui todas as permissões cadastradas
  if (userRole === 'system_admin') {
    const { rows } = await client.query(
      'SELECT slug FROM public.permissions ORDER BY category, slug;'
    );
    return rows.map((r: { slug: string }) => r.slug);
  }

  // 2. Consulta permissões atribuídas ao papel do usuário
  const { rows } = await client.query(
    `SELECT DISTINCT p.slug
     FROM public.tenant_users tu
     JOIN public.users u ON u.id = tu.user_id
     LEFT JOIN public.roles r ON r.id = tu.role_id
     LEFT JOIN public.role_permissions rp ON rp.role_id = r.id
     LEFT JOIN public.permissions p ON p.id = rp.permission_id
     WHERE tu.user_id = $1::uuid
       AND tu.tenant_id = $2::uuid
       AND tu.is_active = TRUE
       AND u.is_active = TRUE
       AND p.slug IS NOT NULL
     ORDER BY p.slug;`,
    [userId, tenantId]
  );

  return rows.map((r: { slug: string }) => r.slug);
}

/**
 * Factory de middleware Fastify para exigir permissão RBAC específica
 */
export function requirePermission(permissionSlug: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.status(401).send({
        success: false,
        error: 'Autenticação necessária. Usuário não identificado.',
      });
    }

    // 1. Super Administrador de Sistema possui bypass global
    if (request.user.role === 'system_admin') {
      return;
    }

    // 2. Extrai o ID do tenant
    const tenantId =
      request.user.tenant_id ||
      (request.params as any)?.tenantId ||
      (request.query as any)?.tenantId ||
      (request.headers['x-tenant-id'] as string);

    if (!tenantId) {
      return reply.status(403).send({
        success: false,
        code: 'FORBIDDEN_NO_TENANT',
        error: 'Contexto de empresa (tenant) obrigatório para validação de permissões.',
      });
    }

    try {
      let isAllowed = false;

      if (request.withContext) {
        isAllowed = await request.withContext(async (client) => {
          return checkUserPermission(client, tenantId, permissionSlug);
        });
      } else {
        isAllowed = await withReadOnlyTenantContext(
          {
            userId: request.user.sub,
            tenantId,
            role: request.user.role,
            workerId: request.user.worker_id,
          },
          async (client) => checkUserPermission(client, tenantId, permissionSlug)
        );
      }

      if (!isAllowed) {
        return reply.status(403).send({
          success: false,
          code: 'FORBIDDEN_PERMISSION',
          error: `Acesso negado: Perfil não possui a permissão '${permissionSlug}'.`,
          requiredPermission: permissionSlug,
        });
      }
    } catch (err: any) {
      request.log.error(err, `[RBAC] Erro ao validar permissão '${permissionSlug}'`);
      return reply.status(403).send({
        success: false,
        code: 'FORBIDDEN_PERMISSION_ERROR',
        error: 'Acesso negado ou usuário/empresa inativo no sistema.',
      });
    }
  };
}

/**
 * Factory de middleware Fastify para exigir ao menos uma permissão de uma lista (OR)
 */
export function requireAnyPermission(permissionSlugs: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.status(401).send({
        success: false,
        error: 'Autenticação necessária. Usuário não identificado.',
      });
    }

    if (request.user.role === 'system_admin') {
      return;
    }

    const tenantId =
      request.user.tenant_id ||
      (request.params as any)?.tenantId ||
      (request.query as any)?.tenantId ||
      (request.headers['x-tenant-id'] as string);

    if (!tenantId) {
      return reply.status(403).send({
        success: false,
        code: 'FORBIDDEN_NO_TENANT',
        error: 'Contexto de empresa (tenant) obrigatório para validação de permissões.',
      });
    }

    try {
      let isAllowed = false;
      const checker = async (client: pg.PoolClient) => {
        for (const slug of permissionSlugs) {
          const allowed = await checkUserPermission(client, tenantId, slug);
          if (allowed) return true;
        }
        return false;
      };

      if (request.withContext) {
        isAllowed = await request.withContext(checker);
      } else {
        isAllowed = await withReadOnlyTenantContext(
          {
            userId: request.user.sub,
            tenantId,
            role: request.user.role,
            workerId: request.user.worker_id,
          },
          checker
        );
      }

      if (!isAllowed) {
        return reply.status(403).send({
          success: false,
          code: 'FORBIDDEN_PERMISSION',
          error: `Acesso negado: Perfil requer ao menos uma das seguintes permissões: ${permissionSlugs.join(', ')}.`,
          requiredPermissions: permissionSlugs,
        });
      }
    } catch (err: any) {
      request.log.error(err, `[RBAC] Erro ao validar permissões [${permissionSlugs.join(', ')}]`);
      return reply.status(403).send({
        success: false,
        code: 'FORBIDDEN_PERMISSION_ERROR',
        error: 'Acesso negado ou usuário/empresa inativo no sistema.',
      });
    }
  };
}
