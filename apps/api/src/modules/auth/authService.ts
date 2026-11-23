import pg from 'pg';
import { dbPool as defaultPool } from '../../shared/db/pool.js';
import { hashPassword, verifyPassword, normalizeCpf, normalizeBirthDate } from '../../shared/security/passwordHasher.js';
import { TokenService, GeneratedTokens, AuthTokenPayload } from './tokenService.js';
import { AlertService } from '../../shared/observability/AlertService.js';

export interface AdminLoginResult {
  user: {
    id: string;
    email: string;
    full_name: string;
    role: string;
  };
  tenant: {
    id: string;
    name: string;
  } | null;
  tokens: GeneratedTokens;
}

export interface PortalLoginResult {
  worker: {
    id: string;
    full_name: string;
    cpf: string;
    position_title?: string;
  };
  tenantId: string;
  tokens: GeneratedTokens;
}

export class AuthService {
  private pool: pg.Pool;
  private tokenService: TokenService;
  private alertService: AlertService;
  private readonly maxFailedAttempts = 5;
  private readonly lockDurationMinutes = 15;

  constructor(pool?: pg.Pool) {
    this.pool = pool || defaultPool;
    this.tokenService = new TokenService(this.pool);
    this.alertService = new AlertService(this.pool);
  }

  /**
   * 1. Login Corporativo para RH, Departamento Pessoal e Administradores (E-mail + Senha)
   */
  public async loginAdmin(params: {
    email: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AdminLoginResult> {
    const cleanEmail = params.email.trim().toLowerCase();

    // 1. Busca usuário por e-mail via helper seguro
    const userQuery = `
      SELECT id, email, password_hash, full_name, failed_login_attempts, locked_until, is_active
      FROM public.auth_get_user_for_login($1);
    `;
    const userRes = await this.pool.query(userQuery, [cleanEmail]);

    if (userRes.rows.length === 0) {
      throw new Error('E-mail ou senha incorretos.');
    }

    const user = userRes.rows[0];

    // 2. Checa status da conta
    if (!user.is_active) {
      throw new Error('Conta desativada. Entre em contato com o administrador do sistema.');
    }

    // 3. Checa bloqueio de segurança contra força bruta
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const remainingMinutes = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / (60 * 1000));
      throw new Error(`Conta temporariamente bloqueada por excesso de tentativas. Tente novamente em ${remainingMinutes} minuto(s).`);
    }

    // 4. Valida senha com Argon2id
    const passwordMatch = await verifyPassword(params.password, user.password_hash);

    if (!passwordMatch) {
      const attempts = user.failed_login_attempts + 1;
      let lockUntil: string | null = null;

      if (attempts >= this.maxFailedAttempts) {
        lockUntil = new Date(Date.now() + this.lockDurationMinutes * 60 * 1000).toISOString();

        await this.alertService.createAlert({
          severity: 'WARNING',
          category: 'SECURITY',
          title: 'Bloqueio de Conta por Tentativas de Acesso',
          message: `A conta ${cleanEmail} foi bloqueada temporariamente após ${attempts} tentativas consecutivas de senha incorreta.`,
          metadata: {
            user_id: user.id,
            email: cleanEmail,
            ip_address: params.ipAddress,
            user_agent: params.userAgent,
          },
        });
      }

      await this.pool.query(
        'UPDATE public.users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3;',
        [attempts, lockUntil, user.id]
      );

      if (lockUntil) {
        throw new Error(`Conta bloqueada por excesso de tentativas. Tente novamente em ${this.lockDurationMinutes} minutos.`);
      }

      throw new Error('E-mail ou senha incorretos.');
    }

    // 5. Sucesso na senha: reseta tentativas e atualiza last_login
    await this.pool.query(
      'UPDATE public.users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1;',
      [user.id]
    );

    // 6. Busca tenant e perfil do usuário via helper seguro
    const tenantQuery = `
      SELECT tenant_id, role, tenant_name
      FROM public.auth_get_user_tenant_membership($1);
    `;
    const tenantRes = await this.pool.query(tenantQuery, [user.id]);

    const tenantUser = tenantRes.rows[0];
    const role = tenantUser?.role || 'system_admin';
    const tenantId = tenantUser?.tenant_id || null;
    const tenantName = tenantUser?.tenant_name || null;

    // 7. Cria sessão e gera par de tokens
    const tokens = await this.tokenService.createSession({
      userId: user.id,
      email: user.email,
      tenantId,
      role,
      aal: 'aal1',
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role,
      },
      tenant: tenantId ? { id: tenantId, name: tenantName } : null,
      tokens,
    };
  }

