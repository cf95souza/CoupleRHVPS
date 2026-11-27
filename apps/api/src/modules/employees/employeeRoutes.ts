import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAnyPermission, requirePermission } from '../auth/authMiddleware.js';
import { getUserPermissions } from '../auth/rbacMiddleware.js';
import {
  serializeAlimonyBeneficiary,
  serializeContract,
  UserPermissionContext,
} from '../../shared/serializers/entitySerializers.js';
import { maskCpf } from '../../shared/security/lgpdMasker.js';
import { DiscountPriorityManager, MultiRegimeCalculator, round2 } from '@couplerh/payroll-core';

const createLoanSchema = z.object({
  financialInstitution: z.string().min(1).default('Banco Consignado'),
  bankCode: z.string().optional().nullable(),
  contractNumber: z.string().optional().nullable(),
  totalAmount: z.number().positive().optional(),
  installmentAmount: z.number().positive('Valor da parcela deve ser maior que zero.'),
  totalInstallments: z.number().int().positive('Número total de parcelas deve ser positivo.'),
  paidInstallments: z.number().int().nonnegative().default(0),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de início inválida (AAAA-MM-DD).'),
  notes: z.string().optional().nullable(),
});

const createEmployeeSchema = z.object({
  // Dados Pessoais do Trabalhador
  fullName: z.string().min(3, 'Nome completo deve conter no mínimo 3 caracteres.'),
  cpf: z.string().regex(/^\d{11}$/, 'CPF deve conter exatamente 11 dígitos numéricos.'),
  rg: z.string().optional(),
  rgIssuer: z.string().optional(),
  rgState: z.string().max(2).optional(),
  pis: z.string().optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de nascimento inválida (AAAA-MM-DD).'),
  gender: z.string().optional(),
  maritalStatus: z.string().optional(),
  motherName: z.string().optional(),
  fatherName: z.string().optional(),
  email: z.string().email('E-mail inválido.').optional(),
  phone: z.string().optional(),
  bankCode: z.string().optional(),
  bankAgency: z.string().optional(),
  bankAccount: z.string().optional(),
  bankAccountType: z.string().optional(),
  pixKey: z.string().optional(),
  pixKeyType: z.string().optional(),
  isApprentice: z.boolean().default(false),

  // Dados Contratuais
  companyId: z.string().uuid('ID da empresa inválido.'),
  establishmentId: z.string().uuid('ID do estabelecimento inválido.'),
  departmentId: z.string().uuid().optional().nullable(),
  sectorId: z.string().uuid().optional().nullable(),
  positionId: z.string().uuid('ID do cargo inválido.'),
  costCenterId: z.string().uuid().optional().nullable(),
  workplaceId: z.string().uuid().optional().nullable(),
  contractTypeId: z.string().uuid().optional().nullable(),
  registrationNumber: z.string().min(1, 'Matrícula é obrigatória.'),
  admissionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de admissão inválida (AAAA-MM-DD).'),
  baseSalary: z.number().nonnegative('Salário-base não pode ser negativo.'),
  salaryType: z.enum(['MONTHLY', 'HOURLY', 'DAILY', 'COMMISSION']).default('MONTHLY'),
  monthlyHours: z.number().default(220),
  weeklyHours: z.number().default(44),
  regime: z.enum(['CLT', 'PJ', 'ESTAGIO', 'APPRENTICE', 'TEMPORARY', 'AUTONOMOUS']).default('CLT'),
  isTelework: z.boolean().default(false),
  receivesAdvance: z.boolean().default(true),
  advancePercentage: z.number().default(40.0),
  isConfidentialPayroll: z.boolean().default(false),
  managerWorkerId: z.string().uuid().optional().nullable(),
});

const updateEmployeeSchema = z.object({
  fullName: z.string().min(3).optional(),
  rg: z.string().optional(),
  pis: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  bankCode: z.string().optional(),
  bankAgency: z.string().optional(),
  bankAccount: z.string().optional(),
  bankAccountType: z.string().optional(),
  pixKey: z.string().optional(),
  pixKeyType: z.string().optional(),
  departmentId: z.string().uuid().optional().nullable(),
  sectorId: z.string().uuid().optional().nullable(),
  positionId: z.string().uuid().optional(),
  costCenterId: z.string().uuid().optional().nullable(),
  workplaceId: z.string().uuid().optional().nullable(),
  baseSalary: z.number().nonnegative().optional(),
  monthlyHours: z.number().optional(),
  weeklyHours: z.number().optional(),
  isTelework: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'LEAVE', 'VACATION', 'TERMINATED', 'SUSPENDED']).optional(),
  isConfidentialPayroll: z.boolean().optional(),
  managerWorkerId: z.string().uuid().optional().nullable(),
});

const otherEmploymentSchema = z.object({
  contract_id: z.string().uuid().optional().nullable(),
  employer_cnpj: z
    .string()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v.length === 14, 'CNPJ do outro empregador deve conter 14 dígitos.'),
  employer_name: z.string().min(2, 'Razão social / nome do outro empregador é obrigatório.').max(200),
  esocial_category_code: z.string().min(3).max(10).default('101'),
  ind_mv: z.coerce.number().int().refine((v) => v === 1 || v === 2 || v === 3, 'indMV deve ser 1, 2 ou 3.'),
  competence_year: z.coerce.number().int().min(2000).max(2100),
  competence_month: z.coerce.number().int().min(1).max(13),
  remuneration_amount: z.coerce.number().min(0).default(0),
  inss_withheld: z.coerce.number().min(0).default(0),
  is_recurring: z.boolean().default(false),
  notes: z.string().max(1000).optional().nullable(),
  is_active: z.boolean().default(true),
});

