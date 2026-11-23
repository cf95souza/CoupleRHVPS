import crypto from 'node:crypto';
import { Pool } from 'pg';
import { env } from '../../config/env.js';
import { MailerService } from '../../shared/mailer/MailerService.js';
import { hashPassword, verifyPassword, normalizeBirthDate } from '../../shared/security/passwordHasher.js';

export class PasswordResetService {
  private mailerService: MailerService;

  constructor(private readonly pool: Pool) {
    this.mailerService = new MailerService();
  }

  /**
   * 1. Solicita recuperação de senha (Forgot Password)
   * Resposta genérica anti-enumeração de e-mail (OWASP Top 10 / LGPD)
   */
  public async requestPasswordReset(email: string): Promise<{ success: boolean; message: string }> {
    const cleanEmail = email.toLowerCase().trim();
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const res = await this.pool.query<{
      found: boolean;
      user_id: string | null;
      full_name: string | null;
      email: string | null;
    }>(
      'SELECT * FROM public.auth_create_password_reset_token($1, $2, 30);',
      [cleanEmail, tokenHash]
    );

    const row = res.rows[0];

    // Se usuário existir, envia e-mail com link seguro
    if (row?.found && row.email && row.full_name) {
      const resetUrl = `${env.APP_PUBLIC_URL}/redefinir-senha?token=${rawToken}`;
      try {
        await this.mailerService.sendPasswordReset(row.email, {
          userName: row.full_name,
          resetUrl,
          expiresInMinutes: 30,
        });
      } catch (err) {
        console.error('[AUTH FORGOT_PASSWORD] Erro ao enviar e-mail de recuperação:', err);
      }
    }

    // Mensagem sempre idêntica prevenindo enumeração de contas
    return {
      success: true,
      message: 'Se o e-mail informado estiver cadastrado em nossa base, um link de recuperação será enviado em instantes.',
    };
  }

  /**
   * 2. Valida o token de recuperação de senha
   */
  public async verifyResetToken(rawToken: string): Promise<{ valid: boolean; email?: string; fullName?: string }> {
    const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');

    const res = await this.pool.query<{
      is_valid: boolean;
      is_used: boolean;
      is_expired: boolean;
      user_id: string | null;
      email: string | null;
      full_name: string | null;
    }>(
      'SELECT * FROM public.auth_verify_password_reset_token($1);',
      [tokenHash]
    );

    const row = res.rows[0];

    if (!row || !row.is_valid) {
      if (row?.is_used) {
        throw new Error('Este link de recuperação já foi utilizado.');
      }
      if (row?.is_expired) {
        throw new Error('Este link de recuperação expirou. Solicite um novo link.');
      }
      throw new Error('Link de recuperação inválido ou inexistente.');
    }

    return {
      valid: true,
      email: row.email || undefined,
      fullName: row.full_name || undefined,
    };
  }

  /**
   * 3. Redefine a senha com revogação total de sessões ativas
   */
  public async resetPassword(rawToken: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('A nova senha deve possuir pelo menos 8 caracteres.');
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
    const newPasswordHash = await hashPassword(newPassword);

    const res = await this.pool.query<{ success: boolean; user_id: string | null }>(
      'SELECT * FROM public.auth_consume_password_reset_token($1, $2);',
      [tokenHash, newPasswordHash]
    );

    const row = res.rows[0];
    if (!row?.success) {
      throw new Error('Não foi possível redefinir a senha. O link pode ser inválido ou ter expirado.');
    }

    return {
      success: true,
      message: 'Senha redefinida com sucesso. Faça login com sua nova senha.',
    };
  }

  /**
   * 4. Permite ao colaborador autenticado no portal cadastrar/alterar sua senha própria
   */
  public async changeWorkerPassword(params: {
    userId: string;
    currentBirthDateOrPassword: string;
    newPassword: string;
  }): Promise<{ success: boolean; message: string }> {
    if (!params.newPassword || params.newPassword.length < 6) {
      throw new Error('A nova senha deve possuir pelo menos 6 caracteres.');
    }

    // Busca trabalhador e usuário via helper seguro SECURITY DEFINER
    const workerRes = await this.pool.query<{
      birth_date: Date | string | null;
      password_hash: string | null;
    }>(
      'SELECT birth_date, password_hash FROM public.auth_get_worker_credentials_for_change($1);',
      [params.userId]
    );

    if (workerRes.rows.length === 0) {
      throw new Error('Colaborador não localizado.');
    }

    const { birth_date, password_hash } = workerRes.rows[0];

    // Valida credencial atual (seja data de nascimento ou senha atual)
    let isCurrentValid = false;

    // Normaliza birth_date
    let workerBirthIso: string | null = null;
    if (birth_date) {
      if (birth_date instanceof Date) {
        workerBirthIso = birth_date.toISOString().split('T')[0];
      } else if (typeof birth_date === 'string') {
        workerBirthIso = birth_date.split('T')[0];
      }
    }

    const inputBirthIso = normalizeBirthDate(params.currentBirthDateOrPassword);
    if (workerBirthIso && inputBirthIso && workerBirthIso === inputBirthIso) {
      isCurrentValid = true;
    }

    if (!isCurrentValid && password_hash) {
      isCurrentValid = await verifyPassword(params.currentBirthDateOrPassword, password_hash);
    }

    if (!isCurrentValid) {
      throw new Error('A data de nascimento ou senha atual informada está incorreta.');
    }

    const newHash = await hashPassword(params.newPassword);
    await this.pool.query(
      'SELECT public.auth_change_worker_password($1, $2);',
      [params.userId, newHash]
    );

    return {
      success: true,
      message: 'Senha pessoal do portal atualizada com sucesso.',
    };
  }
}
