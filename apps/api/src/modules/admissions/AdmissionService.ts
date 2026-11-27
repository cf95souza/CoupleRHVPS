import crypto from 'crypto';
import pg from 'pg';
import { MailerService } from '../../shared/mailer/MailerService.js';

export interface CreateInviteInput {
  tenantId: string;
  companyId: string;
  candidateName: string;
  candidateEmail: string;
  candidatePhone?: string;
  candidateCpf?: string;
  positionId?: string;
  departmentId?: string;
  proposedSalaryCents: number;
  hireDate: string;
  createdByUserId?: string;
}

export interface CandidateSubmissionInput {
  inviteToken: string;
  personalData: {
    fullName: string;
    cpf: string;
    rg: string;
    rgIssuer: string;
    birthDate: string;
    gender?: string;
    maritalStatus?: string;
    raceOrColor?: string;
    motherName: string;
    fatherName?: string;
    pisPasep?: string;
    ctpsNumber?: string;
    ctpsSeries?: string;
    cnhNumber?: string;
    cnhCategory?: string;
  };
  addressData: {
    zipCode: string;
    street: string;
    number: string;
    complement?: string;
    neighborhood: string;
    city: string;
    state: string;
  };
  bankData: {
    bankCode: string;
    bankName: string;
    agency: string;
    account: string;
    accountType: 'CHECKING' | 'SAVINGS';
    pixKey?: string;
  };
  dependentsData?: Array<{
    name: string;
    cpf: string;
    birthDate: string;
    relationship: string;
    isIrrfDependent: boolean;
    isFamilyAllowanceDependent: boolean;
  }>;
  transportOption: {
    optIn: boolean;
    transportLines?: string;
    waiverReason?: string;
  };
  timeBankAgreement: boolean;
  documentFileIds?: string[];
  signatureSvg?: string;
  signatureIp?: string;
  signatureUserAgent?: string;
}

export class AdmissionService {
  private mailer = new MailerService();