const dependentSchema = z.object({
  name: z.string().min(2, 'Nome do dependente é obrigatório.'),
  cpf: z
    .string()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v.length === 0 || v.length === 11, 'CPF do dependente deve conter 11 dígitos.')
    .optional()
    .nullable(),
  relationship: z.string().min(2, 'Grau de parentesco é obrigatório.').max(40),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de nascimento inválida (AAAA-MM-DD).'),
  is_irrf_dependent: z.boolean().default(true),
  is_family_salary: z.boolean().optional(),
  is_family_allowance_dependent: z.boolean().optional(),
  is_incapacitated: z.boolean().optional(),
  has_disability: z.boolean().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  birth_certificate_number: z.string().max(120).optional().nullable(),
  vaccination_card_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  school_frequency_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

const alimonyBeneficiarySchema = z.object({
  beneficiary_name: z.string().min(2, 'Nome do beneficiário é obrigatório.'),
  beneficiary_cpf: z
    .string()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v.length === 0 || v.length === 11, 'CPF do beneficiário deve ter 11 dígitos.')
    .optional()
    .nullable(),
  beneficiary_birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  relationship: z.string().max(60).optional().nullable(),
  court_process_number: z.string().max(120).optional().nullable(),
  court_name: z.string().max(120).optional().nullable(),
  rubric_id: z.string().uuid().optional().nullable(),
  calculation_basis: z
    .enum(['NET_SALARY', 'GROSS_SALARY', 'BASE_SALARY', 'MINIMUM_WAGE', 'FIXED_AMOUNT'])
    .default('NET_SALARY'),
  percentage: z.coerce.number().min(0).max(100).optional().nullable(),
  fixed_amount: z.coerce.number().min(0).optional().nullable(),
  min_amount: z.coerce.number().min(0).optional().nullable(),
  max_amount: z.coerce.number().min(0).optional().nullable(),
  payment_method: z.enum(['BANK_TRANSFER', 'PIX', 'JUDICIAL_DEPOSIT']).default('BANK_TRANSFER'),
  pix_key_type: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']).optional().nullable(),
  pix_key: z.string().max(160).optional().nullable(),
  bank_code: z.string().max(10).optional().nullable(),
  bank_name: z.string().max(100).optional().nullable(),
  bank_agency: z.string().max(20).optional().nullable(),
  bank_account: z.string().max(30).optional().nullable(),
  bank_account_type: z.enum(['CORRENTE', 'POUPANCA', 'SALARIO', 'JUDICIAL']).optional().nullable(),
  apply_on_monthly: z.boolean().default(true),
  apply_on_advance: z.boolean().default(false),
  apply_on_vacation: z.boolean().default(true),
  apply_on_thirteenth: z.boolean().default(true),
  apply_on_termination: z.boolean().default(true),
  apply_on_complementary: z.boolean().default(true),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  is_active: z.boolean().default(true),
  notes: z.string().max(1000).optional().nullable(),
});

