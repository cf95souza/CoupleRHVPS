import pg from 'pg';
import { dbPool } from './pool.js';

export interface TenantContext {
  userId?: string | null;
  tenantId?: string | null;
  role?: string | null;
  workerId?: string | null;
}

export class InactiveAccountError extends Error {
  public code: string;

  constructor(reason: string) {
    super(`Conta ou vínculo inativo no sistema: ${reason}`);
    this.name = 'InactiveAccountError';
    this.code = reason; // 'USER_INACTIVE' | 'TENANT_INACTIVE' | 'MEMBERSHIP_INACTIVE'
  }
}

/**
 * Executa uma operação transacional isolada com contexto de RLS e auditoria configurados no PostgreSQL.
 *
 * 1. Adquire uma conexão exclusiva do pool (role couplerh_app com RLS ativa).
 * 2. Valida atividade do usuário, tenant e vínculo (membership) via auth_assert_tenant_context_active.
 * 3. Inicia transação atômica: BEGIN.
 * 4. Configura as variáveis de sessão com escopo estritamente local à transação (is_local = true):
 *    - app.current_user_id
 *    - app.current_tenant_id
 *    - app.current_role_id
 *    - app.current_worker_id
 * 5. Executa a função de callback fornecida com o cliente transacional.
 * 6. Em caso de sucesso, efetua o COMMIT.
 * 7. Em caso de erro, efetua o ROLLBACK e relança o erro original.
 * 8. Libera o cliente de volta ao pool no bloco finally, garantindo que o pool nunca seja contaminado.
 */
export async function withTenantContext<T>(
  ctx: TenantContext,
  callback: (client: pg.PoolClient) => Promise<T>,
  customPool?: pg.Pool
): Promise<T> {
  const pool = customPool || dbPool;
  const client = await pool.connect();

  try {
    // 1. Validação prévia de integridade de conta e tenant
    if (ctx.userId || ctx.tenantId) {
      const { rows } = await client.query<{ is_active: boolean; reason: string }>(
        'SELECT is_active, reason FROM public.auth_assert_tenant_context_active($1, $2);',
        [ctx.userId || null, ctx.tenantId || null]
      );

      if (rows.length > 0 && !rows[0].is_active) {
        throw new InactiveAccountError(rows[0].reason);
      }
    }

    // 2. Inicia transação
    await client.query('BEGIN;');

    // 3. Aplica variáveis com is_local = true (equivalente a SET LOCAL)
    await client.query(
      `SELECT 
        set_config('app.current_user_id', $1, true),
        set_config('app.current_tenant_id', $2, true),
        set_config('app.current_role_id', $3, true),
        set_config('app.current_worker_id', $4, true);`,
      [
        ctx.userId ?? '',
        ctx.tenantId ?? '',
        ctx.role ?? '',
        ctx.workerId ?? '',
      ]
    );

    // 4. Executa callback de negócio
    const result = await callback(client);

    // 5. Commit
    await client.query('COMMIT;');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK;');
    } catch {
      // Ignora erro secundário de rollback se a conexão foi abortada pelo servidor
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Executa uma operação somente leitura (READ ONLY) no escopo de RLS do Tenant
 */
export async function withReadOnlyTenantContext<T>(
  ctx: TenantContext,
  callback: (client: pg.PoolClient) => Promise<T>,
  customPool?: pg.Pool
): Promise<T> {
  const pool = customPool || dbPool;
  const client = await pool.connect();

  try {
    if (ctx.userId || ctx.tenantId) {
      const { rows } = await client.query<{ is_active: boolean; reason: string }>(
        'SELECT is_active, reason FROM public.auth_assert_tenant_context_active($1, $2);',
        [ctx.userId || null, ctx.tenantId || null]
      );

      if (rows.length > 0 && !rows[0].is_active) {
        throw new InactiveAccountError(rows[0].reason);
      }
    }

    await client.query('BEGIN READ ONLY;');

    await client.query(
      `SELECT 
        set_config('app.current_user_id', $1, true),
        set_config('app.current_tenant_id', $2, true),
        set_config('app.current_role_id', $3, true),
        set_config('app.current_worker_id', $4, true);`,
      [
        ctx.userId ?? '',
        ctx.tenantId ?? '',
        ctx.role ?? '',
        ctx.workerId ?? '',
      ]
    );

    const result = await callback(client);
    await client.query('COMMIT;');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK;');
    } catch {
      // Ignora erro secundário de rollback
    }
    throw error;
  } finally {
    client.release();
  }
}