  /**
   * 1. Cria um novo convite de pré-admissão tokenizado (CSPRNG 32 bytes) com validade de 7 dias
   */
  async createInvite(client: pg.PoolClient | pg.Pool, input: CreateInviteInput) {
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias

    const { rows } = await client.query(
      `
      INSERT INTO public.admission_invites (
        tenant_id, company_id, invite_token, candidate_name, candidate_email,
        candidate_phone, candidate_cpf, position_id, department_id,
        proposed_salary_cents, hire_date, status, expires_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', $12, $13)
      RETURNING *;
    `,
      [
        input.tenantId,
        input.companyId,
        inviteToken,
        input.candidateName,
        input.candidateEmail,
        input.candidatePhone || null,
        input.candidateCpf || null,
        input.positionId || null,
        input.departmentId || null,
        input.proposedSalaryCents,
        input.hireDate,
        expiresAt,
        input.createdByUserId || null,
      ]
    );

    const invite = rows[0];

    // Dispara e-mail transacional para o candidato
    const inviteUrl = `${process.env.APP_BASE_URL || 'https://app.couplerh.com.br'}/admissao/${inviteToken}`;
    await this.mailer
      .sendQueued({
        to: input.candidateEmail,
        subject: `coupleRH: Convite para Admissão Digital — ${input.candidateName}`,
        html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b;">
          <h2 style="color: #0f172a; margin-bottom: 8px;">Parabéns, ${input.candidateName}!</h2>
          <p style="font-size: 14px; line-height: 1.6; color: #475569;">
            Você foi convidado para realizar o preenchimento da sua ficha cadastral e envio de documentos para admissão na empresa.
          </p>
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 4px 0; font-size: 13px;"><strong>Data prevista de início:</strong> ${input.hireDate}</p>
            <p style="margin: 4px 0; font-size: 13px;"><strong>Validade do convite:</strong> 7 dias corridos</p>
          </div>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${inviteUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px; display: inline-block;">
              Acessar Ficha de Admissão Digital
            </a>
          </div>
          <p style="font-size: 12px; color: #94a3b8; text-align: center;">
            Se o botão não funcionar, copie e cole este link no seu navegador:<br/>
            <span style="color: #2563eb;">${inviteUrl}</span>
          </p>
        </div>
      `,
      })
      .catch((err: unknown) => console.warn('[ADMISSION] Falha no disparo do e-mail de convite:', err));

    return invite;
  }

  /**
   * 2. Lista convites do tenant com filtros e contadores
   */
  async listInvites(client: pg.PoolClient | pg.Pool, tenantId: string, companyId?: string) {
    let sql = `
      SELECT 
        ai.*,
        c.trade_name AS company_trade_name,
        c.corporate_name AS company_corporate_name,
        p.title AS position_title,
        d.name AS department_name,
        asub.id AS submission_id,
        asub.submitted_at
      FROM public.admission_invites ai
      JOIN public.companies c ON c.id = ai.company_id
      LEFT JOIN public.positions p ON p.id = ai.position_id
      LEFT JOIN public.departments d ON d.id = ai.department_id
      LEFT JOIN public.admission_submissions asub ON asub.invite_id = ai.id
      WHERE ai.tenant_id = $1
    `;
    const params: any[] = [tenantId];
    if (companyId) {
      params.push(companyId);
      sql += ` AND ai.company_id = $2`;
    }
    sql += ` ORDER BY ai.created_at DESC;`;

    const { rows } = await client.query(sql, params);
    return rows;
  }

  /**
   * 3. Busca detalhes de um convite para o DP auditar
   */
  async getInviteById(client: pg.PoolClient | pg.Pool, tenantId: string, inviteId: string) {
    const { rows } = await client.query(
      `
      SELECT 
        ai.*,
        c.trade_name AS company_trade_name,
        c.corporate_name AS company_corporate_name,
        c.cnpj AS company_cnpj,
        p.title AS position_title,
        d.name AS department_name,
        asub.id AS submission_id,
        asub.personal_data,
        asub.address_data,
        asub.bank_data,
        asub.dependents_data,
        asub.transport_option,
        asub.time_bank_agreement,
        asub.document_file_ids,
        asub.signature_svg,
        asub.signature_ip,
        asub.submitted_at,
        asub.reviewed_at,
        asub.review_notes,
        asub.worker_id,
        asub.contract_id
      FROM public.admission_invites ai
      JOIN public.companies c ON c.id = ai.company_id
      LEFT JOIN public.positions p ON p.id = ai.position_id
      LEFT JOIN public.departments d ON d.id = ai.department_id
      LEFT JOIN public.admission_submissions asub ON asub.invite_id = ai.id
      WHERE ai.tenant_id = $1 AND ai.id = $2;
    `,
      [tenantId, inviteId]
    );

    return rows[0] || null;
  }

  /**
   * 4. Rota pública para carregar dados do convite para o candidato
   */
  async getPublicInviteByToken(client: pg.PoolClient | pg.Pool, token: string) {
    const { rows } = await client.query(
      `
      SELECT 
        ai.id,
        ai.candidate_name,
        ai.candidate_email,
        ai.candidate_phone,
        ai.candidate_cpf,
        ai.proposed_salary_cents,
        ai.hire_date,
        ai.status,
        ai.expires_at,
        c.trade_name AS company_name,
        c.cnpj AS company_cnpj,
        p.title AS position_title,
        d.name AS department_name
      FROM public.admission_invites ai
      JOIN public.companies c ON c.id = ai.company_id
      LEFT JOIN public.positions p ON p.id = ai.position_id
      LEFT JOIN public.departments d ON d.id = ai.department_id
      WHERE ai.invite_token = $1;
    `,
      [token]
    );

    const invite = rows[0];
    if (!invite) {
      throw new Error('Convite de admissão não encontrado ou inválido.');
    }

    if (new Date(invite.expires_at) < new Date()) {
      throw new Error('Este convite de admissão expirou. Solicite um novo link ao RH da empresa.');
    }

    if (invite.status === 'APPROVED') {
      throw new Error('Esta admissão já foi homologada e concluída com sucesso.');
    }

    return invite;
  }

  /**
   * 5. Candidato submete o formulário completo e termo com assinatura
   */
  async submitAdmission(client: pg.PoolClient | pg.Pool, input: CandidateSubmissionInput) {
    const { rows: inviteRows } = await client.query(
      `SELECT * FROM public.admission_invites WHERE invite_token = $1;`,
      [input.inviteToken]
    );
    const invite = inviteRows[0];
    if (!invite) throw new Error('Convite de admissão não encontrado.');
    if (new Date(invite.expires_at) < new Date()) throw new Error('Convite de admissão expirado.');
    if (invite.status === 'APPROVED') throw new Error('Esta admissão já foi homologada.');

    // Upsert na tabela admission_submissions
    const { rows: subRows } = await client.query(
      `
      INSERT INTO public.admission_submissions (
        invite_id, tenant_id, personal_data, address_data, bank_data,
        dependents_data, transport_option, time_bank_agreement,
        document_file_ids, signature_svg, signature_ip, signature_user_agent, submitted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
      ON CONFLICT (invite_id) DO UPDATE SET
        personal_data = EXCLUDED.personal_data,
        address_data = EXCLUDED.address_data,
        bank_data = EXCLUDED.bank_data,
        dependents_data = EXCLUDED.dependents_data,
        transport_option = EXCLUDED.transport_option,
        time_bank_agreement = EXCLUDED.time_bank_agreement,
        document_file_ids = EXCLUDED.document_file_ids,
        signature_svg = EXCLUDED.signature_svg,
        signature_ip = EXCLUDED.signature_ip,
        signature_user_agent = EXCLUDED.signature_user_agent,
        submitted_at = now()
      RETURNING *;
    `,
      [
        invite.id,
        invite.tenant_id,
        JSON.stringify(input.personalData),
        JSON.stringify(input.addressData),
        JSON.stringify(input.bankData),
        JSON.stringify(input.dependentsData || []),
        JSON.stringify(input.transportOption),
        input.timeBankAgreement,
        JSON.stringify(input.documentFileIds || []),
        input.signatureSvg || null,
        input.signatureIp || null,
        input.signatureUserAgent || null,
      ]
    );

    // Atualiza status do convite para SUBMITTED
    await client.query(
      `UPDATE public.admission_invites SET status = 'SUBMITTED', updated_at = now() WHERE id = $1;`,
      [invite.id]
    );

    return subRows[0];
  }

  /**
   * 6. DP Homologa a Admissão: cria atomicamente Worker, Contract e Dependentes
   */
  async approveAdmission(
    client: pg.PoolClient,
    tenantId: string,
    inviteId: string,
    reviewedByUserId: string,
    notes?: string
  ) {
    const invite = await this.getInviteById(client, tenantId, inviteId);
    if (!invite) throw new Error('Convite de admissão não encontrado.');
    if (invite.status !== 'SUBMITTED') {
      throw new Error('Apenas admissões com status SUBMITTED podem ser homologadas.');
    }

    const p = invite.personal_data;
    const a = invite.address_data;
    const b = invite.bank_data;

    // 1. Cria ou reaproveita o trabalhador na tabela workers
    const { rows: workerRows } = await client.query(
      `
      INSERT INTO public.workers (
        tenant_id, name, cpf, rg, birth_date, gender, marital_status,
        mother_name, father_name, pis, ctps_number, ctps_series,
        address_zip_code, address_street, address_number, address_complement,
        address_neighborhood, address_city, address_state,
        bank_code, bank_agency, bank_account, bank_account_type, pix_key
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, $19,
        $20, $21, $22, $23, $24
      )
      RETURNING id;
    `,
      [
        tenantId,
        p.fullName || invite.candidate_name,
        p.cpf || invite.candidate_cpf,
        p.rg || null,
        p.birthDate || '1990-01-01',
        p.gender || 'OTHER',
        p.maritalStatus || 'SINGLE',
        p.motherName || 'Não Informado',
        p.fatherName || null,
        p.pisPasep || null,
        p.ctpsNumber || null,
        p.ctpsSeries || null,
        a.zipCode || null,
        a.street || null,
        a.number || null,
        a.complement || null,
        a.neighborhood || null,
        a.city || null,
        a.state || null,
        b.bankCode || null,
        b.agency || null,
        b.account || null,
        b.accountType || 'CHECKING',
        b.pixKey || null,
      ]
    );

    const workerId = workerRows[0].id;

    // 2. Busca o primeiro tipo de contrato ativo (ou CLTI padrão)
    const { rows: ctRows } = await client.query(
      `SELECT id FROM public.contract_types WHERE tenant_id = $1 LIMIT 1;`,
      [tenantId]
    );
    const contractTypeId = ctRows[0]?.id || null;

    // 3. Cria o Contrato de Trabalho ativo
    const baseSalary = invite.proposed_salary_cents / 100;
    const { rows: contractRows } = await client.query(
      `
      INSERT INTO public.contracts (
        tenant_id, worker_id, company_id, position_id, department_id,
        contract_type_id, base_salary, start_date, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE'
      )
      RETURNING id;
    `,
      [
        tenantId,
        workerId,
        invite.company_id,
        invite.position_id,
        invite.department_id,
        contractTypeId,
        baseSalary,
        invite.hire_date,
      ]
    );

    const contractId = contractRows[0].id;

    // 4. Se houver dependentes, cadastra na tabela de dependentes
    if (Array.isArray(invite.dependents_data) && invite.dependents_data.length > 0) {
      for (const dep of invite.dependents_data) {
        await client.query(
          `
          INSERT INTO public.worker_dependents (
            tenant_id, worker_id, name, cpf, birth_date, relationship,
            is_irrf_dependent, is_family_allowance_dependent
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
        `,
          [
            tenantId,
            workerId,
            dep.name,
            dep.cpf || null,
            dep.birthDate,
            dep.relationship || 'CHILD',
            dep.isIrrfDependent ?? true,
            dep.isFamilyAllowanceDependent ?? true,
          ]
        ).catch(() => undefined);
      }
    }

    // 5. Atualiza o status da submissão e do convite para APPROVED
    await client.query(
      `
      UPDATE public.admission_submissions SET
        worker_id = $1,
        contract_id = $2,
        reviewed_by = $3,
        reviewed_at = now(),
        review_notes = $4,
        updated_at = now()
      WHERE invite_id = $5;
    `,
      [workerId, contractId, reviewedByUserId, notes || 'Homologado pelo DP', inviteId]
    );

    await client.query(
      `UPDATE public.admission_invites SET status = 'APPROVED', updated_at = now() WHERE id = $1;`,
      [inviteId]
    );

    return {
      success: true,
      workerId,
      contractId,
      message: 'Admissão homologada com sucesso. Colaborador e contrato criados no sistema.',
    };
  }

  /**
   * 7. DP Rejeita a admissão com solicitação de retificação
   */
  async rejectAdmission(
    client: pg.PoolClient | pg.Pool,
    tenantId: string,
    inviteId: string,
    reviewedByUserId: string,
    notes: string
  ) {
    await client.query(
      `
      UPDATE public.admission_submissions SET
        reviewed_by = $1,
        reviewed_at = now(),
        review_notes = $2,
        updated_at = now()
      WHERE invite_id = $3 AND tenant_id = $4;
    `,
      [reviewedByUserId, notes, inviteId, tenantId]
    );

    await client.query(
      `UPDATE public.admission_invites SET status = 'REJECTED', updated_at = now() WHERE id = $1 AND tenant_id = $2;`,
      [inviteId, tenantId]
    );

    return { success: true, message: 'Admissão marcada para revisão/rejeitada.' };
  }
}