export const employeeRoutes: FastifyPluginAsync = async (app) => {
  // 1. Listagem de Colaboradores com Sigilo Salarial e LGPD
  app.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const query = request.query as {
      page?: string;
      limit?: string;
      search?: string;
      departmentId?: string;
      status?: string;
    };

    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    try {
      const result = await request.withContext(async (client) => {
        // Carrega permissões do usuário
        const permsList = await getUserPermissions(
          client,
          request.user!.sub,
          request.user!.tenant_id!,
          request.user!.role
        );
        const permsSet = new Set(permsList);
        const ctx: UserPermissionContext = {
          hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
        };

        const { rows } = await client.query(
          `SELECT
            c.id,
            c.tenant_id,
            c.company_id,
            c.establishment_id,
            c.department_id,
            c.sector_id,
            c.position_id,
            c.cost_center_id,
            c.workplace_id,
            c.contract_type_id,
            c.worker_id,
            c.manager_worker_id,
            c.registration_number,
            c.admission_date,
            c.experience_end_date,
            c.termination_date,
            c.salary_type,
            c.base_salary,
            c.monthly_hours,
            c.weekly_hours,
            c.regime,
            c.overtime_regime,
            c.is_telework,
            c.receives_advance,
            c.advance_percentage,
            c.status,
            c.is_confidential_payroll,
            c.created_at,
            c.updated_at,
            to_jsonb(w.*) AS worker
          FROM public.contracts c
          JOIN public.workers w ON w.id = c.worker_id
          WHERE c.deleted_at IS NULL
            AND ($1::uuid IS NULL OR c.department_id = $1::uuid)
            AND ($2::text IS NULL OR c.status = $2::text)
            AND (
              $3::text IS NULL OR (
                w.full_name ILIKE '%' || $3 || '%'
                OR c.registration_number ILIKE '%' || $3 || '%'
                OR w.cpf ILIKE '%' || $3 || '%'
              )
            )
          ORDER BY w.full_name ASC
          LIMIT $4 OFFSET $5;`,
          [
            query.departmentId || null,
            query.status || null,
            query.search || null,
            limit,
            offset,
          ]
        );

        // Aplica o serializador LGPD & Sigilo Salarial
        const sanitized = rows
          .map((row) => serializeContract(row, ctx))
          .filter((item) => item !== null);

        return { list: sanitized, total: sanitized.length };
      });

      return reply.send({
        success: true,
        data: result.list,
        count: result.total,
        page,
        limit,
      });
    } catch (err: any) {
      request.log.error(err, '[EMPLOYEES_LIST] Erro ao listar colaboradores');
      return reply.status(500).send({
        success: false,
        error: 'Erro interno ao consultar lista de colaboradores.',
      });
    }
  });

  // 2. Detalhe de Colaborador por ID do Contrato
  app.get('/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    try {
      const contract = await request.withContext(async (client) => {
        const permsList = await getUserPermissions(
          client,
          request.user!.sub,
          request.user!.tenant_id!,
          request.user!.role
        );
        const permsSet = new Set(permsList);
        const ctx: UserPermissionContext = {
          hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
        };

        const { rows } = await client.query(
          `SELECT
            c.*,
            to_jsonb(w.*) AS worker
          FROM public.contracts c
          JOIN public.workers w ON w.id = c.worker_id
          WHERE (c.id = $1::uuid OR c.worker_id = $1::uuid)
            AND c.deleted_at IS NULL
          LIMIT 1;`,
          [id]
        );

        if (rows.length === 0) return null;

        const row = rows[0];
        // Se for confidencial e o usuário não tiver permissão
        if (row.is_confidential_payroll && !ctx.hasPermission('view_executive_payroll')) {
          return 'FORBIDDEN_CONFIDENTIAL';
        }

        return serializeContract(row, ctx);
      });

      if (!contract) {
        return reply.status(404).send({
          success: false,
          code: 'EMPLOYEE_NOT_FOUND',
          error: 'Colaborador não encontrado ou excluído.',
        });
      }

      if (contract === 'FORBIDDEN_CONFIDENTIAL') {
        return reply.status(403).send({
          success: false,
          code: 'FORBIDDEN_EXECUTIVE_PAYROLL',
          error: 'Acesso restrito. Contrato confidencial de diretoria.',
        });
      }

      return reply.send({
        success: true,
        data: contract,
      });
    } catch (err: any) {
      request.log.error(err, '[EMPLOYEE_GET] Erro ao obter colaborador');
      return reply.status(500).send({
        success: false,
        error: 'Erro interno ao consultar dados do colaborador.',
      });
    }
  });

  // 3. Admissão de Novo Colaborador (Trabalhador + Contrato)
  app.post(
    '/',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const parseResult = createEmployeeSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados de admissão inválidos.',
          details: parseResult.error.format(),
        });
      }

      const data = parseResult.data;
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const created = await request.withContext(async (client) => {
          // Inserção ou Reativação do Trabalhador
          const { rows: workerRows } = await client.query(
            `INSERT INTO public.workers (
              tenant_id, full_name, cpf, rg, rg_issuer, rg_state, pis,
              birth_date, gender, marital_status, mother_name, father_name,
              email, phone, bank_code, bank_agency, bank_account, bank_account_type,
              pix_key, pix_key_type, is_apprentice, is_active
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10, $11, $12,
              $13, $14, $15, $16, $17, $18,
              $19, $20, $21, TRUE
            )
            ON CONFLICT (tenant_id, cpf) DO UPDATE
            SET full_name = EXCLUDED.full_name,
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                updated_at = NOW()
            RETURNING id;`,
            [
              request.user!.tenant_id,
              data.fullName,
              data.cpf,
              data.rg || null,
              data.rgIssuer || null,
              data.rgState || null,
              data.pis || null,
              data.birthDate,
              data.gender || null,
              data.maritalStatus || null,
              data.motherName || null,
              data.fatherName || null,
              data.email || null,
              data.phone || null,
              data.bankCode || null,
              data.bankAgency || null,
              data.bankAccount || null,
              data.bankAccountType || null,
              data.pixKey || null,
              data.pixKeyType || null,
              data.isApprentice,
            ]
          );

          const workerId = workerRows[0].id;

          // Inserção do Contrato de Trabalho
          const { rows: contractRows } = await client.query(
            `INSERT INTO public.contracts (
              tenant_id, worker_id, company_id, establishment_id, department_id,
              sector_id, position_id, cost_center_id, workplace_id, contract_type_id,
              registration_number, admission_date, salary_type, base_salary,
              monthly_hours, weekly_hours, regime, is_telework, receives_advance,
              advance_percentage, is_confidential_payroll, manager_worker_id, status
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9, $10,
              $11, $12, $13, $14,
              $15, $16, $17, $18, $19,
              $20, $21, $22, 'ACTIVE'
            ) RETURNING id, registration_number, admission_date;`,
            [
              request.user!.tenant_id,
              workerId,
              data.companyId,
              data.establishmentId,
              data.departmentId || null,
              data.sectorId || null,
              data.positionId,
              data.costCenterId || null,
              data.workplaceId || null,
              data.contractTypeId || null,
              data.registrationNumber,
              data.admissionDate,
              data.salaryType,
              data.baseSalary,
              data.monthlyHours,
              data.weeklyHours,
              data.regime,
              data.isTelework,
              data.receivesAdvance,
              data.advancePercentage,
              data.isConfidentialPayroll,
              data.managerWorkerId || null,
            ]
          );

          return {
            workerId,
            contractId: contractRows[0].id,
            registrationNumber: contractRows[0].registration_number,
            admissionDate: contractRows[0].admission_date,
          };
        });

        return reply.status(201).send({
          success: true,
          message: 'Colaborador admitido com sucesso.',
          data: created,
        });
      } catch (err: any) {
        request.log.error(err, '[EMPLOYEE_CREATE] Erro ao admitir colaborador');
        const message = err.message || '';
        if (message.includes('unique') || message.includes('duplicate')) {
          return reply.status(409).send({
            success: false,
            code: 'DUPLICATE_REGISTRATION',
            error: 'Matrícula ou CPF já cadastrado para esta empresa.',
          });
        }
        return reply.status(500).send({
          success: false,
          error: 'Erro interno ao realizar admissão.',
        });
      }
    }
  );

  // 4. Atualização Cadastral e Contratual
  app.put(
    '/:id',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parseResult = updateEmployeeSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Dados de atualização inválidos.',
          details: parseResult.error.format(),
        });
      }

      const data = parseResult.data;
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        await request.withContext(async (client) => {
          // Busca o worker_id do contrato
          const { rows: contractRows } = await client.query(
            'SELECT worker_id FROM public.contracts WHERE id = $1::uuid;',
            [id]
          );
          if (contractRows.length === 0) return null;
          const workerId = contractRows[0].worker_id;

          // Atualiza dados contratuais se houverem
          await client.query(
            `UPDATE public.contracts
             SET department_id = COALESCE($1, department_id),
                 sector_id = COALESCE($2, sector_id),
                 position_id = COALESCE($3, position_id),
                 cost_center_id = COALESCE($4, cost_center_id),
                 workplace_id = COALESCE($5, workplace_id),
                 base_salary = COALESCE($6, base_salary),
                 monthly_hours = COALESCE($7, monthly_hours),
                 weekly_hours = COALESCE($8, weekly_hours),
                 is_telework = COALESCE($9, is_telework),
                 status = COALESCE($10, status),
                 is_confidential_payroll = COALESCE($11, is_confidential_payroll),
                 manager_worker_id = COALESCE($12, manager_worker_id),
                 updated_at = NOW()
             WHERE id = $13::uuid;`,
            [
              data.departmentId,
              data.sectorId,
              data.positionId,
              data.costCenterId,
              data.workplaceId,
              data.baseSalary,
              data.monthlyHours,
              data.weeklyHours,
              data.isTelework,
              data.status,
              data.isConfidentialPayroll,
              data.managerWorkerId,
              id,
            ]
          );

          // Atualiza dados pessoais
          await client.query(
            `UPDATE public.workers
             SET full_name = COALESCE($1, full_name),
                 rg = COALESCE($2, rg),
                 pis = COALESCE($3, pis),
                 email = COALESCE($4, email),
                 phone = COALESCE($5, phone),
                 bank_code = COALESCE($6, bank_code),
                 bank_agency = COALESCE($7, bank_agency),
                 bank_account = COALESCE($8, bank_account),
                 bank_account_type = COALESCE($9, bank_account_type),
                 pix_key = COALESCE($10, pix_key),
                 pix_key_type = COALESCE($11, pix_key_type),
                 updated_at = NOW()
             WHERE id = $12::uuid;`,
            [
              data.fullName,
              data.rg,
              data.pis,
              data.email,
              data.phone,
              data.bankCode,
              data.bankAgency,
              data.bankAccount,
              data.bankAccountType,
              data.pixKey,
              data.pixKeyType,
              workerId,
            ]
          );
        });

        return reply.send({
          success: true,
          message: 'Colaborador atualizado com sucesso.',
        });
      } catch (err: any) {
        request.log.error(err, '[EMPLOYEE_UPDATE] Erro ao atualizar');
        return reply.status(500).send({
          success: false,
          error: 'Erro interno ao atualizar colaborador.',
        });
      }
    }
  );

  // 5. Beneficiários de Pensão Alimentícia (FOLHA-03 Multi-Beneficiário & Dados Bancários/PIX)
  app.get(
    '/:id/alimony-beneficiaries',
    { preHandler: [authenticate, requireAnyPermission(['view_employees', 'calculate_payroll', 'view_payslips'])] },
    async (request, reply) => {
      const { id: contractId } = request.params as { id: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const data = await request.withContext(async (client) => {
        const permsList = await getUserPermissions(
          client,
          request.user!.sub,
          request.user!.tenant_id!,
          request.user!.role
        );
        const permsSet = new Set(permsList);
        const ctx: UserPermissionContext = {
          hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
        };

        const { rows } = await client.query(
          `SELECT * FROM public.alimony_beneficiaries
           WHERE contract_id = $1::uuid AND deleted_at IS NULL
           ORDER BY is_active DESC, created_at ASC;`,
          [contractId]
        );
        return rows.map((r) => serializeAlimonyBeneficiary(r, ctx));
      });

      return reply.send({ success: true, data });
    }
  );

  app.post(
    '/:id/alimony-beneficiaries',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id: contractId } = request.params as { id: string };
      const parse = alimonyBeneficiarySchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: parse.error.errors[0]?.message || 'Dados inválidos para beneficiário de pensão.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      if (d.calculation_basis === 'FIXED_AMOUNT' && (!d.fixed_amount || d.fixed_amount <= 0)) {
        return reply.status(400).send({
          success: false,
          error: 'Informe um valor fixo positivo quando a base for FIXED_AMOUNT.',
        });
      }
      if (d.calculation_basis !== 'FIXED_AMOUNT' && (!d.percentage || d.percentage <= 0)) {
        return reply.status(400).send({
          success: false,
          error: 'Informe um percentual positivo quando a base não for valor fixo.',
        });
      }

      try {
        const created = await request.withContext(async (client) => {
          const { rows: ctrRows } = await client.query(
            `SELECT id FROM public.contracts WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL;`,
            [contractId, request.user!.tenant_id]
          );
          if (ctrRows.length === 0) return null;

          const { rows } = await client.query(
            `INSERT INTO public.alimony_beneficiaries (
               tenant_id, contract_id, rubric_id, beneficiary_name, beneficiary_cpf, beneficiary_birth_date,
               relationship, court_process_number, court_name, calculation_basis, percentage, fixed_amount,
               min_amount, max_amount, payment_method, pix_key_type, pix_key, bank_code, bank_name,
               bank_agency, bank_account, bank_account_type, apply_on_monthly, apply_on_advance,
               apply_on_vacation, apply_on_thirteenth, apply_on_termination, apply_on_complementary,
               start_date, end_date, is_active, notes
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date,
               $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24,
               $25, $26, $27, $28,
               COALESCE($29::date, CURRENT_DATE), $30::date, $31, $32
             ) RETURNING *;`,
            [
              request.user!.tenant_id,
              contractId,
              d.rubric_id || null,
              d.beneficiary_name,
              d.beneficiary_cpf || null,
              d.beneficiary_birth_date || null,
              d.relationship || null,
              d.court_process_number || null,
              d.court_name || null,
              d.calculation_basis,
              d.percentage ?? null,
              d.fixed_amount ?? null,
              d.min_amount ?? null,
              d.max_amount ?? null,
              d.payment_method,
              d.pix_key_type || null,
              d.pix_key || null,
              d.bank_code || null,
              d.bank_name || null,
              d.bank_agency || null,
              d.bank_account || null,
              d.bank_account_type || null,
              d.apply_on_monthly,
              d.apply_on_advance,
              d.apply_on_vacation,
              d.apply_on_thirteenth,
              d.apply_on_termination,
              d.apply_on_complementary,
              d.start_date || null,
              d.end_date || null,
              d.is_active,
              d.notes || null,
            ]
          );

          const permsList = await getUserPermissions(
            client,
            request.user!.sub,
            request.user!.tenant_id!,
            request.user!.role
          );
          const permsSet = new Set(permsList);
          const ctx: UserPermissionContext = {
            hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
          };
          return serializeAlimonyBeneficiary(rows[0], ctx);
        });

        if (!created) {
          return reply.status(404).send({ success: false, error: 'Contrato não encontrado ou fora do escopo.' });
        }
        return reply.status(201).send({ success: true, data: created });
      } catch (err: any) {
        request.log.error(err, '[ALIMONY_CREATE] Erro ao criar beneficiário');
        return reply.status(400).send({ success: false, error: err.message });
      }
    }
  );

  app.put(
    '/:id/alimony-beneficiaries/:beneficiaryId',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id: contractId, beneficiaryId } = request.params as { id: string; beneficiaryId: string };
      const parse = alimonyBeneficiarySchema.partial().safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: parse.error.errors[0]?.message || 'Dados inválidos.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      const updated = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `UPDATE public.alimony_beneficiaries
           SET rubric_id = COALESCE($1::uuid, rubric_id),
               beneficiary_name = COALESCE($2, beneficiary_name),
               beneficiary_cpf = COALESCE($3, beneficiary_cpf),
               beneficiary_birth_date = COALESCE($4::date, beneficiary_birth_date),
               relationship = COALESCE($5, relationship),
               court_process_number = COALESCE($6, court_process_number),
               court_name = COALESCE($7, court_name),
               calculation_basis = COALESCE($8, calculation_basis),
               percentage = COALESCE($9, percentage),
               fixed_amount = COALESCE($10, fixed_amount),
               min_amount = COALESCE($11, min_amount),
               max_amount = COALESCE($12, max_amount),
               payment_method = COALESCE($13, payment_method),
               pix_key_type = COALESCE($14, pix_key_type),
               pix_key = COALESCE($15, pix_key),
               bank_code = COALESCE($16, bank_code),
               bank_name = COALESCE($17, bank_name),
               bank_agency = COALESCE($18, bank_agency),
               bank_account = COALESCE($19, bank_account),
               bank_account_type = COALESCE($20, bank_account_type),
               apply_on_monthly = COALESCE($21, apply_on_monthly),
               apply_on_advance = COALESCE($22, apply_on_advance),
               apply_on_vacation = COALESCE($23, apply_on_vacation),
               apply_on_thirteenth = COALESCE($24, apply_on_thirteenth),
               apply_on_termination = COALESCE($25, apply_on_termination),
               apply_on_complementary = COALESCE($26, apply_on_complementary),
               start_date = COALESCE($27::date, start_date),
               end_date = CASE WHEN $28::boolean THEN $29::date ELSE end_date END,
               is_active = COALESCE($30, is_active),
               notes = COALESCE($31, notes),
               updated_at = NOW()
           WHERE id = $32::uuid AND contract_id = $33::uuid AND deleted_at IS NULL
           RETURNING *;`,
          [
            d.rubric_id ?? null,
            d.beneficiary_name ?? null,
            d.beneficiary_cpf ?? null,
            d.beneficiary_birth_date ?? null,
            d.relationship ?? null,
            d.court_process_number ?? null,
            d.court_name ?? null,
            d.calculation_basis ?? null,
            d.percentage ?? null,
            d.fixed_amount ?? null,
            d.min_amount ?? null,
            d.max_amount ?? null,
            d.payment_method ?? null,
            d.pix_key_type ?? null,
            d.pix_key ?? null,
            d.bank_code ?? null,
            d.bank_name ?? null,
            d.bank_agency ?? null,
            d.bank_account ?? null,
            d.bank_account_type ?? null,
            d.apply_on_monthly ?? null,
            d.apply_on_advance ?? null,
            d.apply_on_vacation ?? null,
            d.apply_on_thirteenth ?? null,
            d.apply_on_termination ?? null,
            d.apply_on_complementary ?? null,
            d.start_date ?? null,
            Object.prototype.hasOwnProperty.call(d, 'end_date'),
            d.end_date ?? null,
            d.is_active ?? null,
            d.notes ?? null,
            beneficiaryId,
            contractId,
          ]
        );
        if (rows.length === 0) return null;

        const permsList = await getUserPermissions(
          client,
          request.user!.sub,
          request.user!.tenant_id!,
          request.user!.role
        );
        const permsSet = new Set(permsList);
        const ctx: UserPermissionContext = {
          hasPermission: (slug: string) => request.user?.role === 'system_admin' || permsSet.has(slug),
        };
        return serializeAlimonyBeneficiary(rows[0], ctx);
      });

      if (!updated) {
        return reply.status(404).send({ success: false, error: 'Beneficiário não encontrado.' });
      }
      return reply.send({ success: true, data: updated });
    }
  );

  app.delete(
    '/:id/alimony-beneficiaries/:beneficiaryId',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id: contractId, beneficiaryId } = request.params as { id: string; beneficiaryId: string };
      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const removed = await request.withContext(async (client) => {
        const { rows } = await client.query(
          `UPDATE public.alimony_beneficiaries
           SET is_active = FALSE, deleted_at = NOW(), updated_at = NOW()
           WHERE id = $1::uuid AND contract_id = $2::uuid AND deleted_at IS NULL
           RETURNING id;`,
          [beneficiaryId, contractId]
        );
        return rows[0] || null;
      });

      if (!removed) {
        return reply.status(404).send({ success: false, error: 'Beneficiário não encontrado.' });
      }
      return reply.send({ success: true, message: 'Beneficiário removido com sucesso.' });
    }
  );

  // ===========================================================================
  // DEPENDENTES & SALÁRIO-FAMÍLIA (FOLHA-05 — Vacina/Escola & IRRF)
  // Aceita :id como contract_id ou worker_id
  // ===========================================================================
  const resolveWorkerIdForEmployeeParam = async (client: any, idParam: string, tenantId: string): Promise<string | null> => {
    const { rows } = await client.query(
      `SELECT w.id AS worker_id
       FROM public.workers w
       LEFT JOIN public.contracts c ON c.worker_id = w.id AND c.deleted_at IS NULL
       WHERE w.tenant_id = $2::uuid
         AND (c.id = $1::uuid OR w.id = $1::uuid)
       LIMIT 1;`,
      [idParam, tenantId]
    );
    return rows[0]?.worker_id || null;
  };

  const serializeDependentRow = (dep: any, canViewPii: boolean) => ({
    ...dep,
    cpf: canViewPii ? dep.cpf : maskCpf(dep.cpf),
    is_family_allowance_dependent: Boolean(dep.is_family_salary),
    has_disability: Boolean(dep.is_incapacitated),
  });

  app.get('/:id/dependents', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const result = await request.withContext(async (client) => {
      const workerId = await resolveWorkerIdForEmployeeParam(client, id, request.user!.tenant_id!);
      if (!workerId) return null;

      const permsList = await getUserPermissions(
        client,
        request.user!.sub,
        request.user!.tenant_id!,
        request.user!.role
      );
      const canViewPii = request.user?.role === 'system_admin' || permsList.includes('view_pii_unmasked');

      const { rows } = await client.query(
        `SELECT * FROM public.dependents
         WHERE tenant_id = $1::uuid AND worker_id = $2::uuid AND deleted_at IS NULL
         ORDER BY birth_date DESC, created_at DESC;`,
        [request.user!.tenant_id, workerId]
      );
      return rows.map((r) => serializeDependentRow(r, canViewPii));
    });

    if (result === null) {
      return reply.status(404).send({ success: false, error: 'Colaborador não encontrado.' });
    }
    return reply.send({ success: true, data: result });
  });

  app.post(
    '/:id/dependents',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parse = dependentSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: parse.error.errors[0]?.message || 'Dados inválidos para dependente.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      const isFamilySalary = d.is_family_salary ?? d.is_family_allowance_dependent ?? false;
      const isIncapacitated = d.is_incapacitated ?? d.has_disability ?? false;

      const created = await request.withContext(async (client) => {
        const workerId = await resolveWorkerIdForEmployeeParam(client, id, request.user!.tenant_id!);
        if (!workerId) return null;

        const { rows } = await client.query(
          `INSERT INTO public.dependents (
             tenant_id, worker_id, name, cpf, relationship, birth_date,
             is_irrf_dependent, is_family_salary, is_incapacitated,
             start_date, end_date, birth_certificate_number,
             vaccination_card_date, school_frequency_date
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6::date,
             $7, $8, $9,
             COALESCE($10::date, $6::date), $11::date, $12,
             $13::date, $14::date
           )
           RETURNING *;`,
          [
            request.user!.tenant_id,
            workerId,
            d.name,
            d.cpf || null,
            d.relationship,
            d.birth_date,
            d.is_irrf_dependent,
            isFamilySalary,
            isIncapacitated,
            d.start_date || null,
            d.end_date || null,
            d.birth_certificate_number || null,
            d.vaccination_card_date || null,
            d.school_frequency_date || null,
          ]
        );
        return serializeDependentRow(rows[0], true);
      });

      if (!created) {
        return reply.status(404).send({ success: false, error: 'Colaborador não encontrado.' });
      }
      return reply.status(201).send({ success: true, data: created });
    }
  );

  app.put(
    '/:id/dependents/:dependentId',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id, dependentId } = request.params as { id: string; dependentId: string };
      const parse = dependentSchema.partial().safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: parse.error.errors[0]?.message || 'Dados inválidos para dependente.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      const bodyObj = (request.body || {}) as Record<string, any>;
      const hasEndDate = Object.prototype.hasOwnProperty.call(bodyObj, 'end_date');
      const hasVaccDate = Object.prototype.hasOwnProperty.call(bodyObj, 'vaccination_card_date');
      const hasSchoolDate = Object.prototype.hasOwnProperty.call(bodyObj, 'school_frequency_date');
      const isFamilySalary = d.is_family_salary ?? d.is_family_allowance_dependent;
      const isIncapacitated = d.is_incapacitated ?? d.has_disability;

      const updated = await request.withContext(async (client) => {
        const workerId = await resolveWorkerIdForEmployeeParam(client, id, request.user!.tenant_id!);
        if (!workerId) return null;

        const { rows } = await client.query(
          `UPDATE public.dependents
           SET name = COALESCE($1, name),
               cpf = COALESCE($2, cpf),
               relationship = COALESCE($3, relationship),
               birth_date = COALESCE($4::date, birth_date),
               is_irrf_dependent = COALESCE($5, is_irrf_dependent),
               is_family_salary = COALESCE($6, is_family_salary),
               is_incapacitated = COALESCE($7, is_incapacitated),
               start_date = COALESCE($8::date, start_date),
               end_date = CASE WHEN $9::boolean THEN $10::date ELSE end_date END,
               birth_certificate_number = COALESCE($11, birth_certificate_number),
               vaccination_card_date = CASE WHEN $12::boolean THEN $13::date ELSE vaccination_card_date END,
               school_frequency_date = CASE WHEN $14::boolean THEN $15::date ELSE school_frequency_date END,
               updated_at = NOW()
           WHERE id = $16::uuid AND worker_id = $17::uuid AND tenant_id = $18::uuid AND deleted_at IS NULL
           RETURNING *;`,
          [
            d.name ?? null,
            d.cpf ?? null,
            d.relationship ?? null,
            d.birth_date ?? null,
            d.is_irrf_dependent ?? null,
            isFamilySalary ?? null,
            isIncapacitated ?? null,
            d.start_date ?? null,
            hasEndDate,
            d.end_date ?? null,
            d.birth_certificate_number ?? null,
            hasVaccDate,
            d.vaccination_card_date ?? null,
            hasSchoolDate,
            d.school_frequency_date ?? null,
            dependentId,
            workerId,
            request.user!.tenant_id,
          ]
        );
        return rows[0] ? serializeDependentRow(rows[0], true) : null;
      });

      if (!updated) {
        return reply.status(404).send({ success: false, error: 'Dependente não encontrado.' });
      }
      return reply.send({ success: true, data: updated });
    }
  );

  app.delete(
    '/:id/dependents/:dependentId',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id, dependentId } = request.params as { id: string; dependentId: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const removed = await request.withContext(async (client) => {
        const workerId = await resolveWorkerIdForEmployeeParam(client, id, request.user!.tenant_id!);
        if (!workerId) return null;

        const { rows } = await client.query(
          `UPDATE public.dependents
           SET deleted_at = NOW(), updated_at = NOW()
           WHERE id = $1::uuid AND worker_id = $2::uuid AND tenant_id = $3::uuid AND deleted_at IS NULL
           RETURNING id;`,
          [dependentId, workerId, request.user!.tenant_id]
        );
        return rows[0] || null;
      });

      if (!removed) {
        return reply.status(404).send({ success: false, error: 'Dependente não encontrado.' });
      }
      return reply.send({ success: true, message: 'Dependente removido com sucesso.' });
    }
  );

  // ===========================================================================
  // MÚLTIPLOS VÍNCULOS PREVIDENCIÁRIOS (FOLHA-06 — INSS Outro Empregador / indMV 1/2/3)
  // Aceita :id como contract_id ou worker_id
  // ===========================================================================
  app.get('/:id/other-employments', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }

    const result = await request.withContext(async (client) => {
      const workerId = await resolveWorkerIdForEmployeeParam(client, id, request.user!.tenant_id!);
      if (!workerId) return null;

      const { rows: workerRows } = await client.query(
        `SELECT cpf FROM public.workers WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1;`,
        [workerId, request.user!.tenant_id]
      );
      const cleanCpf = String(workerRows[0]?.cpf || '').replace(/\D/g, '');

      const { rows: externals } = await client.query(
        `SELECT * FROM public.employee_other_employments
         WHERE tenant_id = $1::uuid AND worker_id = $2::uuid AND deleted_at IS NULL
         ORDER BY competence_year DESC, competence_month DESC, created_at DESC;`,
        [request.user!.tenant_id, workerId]
      );

      let groupContracts: any[] = [];
      if (cleanCpf) {
        const { rows: grpRows } = await client.query(
          `SELECT c.id AS contract_id, c.registration_number, c.status, c.admission_date,
                  co.id AS company_id, co.corporate_name AS company_name, co.cnpj AS company_cnpj
           FROM public.contracts c
           JOIN public.workers w ON w.id = c.worker_id
           JOIN public.companies co ON co.id = c.company_id
           WHERE c.tenant_id = $1::uuid
             AND regexp_replace(COALESCE(w.cpf, ''), '[^0-9]', '', 'g') = $2
             AND c.deleted_at IS NULL
             AND c.status IN ('ACTIVE', 'LEAVE', 'VACATION')
           ORDER BY c.admission_date ASC;`,
          [request.user!.tenant_id, cleanCpf]
        );
        groupContracts = grpRows;
      }

      return {
        externalEmployments: externals,
        groupContracts,
      };
    });

    if (!result) {
      return reply.status(404).send({ success: false, error: 'Colaborador não encontrado.' });
    }
    return reply.send({ success: true, data: result });
  });

  app.post(
    '/:id/other-employments',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parse = otherEmploymentSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: parse.error.errors[0]?.message || 'Dados inválidos para múltiplo vínculo.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      try {
        const created = await request.withContext(async (client) => {
          const workerId = await resolveWorkerIdForEmployeeParam(client, id, request.user!.tenant_id!);
          if (!workerId) return null;

          const { rows } = await client.query(
            `INSERT INTO public.employee_other_employments (
               tenant_id, worker_id, contract_id, employer_cnpj, employer_name,
               esocial_category_code, ind_mv, competence_year, competence_month,
               remuneration_amount, inss_withheld, is_recurring, notes, is_active
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4, $5,
               $6, $7, $8, $9,
               $10, $11, $12, $13, $14
             )
             RETURNING *;`,
            [
              request.user!.tenant_id,
              workerId,
              d.contract_id || null,
              d.employer_cnpj,
              d.employer_name,
              d.esocial_category_code,
              d.ind_mv,
              d.competence_year,
              d.competence_month,
              d.remuneration_amount,
              d.inss_withheld,
              d.is_recurring,
              d.notes || null,
              d.is_active,
            ]
          );
          return rows[0];
        });

        if (!created) {
          return reply.status(404).send({ success: false, error: 'Colaborador não encontrado.' });
        }
        return reply.status(201).send({ success: true, data: created });
      } catch (err: any) {
        if (err?.code === '23505') {
          return reply.status(409).send({
            success: false,
            error: 'Já existe um vínculo cadastrado para este CNPJ nesta competência.',
          });
        }
        return reply.status(400).send({ success: false, error: err.message });
      }
    }
  );

  app.put(
    '/:id/other-employments/:employmentId',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id, employmentId } = request.params as { id: string; employmentId: string };
      const parse = otherEmploymentSchema.partial().safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: parse.error.errors[0]?.message || 'Dados inválidos.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      const updated = await request.withContext(async (client) => {
        const workerId = await resolveWorkerIdForEmployeeParam(client, id, request.user!.tenant_id!);
        if (!workerId) return null;

        const { rows } = await client.query(
          `UPDATE public.employee_other_employments
           SET employer_cnpj = COALESCE($1, employer_cnpj),
               employer_name = COALESCE($2, employer_name),
               esocial_category_code = COALESCE($3, esocial_category_code),
               ind_mv = COALESCE($4, ind_mv),
               competence_year = COALESCE($5, competence_year),
               competence_month = COALESCE($6, competence_month),
               remuneration_amount = COALESCE($7, remuneration_amount),
               inss_withheld = COALESCE($8, inss_withheld),
               is_recurring = COALESCE($9, is_recurring),
               notes = COALESCE($10, notes),
               is_active = COALESCE($11, is_active),
               updated_at = NOW()
           WHERE id = $12::uuid AND worker_id = $13::uuid AND tenant_id = $14::uuid AND deleted_at IS NULL
           RETURNING *;`,
          [
            d.employer_cnpj ?? null,
            d.employer_name ?? null,
            d.esocial_category_code ?? null,
            d.ind_mv ?? null,
            d.competence_year ?? null,
            d.competence_month ?? null,
            d.remuneration_amount ?? null,
            d.inss_withheld ?? null,
            d.is_recurring ?? null,
            d.notes ?? null,
            d.is_active ?? null,
            employmentId,
            workerId,
            request.user!.tenant_id,
          ]
        );
        return rows[0] || null;
      });

      if (!updated) {
        return reply.status(404).send({ success: false, error: 'Vínculo não encontrado.' });
      }
      return reply.send({ success: true, data: updated });
    }
  );

  app.delete(
    '/:id/other-employments/:employmentId',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id, employmentId } = request.params as { id: string; employmentId: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const removed = await request.withContext(async (client) => {
        const workerId = await resolveWorkerIdForEmployeeParam(client, id, request.user!.tenant_id!);
        if (!workerId) return null;

        const { rows } = await client.query(
          `UPDATE public.employee_other_employments
           SET is_active = FALSE, deleted_at = NOW(), updated_at = NOW()
           WHERE id = $1::uuid AND worker_id = $2::uuid AND tenant_id = $3::uuid AND deleted_at IS NULL
           RETURNING id;`,
          [employmentId, workerId, request.user!.tenant_id]
        );
        return rows[0] || null;
      });

      if (!removed) {
        return reply.status(404).send({ success: false, error: 'Vínculo não encontrado.' });
      }
      return reply.send({ success: true, message: 'Vínculo externo removido com sucesso.' });
    }
  );

  // Helper para resolver id tanto como contract_id quanto como worker_id
  const resolveContractAndWorker = async (
    client: any,
    idParam: string,
    tenantId: string
  ): Promise<{ contractId: string; workerId: string } | null> => {
    const { rows } = await client.query(
      `SELECT c.id AS contract_id, w.id AS worker_id
       FROM public.workers w
       LEFT JOIN public.contracts c ON c.worker_id = w.id AND c.deleted_at IS NULL
       WHERE w.tenant_id = $2::uuid
         AND (c.id = $1::uuid OR w.id = $1::uuid)
       ORDER BY c.created_at DESC
       LIMIT 1;`,
      [idParam, tenantId]
    );
    if (!rows[0] || !rows[0].contract_id) return null;
    return { contractId: rows[0].contract_id, workerId: rows[0].worker_id };
  };

  // ===========================================================================
  // EMPRÉSTIMOS CONSIGNADOS (FOLHA-07 — Lei 10.820/2003 / Margem 35%)
  // ===========================================================================
  app.get(
    '/:id/loans',
    { preHandler: [authenticate, requireAnyPermission(['view_employees', 'view_payslips', 'calculate_payroll'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const result = await request.withContext(async (client) => {
        const resolved = await resolveContractAndWorker(client, id, request.user!.tenant_id!);
        if (!resolved) return null;

        const { rows: loans } = await client.query(
          `SELECT * FROM public.payroll_loans
           WHERE tenant_id = $1::uuid AND contract_id = $2::uuid
           ORDER BY created_at DESC;`,
          [request.user!.tenant_id, resolved.contractId]
        );

        // Busca dados de salário base para cálculo da margem de 35%
        const { rows: contractRows } = await client.query(
          `SELECT base_salary FROM public.contracts
           WHERE id = $1::uuid AND tenant_id = $2::uuid;`,
          [resolved.contractId, request.user!.tenant_id]
        );
        const baseSalary = Number(contractRows[0]?.base_salary || 0);
        const activeInstallmentsTotal = loans
          .filter((l: any) => l.is_active && l.status === 'ACTIVE')
          .reduce((sum: number, l: any) => sum + Number(l.installment_amount || 0), 0);
        const estimatedMaxMargin = round2((baseSalary * DiscountPriorityManager.MARGIN_LEGAL_PERCENTAGE) / 100);
        const remainingEstimatedMargin = Math.max(0, round2(estimatedMaxMargin - activeInstallmentsTotal));

        return {
          loans,
          marginSummary: {
            baseSalary,
            legalMarginPercentage: DiscountPriorityManager.MARGIN_LEGAL_PERCENTAGE,
            maxConsignableLimit: estimatedMaxMargin,
            committedInstallments: round2(activeInstallmentsTotal),
            availableMargin: remainingEstimatedMargin,
          },
        };
      });

      if (!result) {
        return reply.status(404).send({ success: false, error: 'Colaborador/Contrato não encontrado.' });
      }
      return reply.send({ success: true, data: result.loans, marginSummary: result.marginSummary });
    }
  );

  app.post(
    '/:id/loans',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parse = createLoanSchema.safeParse(request.body || {});
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: parse.error.errors[0]?.message || 'Dados inválidos.',
          details: parse.error.format(),
        });
      }

      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      const created = await request.withContext(async (client) => {
        const resolved = await resolveContractAndWorker(client, id, request.user!.tenant_id!);
        if (!resolved) return null;

        const finInst = d.financialInstitution || d.bankCode || 'Banco Consignado';
        const totalAmt = d.totalAmount ?? round2(d.installmentAmount * d.totalInstallments);
        const { rows } = await client.query(
          `INSERT INTO public.payroll_loans (
             tenant_id, contract_id, financial_institution, contract_number,
             total_amount, installment_amount, total_installments, paid_installments,
             start_date, is_active, status, notes
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4,
             $5, $6, $7, $8,
             $9::date, TRUE, 'ACTIVE', $10
           ) RETURNING *;`,
          [
            request.user!.tenant_id,
            resolved.contractId,
            finInst,
            d.contractNumber || `EMP-${Date.now()}`,
            totalAmt,
            d.installmentAmount,
            d.totalInstallments,
            d.paidInstallments ?? 0,
            d.startDate,
            d.notes ?? null,
          ]
        );
        return rows[0] || null;
      });

      if (!created) {
        return reply.status(404).send({ success: false, error: 'Colaborador/Contrato não encontrado.' });
      }
      return reply.status(201).send({ success: true, data: created });
    }
  );

  app.delete(
    '/:id/loans/:loanId',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id, loanId } = request.params as { id: string; loanId: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const updated = await request.withContext(async (client) => {
        const resolved = await resolveContractAndWorker(client, id, request.user!.tenant_id!);
        if (!resolved) return null;

        const { rows } = await client.query(
          `UPDATE public.payroll_loans
           SET is_active = FALSE, status = 'CANCELLED', updated_at = NOW()
           WHERE id = $1::uuid AND contract_id = $2::uuid AND tenant_id = $3::uuid
           RETURNING id;`,
          [loanId, resolved.contractId, request.user!.tenant_id]
        );
        return rows[0] || null;
      });

      if (!updated) {
        return reply.status(404).send({ success: false, error: 'Empréstimo não encontrado.' });
      }
      return reply.send({ success: true, message: 'Empréstimo cancelado com sucesso.' });
    }
  );

  // ===========================================================================
  // SALDOS DEVEDORES & INSUFICIÊNCIA DE SALDO (FOLHA-07 — Rubricas 499/899 / CLT Art. 462)
  // ===========================================================================
  app.get(
    '/:id/balance-debts',
    { preHandler: [authenticate, requireAnyPermission(['view_employees', 'view_payslips', 'calculate_payroll'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const debts = await request.withContext(async (client) => {
        const resolved = await resolveContractAndWorker(client, id, request.user!.tenant_id!);
        if (!resolved) return null;

        const { rows } = await client.query(
          `SELECT bd.*,
                  p_src.year AS source_year, p_src.month AS source_month,
                  p_clr.year AS cleared_year, p_clr.month AS cleared_month
           FROM public.employee_balance_debts bd
           LEFT JOIN public.payroll_periods p_src ON p_src.id = bd.source_period_id
           LEFT JOIN public.payroll_periods p_clr ON p_clr.id = bd.cleared_period_id
           WHERE bd.tenant_id = $1::uuid
             AND (bd.contract_id = $2::uuid OR bd.worker_id = $3::uuid)
           ORDER BY bd.created_at DESC;`,
          [request.user!.tenant_id, resolved.contractId, resolved.workerId]
        );
        return rows;
      });

      if (!debts) {
        return reply.status(404).send({ success: false, error: 'Colaborador/Contrato não encontrado.' });
      }
      return reply.send({ success: true, data: debts });
    }
  );

  app.post(
    '/:id/balance-debts/:debtId/cancel',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id, debtId } = request.params as { id: string; debtId: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const cancelled = await request.withContext(async (client) => {
        const resolved = await resolveContractAndWorker(client, id, request.user!.tenant_id!);
        if (!resolved) return null;

        const { rows } = await client.query(
          `UPDATE public.employee_balance_debts
           SET status = 'CANCELLED', balance_remaining = 0, updated_at = NOW(),
               notes = COALESCE(notes || ' | ', '') || 'Cancelado administrativamente'
           WHERE id = $1::uuid
             AND (contract_id = $2::uuid OR worker_id = $3::uuid)
             AND tenant_id = $4::uuid
             AND status IN ('PENDING', 'PARTIALLY_DEDUCTED')
           RETURNING id;`,
          [debtId, resolved.contractId, resolved.workerId, request.user!.tenant_id]
        );
        return rows[0] || null;
      });

      if (!cancelled) {
        return reply.status(404).send({ success: false, error: 'Débito pendente não encontrado.' });
      }
      return reply.send({ success: true, message: 'Saldo devedor cancelado com sucesso.' });
    }
  );

  // FOLHA-15: Gestão de Convocações de Trabalho Intermitente (CLT Art. 452-A)
  app.get(
    '/:id/intermittent-calls',
    { preHandler: [authenticate, requirePermission('view_employees')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const calls = await request.withContext(async (client) => {
        const resolved = await resolveContractAndWorker(client, id, request.user!.tenant_id!);
        if (!resolved) return null;

        const { rows } = await client.query(
          `SELECT * FROM public.intermittent_calls
           WHERE tenant_id = $1::uuid AND contract_id = $2::uuid
           ORDER BY work_start_date DESC;`,
          [request.user!.tenant_id, resolved.contractId]
        );
        return rows;
      });

      if (!calls) return reply.status(404).send({ success: false, error: 'Contrato não encontrado.' });
      return reply.send({ success: true, data: calls });
    }
  );

  app.post(
    '/:id/intermittent-calls',
    { preHandler: [authenticate, requirePermission('manage_employees')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const bodySchema = z.object({
        call_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        work_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        work_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        hours_worked: z.coerce.number().positive(),
        hourly_rate: z.coerce.number().nonnegative(),
        dias_uteis: z.coerce.number().int().positive().default(25),
        dias_inuteis: z.coerce.number().int().nonnegative().default(5),
        status: z.enum(['PENDING', 'ACCEPTED', 'COMPLETED']).default('ACCEPTED'),
        notes: z.string().optional().nullable(),
      });
      const parse = bodySchema.safeParse(request.body || {});
      if (!parse.success) return reply.status(400).send({ success: false, details: parse.error.format() });
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      const d = parse.data;
      const computed = MultiRegimeCalculator.calculateIntermittentCall({
        hoursWorked: d.hours_worked,
        hourlyRate: d.hourly_rate,
        diasUteis: d.dias_uteis,
        diasInuteis: d.dias_inuteis,
      });

      const created = await request.withContext(async (client) => {
        const resolved = await resolveContractAndWorker(client, id, request.user!.tenant_id!);
        if (!resolved) return null;

        const { rows } = await client.query(
          `INSERT INTO public.intermittent_calls (
             tenant_id, contract_id, call_date, work_start_date, work_end_date,
             hours_worked, hourly_rate, gross_salary,
             vacation_proportional, vacation_third, thirteenth_proportional, dsr_amount,
             status, notes
           ) VALUES (
             $1::uuid, $2::uuid, $3::date, $4::date, $5::date,
             $6, $7, $8,
             $9, $10, $11, $12,
             $13, $14
           ) RETURNING *;`,
          [
            request.user!.tenant_id,
            resolved.contractId,
            d.call_date,
            d.work_start_date,
            d.work_end_date,
            d.hours_worked,
            d.hourly_rate,
            computed.grossWorked,
            computed.vacationProportional,
            computed.vacationThird,
            computed.thirteenthProportional,
            computed.dsrAmount,
            d.status,
            d.notes || null,
          ]
        );
        return rows[0];
      });

      if (!created) return reply.status(404).send({ success: false, error: 'Contrato não encontrado.' });
      return reply.status(201).send({ success: true, data: created });
    }
  );
};
