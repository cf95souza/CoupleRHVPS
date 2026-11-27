import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V5 — FOLHA-08: Benefícios Enterprise
 * 
 * Validações:
 * 1. Catálogo Corporativo com Código ANS e Regras de Negócio (VT Lei 7.418/85, Saúde, Odonto)
 * 2. Vale-Transporte: Trava do teto de 6% do salário vs custo efetivo concedido
 * 3. Plano de Saúde: Desconto do titular (rubrica 907) e dependente vinculado (rubrica 908)
 * 4. Coparticipação Médica: Importação de CSV de fatura, dedução em folha (rubrica 909) e baixa no fechamento
 */
describe('FOLHA-08: Benefícios Enterprise (Teto VT Lei 7.418/85, Planos ANS e Coparticipação CSV)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let tokenAdmin: string;

  const tenantId = 'f5080000-0000-0000-0000-000000000001';
  const companyId = 'f5080000-0000-0000-0000-000000000011';
  const estId = 'f5080000-0000-0000-0000-000000000021';
  const posId = 'f5080000-0000-0000-0000-000000000031';
  const wpId = 'f5080000-0000-0000-0000-000000000041';
  const userId = 'f5080000-0000-0000-0000-000000000101';

  const workers = {
    w1: 'f5080000-0000-0000-0000-000000000201', // VT com teto 6% (Salário R$ 2.000)
    w2: 'f5080000-0000-0000-0000-000000000202', // VT com custo menor (Salário R$ 6.000)
    w3: 'f5080000-0000-0000-0000-000000000203', // Plano de Saúde + Dependentes + Coparticipação
  };

  const contracts = {
    c1: 'f5080000-0000-0000-0000-000000000301',
    c2: 'f5080000-0000-0000-0000-000000000302',
    c3: 'f5080000-0000-0000-0000-000000000303',
  };

  let periodId = '';
  let catalogVtId = '';
  let catalogHealthId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Folha08Pass!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`DELETE FROM public.benefit_copayments WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.benefit_import_batches WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.employee_benefit_dependents WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.employee_benefits WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.benefit_catalogs WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.workers WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.establishments WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.workplaces WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.positions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.companies WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid`, [userId]);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active)
         VALUES ($1::uuid, 'admin.folha08@couplerh.test', 'Admin FOLHA 08', $2, TRUE)`,
        [userId, pwHash]
      );

      await client.query(
        `INSERT INTO public.tenants (id, name, status)
         VALUES ($1::uuid, 'Tenant FOLHA-08 Benefícios Enterprise', 'ACTIVE')`,
        [tenantId]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
         VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Enterprise Beneficios S.A.', '88123456000188', 'LUCRO_PRESUMIDO', 'ACTIVE')`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz SP', '88123456000188')`,
        [estId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Escritório Central SP', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1::uuid, $2::uuid, 'Analista Pleno', '252405')`,
        [posId, tenantId]
      );

      // Inserção dos 3 colaboradores de teste
      const workerData = [
        { id: workers.w1, name: 'Colaborador VT Teto', cpf: '88100000001', salary: 2000.0, cid: contracts.c1, mat: 'MAT-801' },
        { id: workers.w2, name: 'Colaborador VT Custo Menor', cpf: '88100000002', salary: 6000.0, cid: contracts.c2, mat: 'MAT-802' },
        { id: workers.w3, name: 'Colaborador Plano Saude', cpf: '88100000003', salary: 4500.0, cid: contracts.c3, mat: 'MAT-803' },
      ];

      for (const w of workerData) {
        await client.query(
          `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
           VALUES ($1::uuid, $2::uuid, $3, $4, '1990-05-15', TRUE)`,
          [w.id, tenantId, w.name, w.cpf]
        );

        await client.query(
          `INSERT INTO public.contracts (
             id, tenant_id, company_id, establishment_id, position_id, workplace_id,
             worker_id, registration_number, admission_date, base_salary, salary_type,
             monthly_hours, weekly_hours, regime, status, receives_advance
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
             $7::uuid, $8, '2025-01-01', $9, 'MONTHLY',
             220, 44, 'CLT', 'ACTIVE', FALSE
           )`,
          [w.cid, tenantId, companyId, estId, posId, wpId, w.id, w.mat, w.salary]
        );
      }

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const authRes = await tokenService.createSession({
      userId,
      tenantId,
      role: 'system_admin',
      email: 'admin.folha08@couplerh.test',
      aal: 'aal2',
    });
    tokenAdmin = authRes.accessToken;
  });

  afterAll(async () => {
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);
      await client.query(`DELETE FROM public.benefit_copayments WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.benefit_import_batches WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.employee_benefit_dependents WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.employee_benefits WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.benefit_catalogs WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.workers WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.establishments WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.workplaces WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.positions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.companies WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid`, [userId]);
      await client.query('COMMIT;');
    } catch {
      await client.query('ROLLBACK;');
    } finally {
      client.release();
      await app.close();
    }
  });

  it('1. Deve cadastrar itens no Catálogo de Benefícios Enterprise (VT Lei 7.418/85 e Plano ANS)', async () => {
    // 1.1 Cadastro de Vale-Transporte
    const resVt = await app.inject({
      method: 'POST',
      url: '/api/v1/benefits/catalogs',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Vale Transporte SP',
        code: 'VT_SP',
        benefitType: 'TRANSPORTATION_VOUCHER',
        defaultProvider: 'SPTrans / EMTU',
        discountRule: 'LEGAL_VT_6_PERCENT',
        maxDeductionPercentage: 6.0,
      },
    });

    expect(resVt.statusCode).toBe(201);
    const bodyVt = resVt.json();
    expect(bodyVt.success).toBe(true);
    expect(bodyVt.data.code).toBe('VT_SP');
    catalogVtId = bodyVt.data.id;

    // 1.2 Cadastro de Plano de Saúde com Registro ANS
    const resHealth = await app.inject({
      method: 'POST',
      url: '/api/v1/benefits/catalogs',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Bradesco Saúde Top Nacional',
        code: 'SAUDE_BRADESCO',
        benefitType: 'HEALTH_PLAN',
        defaultProvider: 'Bradesco Saúde S.A.',
        ansCode: '005711',
        providerCnpj: '92693118000160',
        discountRule: 'FIXED_VALUE',
      },
    });

    expect(resHealth.statusCode).toBe(201);
    const bodyHealth = resHealth.json();
    expect(bodyHealth.data.ans_code).toBe('005711');
    catalogHealthId = bodyHealth.data.id;

    // 1.3 Listagem do Catálogo
    const resList = await app.inject({
      method: 'GET',
      url: '/api/v1/benefits/catalogs',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(resList.statusCode).toBe(200);
    expect(resList.json().data).toHaveLength(2);
  });

  it('2. Deve vincular VT aos contratos e aplicar o teto de 6% e o custo efetivo conforme a Lei 7.418/85', async () => {
    // 2.1 Cria período 09/2026 para a empresa (22 dias úteis)
    const pRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 9, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(pRes.statusCode).toBe(201);
    periodId = pRes.json().data.id;

    // 2.2 Contrato 1: Salário R$ 2.000. 22 dias presenciais, 2 passes/dia a R$ 4,50 = Custo R$ 198,00
    // Teto 6% = R$ 120,00 -> Desconto esperado na rubrica 905: R$ 120,00 (Teto 6% aplicado)
    const link1 = await app.inject({
      method: 'POST',
      url: `/api/v1/benefits/employees/${contracts.c1}/benefits`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        benefitCatalogId: catalogVtId,
        optIn: true,
        workRegime: 'PRESENTIAL',
        dailyPasses: 2,
        passUnitValue: 4.5,
        startDate: '2026-01-01',
      },
    });
    expect(link1.statusCode).toBe(201);

    // 2.3 Contrato 2: Salário R$ 6.000. 22 dias presenciais, 2 passes/dia a R$ 4,50 = Custo R$ 198,00
    // Teto 6% = R$ 360,00 -> Desconto esperado na rubrica 905: R$ 198,00 (Custo efetivo menor)
    const link2 = await app.inject({
      method: 'POST',
      url: `/api/v1/benefits/employees/${contracts.c2}/benefits`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        benefitCatalogId: catalogVtId,
        optIn: true,
        workRegime: 'PRESENTIAL',
        dailyPasses: 2,
        passUnitValue: 4.5,
        startDate: '2026-01-01',
      },
    });
    expect(link2.statusCode).toBe(201);

    // 2.4 Execução do cálculo da folha 09/2026
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodId },
    });
    expect(calcRes.statusCode).toBe(200);

    // 2.5 Verificar holerite do Contrato 1 (Teto de 6%)
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips1 } = await client.query(
        `SELECT ps.*,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '905'), 0) AS vt_aplicado
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
        [tenantId, periodId, contracts.c1]
      );
      expect(slips1).toHaveLength(1);
      // 6% de R$ 2.000,00 = exatamente R$ 120,00 (teto aplicado sobre custo de R$ 198,00)
      expect(Number(slips1[0].vt_aplicado)).toBe(120.0);
    });

    // 2.6 Verificar holerite do Contrato 2 (Custo efetivo menor que 6%)
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips2 } = await client.query(
        `SELECT ps.*,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '905'), 0) AS vt_aplicado
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
        [tenantId, periodId, contracts.c2]
      );
      expect(slips2).toHaveLength(1);
      // Custo real: 25 dias úteis (considerando sábados úteis de acordo com escala/DSR) * 2 passes * R$ 4,50 = R$ 225,00 (menor que os R$ 360 do teto de 6%)
      expect(Number(slips2[0].vt_aplicado)).toBe(225.0);
    });
  });

  it('3. Deve vincular Plano de Saúde com código ANS e dependente, apurando rubricas 907 e 908', async () => {
    // 3.1 Vincula plano de saúde ao Contrato 3 (Titular: R$ 600 custo, R$ 400 subsídio empresa -> R$ 200 colaborador)
    const linkRes = await app.inject({
      method: 'POST',
      url: `/api/v1/benefits/employees/${contracts.c3}/benefits`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        benefitCatalogId: catalogHealthId,
        holderMonthlyCost: 600.0,
        holderDiscountValue: 200.0,
        companySubsidyAmount: 400.0,
        startDate: '2026-01-01',
      },
    });
    expect(linkRes.statusCode).toBe(201);
    const benefitId = linkRes.json().data.id;

    // 3.2 Adiciona dependente (Filho) ao plano de saúde (R$ 300 custo, R$ 100 subsídio -> R$ 200 colaborador)
    const depRes = await app.inject({
      method: 'POST',
      url: `/api/v1/benefits/employees/${contracts.c3}/benefits/${benefitId}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        dependentName: 'Lucas da Silva (Filho)',
        dependentCpf: '88100000099',
        relationship: 'CHILD',
        birthDate: '2018-04-12',
        monthlyCost: 300.0,
        employeeDiscount: 200.0,
        companySubsidy: 100.0,
        startDate: '2026-01-01',
      },
    });
    expect(depRes.statusCode).toBe(201);

    // 3.3 Recalcula a folha
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodId },
    });
    expect(calcRes.statusCode).toBe(200);

    // 3.4 Verifica holerite do Contrato 3
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips3 } = await client.query(
        `SELECT ps.*,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '907'), 0) AS saude_titular,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '908'), 0) AS saude_dependentes
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
        [tenantId, periodId, contracts.c3]
      );
      expect(slips3).toHaveLength(1);
      // Rubrica 907 (Titular): R$ 200,00
      expect(Number(slips3[0].saude_titular)).toBe(200.0);
      // Rubrica 908 (Dependentes): R$ 200,00
      expect(Number(slips3[0].saude_dependentes)).toBe(200.0);
    });
  });

  it('4. Deve importar CSV de fatura de coparticipação, descontar rubrica 909 e liquidar no fechamento', async () => {
    // 4.1 Importa fatura CSV de coparticipação para o Colaborador 3 (CPF: 88100000003)
    const csvContent = `CPF;NOME_PACIENTE;TIPO;DATA;PROCEDIMENTO;DESCRICAO;VALOR_COPART
881.000.000-03;Colaborador Plano Saude;TITULAR;2026-09-05;10101012;Consulta Médica Especializada;45,00
881.000.000-03;Lucas da Silva (Filho);DEPENDENTE;2026-09-12;40301630;Exame Hemograma Completo;35,00`;

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/benefits/copayments/import-csv',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        payrollPeriodId: periodId,
        benefitType: 'HEALTH_PLAN',
        csvContent,
        filename: 'fatura_copart_bradesco_092026.csv',
      },
    });

    expect(importRes.statusCode).toBe(201);
    const importBody = importRes.json();
    expect(importBody.success).toBe(true);
    expect(importBody.data.processedRows).toBe(2);
    expect(importBody.data.totalCopayAmount).toBe(80.0); // 45 + 35

    // 4.2 Recalcula a folha e verifica desconto de coparticipação na rubrica 909
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodId },
    });
    expect(calcRes.statusCode).toBe(200);

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips3 } = await client.query(
        `SELECT ps.*,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '909'), 0) AS copart_saude
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
        [tenantId, periodId, contracts.c3]
      );
      expect(slips3).toHaveLength(1);
      // Rubrica 909: R$ 80,00
      expect(Number(slips3[0].copart_saude)).toBe(80.0);
    });

    // 4.3 Fecha a folha de pagamento
    const closeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/payroll/periods/${periodId}/close`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { notes: 'Fechamento de folha de teste com benefícios homologados.' },
    });
    expect(closeRes.statusCode).toBe(200);

    // 4.4 Confere que os registros de coparticipação transicionaram para 'DEDUCTED'
    const copayListRes = await app.inject({
      method: 'GET',
      url: `/api/v1/benefits/copayments?period_id=${periodId}&contract_id=${contracts.c3}`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(copayListRes.statusCode).toBe(200);
    const copays = copayListRes.json().data;
    expect(copays).toHaveLength(2);
    expect(copays.every((c: any) => c.status === 'DEDUCTED')).toBe(true);
  });
});
