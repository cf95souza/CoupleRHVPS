import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V7 — CONT-01, CONT-02 e CONT-03 (Integração API + PostgreSQL Real)
 *
 * Validações E2E:
 * 1. CONT-01: Rateio Multi-CC / Projetos / Obras CNO (S-1020) sem perda de centavos e rejeição se soma != 100%.
 * 2. CONT-02: Razão de Provisões Reais Acumuladas com carryover de saldo anterior e variação por reajuste salarial.
 * 3. CONT-03: Plano de contas parametrizável (auto-seed + custom), lançamentos D === C e exportação para 5 ERPs.
 */
describe('CONT-01 a 03: Rateios Multi-CC/CNO, Provisões Reais e Exportação ERP', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;

  const tenantId = 'f7010000-0000-0000-0000-000000000001';
  const companyId = 'f7010000-0000-0000-0000-000000000011';
  const estId = 'f7010000-0000-0000-0000-000000000021';
  const posId = 'f7010000-0000-0000-0000-000000000031';
  const wpId = 'f7010000-0000-0000-0000-000000000041';
  const userId = 'f7010000-0000-0000-0000-000000000101';
  const workerId = 'f7010000-0000-0000-0000-000000000201';
  const contractId = 'f7010000-0000-0000-0000-000000000301';

  const ccAdmId = 'f7010000-0000-0000-0000-000000000401';
  const ccProjId = 'f7010000-0000-0000-0000-000000000402';
  const ccObraId = 'f7010000-0000-0000-0000-000000000403';

  let period06Id = '';
  let period07Id = '';

  const cleanupTenant = async (client: any) => {
    await client.query(`DELETE FROM public.tax_reconciliation_snapshots WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.cnab_return_imports WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.cnab_remittance_items WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.cnab_remittances WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.accounting_export_batches WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.accounting_mapping_rules WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.accounting_chart_of_accounts WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.accounting_provisions_ledger WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.payslip_cost_allocations WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.contract_cost_allocations WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.payroll_variable_events WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.cost_centers WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.workers WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.establishments WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.workplaces WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.positions WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.companies WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.users WHERE id = $1::uuid`, [userId]);
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Cont0103!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await cleanupTenant(client);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active)
         VALUES ($1::uuid, 'admin.v7a@couplerh.test', 'Admin V7A', $2, TRUE)`,
        [userId, pwHash]
      );
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V7A', 'ACTIVE')`, [
        tenantId,
      ]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active) VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status, labor_config)
         VALUES ($1::uuid, $2::uuid, 'Construtora Contabil V7 S.A.', '70100000000101', 'LUCRO_REAL', 'ACTIVE',
                 '{"rat_aliquot": 0.02, "fap_multiplier": 1.0, "terceiros_aliquot": 0.058}'::jsonb)`,
        [companyId, tenantId]
      );
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz V7A', '70100000000101')`,
        [estId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sede V7A', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo) VALUES ($1::uuid, $2::uuid, 'Engenheiro Civil', '214205')`,
        [posId, tenantId]
      );

      await client.query(
        `INSERT INTO public.cost_centers (id, tenant_id, company_id, code, name, allocation_type)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CC-ADM', 'Administrativo Central', 'COST_CENTER')`,
        [ccAdmId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.cost_centers (id, tenant_id, company_id, code, name, allocation_type, project_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CC-PROJ', 'Projeto ERP 2026', 'PROJECT', 'PRJ-2026-01')`,
        [ccProjId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.cost_centers (id, tenant_id, company_id, code, name, allocation_type, cno_number, esocial_lotacao_code, esocial_tp_lotacao)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CC-OBRA', 'Obra Torre Norte', 'CNO_WORK', '900123456789', 'LOT-OBRA-01', '02')`,
        [ccObraId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES ($1::uuid, $2::uuid, 'Mariana Souza Engenheira', '70100000001', '1990-02-20', TRUE)`,
        [workerId, tenantId]
      );
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, cost_center_id, registration_number, admission_date,
           base_salary, salary_type, monthly_hours, weekly_hours, regime, status,
           calculation_regime, esocial_category_code
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, 'MAT-V7-01', '2025-01-10',
           3000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', 'CLT', '101'
         )`,
        [contractId, tenantId, companyId, estId, posId, wpId, workerId, ccAdmId]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const auth = await tokenService.createSession({
      userId,
      tenantId,
      role: 'system_admin',
      email: 'admin.v7a@couplerh.test',
      aal: 'aal2',
    });
    tokenAdmin = auth.accessToken;
  });

  afterAll(async () => {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await cleanupTenant(client);
      await client.query('COMMIT;');
    } catch {
      await client.query('ROLLBACK;');
    } finally {
      client.release();
      await app.close();
    }
  });

  it('1. CONT-01: Deve rejeitar rateio != 100%, persistir 33.33/33.33/33.34 com Obra CNO e ratear holerite sem perda de centavos', async () => {
    const invalidRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/accounting/contracts/${contractId}/cost-allocations`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        allocations: [
          { costCenterId: ccAdmId, percentage: 50 },
          { costCenterId: ccObraId, percentage: 40 },
        ],
      },
    });
    expect(invalidRes.statusCode).toBe(400);

    const validRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/accounting/contracts/${contractId}/cost-allocations`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        allocations: [
          { costCenterId: ccAdmId, percentage: 33.33 },
          { costCenterId: ccProjId, projectCode: 'PRJ-2026-01', percentage: 33.33 },
          { costCenterId: ccObraId, cnoNumber: '900123456789', esocialLotacaoCode: 'LOT-OBRA-01', percentage: 33.34 },
        ],
      },
    });
    expect(validRes.statusCode).toBe(200);
    expect(validRes.json().data).toHaveLength(3);

    const pRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 6, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(pRes.statusCode).toBe(201);
    period06Id = pRes.json().data.id;

    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: period06Id },
    });
    expect(calcRes.statusCode).toBe(200);

    const genRes = await app.inject({
      method: 'POST',
      url: `/api/v1/accounting/periods/${period06Id}/cost-allocations/generate`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {},
    });
    expect(genRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/accounting/periods/${period06Id}/cost-allocations`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json().data;
    expect(body.items).toHaveLength(3);
    expect(body.items.some((x: any) => x.cno_number === '900123456789')).toBe(true);

    const sumGross = Number(
      body.items.reduce((acc: number, row: any) => acc + Number(row.gross_amount || 0), 0).toFixed(2)
    );
    const sumNet = Number(
      body.items.reduce((acc: number, row: any) => acc + Number(row.net_amount || 0), 0).toFixed(2)
    );
    const sumFgts = Number(
      body.items.reduce((acc: number, row: any) => acc + Number(row.fgts_amount || 0), 0).toFixed(2)
    );

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips } = await client.query(
        `SELECT total_earnings, net_salary, fgts_month
         FROM public.payslips
         WHERE payroll_period_id = $1::uuid AND contract_id = $2::uuid`,
        [period06Id, contractId]
      );
      expect(slips).toHaveLength(1);
      expect(sumGross).toBe(Number(slips[0].total_earnings));
      expect(sumNet).toBe(Number(slips[0].net_salary));
      expect(sumFgts).toBe(Number(slips[0].fgts_month));
    });
  });

  it('2. CONT-02: Deve gerar razão acumulado de provisões em 06/2026 e carregar saldo anterior + reajuste salarial em 07/2026', async () => {
    const gen06 = await app.inject({
      method: 'POST',
      url: `/api/v1/accounting/periods/${period06Id}/provisions/generate`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {},
    });
    expect(gen06.statusCode).toBe(200);
    const data06 = gen06.json().data;
    expect(data06.entries).toHaveLength(2);
    expect(data06.totalClosingPrincipal).toBeGreaterThan(0);

    const vac06 = data06.entries.find((e: any) => e.provision_type === 'VACATION');
    const dec06 = data06.entries.find((e: any) => e.provision_type === 'THIRTEENTH');
    expect(vac06).toBeDefined();
    expect(dec06).toBeDefined();
    expect(Number(vac06.closing_balance)).toBeGreaterThan(0);

    // Reajusta salário do contrato de 3000 -> 3600 antes de 07/2026
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      await client.query(`UPDATE public.contracts SET base_salary = 3600.00 WHERE id = $1::uuid`, [contractId]);
    });

    const p07Res = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 7, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(p07Res.statusCode).toBe(201);
    period07Id = p07Res.json().data.id;

    const calc07 = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: period07Id },
    });
    expect(calc07.statusCode).toBe(200);

    const gen07 = await app.inject({
      method: 'POST',
      url: `/api/v1/accounting/periods/${period07Id}/provisions/generate`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {},
    });
    expect(gen07.statusCode).toBe(200);

    const get07 = await app.inject({
      method: 'GET',
      url: `/api/v1/accounting/periods/${period07Id}/provisions`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(get07.statusCode).toBe(200);
    const data07 = get07.json().data;
    const vac07 = data07.entries.find((e: any) => e.provision_type === 'VACATION');
    const dec07 = data07.entries.find((e: any) => e.provision_type === 'THIRTEENTH');

    expect(Number(vac07.opening_balance)).toBe(Number(vac06.closing_balance));
    expect(Number(dec07.opening_balance)).toBe(Number(dec06.closing_balance));
    expect(Number(vac07.salary_adjustment_diff)).toBeGreaterThan(0);
    expect(Number(dec07.salary_adjustment_diff)).toBeGreaterThan(0);

    // Equação contábil: closing = opening + monthly + salary_diff + averages - settlements
    const expectedVacClosing = Number(
      (
        Number(vac07.opening_balance) +
        Number(vac07.monthly_accrual) +
        Number(vac07.salary_adjustment_diff) +
        Number(vac07.averages_adjustment) -
        Number(vac07.settlements_paid)
      ).toFixed(2)
    );
    expect(Number(vac07.closing_balance)).toBe(expectedVacClosing);
  });

  it('3. CONT-03: Deve autosssemear plano de contas, aceitar conta/regra customizada, fechar D === C e exportar nos 5 leiautes ERP', async () => {
    const chartRes = await app.inject({
      method: 'GET',
      url: `/api/v1/accounting/chart-of-accounts?companyId=${companyId}`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(chartRes.statusCode).toBe(200);
    const accounts = chartRes.json().data as any[];
    expect(accounts.length).toBeGreaterThan(0);

    const createAccRes = await app.inject({
      method: 'POST',
      url: '/api/v1/accounting/chart-of-accounts',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        companyId,
        accountCode: '4.1.9.99.001',
        accountName: 'Despesa Customizada Engenharia V7',
        reducedCode: '9991',
        accountType: 'EXPENSE',
        nature: 'DEBIT',
        requiresCostCenter: true,
      },
    });
    expect(createAccRes.statusCode).toBe(201);
    const customAccount = createAccRes.json().data;
    const creditTarget = accounts.find((a) => a.nature === 'CREDIT') || accounts[0];

    const createRuleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/accounting/mapping-rules',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        companyId,
        ruleScope: 'RUBRIC',
        rubricCode: '999',
        eventKey: 'CUSTOM_TEST_EVENT',
        debitAccountId: customAccount.id,
        creditAccountId: creditTarget.id,
        historyTemplate: 'V7 Evento Customizado {competence}',
        splitByCostCenter: true,
        priority: 50,
      },
    });
    expect(createRuleRes.statusCode).toBe(201);

    const entriesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/accounting/periods/${period07Id}/entries`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(entriesRes.statusCode).toBe(200);
    const entriesData = entriesRes.json().data;
    expect(entriesData.isBalanced).toBe(true);
    expect(entriesData.totalDebit).toBeGreaterThan(0);
    expect(entriesData.totalDebit).toBe(entriesData.totalCredit);

    const formats = ['DOMINIO', 'ALTERDATA', 'PROTHEUS', 'SENIOR', 'CSV_CONFIGURABLE'] as const;
    for (const format of formats) {
      const expRes = await app.inject({
        method: 'POST',
        url: `/api/v1/accounting/periods/${period07Id}/export`,
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        payload: { format, delimiter: format === 'CSV_CONFIGURABLE' ? ';' : undefined },
      });
      expect(expRes.statusCode).toBe(201);
      const expData = expRes.json().data;
      expect(expData.fileName).toBeTruthy();
      expect(expData.fileHash).toMatch(/^[a-f0-9]{64}$/);
      expect(expData.content.length).toBeGreaterThan(0);
      expect(expData.journal.isBalanced).toBe(true);
    }

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows } = await client.query(
        `SELECT erp_format, is_balanced FROM public.accounting_export_batches WHERE payroll_period_id = $1::uuid`,
        [period07Id]
      );
      expect(rows).toHaveLength(5);
      expect(rows.every((r: any) => r.is_balanced === true)).toBe(true);
    });
  });
});
