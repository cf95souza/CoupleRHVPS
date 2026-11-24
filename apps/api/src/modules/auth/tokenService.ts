import crypto from 'crypto';
import pg from 'pg';
import { env } from '../../config/env.js';
import { dbPool as defaultPool } from '../../shared/db/pool.js';
import { AlertService } from '../../shared/observability/AlertService.js';
import { signJwt, verifyJwt } from '../../shared/security/jwtHelper.js';

export interface AuthTokenPayload {
  sub: string;               // user_id
  email?: string | null;
  cpf?: string | null;
  tenant_id?: string | null;
  role: string;              // 'system_admin' | 'tenant_admin' | 'dp_analyst' | 'manager' | 'employee' | 'sst_specialist' | 'auditor'
  worker_id?: string | null;
  aal: 'aal1' | 'aal2';
  session_id: string;        // id na tabela user_sessions
  scope?: 'mfa_challenge' | 'mfa_setup_only';
}

export interface GeneratedTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresInSeconds: number;
}

export class TokenService {
  private pool: pg.Pool;
  private alertService: AlertService;

  constructor(pool?: pg.Pool) {
    this.pool = pool || defaultPool;
    this.alertService = new AlertService(this.pool);
  }

  /**
   * Calcula o hash SHA-256 de um token para armazenamento seguro no banco
   */
  public hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Emite um novo par de Access Token (JWT curto 15m) e Refresh Token (rotativo)
   */
  public async createSession(params: {
    userId: string;
    email?: string | null;
    cpf?: string | null;
    tenantId?: string | null;
    role: string;
    workerId?: string | null;
    aal?: 'aal1' | 'aal2';
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<GeneratedTokens> {
    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const refreshTokenHash = this.hashToken(rawRefreshToken);
    const aal = params.aal || 'aal1';

    // 7 dias de validade para o refresh token
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

    const insertSessionQuery = `
      INSERT INTO public.user_sessions (
        user_id, refresh_token_hash, aal, ip_address, user_agent, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id;
    `;

    const sessionRes = await this.pool.query(insertSessionQuery, [
      params.userId,
      refreshTokenHash,
      aal,
      params.ipAddress || null,
      params.userAgent || null,
      expiresAt.toISOString(),
    ]);

    const sessionId = sessionRes.rows[0].id;

    const payload: AuthTokenPayload = {
      sub: params.userId,
      email: params.email || null,
      cpf: params.cpf || null,
      tenant_id: params.tenantId || null,
      role: params.role,
      worker_id: params.workerId || null,
      aal,
      session_id: sessionId,
    };

    // Assina o JWT com segredo e expiração curta (15 minutos)
    const accessToken = signJwt(payload, env.JWT_ACCESS_SECRET, 15 * 60);

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      sessionId,
      expiresInSeconds: 15 * 60, // 15 minutos em segundos
    };
  }

  /**
   * Rotaciona o Refresh Token com detecção estrita de Replay Attack
   */
  public async rotateRefreshToken(
    rawRefreshToken: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ accessToken: string; newRefreshToken: string; payload: AuthTokenPayload }> {
    const tokenHash = this.hashToken(rawRefreshToken);

    const findSessionQuery = `
      SELECT s.*, u.email, u.cpf, u.is_active, u.full_name
      FROM public.user_sessions s
      JOIN public.users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = $1;
    `;

    const res = await this.pool.query(findSessionQuery, [tokenHash]);

    if (res.rows.length === 0) {
      throw new Error('Sessão inválida ou não encontrada.');
    }

    const session = res.rows[0];

    // DETECÇÃO DE REPLAY ATTACK: se um refresh token revogado for reutilizado
    if (session.revoked_at !== null) {
      // Revoga imediatamente todas as outras sessões deste usuário como medida de defesa
      await this.pool.query(
        'UPDATE public.user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL;',
        [session.user_id]
      );

      await this.alertService.createAlert({
        severity: 'CRITICAL',
        category: 'SECURITY',
        title: 'Tentativa de Replay de Sessão Detectada',
        message: `Detecção de reuso de refresh token revogado para o usuário ID ${session.user_id}. Todas as sessões foram encerradas preventivamente.`,
        metadata: {
          user_id: session.user_id,
          ip_address: ipAddress,
          user_agent: userAgent,
        },
      });

      throw new Error('Violação de segurança detectada: sessão comprometida e revogada.');
    }

    // Checa se o usuário está inativo
    if (!session.is_active) {
      throw new Error('Conta de usuário inativa ou desativada.');
    }

    // Checa expiração da sessão
    if (new Date(session.expires_at).getTime() < Date.now()) {
      throw new Error('Sessão expirada. Faça login novamente.');
    }

    // Invalida o token antigo (Single-use rotation)
    await this.pool.query(
      'UPDATE public.user_sessions SET revoked_at = NOW(), last_seen_at = NOW() WHERE id = $1;',
      [session.id]
    );

    // Identifica papel e tenant ativo do usuário via helper seguro
    const tenantUserQuery = `
      SELECT tenant_id, role
      FROM public.auth_get_user_tenant_membership($1);
    `;

    const tuRes = await this.pool.query(tenantUserQuery, [session.user_id]);
    const role = tuRes.rows[0]?.role || 'employee';
    const tenantId = tuRes.rows[0]?.tenant_id || null;
    let workerId: string | null = null;
    if (role === 'employee') {
      const wRes = await this.pool.query('SELECT id FROM public.workers WHERE user_id = $1 LIMIT 1;', [session.user_id]);
      workerId = wRes.rows[0]?.id || null;
    }

    // Emite nova sessão com novo par de tokens
    const newSession = await this.createSession({
      userId: session.user_id,
      email: session.email,
      cpf: session.cpf,
      tenantId,
      role,
      workerId,
      aal: session.aal,
      ipAddress,
      userAgent,
    });

    const payload: AuthTokenPayload = {
      sub: session.user_id,
      email: session.email,
      cpf: session.cpf,
      tenant_id: tenantId,
      role,
      worker_id: workerId,
      aal: session.aal,
      session_id: newSession.sessionId,
    };

    return {
      accessToken: newSession.accessToken,
      newRefreshToken: newSession.refreshToken,
      payload,
    };
  }

  /**
   * Revoga uma sessão ativa específica (Logout)
   */
  public async revokeSession(sessionId: string, userId: string): Promise<boolean> {
    const query = `
      UPDATE public.user_sessions
      SET revoked_at = NOW()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL;
    `;
    const res = await this.pool.query(query, [sessionId, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Revoga todas as sessões ativas do usuário
   */
  public async revokeAllUserSessions(userId: string): Promise<number> {
    const query = `
      UPDATE public.user_sessions
      SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL;
    `;
    const res = await this.pool.query(query, [userId]);
    return res.rowCount ?? 0;
  }

  /**
   * Revoga uma sessão ativa pelo ID independentemente de usuário (uso restrito de governança/admin)
   */
  public async adminRevokeSession(sessionId: string): Promise<boolean> {
    const query = `
      UPDATE public.user_sessions
      SET revoked_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL;
    `;
    const res = await this.pool.query(query, [sessionId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Lista as sessões ativas do usuário
   */
  public async getActiveSessions(userId: string): Promise<Array<{
    id: string;
    aal: string;
    ip_address: string | null;
    user_agent: string | null;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
  }>> {
    const query = `
      SELECT id, aal, ip_address, user_agent, created_at, last_seen_at, expires_at
      FROM public.user_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY last_seen_at DESC;
    `;
    const res = await this.pool.query(query, [userId]);
    return res.rows;
  }

  /**
   * Lista todas as sessões ativas dos usuários de um determinado Tenant (Visão de Governança)
   */
  public async getTenantActiveSessions(tenantId: string): Promise<Array<{
    id: string;
    user_id: string;
    user_email: string;
    user_name: string;
    aal: string;
    ip_address: string | null;
    user_agent: string | null;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
  }>> {
    const query = `
      SELECT 
        s.id, s.user_id, s.aal, s.ip_address, s.user_agent, s.created_at, s.last_seen_at, s.expires_at,
        u.email as user_email,
        COALESCE(up.full_name, u.email) as user_name
      FROM public.user_sessions s
      JOIN public.tenant_users tu ON tu.user_id = s.user_id AND tu.tenant_id = $1
      JOIN public.users u ON u.id = s.user_id
      LEFT JOIN public.user_profiles up ON up.id = s.user_id
      WHERE s.revoked_at IS NULL AND s.expires_at > NOW()
      ORDER BY s.last_seen_at DESC;
    `;
    const res = await this.pool.query(query, [tenantId]);
    return res.rows;
  }

  /**
   * Valida um JWT Access Token e retorna o payload decodificado
   */
  public verifyAccessToken(token: string): AuthTokenPayload {
    return verifyJwt<AuthTokenPayload>(token, env.JWT_ACCESS_SECRET);
  }

  /**
   * Emite token temporário restrito para responder ao desafio de MFA (5 minutos)
   */
  public issueChallengeToken(params: {
    userId: string;
    sessionId: string;
    email?: string | null;
    tenantId?: string | null;
    role: string;
  }): string {
    const payload: AuthTokenPayload = {
      sub: params.userId,
      email: params.email || null,
      tenant_id: params.tenantId || null,
      role: params.role,
      aal: 'aal1',
      session_id: params.sessionId,
      scope: 'mfa_challenge',
    };

    return signJwt(payload, env.JWT_ACCESS_SECRET, 5 * 60); // 5 minutos
  }

  /**
   * Emite token restrito para setup obrigatório de MFA (15 minutos)
   */
  public issueSetupOnlyToken(params: {
    userId: string;
    sessionId: string;
    email?: string | null;
    tenantId?: string | null;
    role: string;
  }): string {
    const payload: AuthTokenPayload = {
      sub: params.userId,
      email: params.email || null,
      tenant_id: params.tenantId || null,
      role: params.role,
      aal: 'aal1',
      session_id: params.sessionId,
      scope: 'mfa_setup_only',
    };

    return signJwt(payload, env.JWT_ACCESS_SECRET, 15 * 60); // 15 minutos
  }

  /**
   * Emite novo Access Token para uma sessão existente (ex: após elevação para AAL2)
   */
  public issueAccessTokenForSession(params: {
    userId: string;
    sessionId: string;
    email?: string | null;
    cpf?: string | null;
    tenantId?: string | null;
    role: string;
    workerId?: string | null;
    aal: 'aal1' | 'aal2';
  }): string {
    const payload: AuthTokenPayload = {
      sub: params.userId,
      email: params.email || null,
      cpf: params.cpf || null,
      tenant_id: params.tenantId || null,
      role: params.role,
      worker_id: params.workerId || null,
      aal: params.aal,
      session_id: params.sessionId,
    };

    return signJwt(payload, env.JWT_ACCESS_SECRET, 15 * 60);
  }

  /**
   * Promove a sessão para AAL2 no banco de dados
   */
  public async promoteSessionToAal2(sessionId: string): Promise<boolean> {
    const res = await this.pool.query<{ auth_promote_session_aal2: boolean }>(
      'SELECT public.auth_promote_session_aal2($1);',
      [sessionId]
    );
    return Boolean(res.rows[0]?.auth_promote_session_aal2);
  }

  /**
   * Atualiza a atividade da sessão e detecta timeout de inatividade
   */
  public async touchSessionActivity(
    sessionId: string,
    maxInactivityMinutes = 60
  ): Promise<{ isValid: boolean; isExpired: boolean; userId: string | null; aal: string | null }> {
    const res = await this.pool.query<{
      is_valid: boolean;
      is_expired: boolean;
      user_id: string | null;
      aal: string | null;
    }>(
      'SELECT * FROM public.auth_touch_session_activity($1, $2);',
      [sessionId, maxInactivityMinutes]
    );

    const row = res.rows[0];
    return {
      isValid: Boolean(row?.is_valid),
      isExpired: Boolean(row?.is_expired),
      userId: row?.user_id || null,
      aal: row?.aal || null,
    };
  }
}
