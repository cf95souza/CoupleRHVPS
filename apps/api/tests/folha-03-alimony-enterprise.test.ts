import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { INSSCalculator, IRRFCalculator, round2 } from '@couplerh/payroll-core';

/**
 * FASE V5 — FOLHA-03: Testes E2E de Pensão Alimentícia Enterprise
 * (Solver Circular Pensão ↔ IRRF + Multi-Beneficiário + Splits + RLS + Imutabilidade CLT).
 */
describe('FOLHA-03: Pensão Alimentícia Enterprise (Solver Circular, Multi-Beneficiário & Splits)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let tokenAdminA: string;
  let tokenDpNoPiiA: string;
  let tokenAdminB: string;

  const tenantAId = 'f5030000-0000-0000-0000-000000000001';
  const tenantBId = 'f5030000-0000-0000-0000-000000000002';

  const companyAId = 'f5030000-0000-0000-0000-000000000011';
  const companyBId = 'f5030000-0000-0000-0000-000000000012';
  const estAId = 'f5030000-0000-0000-0000-000000000021';
  const posAId = 'f5030000-0000-0000-0000-000000000031';
  const wpAId = 'f5030000-0000-0000-0000-000000000041';

  const userAdminAId = 'f5030000-0000-0000-0000-000000000101';
  const userDpNoPiiAId = 'f5030000-0000-0000-0000-000000000102';
  const userAdminBId = 'f5030000-0000-0000-0000-000000000103';

  const workerId = 'f5030000-0000-0000-0000-000000000201';
  const contractId = 'f5030000-0000-0000-0000-000000000301';

  let customRoleId: string;
  let periodId: string;
  let payslipId: string;
  let ben1Id: string;
  let ben2Id: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantBId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantBId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.users WHERE id IN ($1::uuid, $2::uuid, $3::uuid);`, [
        userAdminAId,
        userDpNoPiiAId,
        userAdminBId,
      ]);

      const passHash = await hashPassword('Folha03@2026!');

      await client.query(
        `INSERT INTO public.users (id, email, password_hash, full_name, is_active)
         VALUES
           ($1, 'admin.a.f503@couplerh.test', $4, 'Admin A F503', TRUE),
           ($2, 'dp.nopii.f503@couplerh.test', $4, 'DP Sem PII F503', TRUE),
           ($3, 'admin.b.f503@couplerh.test', $4, 'Admin B F503', TRUE);`,
        [userAdminAId, userDpNoPiiAId, userAdminBId, passHash]
      );

      // Tenant Beta
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1, 'Tenant Beta F503', 'ACTIVE');`, [
        tenantBId,
      ]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1, $2, 'system_admin', 'ALL', TRUE);`,
        [tenantBId, userAdminBId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1, $2, 'Beta F503 Ltda', '72222222000172', 'SIMPLES_NACIONAL', 'ACTIVE');`,
        [companyBId, tenantBId]
      );

      // Tenant Alpha
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1, 'Tenant Alpha F503', 'ACTIVE');`, [
        tenantAId,
      ]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1, $2, 'system_admin', 'ALL', TRUE);`,
        [tenantAId, userAdminAId]
      );

      // Perfil customizado com view_employees/view_payslips mas SEM view_pii_unmasked
      const { rows: roleRows } = await client.query(
        `INSERT INTO public.roles (tenant_id, slug, name, is_system)
         VALUES ($1, 'f503_masked_viewer', 'Visualizador F503 Sem PII', FALSE)
         RETURNING id;`,
        [tenantAId]
      );
      customRoleId = roleRows[0].id;
      await client.query(
        `INSERT INTO public.role_permissions (role_id, permission_id)
         SELECT $1::uuid, p.id FROM public.permissions p
         WHERE p.slug IN ('view_employees', 'view_payslips', 'calculate_payroll');`,
        [customRoleId]
      );
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, role_id, scope_mode, is_active)
         VALUES ($1, $2, 'dp_analyst', $3::uuid, 'ALL', TRUE);`,
        [tenantAId, userDpNoPiiAId, customRoleId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1, $2, 'Alpha F503 Ltda', '71111111000171', 'LUCRO_REAL', 'ACTIVE');`,
        [companyAId, tenantAId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1, $2, $3, 'Matriz F503', '71111111000171');`,
        [estAId, tenantAId, companyAId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1, $2, 'Gerente de Produto', '142310');`,
        [posAId, tenantAId]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1, $2, $3, 'Sede SP', 'SP', '3550308');`,
        [wpAId, tenantAId, companyAId]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, email)
         VALUES ($1, $2, 'Carlos Roberto Mendes', '77788899900', '1988-04-12', 'carlos.f503@couplerh.test');`,
        [workerId, tenantAId]
      );

      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, registration_number, admission_date, base_salary, salary_type,
           monthly_hours, weekly_hours, status, receives_advance
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, 'MAT-F503-01', '2025-01-10', 10000.00, 'MONTHLY',
           220, 44, 'ACTIVE', TRUE
         );`,
        [contractId, tenantAId, companyAId, estAId, posAId, wpAId, workerId]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const [tA, tMask, tB] = await Promise.all([
      tokenService.createSession({
        userId: userAdminAId,
        tenantId: tenantAId,
        role: 'system_admin',
        email: 'admin.a.f503@couplerh.test',
        aal: 'aal2',
      }),
      tokenService.createSession({
        userId: userDpNoPiiAId,
        tenantId: tenantAId,
        role: 'dp_analyst',
        email: 'dp.nopii.f503@couplerh.test',
        aal: 'aal2',
      }),
      tokenService.createSession({
        userId: userAdminBId,
        tenantId: tenantBId,
        role: 'system_admin',
        email: 'admin.b.f503@couplerh.test',
        aal: 'aal2',
      }),
    ]);

    tokenAdminA = tA.accessToken;
    tokenDpNoPiiA = tMask.accessToken;
    tokenAdminB = tB.accessToken;
  });

  afterAll(async () => {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantBId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantBId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantBId]);

      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantAId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantAId]);
      await client.query(`DELETE FROM public.users WHERE id IN ($1::uuid, $2::uuid, $3::uuid);`, [
        userAdminAId,
        userDpNoPiiAId,
        userAdminBId,
      ]);

      await client.query('COMMIT;');
    } catch {
      await client.query('ROLLBACK;');
    } finally {
      client.release();
    }
    await app.close();
  });

  it('1. CRUD Multi-Beneficiário com dados bancários/PIX, mascaramento LGPD e isolamento cross-tenant', async () => {
    const create1 = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contractId}/alimony-beneficiaries`,
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        beneficiary_name: 'Ana Beatriz Mendes',
        beneficiary_cpf: '111.222.333-44',
        relationship: 'FILHO',
        court_process_number: '0001111-22.2026.8.26.0100',
        calculation_basis: 'NET_SALARY',
        percentage: 20,
        payment_method: 'PIX',
        pix_key_type: 'CPF',
        pix_key: '11122233344',
        apply_on_monthly: true,
        apply_on_vacation: true,
        apply_on_thirteenth: true,
        start_date: '2026-01-01',
      },
    });
    expect(create1.statusCode).toBe(201);
    const b1 = create1.json();
    expect(b1.data.beneficiary_cpf).toBe('11122233344');
    ben1Id = b1.data.id;

    const create2 = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contractId}/alimony-beneficiaries`,
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        beneficiary_name: 'Lucas Mendes',
        beneficiary_cpf: '55566677788',
        relationship: 'FILHO',
        court_process_number: '0001111-22.2026.8.26.0100',
        calculation_basis: 'NET_SALARY',
        percentage: 10,
        payment_method: 'BANK_TRANSFER',
        bank_code: '341',
        bank_name: 'Itaú',
        bank_agency: '1234',
        bank_account: '56789-0',
        bank_account_type: 'CORRENTE',
        apply_on_monthly: true,
        start_date: '2026-01-01',
      },
    });
    expect(create2.statusCode).toBe(201);
    ben2Id = create2.json().data.id;

    // Usuário sem view_pii_unmasked recebe CPF, PIX e conta mascarados
    const maskedRes = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contractId}/alimony-beneficiaries`,
      headers: { Authorization: `Bearer ${tokenDpNoPiiA}` },
    });
    expect(maskedRes.statusCode).toBe(200);
    const maskedBody = maskedRes.json();
    expect(maskedBody.data).toHaveLength(2);
    expect(maskedBody.data[0].beneficiary_cpf).not.toBe('11122233344');
    expect(maskedBody.data[0].pix_key).not.toBe('11122233344');
    expect(maskedBody.data[1].bank_account).not.toBe('56789-0');

    // Cross-tenant não enxerga beneficiários do Tenant Alpha
    const tenantBRes = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contractId}/alimony-beneficiaries`,
      headers: { Authorization: `Bearer ${tokenAdminB}` },
    });
    expect(tenantBRes.statusCode).toBe(200);
    expect(tenantBRes.json().data).toHaveLength(0);
  });

  it('2. calcula folha mensal resolvendo Solver Circular Pensão ↔ IRRF, gravando 904, trace na memória, payslip_alimony_splits e irrf_cash_ledger', async () => {
    const createPeriod = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        company_id: companyAId,
        month: 11,
        year: 2026,
        type: 'MONTHLY',
        irrf_regime: 'CASH',
      },
    });
    expect(createPeriod.statusCode).toBe(201);
    periodId = createPeriod.json().data.id;

    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: { period_id: periodId },
    });
    expect(calcRes.statusCode).toBe(200);
    expect(calcRes.json().success).toBe(true);

    const dbCheck = await withTenantContext(
      { userId: userAdminAId, tenantId: tenantAId, role: 'system_admin' },
      async (client) => {
        const psRes = await client.query(
          `SELECT * FROM public.payslips WHERE payroll_period_id = $1::uuid AND contract_id = $2::uuid;`,
          [periodId, contractId]
        );
        const ps = psRes.rows[0];
        payslipId = ps.id;

        const itemsRes = await client.query(
          `SELECT rubric_code, amount, type FROM public.payslip_items WHERE payslip_id = $1::uuid;`,
          [ps.id]
        );
        const memRes = await client.query(
          `SELECT step_name, origin, quantity_used, parsed_formula, result_value
           FROM public.payroll_memory_calc WHERE payslip_id = $1::uuid;`,
          [ps.id]
        );
        const splitsRes = await client.query(
          `SELECT * FROM public.payslip_alimony_splits WHERE payslip_id = $1::uuid ORDER BY percentage_applied DESC;`,
          [ps.id]
        );
        const ledgerRes = await client.query(
          `SELECT * FROM public.irrf_cash_ledger WHERE payslip_id = $1::uuid;`,
          [ps.id]
        );
        const inssRes = await client.query(
          `SELECT bracket_number, base_limit, aliquot
           FROM public.inss_parameters ip
           JOIN public.legal_versions lv ON lv.id = ip.legal_version_id
           WHERE lv.is_active = TRUE ORDER BY bracket_number;`
        );
        const irrfRes = await client.query(
          `SELECT bracket_number, base_limit, aliquot, deduction
           FROM public.irrf_parameters irp
           JOIN public.legal_versions lv ON lv.id = irp.legal_version_id
           WHERE lv.is_active = TRUE ORDER BY bracket_number;`
        );
        const genRes = await client.query(
          `SELECT gp.* FROM public.general_legal_parameters gp
           JOIN public.legal_versions lv ON lv.id = gp.legal_version_id
           WHERE lv.is_active = TRUE LIMIT 1;`
        );

        return {
          payslip: ps,
          items: itemsRes.rows,
          memory: memRes.rows,
          splits: splitsRes.rows,
          ledger: ledgerRes.rows[0],
          inssBrackets: inssRes.rows.map((r: any) => ({
            bracket_number: Number(r.bracket_number),
            base_limit: Number(r.base_limit),
            aliquot: Number(r.aliquot),
            deduction: 0,
          })),
          irrfBrackets: irrfRes.rows.map((r: any) => ({
            bracket_number: Number(r.bracket_number),
            base_limit: r.base_limit !== null ? Number(r.base_limit) : null,
            aliquot: Number(r.aliquot),
            deduction: Number(r.deduction),
          })),
          genParams: genRes.rows[0],
        };
      }
    );

    expect(dbCheck.splits).toHaveLength(2);
    const totalAlimonyFromSplits = round2(
      dbCheck.splits.reduce((s: number, x: any) => s + Number(x.amount), 0)
    );

    const item901 = dbCheck.items.find((i: any) => i.rubric_code === '901');
    const item902 = dbCheck.items.find((i: any) => i.rubric_code === '902');
    const item904 = dbCheck.items.find((i: any) => i.rubric_code === '904');

    expect(Number(item904.amount)).toBe(totalAlimonyFromSplits);
    expect(Number(dbCheck.ledger.alimony_deducted)).toBe(totalAlimonyFromSplits);
    expect(Number(dbCheck.ledger.irrf_withheld)).toBe(Number(item902.amount));

    // Validação independente da equação de ponto fixo (Bruto - INSS - IRRF) * 30%
    const inssVal = INSSCalculator.calculate(10000, dbCheck.inssBrackets).value;
    expect(Number(item901.amount)).toBe(inssVal);

    const expectedIrrf = IRRFCalculator.calculate(
      10000,
      inssVal,
      0,
      dbCheck.irrfBrackets,
      {
        minimum_wage: Number(dbCheck.genParams.minimum_wage),
        dependent_deduction: Number(dbCheck.genParams.dependent_deduction),
        simplified_discount: Number(dbCheck.genParams.simplified_discount),
        irrf_exemption_limit:
          dbCheck.genParams.irrf_exemption_limit !== null
            ? Number(dbCheck.genParams.irrf_exemption_limit)
            : undefined,
        irrf_reduction_formula_limit:
          dbCheck.genParams.irrf_reduction_formula_limit !== null
            ? Number(dbCheck.genParams.irrf_reduction_formula_limit)
            : undefined,
        irrf_reduction_a:
          dbCheck.genParams.irrf_reduction_a !== null
            ? Number(dbCheck.genParams.irrf_reduction_a)
            : undefined,
        irrf_reduction_b:
          dbCheck.genParams.irrf_reduction_b !== null
            ? Number(dbCheck.genParams.irrf_reduction_b)
            : undefined,
      },
      totalAlimonyFromSplits
    );
    expect(Number(item902.amount)).toBe(expectedIrrf.value);
    expect(Number(dbCheck.splits[0].irrf_converged)).toBe(expectedIrrf.value);
    expect(Number(dbCheck.splits[0].solver_iterations)).toBeGreaterThanOrEqual(3);

    const expectedTotalAlimony = round2((10000 - inssVal - expectedIrrf.value) * 0.3);
    expect(Math.abs(totalAlimonyFromSplits - expectedTotalAlimony)).toBeLessThanOrEqual(0.02);

    // Memória de cálculo contém trace do Solver
    const traceMem = dbCheck.memory.find((m: any) => m.origin === 'SOLVER_TRACE');
    expect(traceMem).toBeDefined();
    expect(traceMem.parsed_formula).toContain('CONVERGIDO');

    // Endpoints de consulta de splits (com mascaramento para DP sem view_pii_unmasked)
    const splitsEndpointMasked = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/payslips/${payslipId}/alimony-splits`,
      headers: { Authorization: `Bearer ${tokenDpNoPiiA}` },
    });
    expect(splitsEndpointMasked.statusCode).toBe(200);
    const spJson = splitsEndpointMasked.json();
    expect(spJson.splits).toHaveLength(2);
    expect(spJson.splits[0].payment_details.pix_key).not.toBe('11122233344');

    const periodSplitsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodId}/alimony-splits`,
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    expect(periodSplitsRes.statusCode).toBe(200);
    expect(periodSplitsRes.json().totalAmount).toBe(totalAlimonyFromSplits);
  });

  it('3. suporta preview de convergência (/alimony/preview), atualização/exclusão lógica de beneficiário e bloqueia alteração de splits em folha CLOSED', async () => {
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/alimony/preview',
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: {
        gross_salary: 10000,
        inss: 951.62,
        dependents: 0,
        beneficiaries: [
          {
            beneficiary_name: 'Teste Preview',
            calculation_basis: 'NET_SALARY',
            percentage: 30,
          },
        ],
      },
    });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.json().preview.converged).toBe(true);
    expect(previewRes.json().preview.trace.length).toBeGreaterThanOrEqual(3);

    // Atualiza e remove ben2
    const updRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/employees/${contractId}/alimony-beneficiaries/${ben2Id}`,
      headers: { Authorization: `Bearer ${tokenAdminA}` },
      payload: { percentage: 15 },
    });
    expect(updRes.statusCode).toBe(200);
    expect(updRes.json().data.percentage).toBe(15);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/employees/${contractId}/alimony-beneficiaries/${ben1Id}`,
      headers: { Authorization: `Bearer ${tokenAdminA}` },
    });
    expect(delRes.statusCode).toBe(200);

    // Testa imutabilidade CLT de payslip_alimony_splits após fechamento
    await withTenantContext(
      { userId: userAdminAId, tenantId: tenantAId, role: 'system_admin' },
      async (client) => {
        await client.query(`UPDATE public.payroll_periods SET status = 'CLOSED' WHERE id = $1::uuid;`, [periodId]);
        await client.query('SAVEPOINT sp_closed_alimony;');
        await expect(
          client.query(`DELETE FROM public.payslip_alimony_splits WHERE payslip_id = $1::uuid;`, [payslipId])
        ).rejects.toThrow(/FECHADA/);
        await client.query('ROLLBACK TO SAVEPOINT sp_closed_alimony;');
        await client.query(`UPDATE public.payroll_periods SET status = 'CALCULATED' WHERE id = $1::uuid;`, [periodId]);
      }
    );
  });
});
