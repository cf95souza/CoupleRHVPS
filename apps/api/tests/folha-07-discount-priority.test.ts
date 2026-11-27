import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V5 — FOLHA-07: Fila de Prioridade Legal de Descontos, Margem Consignável 35% e Insuficiência de Saldo (499/899)
 * Valida:
 * 1. CRUD e Gestão de Empréstimos Consignados (Lei 10.820/2003) e cálculo da margem de 35%
 * 2. Trava estrita de 35% da remuneração líquida disponível para empréstimo consignado (rubrica 805)
 * 3. Cenário Golden de Insuficiência de Saldo (CLT Art. 462): geração da Rubrica 499 mantendo líquido em R$ 0,00
 * 4. Fechamento de Folha (close_payroll_period): baixa de parcelas de consignado e registro em employee_balance_debts
 * 5. Mês subsequente: dedução automática do saldo devedor através da Rubrica 899 e quitação da dívida
 */
describe('FOLHA-07: Prioridade Legal, Margem Consignável 35% e Insuficiência de Saldo (499/899)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let tokenAdmin: string;

  const tenantId = 'f5070000-0000-0000-0000-000000000001';
  const companyId = 'f5070000-0000-0000-0000-000000000011';
  const estId = 'f5070000-0000-0000-0000-000000000021';
  const posId = 'f5070000-0000-0000-0000-000000000031';
  const wpId = 'f5070000-0000-0000-0000-000000000041';
  const userId = 'f5070000-0000-0000-0000-000000000101';

  const workers = {
    loanWorker: 'f5070000-0000-0000-0000-000000000201',
    deficitWorker: 'f5070000-0000-0000-0000-000000000202',
  };

  const contracts = {
    loanContract: 'f5070000-0000-0000-0000-000000000301',
    deficitContract: 'f5070000-0000-0000-0000-000000000302',
  };

  let period1Id = '';
  let period2Id = '';
  let createdLoanId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Folha07Pass!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.employee_balance_debts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_loans WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid`, [userId]);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active)
         VALUES ($1::uuid, 'admin.folha07@couplerh.test', 'Admin FOLHA 07', $2, TRUE)`,
        [userId, pwHash]
      );

      await client.query(
        `INSERT INTO public.tenants (id, name, status)
         VALUES ($1::uuid, 'Tenant FOLHA-07 Prioridade e Margem', 'ACTIVE')`,
        [tenantId]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1::uuid, $2::uuid, 'system_admin', 'ALL', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status, negative_net_policy)
         VALUES ($1::uuid, $2::uuid, 'Empresa Consignado & Saldo Ltda', '71111111000171', 'LUCRO_PRESUMIDO', 'ACTIVE', 'INSUFFICIENCY_CARRYOVER')`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz F7', '71111111000171')`,
        [estId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1::uuid, $2::uuid, 'Analista F7', '252105')`,
        [posId, tenantId]
      );

      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Unidade F7', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, email)
         VALUES
           ($1::uuid, $3::uuid, 'Colaborador Consignado 35', '71000000001', '1990-05-10', 'loan@f507.test'),
           ($2::uuid, $3::uuid, 'Colaborador Deficit 499', '72000000002', '1992-08-20', 'deficit@f507.test')`,
        [workers.loanWorker, workers.deficitWorker, tenantId]
      );

      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, registration_number, admission_date, base_salary, salary_type,
           monthly_hours, weekly_hours, regime, status, receives_advance
         ) VALUES
           ($1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, 'MAT-LOAN', '2024-01-01', 3000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', FALSE),
           ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $9::uuid, 'MAT-DEFICIT', '2024-01-01', 1518.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', FALSE)`,
        [
          contracts.loanContract,
          contracts.deficitContract,
          tenantId,
          companyId,
          estId,
          posId,
          wpId,
          workers.loanWorker,
          workers.deficitWorker,
        ]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const tok = await tokenService.createSession({
      userId,
      tenantId,
      role: 'system_admin',
      email: 'admin.folha07@couplerh.test',
      aal: 'aal2',
    });
    tokenAdmin = tok.accessToken;
  });

  afterAll(async () => {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.employee_balance_debts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_loans WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid`, [userId]);
      await client.query('COMMIT;');
    } catch {
      await client.query('ROLLBACK;');
    } finally {
      client.release();
    }
    await app.close();
  });

  it('1. CRUD e Gestão de Empréstimos Consignados (Lei 10.820/2003 / Margem 35%)', async () => {
    // 1.1 Consulta margem consignável inicial (Salário R$ 3.000,00 -> Margem 35% = R$ 1.050,00)
    const initialLoansRes = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contracts.loanContract}/loans`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(initialLoansRes.statusCode).toBe(200);
    const bodyInit = initialLoansRes.json();
    expect(bodyInit.success).toBe(true);
    expect(bodyInit.marginSummary.baseSalary).toBe(3000.0);
    expect(bodyInit.marginSummary.maxConsignableLimit).toBe(1050.0);
    expect(bodyInit.marginSummary.committedInstallments).toBe(0.0);
    expect(bodyInit.marginSummary.availableMargin).toBe(1050.0);

    // 1.2 Cadastro de Empréstimo Consignado solicitando parcela de R$ 1.500,00 (acima do limite)
    const createLoanRes = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.loanContract}/loans`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        bankCode: '033',
        contractNumber: 'EMP-SANTANDER-2026-001',
        installmentAmount: 1500.0,
        totalInstallments: 12,
        paidInstallments: 0,
        startDate: '2026-07-01',
        notes: 'Empréstimo consignado convênio bancário',
      },
    });
    expect(createLoanRes.statusCode).toBe(201);
    const createdLoan = createLoanRes.json().data;
    expect(createdLoan.id).toBeDefined();
    expect(Number(createdLoan.installment_amount)).toBe(1500.0);
    expect(createdLoan.status).toBe('ACTIVE');
    createdLoanId = createdLoan.id;

    // 1.3 Nova consulta de margem reflete parcela cadastrada
    const updatedLoansRes = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contracts.loanContract}/loans`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(updatedLoansRes.statusCode).toBe(200);
    const bodyUpd = updatedLoansRes.json();
    expect(bodyUpd.marginSummary.committedInstallments).toBe(1500.0);
    expect(bodyUpd.marginSummary.availableMargin).toBe(0.0); // Esgotou margem estimada
  });

  it('2. Trava de Margem 35% no Consignado e Rubrica 499 (Insuficiência de Saldo / Líquido R$ 0,00)', async () => {
    // 2.1 Cria período 07/2026 para a empresa
    const p1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 7, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(p1Res.statusCode).toBe(201);
    period1Id = p1Res.json().data.id;

    // 2.2 Lança evento variável no Contrato Deficitário para gerar déficit CLT Art. 462
    // Salário base R$ 1.518,00 | INSS (7.5%) R$ 113,85 -> Líquido prévio ~ R$ 1.404,15
    // Lançamento de Adiantamento/Desconto de R$ 1.754,15 gera déficit líquido de R$ 350,00
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      // Localiza rubrica 850 (Adiantamento Salarial)
      const { rows: r850Rows } = await client.query(
        `SELECT id FROM public.rubrics WHERE code = '850' AND (tenant_id = $1::uuid OR tenant_id IS NULL) LIMIT 1;`,
        [tenantId]
      );
      expect(r850Rows[0]?.id).toBeDefined();

      await client.query(
        `INSERT INTO public.payroll_variable_events (
           tenant_id, payroll_period_id, contract_id, rubric_id, manual_value, origin
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'MANUAL');`,
        [tenantId, period1Id, contracts.deficitContract, r850Rows[0].id, 1754.15]
      );
    });

    // 2.3 Executa cálculo da folha 07/2026
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: period1Id },
    });
    expect(calcRes.statusCode).toBe(200);

    // 2.4 Valida holerite do Contrato com Consignado (Trava da Lei 10.820/2003)
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: loanSlips } = await client.query(
        `SELECT ps.*,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '805'), 0) AS consignado_aplicado,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '901'), 0) AS inss_aplicado
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
        [tenantId, period1Id, contracts.loanContract]
      );
      expect(loanSlips.length).toBe(1);
      const slipLoan = loanSlips[0];

      // Salário Bruto: R$ 3.000,00
      // INSS 2026: R$ 253,41
      // Líquido disponível para margem: R$ 3.000,00 - R$ 253,41 = R$ 2.746,59
      // Margem 35%: R$ 2.746,59 * 0.35 = R$ 961,31
      // Parcela solicitada de R$ 1.500,00 cortada estritamente para R$ 961,31!
      expect(Number(slipLoan.consignado_aplicado)).toBe(961.31);
      expect(Number(slipLoan.total_earnings)).toBe(3000.0);
      expect(Number(slipLoan.total_deductions)).toBeCloseTo(253.41 + 961.31, 2);
      expect(Number(slipLoan.net_salary)).toBeCloseTo(3000.0 - (253.41 + 961.31), 2);

      // Memória de cálculo registra a trava legal de 35%
      const { rows: memRows } = await client.query(
        `SELECT * FROM public.payroll_memory_calc
         WHERE payslip_id = $1::uuid AND origin = 'LEI_10820_MARGIN_CAP';`,
        [slipLoan.id]
      );
      expect(memRows.length).toBeGreaterThanOrEqual(1);
      expect(memRows[0].parsed_formula).toContain('Margem R$ 961.31');
    });

    // 2.5 Valida holerite do Contrato Deficitário (Golden Scenario Insuficiência de Saldo)
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: deficitSlips } = await client.query(
        `SELECT ps.*,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '499'), 0) AS r499_amount,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '850'), 0) AS r850_amount,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '901'), 0) AS inss_amount
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
        [tenantId, period1Id, contracts.deficitContract]
      );
      expect(deficitSlips.length).toBe(1);
      const slipDeficit = deficitSlips[0];

      // Salário base R$ 1.518,00 | INSS R$ 113,85 | Adiantamento R$ 1.754,15
      // Descontos: R$ 1.868,00 | Proventos iniciais: R$ 1.518,00 -> Déficit: R$ 350,00
      // Rubrica 499 (Provento de Insuficiência de Saldo) gerada no valor de R$ 350,00!
      expect(Number(slipDeficit.r499_amount)).toBe(350.0);
      expect(Number(slipDeficit.total_earnings)).toBe(1868.0);
      expect(Number(slipDeficit.total_deductions)).toBe(1868.0);
      // Salário líquido estritamente ZERO (CLT Art. 462)!
      expect(Number(slipDeficit.net_salary)).toBe(0.0);

      // Memória de cálculo registra a geração da rubrica 499
      const { rows: memRows } = await client.query(
        `SELECT * FROM public.payroll_memory_calc
         WHERE payslip_id = $1::uuid AND origin = 'INSUFFICIENCY_CARRYOVER';`,
        [slipDeficit.id]
      );
      expect(memRows.length).toBeGreaterThanOrEqual(1);
      expect(memRows[0].step_name).toMatch(/Insufici.*ncia de Saldo/);
    });
  });

  it('3. Fechamento de Folha 07/2026: Baixa de Parcela Consignado e Criação de Registro de Saldo Devedor', async () => {
    // 3.1 Executa fechamento do período 07/2026
    const closeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/payroll/periods/${period1Id}/close`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { notes: 'Fechamento de homologação FOLHA-07' },
    });
    if (closeRes.statusCode !== 200) {
      console.log('CLOSE_RES_ERROR:', closeRes.statusCode, closeRes.json());
    }
    expect(closeRes.statusCode).toBe(200);
    const closeData = closeRes.json().data;
    expect(closeData.closed).toBe(true);

    // 3.2 Confere baixa automática da 1ª parcela do empréstimo consignado
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: loanRows } = await client.query(
        `SELECT * FROM public.payroll_loans WHERE id = $1::uuid;`,
        [createdLoanId]
      );
      expect(loanRows.length).toBe(1);
      expect(loanRows[0].paid_installments).toBe(1);
      expect(loanRows[0].is_active).toBe(true);
      expect(loanRows[0].status).toBe('ACTIVE');

      // 3.3 Confere criação do registro de rastreabilidade de saldo devedor em employee_balance_debts
      const { rows: debtRows } = await client.query(
        `SELECT * FROM public.employee_balance_debts
         WHERE tenant_id = $1::uuid AND contract_id = $2::uuid;`,
        [tenantId, contracts.deficitContract]
      );
      expect(debtRows.length).toBe(1);
      const debt = debtRows[0];
      expect(Number(debt.amount)).toBe(350.0);
      expect(Number(debt.balance_remaining)).toBe(350.0);
      expect(debt.status).toBe('PENDING');
      expect(debt.competence_year).toBe(2026);
      expect(debt.competence_month).toBe(7);
      expect(debt.target_year).toBe(2026);
      expect(debt.target_month).toBe(8); // Alvo da competência seguinte
    });

    // 3.4 API GET /balance-debts retorna o débito gerado
    const getDebtsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contracts.deficitContract}/balance-debts`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(getDebtsRes.statusCode).toBe(200);
    const debtsList = getDebtsRes.json().data;
    expect(debtsList.length).toBe(1);
    expect(Number(debtsList[0].amount)).toBe(350.0);
    expect(debtsList[0].status).toBe('PENDING');
  });

  it('4. Competência Seguinte 08/2026: Dedução Automática com Rubrica 899 e Quitação da Dívida', async () => {
    // 4.1 Cria período 08/2026
    const p2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 8, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(p2Res.statusCode).toBe(201);
    period2Id = p2Res.json().data.id;

    // 4.2 Executa cálculo da folha 08/2026 (sem eventos manuais no contrato deficitário)
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: period2Id },
    });
    expect(calcRes.statusCode).toBe(200);

    // 4.3 Confere dedução automática da Rubrica 899 no holerite 08/2026
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: deficitSlips } = await client.query(
        `SELECT ps.*,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '899'), 0) AS r899_amount,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '901'), 0) AS inss_amount
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
        [tenantId, period2Id, contracts.deficitContract]
      );
      expect(deficitSlips.length).toBe(1);
      const slipM2 = deficitSlips[0];

      // Salário R$ 1.518,00 | INSS R$ 113,85
      // Rubrica 899 (Desconto de Insuficiência de Saldo Anterior) automaticamente aplicada: R$ 350,00!
      expect(Number(slipM2.r899_amount)).toBe(350.0);
      expect(Number(slipM2.total_earnings)).toBe(1518.0);
      expect(Number(slipM2.total_deductions)).toBeCloseTo(113.85 + 350.0, 2);
      expect(Number(slipM2.net_salary)).toBeCloseTo(1518.0 - (113.85 + 350.0), 2);
    });

    // 4.4 Fecha a folha 08/2026 e confere liquidação da dívida em employee_balance_debts
    const closeM2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/payroll/periods/${period2Id}/close`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { notes: 'Fechamento mês 2 com liquidação de insuficiência' },
    });
    expect(closeM2Res.statusCode).toBe(200);

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: debtRows } = await client.query(
        `SELECT * FROM public.employee_balance_debts
         WHERE tenant_id = $1::uuid AND contract_id = $2::uuid;`,
        [tenantId, contracts.deficitContract]
      );
      expect(debtRows.length).toBe(1);
      const debt = debtRows[0];
      // A dívida anterior foi completamente quitada (DEDUCTED)
      expect(debt.status).toBe('DEDUCTED');
      expect(Number(debt.balance_remaining)).toBe(0.0);
      expect(debt.cleared_period_id).toBe(period2Id);

      // O empréstimo consignado do Contrato 1 teve a 2ª parcela baixada
      const { rows: loanRows } = await client.query(
        `SELECT * FROM public.payroll_loans WHERE id = $1::uuid;`,
        [createdLoanId]
      );
      expect(loanRows[0].paid_installments).toBe(2);
    });

    // 4.5 API GET /balance-debts agora reflete a quitação
    const getDebtsAfterRes = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contracts.deficitContract}/balance-debts`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(getDebtsAfterRes.statusCode).toBe(200);
    const debtsListAfter = getDebtsAfterRes.json().data;
    expect(debtsListAfter[0].status).toBe('DEDUCTED');
    expect(Number(debtsListAfter[0].balance_remaining)).toBe(0.0);
  });
});
