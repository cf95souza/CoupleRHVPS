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
   * Valida um JWT Access Token e retorna o payload decodificado
   */
  public verifyAccessToken(token: string): AuthTokenPayload {
    return verifyJwt<AuthTokenPayload>(token, env.JWT_ACCESS_SECRET);
  }
}