  /**
   * 2. Login Prático do Portal do Colaborador (CPF + Data de Nascimento como Senha)
   * Zero complicação para o trabalhador operacional
   */
  public async loginPortal(params: {
    cpf: string;
    birthDateOrPassword: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<PortalLoginResult> {
    const cleanCpf = normalizeCpf(params.cpf);

    if (cleanCpf.length !== 11) {
      throw new Error('CPF inválido. Forneça os 11 dígitos.');
    }

    // 1. Localiza o trabalhador em workers com contrato ativo via helper seguro
    const workerQuery = `
      SELECT id, tenant_id, user_id, full_name, cpf, birth_date, email,
             contract_status, position_title
      FROM public.auth_get_worker_for_portal_login($1);
    `;
    const workerRes = await this.pool.query(workerQuery, [cleanCpf]);

    if (workerRes.rows.length === 0) {
      throw new Error('CPF ou data de nascimento incorretos.');
    }

    const worker = workerRes.rows[0];

    // 2. Normaliza a data de nascimento do trabalhador no banco
    let workerBirthIso: string | null = null;
    if (worker.birth_date) {
      if (worker.birth_date instanceof Date) {
        workerBirthIso = worker.birth_date.toISOString().split('T')[0];
      } else if (typeof worker.birth_date === 'string') {
        workerBirthIso = (worker.birth_date as string).split('T')[0];
      }
    }
    const inputBirthIso = normalizeBirthDate(params.birthDateOrPassword);

    let isAuthenticated = false;

    // Confere se bate com a data de nascimento (DDMMAAAA ou DD/MM/AAAA)
    if (workerBirthIso && inputBirthIso && workerBirthIso === inputBirthIso) {
      isAuthenticated = true;
    }

    // Se não bateu com a data, mas o trabalhador já tem conta em users com senha própria
    if (!isAuthenticated && worker.user_id) {
      const userRes = await this.pool.query(
        'SELECT password_hash FROM public.users WHERE id = $1 AND is_active = TRUE;',
        [worker.user_id]
      );
      if (userRes.rows.length > 0) {
        isAuthenticated = await verifyPassword(params.birthDateOrPassword, userRes.rows[0].password_hash);
      }
    }

    if (!isAuthenticated) {
      throw new Error('CPF ou data de nascimento incorretos.');
    }

    // 3. Provisiona / vincula usuário de forma atômica e segura via helper SECURITY DEFINER
    const birthDateInitial = workerBirthIso || '1990-01-01';
    const defaultHash = await hashPassword(birthDateInitial);

    const ensureUserRes = await this.pool.query<{ auth_ensure_portal_worker_user: string }>(
      'SELECT public.auth_ensure_portal_worker_user($1, $2, $3, $4, $5, $6);',
      [worker.id, worker.tenant_id, cleanCpf, worker.full_name, worker.email || null, defaultHash]
    );

    const userId = ensureUserRes.rows[0].auth_ensure_portal_worker_user;

    // 4. Emite sessão com role 'employee' e o worker_id vinculado
    const tokens = await this.tokenService.createSession({
      userId,
      cpf: cleanCpf,
      tenantId: worker.tenant_id,
      role: 'employee',
      workerId: worker.id,
      aal: 'aal1',
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    return {
      worker: {
        id: worker.id,
        full_name: worker.full_name,
        cpf: cleanCpf,
        position_title: worker.position_title || 'Colaborador',
      },
      tenantId: worker.tenant_id,
      tokens,
    };
  }

  /**
   * 3. Rotação de Refresh Token
   */
  public async refreshToken(rawRefreshToken: string, ipAddress?: string, userAgent?: string) {
    return this.tokenService.rotateRefreshToken(rawRefreshToken, ipAddress, userAgent);
  }

  /**
   * 4. Logout / Revogação de Sessão
   */
  public async logout(sessionId: string, userId: string): Promise<boolean> {
    return this.tokenService.revokeSession(sessionId, userId);
  }

  /**
   * 5. Consulta Dados do Usuário Autenticado (/me)
   */
  public async getMe(userId: string) {
    const userQuery = `
      SELECT id, email, cpf, full_name, phone, last_login_at,
             tenant_id, role, tenant_name, worker_id
      FROM public.auth_get_me($1);
    `;
    const res = await this.pool.query(userQuery, [userId]);
    if (res.rows.length === 0) {
      throw new Error('Usuário não encontrado ou inativo.');
    }
    return res.rows[0];
  }

  public getTokenService(): TokenService {
    return this.tokenService;
  }
}
