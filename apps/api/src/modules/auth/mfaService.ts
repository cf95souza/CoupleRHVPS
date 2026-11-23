import { Pool } from 'pg';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import {
  encryptAesGcm,
  decryptAesGcm,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../../shared/security/cryptoHelper.js';
import { verifyPassword } from '../../shared/security/passwordHasher.js';

// Configuração padrão do TOTP (RFC 6238): tolerância de ±1 período de 30s
authenticator.options = {
  window: 1,
};

export interface MfaEnrollResult {
  factorId: string;
  secret: string;
  otpauthUri: string;
  qrCodeSvg: string;
  recoveryCodes: string[];
}

export interface MfaVerifyResult {
  success: boolean;
  aal: 'aal2';
}

export interface MfaChallengeResult {
  success: boolean;
  aal: 'aal2';
  recoveryCodeUsed: boolean;
}

export interface MfaFactor {
  id: string;
  factor_type: string;
  friendly_name: string;
  is_verified: boolean;
  verified_at: string | null;
  created_at: string;
}

export interface TenantMfaSettings {
  requireMfaRoles: string[];
  sessionTimeoutMinutes: number;
  maxLoginAttempts: number;
}

export class MfaService {
  constructor(private readonly pool: Pool) {}

  /**
   * 1. Inicia o cadastro de MFA (Enroll)
   * Gera o secret TOTP, criptografa com AES-256-GCM, gera 8 recovery codes e o QR Code SVG
   */
  public async enroll(params: {
    userId: string;
    userEmail: string;
    friendlyName?: string;
  }): Promise<MfaEnrollResult> {
    const secret = authenticator.generateSecret();
    const secretEncrypted = encryptAesGcm(secret);
    const recoveryCodes = generateRecoveryCodes(8);
    const recoveryCodesHash = JSON.stringify(recoveryCodes.map(hashRecoveryCode));

    const res = await this.pool.query<{ auth_save_mfa_factor: string }>(
      'SELECT public.auth_save_mfa_factor($1, $2, $3::jsonb, $4);',
      [
        params.userId,
        secretEncrypted,
        recoveryCodesHash,
        params.friendlyName || 'Aplicativo Autenticador (TOTP)',
      ]
    );

    const factorId = res.rows[0].auth_save_mfa_factor;
    const otpauthUri = authenticator.keyuri(params.userEmail, 'coupleRH', secret);
    const qrCodeSvg = await QRCode.toString(otpauthUri, { type: 'svg' });

    return {
      factorId,
      secret,
      otpauthUri,
      qrCodeSvg,
      recoveryCodes,
    };
  }

  /**
   * 2. Valida o código do primeiro setup (Verify)
   * Promove o fator para verificado e promove a sessão para AAL2
   */
  public async verify(params: {
    userId: string;
    factorId: string;
    code: string;
    sessionId?: string;
  }): Promise<MfaVerifyResult> {
    const cleanCode = params.code.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      throw new Error('O código TOTP deve conter exatamente 6 dígitos numéricos.');
    }

    const factorRes = await this.pool.query<{ id: string; secret_encrypted: string }>(
      'SELECT id, secret_encrypted FROM public.auth_get_mfa_factor_for_verification($1, $2);',
      [params.userId, params.factorId]
    );

    if (factorRes.rows.length === 0) {
      throw new Error('Fator MFA não encontrado.');
    }

    const factor = factorRes.rows[0];
    const plainSecret = decryptAesGcm(factor.secret_encrypted);

    const isValid = authenticator.check(cleanCode, plainSecret);
    if (!isValid) {
      throw new Error('Código de autenticação incorreto ou expirado. Tente novamente.');
    }

    // Marca fator como verificado
    await this.pool.query(
      'SELECT public.auth_verify_mfa_factor($1, $2);',
      [factor.id, params.userId]
    );

    // Se houver sessão vinculada, promove para AAL2
    if (params.sessionId) {
      await this.pool.query(
        'SELECT public.auth_promote_session_aal2($1);',
        [params.sessionId]
      );
    }

    return {
      success: true,
      aal: 'aal2',
    };
  }

  /**
   * 3. Responde ao desafio de MFA (Challenge no login ou operação sensível)
   * Aceita tanto código TOTP de 6 dígitos quanto código de recuperação (Backup Code)
   */
  public async challenge(params: {
    userId: string;
    codeOrRecoveryCode: string;
    sessionId?: string;
  }): Promise<MfaChallengeResult> {
    const cleanInput = params.codeOrRecoveryCode.trim();

    const factorRes = await this.pool.query<{
      id: string;
      secret_encrypted: string;
      recovery_codes_hash: any;
      is_verified: boolean;
    }>(
      'SELECT id, secret_encrypted, recovery_codes_hash, is_verified FROM public.auth_get_mfa_factor_for_verification($1, NULL);',
      [params.userId]
    );

    if (factorRes.rows.length === 0 || !factorRes.rows[0].is_verified) {
      throw new Error('O usuário não possui autenticação em dois fatores ativa.');
    }

    const factor = factorRes.rows[0];

    // Cenário 1: Código numérico de 6 dígitos (TOTP normal)
    if (/^\d{6}$/.test(cleanInput)) {
      const secret = decryptAesGcm(factor.secret_encrypted);
      const isTotpValid = authenticator.check(cleanInput, secret);

      if (isTotpValid) {
        if (params.sessionId) {
          await this.pool.query(
            'SELECT public.auth_promote_session_aal2($1);',
            [params.sessionId]
          );
        }
        return {
          success: true,
          aal: 'aal2',
          recoveryCodeUsed: false,
        };
      }
    }

    // Cenário 2: Código de recuperação (Backup Code)
    const codeHash = hashRecoveryCode(cleanInput);
    const consumeRes = await this.pool.query<{ auth_consume_recovery_code: boolean }>(
      'SELECT public.auth_consume_recovery_code($1, $2, $3);',
      [factor.id, params.userId, codeHash]
    );

    if (consumeRes.rows[0]?.auth_consume_recovery_code) {
      if (params.sessionId) {
        await this.pool.query(
          'SELECT public.auth_promote_session_aal2($1);',
          [params.sessionId]
        );
      }
      return {
        success: true,
        aal: 'aal2',
        recoveryCodeUsed: true,
      };
    }

    throw new Error('Código de autenticação ou de recuperação incorreto.');
  }

  /**
   * 4. Desativação do fator MFA (Unenroll)
   * Exige confirmação da senha atual do usuário + código TOTP ou de recuperação
   */
  public async unenroll(params: {
    userId: string;
    factorId: string;
    currentPassword: string;
    codeOrRecoveryCode: string;
  }): Promise<{ success: boolean }> {
    // 1. Confirma senha atual
    const userRes = await this.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM public.users WHERE id = $1 AND is_active = TRUE;',
      [params.userId]
    );

    if (userRes.rows.length === 0) {
      throw new Error('Usuário não encontrado.');
    }

    const isPasswordValid = await verifyPassword(params.currentPassword, userRes.rows[0].password_hash);
    if (!isPasswordValid) {
      throw new Error('Senha atual incorreta.');
    }

    // 2. Confirma código TOTP ou código de recuperação
    await this.challenge({
      userId: params.userId,
      codeOrRecoveryCode: params.codeOrRecoveryCode,
    });

    // 3. Deleta o fator
    const delRes = await this.pool.query<{ auth_delete_mfa_factor: boolean }>(
      'SELECT public.auth_delete_mfa_factor($1, $2);',
      [params.factorId, params.userId]
    );

    if (!delRes.rows[0]?.auth_delete_mfa_factor) {
      throw new Error('Fator MFA não encontrado para remoção.');
    }

    return { success: true };
  }

  /**
   * 5. Lista fatores do usuário
   */
  public async listFactors(userId: string): Promise<MfaFactor[]> {
    const res = await this.pool.query<MfaFactor>(
      'SELECT * FROM public.auth_get_user_mfa_factors($1);',
      [userId]
    );
    return res.rows;
  }

  /**
   * 6. Consulta configurações de MFA e timeout de inatividade do tenant
   */
  public async getTenantSettings(tenantId?: string | null): Promise<TenantMfaSettings> {
    if (!tenantId) {
      return {
        requireMfaRoles: [],
        sessionTimeoutMinutes: 60,
        maxLoginAttempts: 5,
      };
    }

    const res = await this.pool.query<{
      require_mfa_roles: string[];
      session_timeout_minutes: number;
      max_login_attempts: number;
    }>(
      'SELECT * FROM public.auth_get_tenant_mfa_and_session_settings($1);',
      [tenantId]
    );

    if (res.rows.length === 0) {
      return {
        requireMfaRoles: [],
        sessionTimeoutMinutes: 60,
        maxLoginAttempts: 5,
      };
    }

    const row = res.rows[0];
    return {
      requireMfaRoles: row.require_mfa_roles || [],
      sessionTimeoutMinutes: row.session_timeout_minutes || 60,
      maxLoginAttempts: row.max_login_attempts || 5,
    };
  }

  /**
   * 7. Consulta se o usuário possui MFA verificado ativo
   */
  public async getUserMfaStatus(userId: string): Promise<{
    hasVerifiedMfa: boolean;
    verifiedFactorsCount: number;
    totalFactorsCount: number;
  }> {
    const res = await this.pool.query<{
      has_verified_mfa: boolean;
      verified_factors_count: number;
      total_factors_count: number;
    }>(
      'SELECT * FROM public.auth_get_user_mfa_status($1);',
      [userId]
    );

    const row = res.rows[0];
    return {
      hasVerifiedMfa: Boolean(row?.has_verified_mfa),
      verifiedFactorsCount: row?.verified_factors_count || 0,
      totalFactorsCount: row?.total_factors_count || 0,
    };
  }
}
