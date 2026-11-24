import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
import { getUserPermissions } from '../auth/rbacMiddleware.js';
import { serializeContract, UserPermissionContext } from '../../shared/serializers/entitySerializers.js';

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
};
