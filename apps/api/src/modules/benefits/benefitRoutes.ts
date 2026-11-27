import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAnyPermission, requirePermission } from '../auth/authMiddleware.js';
import { round2 } from '@couplerh/payroll-core';

const createCatalogSchema = z.object({
  name: z.string().min(2, 'Nome do benefício deve conter no mínimo 2 caracteres.'),
  code: z.string().min(2, 'Código deve conter no mínimo 2 caracteres.'),
  benefitType: z.enum([
    'MEAL_VOUCHER',
    'FOOD_VOUCHER',
    'TRANSPORTATION_VOUCHER',
    'HEALTH_PLAN',
    'DENTAL_PLAN',
    'LIFE_INSURANCE',
    'OTHER',
  ]),
  defaultProvider: z.string().optional().nullable(),
  rubricId: z.string().uuid().optional().nullable(),
  maxDeductionPercentage: z.number().min(0).max(100).optional().nullable(),
  ansCode: z.string().max(20).optional().nullable(),
  providerCnpj: z.string().max(14).optional().nullable(),
  discountRule: z.string().default('STANDARD'),
  patCoverage: z.boolean().default(false),
});

const updateCatalogSchema = createCatalogSchema.partial();

const linkBenefitSchema = z.object({
  benefitCatalogId: z.string().uuid('ID do benefício no catálogo inválido.'),
  providerName: z.string().optional().nullable(),
  planTier: z.string().optional().nullable(),
  contractValue: z.number().nonnegative().default(0),
  companyCost: z.number().nonnegative().default(0),
  employeeDiscount: z.number().nonnegative().default(0),
  copayAmount: z.number().nonnegative().default(0),
  optIn: z.boolean().default(true),
  workRegime: z.enum(['PRESENTIAL', 'REMOTE', 'HYBRID']).default('PRESENTIAL'),
  weeklyRemoteDays: z.number().int().min(0).max(5).default(0),
  dailyPasses: z.number().int().min(0).max(10).default(2),
  passUnitValue: z.number().nonnegative().default(0),
  concededBenefitValue: z.number().nonnegative().default(0),
  holderMonthlyCost: z.number().nonnegative().default(0),
  holderDiscountValue: z.number().nonnegative().default(0),
  companySubsidyAmount: z.number().nonnegative().default(0),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de início inválida (AAAA-MM-DD).'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de fim inválida (AAAA-MM-DD).').optional().nullable(),
  notes: z.string().optional().nullable(),
});

