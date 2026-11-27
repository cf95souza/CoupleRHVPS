import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V7 — CONT-04 e CONT-05 (Integração API + PostgreSQL Real)
 *
 * Validações E2E:
 * 1. CONT-04: CNAB 240 no backend (240 cols ASCII, Segmentos A+B, pagamento separado de pensão alimentícia)
 *             + importador de retorno (.ret) conciliando pagamento efetivado ('00') e rejeição ('AN').
 * 2. CONT-05: Informe de Rendimentos Completo (Quadros 1–7 RFB + HTML oficial com pensão e plano de saúde ANS)
 *             + Conciliação DCTFWeb / FGTS Digital + guarda arquitetural zero client-side.
 */
describe('CONT-04 e 05: CNAB 240 Multi-Banco/Retorno, Informe RFB Quadros 1-7 e Conciliação Fiscal', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;

  const tenantId = 'f7040000-0000-0000-0000-000000000001';
  const companyId = 'f7040000-0000-0000-0000-000000000011';
  const estId = 'f7040000-0000-0000-0000-000000000021';
  const posId = 'f7040000-0000-0000-0000-000000000031';
  const wpId = 'f7040000-0000-0000-0000-000000000041';
  const userId = 'f7040000-0000-0000-0000-000000000101';
  const workerId = 'f7040000-0000-0000-0000-000000000201';
  const contractId = 'f7040000-0000-0000-0000-000000000301';

  let periodId = '';
  let generatedRemittanceId = '';
  let generatedCnabContent = '';

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
    await client.query(`DELETE FROM public.payslip_alimony_splits WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.alimony_beneficiaries WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.employee_benefit_dependents WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.employee_benefits WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.benefit_catalogs WHERE tenant_id = $1::uuid`, [tenantId]);
    await client.query(`DELETE FROM public.payroll_variable_events WHERE tenant_id = $1::uuid`, [tenantId]);
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
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Cont0405!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await cleanupTenant(client);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active)
         VALUES ($1::uuid, 'admin.v7b@couplerh.test', 'Admin V7B', $2, TRUE)`,
        [userId, pwHash]
      );
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V7B', 'ACTIVE')`, [
        tenantId,
      ]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active) VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (
           id, tenant_id, corporate_name, cnpj, tax_regime, status,
           payment_bank_code, payment_agency, payment_agency_digit, payment_account, payment_account_digit, payment_agreement_code
         ) VALUES (
           $1::uuid, $2::uuid, 'Tecnologia Pagamentos V7 Ltda', '70400000000104', 'LUCRO_REAL', 'ACTIVE',
           '341', '1234', '0', '56789', '0', 'CONV00341'
         )`,
        [companyId, tenantId]
      );
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz V7B', '70400000000104')`,
        [estId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sede V7B', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo) VALUES ($1::uuid, $2::uuid, 'Arquiteto de Software', '212405')`,
        [posId, tenantId]
      );

      await client.query(
        `INSERT INTO public.workers (
           id, tenant_id, full_name, cpf, birth_date, is_active,
           bank_code, bank_agency, bank_account, bank_account_type, pix_key, pix_key_type
         ) VALUES (
           $1::uuid, $2::uuid, 'Rafael Oliveira Silva', '70400000001', '1989-07-14', TRUE,
           '341', '4321', '98765-4', 'CORRENTE', '70400000001', 'CPF'
         )`,
        [workerId, tenantId]
      );

      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, registration_number, admission_date,
           base_salary, salary_type, monthly_hours, weekly_hours, regime, status,
           calculation_regime, esocial_category_code
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, 'MAT-V7-04', '2025-01-10',
           5000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', 'CLT', '101'
         )`,
        [contractId, tenantId, companyId, estId, posId, wpId, workerId]
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
      email: 'admin.v7b@couplerh.test',
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

  it('1. Setup: Deve cadastrar pensão alimentícia, plano de saúde ANS com dependente e calcular competência 08/2026', async () => {
    const alimonyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contractId}/alimony-beneficiaries`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        beneficiary_name: 'Helena Oliveira (Pensao)',
        beneficiary_cpf: '70400000088',
        relationship: 'FILHO',
        court_process_number: '0007040-11.2026.8.26.0100',
        calculation_basis: 'NET_SALARY',
        percentage: 20,
        payment_method: 'PIX',
        pix_key_type: 'CPF',
        pix_key: '70400000088',
        apply_on_monthly: true,
        start_date: '2026-01-01',
      },
    });
    expect(alimonyRes.statusCode).toBe(201);

    const catRes = await app.inject({
      method: 'POST',
      url: '/api/v1/benefits/catalogs',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Saude V7 Top',
        code: 'SAUDE_V7',
        benefitType: 'HEALTH_PLAN',
        defaultProvider: 'Saude V7 Operadora S.A.',
        ansCode: '005711',
        providerCnpj: '70400000000205',
        discountRule: 'FIXED_VALUE',
      },
    });
    expect(catRes.statusCode).toBe(201);
    const catalogId = catRes.json().data.id;

    const benRes = await app.inject({
      method: 'POST',
      url: `/api/v1/benefits/employees/${contractId}/benefits`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        benefitCatalogId: catalogId,
        holderMonthlyCost: 500,
        holderDiscountValue: 180,
        companySubsidyAmount: 320,
        startDate: '2026-01-01',
      },
    });
    expect(benRes.statusCode).toBe(201);
    const empBenId = benRes.json().data.id;

    const depRes = await app.inject({
      method: 'POST',
      url: `/api/v1/benefits/employees/${contractId}/benefits/${empBenId}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        dependentName: 'Pedro Oliveira',
        dependentCpf: '70400000099',
        relationship: 'CHILD',
        birthDate: '2019-09-10',
        monthlyCost: 250,
        employeeDiscount: 120,
        companySubsidy: 130,
        startDate: '2026-01-01',
      },
    });
    expect(depRes.statusCode).toBe(201);

    const pRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 8, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(pRes.statusCode).toBe(201);
    periodId = pRes.json().data.id;

    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodId },
    });
    expect(calcRes.statusCode).toBe(200);
  });

  it('2. CONT-04: Deve gerar remessa CNAB 240 no servidor com empregado + pensão separada e conciliar arquivo retorno .ret', async () => {
    const genRes = await app.inject({
      method: 'POST',
      url: `/api/v1/accounting/periods/${periodId}/cnab240/generate`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        bankCode: '341',
        paymentChannel: 'MIXED',
        includeAlimony: true,
        paymentDate: '2026-09-04',
      },
    });
    expect(genRes.statusCode).toBe(201);
    const data = genRes.json().data;
    generatedRemittanceId = data.remittance.id;
    generatedCnabContent = data.remittance.file_content;

    expect(data.remittance.employees_count).toBe(1);
    expect(data.remittance.alimony_count).toBe(1);
    expect(data.items).toHaveLength(2);
    expect(data.items.some((i: any) => i.beneficiary_type === 'ALIMONY')).toBe(true);

    const lines = generatedCnabContent.split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) {
      expect(line.length).toBe(240);
    }
    const segALines = lines.filter((l) => l[7] === '3' && l[13] === 'A');
    const segBLines = lines.filter((l) => l[7] === '3' && l[13] === 'B');
    expect(segALines).toHaveLength(2);
    expect(segBLines).toHaveLength(2);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/accounting/periods/${periodId}/cnab240`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(listRes.statusCode).toBe(200);

    // Simula arquivo de retorno (.ret) alterando ocorrências nos 2 Segmentos A: 1º pago ('00'), 2º rejeitado ('AN')
    let segAIndex = 0;
    const retLines = lines.map((line) => {
      if (line[7] === '3' && line[13] === 'A') {
        const occ = segAIndex === 0 ? '00        ' : 'AN        ';
        segAIndex += 1;
        return line.slice(0, 230) + occ;
      }
      return line;
    });

    const retRes = await app.inject({
      method: 'POST',
      url: '/api/v1/accounting/cnab240/return-import',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        companyId,
        remittanceId: generatedRemittanceId,
        fileName: 'retorno_itau_082026.ret',
        content: retLines.join('\r\n'),
      },
    });
    expect(retRes.statusCode).toBe(200);
    const retData = retRes.json().data;
    expect(retData.matchedCount).toBe(2);
    expect(retData.parsed.paidCount).toBe(1);
    expect(retData.parsed.rejectedCount).toBe(1);

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows } = await client.query(`SELECT status FROM public.cnab_remittances WHERE id = $1::uuid`, [
        generatedRemittanceId,
      ]);
      expect(rows[0].status).toBe('PARTIALLY_PAID');
    });
  });

  it('3. CONT-05: Deve emitir Informe de Rendimentos Quadros 1-7 RFB, conciliar DCTFWeb/FGTS e manter guarda anti-client-side', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/accounting/income-reports/2026',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(listRes.statusCode).toBe(200);
    const workersList = listRes.json().data as any[];
    expect(workersList.some((w) => w.worker_id === workerId)).toBe(true);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/v1/accounting/income-reports/2026/workers/${workerId}`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(detailRes.statusCode).toBe(200);
    const { report, html } = detailRes.json().data;
    expect(report.quadro3Tributaveis.totalRendimentos).toBe(5000);
    expect(report.quadro3Tributaveis.pensaoAlimenticia).toBeGreaterThan(0);
    expect(report.quadro7Complementares.pensaoAlimenticiaBeneficiarios.some((p: any) => p.beneficiaryCpf === '70400000088')).toBe(true);
    expect(report.quadro7Complementares.planosSaude.some((s: any) => s.ansCode === '005711')).toBe(true);
    expect(html).toContain('COMPROVANTE DE RENDIMENTOS');
    expect(html).toContain('70400000088');
    expect(html).toContain('005711');

    // Obtém guias oficiais do servidor para conciliar contra DCTFWeb e FGTS Digital
    const guidesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodId}/tax-guides`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(guidesRes.statusCode).toBe(200);
    const guides = guidesRes.json().data;
    const dctfExpected = Number(guides.totalDarfPrevidenciario || 0);
    const fgtsExpected = Number(guides.totalFgtsDigital || guides.fgtsTotal || 0);

    const dctfMatch = await app.inject({
      method: 'POST',
      url: `/api/v1/accounting/periods/${periodId}/tax-reconciliation`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        sourceType: 'DCTFWEB',
        declaredTaxAmount: dctfExpected,
        notes: 'Batimento DCTFWeb ok',
      },
    });
    expect(dctfMatch.statusCode).toBe(200);
    expect(dctfMatch.json().data.status).toBe('MATCHED');

    const fgtsDiv = await app.inject({
      method: 'POST',
      url: `/api/v1/accounting/periods/${periodId}/tax-reconciliation`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        sourceType: 'FGTS_DIGITAL',
        declaredTaxAmount: fgtsExpected + 50,
        notes: 'Divergência simulada FGTS Digital',
      },
    });
    expect(fgtsDiv.statusCode).toBe(200);
    expect(fgtsDiv.json().data.status).toBe('DIVERGENT');

    const reconGet = await app.inject({
      method: 'GET',
      url: `/api/v1/accounting/periods/${periodId}/tax-reconciliation`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(reconGet.statusCode).toBe(200);
    const reconRows = reconGet.json().data as any[];
    expect(reconRows.find((r) => r.source_type === 'DCTFWEB')?.status).toBe('MATCHED');
    expect(reconRows.find((r) => r.source_type === 'FGTS_DIGITAL')?.status).toBe('DIVERGENT');

    // Guarda arquitetural V7: zero geração CNAB/Informe ou fallback Supabase no serviço do frontend
    const frontendObligationsPath = path.resolve(
      process.cwd(),
      '../web/src/services/payroll/payrollObligationsService.ts'
    );
    const src = fs.readFileSync(frontendObligationsPath, 'utf-8');
    expect(src).not.toMatch(/supabase|03410000|generateAnnualIncomeReport|calculateTaxGuides/);
  });
});