const addBenefitDependentSchema = z.object({
  dependentId: z.string().uuid().optional().nullable(),
  dependentName: z.string().min(2, 'Nome do dependente é obrigatório.'),
  dependentCpf: z.string().regex(/^\d{11}$/, 'CPF do dependente deve ter 11 dígitos.').optional().nullable(),
  relationship: z.string().default('OTHER'),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  monthlyCost: z.number().nonnegative().default(0),
  employeeDiscount: z.number().nonnegative().default(0),
  companySubsidy: z.number().nonnegative().default(0),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().slice(0, 10)),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

const importCopaymentCsvSchema = z.object({
  payrollPeriodId: z.string().uuid('ID do período de folha inválido.'),
  benefitType: z.enum(['HEALTH_PLAN', 'DENTAL_PLAN', 'OTHER']).default('HEALTH_PLAN'),
  csvContent: z.string().min(1, 'Conteúdo CSV não pode estar vazio.'),
  filename: z.string().default('coparticipacao_fatura.csv'),
});

export const benefitRoutes: FastifyPluginAsync = async (app) => {
  // 1. Listagem do Catálogo de Benefícios
  app.get('/catalogs', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.withContext || !request.user) {
      return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
    }
    const tenantId = request.user.tenant_id;

    return await request.withContext(async (client) => {
      const { rows } = await client.query(
        `SELECT bc.*, r.code AS rubric_code, r.name AS rubric_name
         FROM public.benefit_catalogs bc
         LEFT JOIN public.rubrics r ON r.id = bc.rubric_id
         WHERE bc.tenant_id = $1::uuid
         ORDER BY bc.name ASC;`,
        [tenantId]
      );

      return reply.send({ success: true, data: rows });
    });
  });

  // 2. Criação de Benefício no Catálogo
  app.post(
    '/catalogs',
    { preHandler: [authenticate, requireAnyPermission(['manage_benefits', 'manage_settings'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const body = createCatalogSchema.parse(request.body);

      return await request.withContext(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO public.benefit_catalogs (
             tenant_id, name, code, benefit_type, default_provider,
             rubric_id, max_deduction_percentage, ans_code, provider_cnpj,
             discount_rule, pat_coverage
           ) VALUES (
             $1::uuid, $2, $3, $4, $5,
             $6::uuid, $7, $8, $9,
             $10, $11
           ) RETURNING *;`,
          [
            tenantId,
            body.name,
            body.code,
            body.benefitType,
            body.defaultProvider || null,
            body.rubricId || null,
            body.maxDeductionPercentage != null ? body.maxDeductionPercentage : null,
            body.ansCode || null,
            body.providerCnpj || null,
            body.discountRule,
            body.patCoverage,
          ]
        );

        return reply.status(201).send({ success: true, data: rows[0] });
      });
    }
  );

  // 3. Atualização de Benefício no Catálogo
  app.patch(
    '/catalogs/:id',
    { preHandler: [authenticate, requireAnyPermission(['manage_benefits', 'manage_settings'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const { id } = request.params as { id: string };
      const body = updateCatalogSchema.parse(request.body);

      const fields: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (body.name !== undefined) {
        fields.push(`name = $${idx++}`);
        values.push(body.name);
      }
      if (body.code !== undefined) {
        fields.push(`code = $${idx++}`);
        values.push(body.code);
      }
      if (body.benefitType !== undefined) {
        fields.push(`benefit_type = $${idx++}`);
        values.push(body.benefitType);
      }
      if (body.defaultProvider !== undefined) {
        fields.push(`default_provider = $${idx++}`);
        values.push(body.defaultProvider);
      }
      if (body.rubricId !== undefined) {
        fields.push(`rubric_id = $${idx++}::uuid`);
        values.push(body.rubricId);
      }
      if (body.maxDeductionPercentage !== undefined) {
        fields.push(`max_deduction_percentage = $${idx++}`);
        values.push(body.maxDeductionPercentage);
      }
      if (body.ansCode !== undefined) {
        fields.push(`ans_code = $${idx++}`);
        values.push(body.ansCode);
      }
      if (body.providerCnpj !== undefined) {
        fields.push(`provider_cnpj = $${idx++}`);
        values.push(body.providerCnpj);
      }
      if (body.discountRule !== undefined) {
        fields.push(`discount_rule = $${idx++}`);
        values.push(body.discountRule);
      }
      if (body.patCoverage !== undefined) {
        fields.push(`pat_coverage = $${idx++}`);
        values.push(body.patCoverage);
      }

      if (fields.length === 0) {
        return reply.status(400).send({ success: false, error: 'Nenhum campo informado para atualização.' });
      }

      fields.push(`updated_at = NOW()`);
      values.push(id, tenantId);

      const sql = `
        UPDATE public.benefit_catalogs
        SET ${fields.join(', ')}
        WHERE id = $${idx++}::uuid AND tenant_id = $${idx}::uuid
        RETURNING *;
      `;

      return await request.withContext(async (client) => {
        const { rows } = await client.query(sql, values);
        if (rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Benefício não encontrado no catálogo.' });
        }

        return reply.send({ success: true, data: rows[0] });
      });
    }
  );

  // 4. Benefícios Ativos do Colaborador (com dependentes vinculados)
  app.get(
    '/employees/:id/benefits',
    { preHandler: [authenticate, requireAnyPermission(['view_employees', 'view_benefits'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const { id: contractId } = request.params as { id: string };

      return await request.withContext(async (client) => {
        const { rows: benefits } = await client.query(
          `SELECT eb.*,
                  bc.name AS benefit_name,
                  bc.code AS benefit_code,
                  bc.benefit_type,
                  bc.ans_code,
                  bc.provider_cnpj,
                  bc.default_provider,
                  bc.discount_rule,
                  bc.pat_coverage,
                  r.code AS rubric_code,
                  r.name AS rubric_name
           FROM public.employee_benefits eb
           JOIN public.benefit_catalogs bc ON bc.id = eb.benefit_catalog_id
           LEFT JOIN public.rubrics r ON r.id = bc.rubric_id
           WHERE eb.tenant_id = $1::uuid
             AND eb.contract_id = $2::uuid
             AND eb.is_active = TRUE
           ORDER BY eb.created_at ASC;`,
          [tenantId, contractId]
        );

        const benefitIds = benefits.map((b: any) => b.id);
        let dependents: any[] = [];
        if (benefitIds.length > 0) {
          const { rows: depRows } = await client.query(
            `SELECT * FROM public.employee_benefit_dependents
             WHERE tenant_id = $1::uuid
               AND employee_benefit_id = ANY($2::uuid[])
               AND is_active = TRUE
               AND deleted_at IS NULL
             ORDER BY created_at ASC;`,
            [tenantId, benefitIds]
          );
          dependents = depRows;
        }

        const depsByBenefit = new Map<string, any[]>();
        for (const d of dependents) {
          const list = depsByBenefit.get(d.employee_benefit_id) || [];
          list.push(d);
          depsByBenefit.set(d.employee_benefit_id, list);
        }

        const enriched = benefits.map((b: any) => ({
          ...b,
          dependents: depsByBenefit.get(b.id) || [],
        }));

        return reply.send({ success: true, data: enriched });
      });
    }
  );

  // 5. Vincular Benefício ao Colaborador
  app.post(
    '/employees/:id/benefits',
    { preHandler: [authenticate, requireAnyPermission(['manage_employees', 'manage_benefits'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const { id: contractId } = request.params as { id: string };
      const body = linkBenefitSchema.parse(request.body);

      return await request.withContext(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO public.employee_benefits (
             tenant_id, contract_id, benefit_catalog_id, provider_name, plan_tier,
             contract_value, company_cost, employee_discount, copay_amount,
             opt_in, work_regime, weekly_remote_days, daily_passes, pass_unit_value,
             conceded_benefit_value, holder_monthly_cost, holder_discount_value, company_subsidy_amount,
             start_date, end_date, notes
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5,
             $6, $7, $8, $9,
             $10, $11, $12, $13, $14,
             $15, $16, $17, $18,
             $19::date, $20::date, $21
           ) RETURNING *;`,
          [
            tenantId,
            contractId,
            body.benefitCatalogId,
            body.providerName || null,
            body.planTier || null,
            body.contractValue,
            body.companyCost,
            body.employeeDiscount,
            body.copayAmount,
            body.optIn,
            body.workRegime,
            body.weeklyRemoteDays,
            body.dailyPasses,
            body.passUnitValue,
            body.concededBenefitValue,
            body.holderMonthlyCost,
            body.holderDiscountValue,
            body.companySubsidyAmount,
            body.startDate,
            body.endDate || null,
            body.notes || null,
          ]
        );

        return reply.status(201).send({ success: true, data: rows[0] });
      });
    }
  );

  // 6. Desativar / Cancelar Benefício do Colaborador
  app.delete(
    '/employees/:id/benefits/:benefitId',
    { preHandler: [authenticate, requireAnyPermission(['manage_employees', 'manage_benefits'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const { id: contractId, benefitId } = request.params as { id: string; benefitId: string };

      return await request.withContext(async (client) => {
        const { rows } = await client.query(
          `UPDATE public.employee_benefits
           SET is_active = FALSE, updated_at = NOW()
           WHERE id = $1::uuid AND tenant_id = $2::uuid AND contract_id = $3::uuid
           RETURNING id;`,
          [benefitId, tenantId, contractId]
        );

        if (rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Benefício não encontrado.' });
        }

        return reply.send({ success: true, message: 'Benefício cancelado com sucesso.' });
      });
    }
  );

  // 7. Adicionar Dependente ao Plano de Benefício (Saúde / Odonto)
  app.post(
    '/employees/:id/benefits/:benefitId/dependents',
    { preHandler: [authenticate, requireAnyPermission(['manage_employees', 'manage_benefits'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const { benefitId } = request.params as { id: string; benefitId: string };
      const body = addBenefitDependentSchema.parse(request.body);

      return await request.withContext(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO public.employee_benefit_dependents (
             tenant_id, employee_benefit_id, dependent_id, dependent_name,
             dependent_cpf, relationship, birth_date, monthly_cost,
             employee_discount, company_subsidy, start_date, end_date
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4,
             $5, $6, $7::date, $8,
             $9, $10, $11::date, $12::date
           ) RETURNING *;`,
          [
            tenantId,
            benefitId,
            body.dependentId || null,
            body.dependentName,
            body.dependentCpf || null,
            body.relationship,
            body.birthDate || null,
            body.monthlyCost,
            body.employeeDiscount,
            body.companySubsidy,
            body.startDate,
            body.endDate || null,
          ]
        );

        return reply.status(201).send({ success: true, data: rows[0] });
      });
    }
  );

  // 8. Remover Dependente do Benefício
  app.delete(
    '/employees/:id/benefits/:benefitId/dependents/:depId',
    { preHandler: [authenticate, requireAnyPermission(['manage_employees', 'manage_benefits'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const { benefitId, depId } = request.params as { id: string; benefitId: string; depId: string };

      return await request.withContext(async (client) => {
        const { rows } = await client.query(
          `UPDATE public.employee_benefit_dependents
           SET is_active = FALSE, deleted_at = NOW(), updated_at = NOW()
           WHERE id = $1::uuid AND tenant_id = $2::uuid AND employee_benefit_id = $3::uuid
           RETURNING id;`,
          [depId, tenantId, benefitId]
        );

        if (rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Dependente não encontrado no benefício.' });
        }

        return reply.send({ success: true, message: 'Dependente desvinculado com sucesso.' });
      });
    }
  );

  // 9. Importação de Fatura CSV de Coparticipação (Saúde / Odonto)
  app.post(
    '/copayments/import-csv',
    { preHandler: [authenticate, requireAnyPermission(['manage_payroll', 'manage_benefits'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const userId = request.user.sub || (request.user as any).user_id;
      const body = importCopaymentCsvSchema.parse(request.body);

      return await request.withContext(async (client) => {
        // Verificar período e obter company_id
        const { rows: pRows } = await client.query(
          `SELECT id, company_id, year, month, status FROM public.payroll_periods
           WHERE id = $1::uuid AND tenant_id = $2::uuid;`,
          [body.payrollPeriodId, tenantId]
        );

        if (pRows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Período de folha não encontrado.' });
        }

        const period = pRows[0];
        if (period.status === 'CLOSED') {
          return reply.status(409).send({
            success: false,
            error: 'Não é possível importar coparticipação em uma competência de folha já FECHADA.',
          });
        }

        // Parse do arquivo CSV
        const lines = body.csvContent
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        if (lines.length < 2) {
          return reply.status(400).send({
            success: false,
            error: 'Arquivo CSV deve conter ao menos a linha de cabeçalho e uma linha de dados.',
          });
        }

        // Separador: vírgula ou ponto-e-vírgula ou tab
        const headerLine = lines[0];
        const sep = headerLine.includes(';') ? ';' : headerLine.includes('\t') ? '\t' : ',';
        const headers = headerLine
          .split(sep)
          .map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));

        // Mapeamento de colunas
        const colCpf = headers.findIndex((h) => h.includes('cpf'));
        const colName = headers.findIndex((h) => h.includes('paciente') || h.includes('nome') || h.includes('titular'));
        const colType = headers.findIndex((h) => h.includes('tipo') || h.includes('parentesco'));
        const colDate = headers.findIndex((h) => h.includes('data'));
        const colCode = headers.findIndex((h) => h.includes('codigo') || h.includes('tuss') || h.includes('proc'));
        const colDesc = headers.findIndex((h) => h.includes('descricao') || h.includes('desc') || h.includes('evento'));
        const colVal = headers.findIndex((h) => h.includes('valor') || h.includes('copart') || h.includes('total'));

        if (colCpf === -1 || colVal === -1) {
          return reply.status(400).send({
            success: false,
            error: 'Cabeçalho do CSV inválido. Colunas obrigatórias: CPF e Valor da Coparticipação.',
          });
        }

        // Carregar trabalhadores e contratos ativos do tenant para resolução em memória
        const { rows: workerContracts } = await client.query(
          `SELECT w.id AS worker_id, w.cpf, c.id AS contract_id
           FROM public.workers w
           JOIN public.contracts c ON c.worker_id = w.id
           WHERE w.tenant_id = $1::uuid
             AND c.company_id = $2::uuid
             AND c.deleted_at IS NULL
             AND c.status IN ('ACTIVE', 'LEAVE', 'VACATION');`,
          [tenantId, period.company_id]
        );

        const contractByCleanCpf = new Map<string, { workerId: string; contractId: string }>();
        for (const wc of workerContracts) {
          const clean = String(wc.cpf).replace(/\D/g, '');
          if (clean.length === 11) {
            contractByCleanCpf.set(clean, { workerId: wc.worker_id, contractId: wc.contract_id });
          }
        }

        let processedCount = 0;
        let errorCount = 0;
        let totalCopay = 0;
        const errors: Array<{ row: number; error: string }> = [];
        const validRecords: any[] = [];

        for (let i = 1; i < lines.length; i++) {
          const rawLine = lines[i];
          if (!rawLine) continue;
          const cols = rawLine.split(sep).map((c) => c.trim().replace(/^["']|["']$/g, ''));

          const rawCpf = cols[colCpf] || '';
          const cleanCpf = rawCpf.replace(/\D/g, '');
          const target = contractByCleanCpf.get(cleanCpf);

          if (!target) {
            errorCount++;
            errors.push({ row: i + 1, error: `CPF [${rawCpf}] não localizado entre colaboradores ativos da empresa.` });
            continue;
          }

          const rawVal = (cols[colVal] || '0').replace('R$', '').replace(/\s/g, '').replace(',', '.');
          const copayAmount = Number(rawVal);
          if (isNaN(copayAmount) || copayAmount < 0) {
            errorCount++;
            errors.push({ row: i + 1, error: `Valor de coparticipação inválido: [${cols[colVal]}].` });
            continue;
          }

          const patientName = colName !== -1 ? cols[colName] || 'Titular' : 'Titular';
          const rawType = colType !== -1 ? (cols[colType] || '').toUpperCase() : 'HOLDER';
          const patientType = rawType.includes('DEP') || rawType.includes('FILH') || rawType.includes('CONJ') ? 'DEPENDENT' : 'HOLDER';
          const procedureDesc = colDesc !== -1 && cols[colDesc] ? cols[colDesc] : 'Coparticipação em Procedimento';
          const procedureCode = colCode !== -1 ? cols[colCode] || null : null;
          const procedureDate = colDate !== -1 && cols[colDate] ? cols[colDate].slice(0, 10) : new Date().toISOString().slice(0, 10);

          validRecords.push({
            tenantId,
            contractId: target.contractId,
            workerId: target.workerId,
            payrollPeriodId: period.id,
            competenceYear: period.year,
            competenceMonth: period.month,
            procedureDate,
            patientType,
            patientName,
            patientCpf: cleanCpf,
            procedureCode,
            procedureDescription: procedureDesc,
            copayAmount: round2(copayAmount),
            benefitType: body.benefitType,
          });

          totalCopay = round2(totalCopay + copayAmount);
          processedCount++;
        }

        // Inserir registro de lote de importação
        const { rows: batchRows } = await client.query(
          `INSERT INTO public.benefit_import_batches (
             tenant_id, company_id, payroll_period_id, benefit_type, filename,
             total_rows, processed_rows, error_count, total_copay_amount, errors_json, imported_by
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5,
             $6, $7, $8, $9, $10::jsonb, $11::uuid
           ) RETURNING id;`,
          [
            tenantId,
            period.company_id,
            period.id,
            body.benefitType,
            body.filename,
            lines.length - 1,
            processedCount,
            errorCount,
            totalCopay,
            JSON.stringify(errors),
            userId,
          ]
        );
        const batchId = batchRows[0].id;

        // Inserir coparticipações validadas
        for (const rec of validRecords) {
          await client.query(
            `INSERT INTO public.benefit_copayments (
               tenant_id, contract_id, worker_id, payroll_period_id,
               competence_year, competence_month, procedure_date, patient_type,
               patient_name, patient_cpf, procedure_code, procedure_description,
               copay_amount, import_batch_id, status, benefit_type
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid,
               $5, $6, $7::date, $8,
               $9, $10, $11, $12,
               $13, $14::uuid, 'PENDING', $15
             );`,
            [
              rec.tenantId,
              rec.contractId,
              rec.workerId,
              rec.payrollPeriodId,
              rec.competenceYear,
              rec.competenceMonth,
              rec.procedureDate,
              rec.patientType,
              rec.patientName,
              rec.patientCpf,
              rec.procedureCode,
              rec.procedureDescription,
              rec.copayAmount,
              batchId,
              rec.benefitType,
            ]
          );
        }

        return reply.status(201).send({
          success: true,
          data: {
            batchId,
            totalRows: lines.length - 1,
            processedRows: processedCount,
            errorCount,
            totalCopayAmount: totalCopay,
            errors: errors.slice(0, 20),
          },
        });
      });
    }
  );

  // 10. Listagem de Coparticipações da Competência
  app.get(
    '/copayments',
    { preHandler: [authenticate, requireAnyPermission(['view_payroll', 'view_benefits'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const { period_id, contract_id } = request.query as { period_id?: string; contract_id?: string };

      if (!period_id) {
        return reply.status(400).send({ success: false, error: 'Parâmetro period_id é obrigatório.' });
      }

      return await request.withContext(async (client) => {
        let sql = `
          SELECT cp.*, w.full_name AS worker_name, w.cpf AS worker_cpf
          FROM public.benefit_copayments cp
          JOIN public.workers w ON w.id = cp.worker_id
          WHERE cp.tenant_id = $1::uuid
            AND cp.payroll_period_id = $2::uuid
            AND cp.deleted_at IS NULL
        `;
        const params: any[] = [tenantId, period_id];

        if (contract_id) {
          sql += ` AND cp.contract_id = $3::uuid`;
          params.push(contract_id);
        }

        sql += ` ORDER BY cp.procedure_date DESC;`;

        const { rows } = await client.query(sql, params);
        return reply.send({ success: true, data: rows });
      });
    }
  );

  // 11. Cancelar Coparticipação
  app.delete(
    '/copayments/:id',
    { preHandler: [authenticate, requireAnyPermission(['manage_payroll', 'manage_benefits'])] },
    async (request, reply) => {
      if (!request.withContext || !request.user) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }
      const tenantId = request.user.tenant_id;
      const { id } = request.params as { id: string };

      return await request.withContext(async (client) => {
        const { rows } = await client.query(
          `UPDATE public.benefit_copayments
           SET status = 'CANCELLED', updated_at = NOW()
           WHERE id = $1::uuid AND tenant_id = $2::uuid
           RETURNING id;`,
          [id, tenantId]
        );

        if (rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Registro de coparticipação não encontrado.' });
        }

        return reply.send({ success: true, message: 'Coparticipação cancelada com sucesso.' });
      });
    }
  );
};
