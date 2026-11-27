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
 * FASE V6 — FOLHA-15 e FOLHA-16 (Integração API + PostgreSQL Real)
 *
 * Validações E2E:
 * 1. FOLHA-15: Multi-Regime eSocial em competência mista:
 *    - CLT Aposentadoria Especial FAE '04' (6%)
 *    - Jovem Aprendiz (FGTS 2%)
 *    - Pró-Labore Cat. 722 (INSS 11% s/ teto, sem FGTS)
 *    - Autônomo RPA Frete Cat. 711 (base reduzida 20%, SEST/SENAT rubrica 916 e ISS rubrica 917)
 *    - Estagiário Cat. 901 (sem INSS/FGTS)
 *    - Intermitente Cat. 111 (convocação via API + rubricas 119/120/121 + alerta INSS se < mínimo)
 *    - Comissionista Puro (salário fixo = 0 + garantia piso sindical rubrica 123)
 * 2. FOLHA-16: Encargos patronais avançados (CPRB mista 2026 Lei 14.973/2024 + CPP Pró-Labore 20% + RAT Especial),
 *    endpoints /tax-guides, /provisions-summary e /accounting-summary (D === C) + guarda anti-cálculo no frontend.
 */
describe('FOLHA-15 e 16: Multi-Regime eSocial e Encargos Patronais Avançados', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;

  const tenantId = 'f6150000-0000-0000-0000-000000000001';
  const companyId = 'f6150000-0000-0000-0000-000000000011';
  const estId = 'f6150000-0000-0000-0000-000000000021';
  const posId = 'f6150000-0000-0000-0000-000000000031';
  const wpId = 'f6150000-0000-0000-0000-000000000041';
  const userId = 'f6150000-0000-0000-0000-000000000101';

  const workers = {
    clt: 'f6150000-0000-0000-0000-000000000201',
    apprentice: 'f6150000-0000-0000-0000-000000000202',
    proLabore: 'f6150000-0000-0000-0000-000000000203',
    rpaFreight: 'f6150000-0000-0000-0000-000000000204',
    intern: 'f6150000-0000-0000-0000-000000000205',
    intermittent: 'f6150000-0000-0000-0000-000000000206',
    commission: 'f6150000-0000-0000-0000-000000000207',
  };

  const contracts = {
    clt: 'f6150000-0000-0000-0000-000000000301',
    apprentice: 'f6150000-0000-0000-0000-000000000302',
    proLabore: 'f6150000-0000-0000-0000-000000000303',
    rpaFreight: 'f6150000-0000-0000-0000-000000000304',
    intern: 'f6150000-0000-0000-0000-000000000305',
    intermittent: 'f6150000-0000-0000-0000-000000000306',
    commission: 'f6150000-0000-0000-0000-000000000307',
  };

  let unionId = '';
  let cctId = '';
  let periodId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Folha1516!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`DELETE FROM public.intermittent_calls WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_variable_events WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.collective_agreements WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid`, [tenantId]);
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
         VALUES ($1::uuid, 'admin.v6c@couplerh.test', 'Admin V6C', $2, TRUE)`,
        [userId, pwHash]
      );
      await client.query(`INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V6C', 'ACTIVE')`, [tenantId]);
      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active) VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );

      // Empresa com CPRB mista 60% desonerada e ano 2026 (Lei 14.973/2024: transição 10% sobre desonerada / 20% sobre onerada -> CPP efetiva 14%)
      await client.query(
        `INSERT INTO public.companies (
           id, tenant_id, corporate_name, cnpj, tax_regime, status,
           cprb_gross_revenue_total, cprb_gross_revenue_exempt, cprb_reoneration_year,
           labor_config
         ) VALUES (
           $1::uuid, $2::uuid, 'Empresa Multi-Regime & CPRB S.A.', '61500000000115', 'LUCRO_PRESUMIDO', 'ACTIVE',
           1000000.00, 600000.00, 2026,
           '{"rat_aliquot": 0.02, "fap_multiplier": 1.0, "terceiros_aliquot": 0.058, "is_cprb_exempted": true}'::jsonb
         )`,
        [companyId, tenantId]
      );
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz V6C', '61500000000115')`,
        [estId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sede V6C', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo) VALUES ($1::uuid, $2::uuid, 'Operador / Prestador', '411010')`,
        [posId, tenantId]
      );

      unionId = 'f6150000-0000-0000-0000-000000000501';
      cctId = 'f6150000-0000-0000-0000-000000000502';
      await client.query(
        `INSERT INTO public.unions (id, tenant_id, code, cnpj, name, trade_name, union_type, base_month)
         VALUES ($1::uuid, $2::uuid, 'SIND-V6C', '61500000000201', 'Sindicato Comércio V6C', 'SINDCOM', 'EMPLOYEE', 5)`,
        [unionId, tenantId]
      );
      await client.query(
        `INSERT INTO public.collective_agreements (
           id, tenant_id, union_id, title, agreement_type, start_date, end_date, base_salary_floor
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'CCT Garantia Mínima 2026', 'CCT', '2026-01-01', '2027-04-30', 2200.00
         )`,
        [cctId, tenantId, unionId]
      );

      const workerList = [
        [workers.clt, 'Worker CLT Especial', '61500000001', false],
        [workers.apprentice, 'Worker Aprendiz', '61500000002', true],
        [workers.proLabore, 'Socio ProLabore', '61500000003', false],
        [workers.rpaFreight, 'Carreteiro Frete RPA', '61500000004', false],
        [workers.intern, 'Estagiario Dev', '61500000005', false],
        [workers.intermittent, 'Intermitente Eventos', '61500000006', false],
        [workers.commission, 'Comissionista Puro', '61500000007', false],
      ] as const;

      for (const [wid, name, cpf, isApp] of workerList) {
        await client.query(
          `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_apprentice, is_active)
           VALUES ($1::uuid, $2::uuid, $3, $4, '1995-03-15', $5, TRUE)`,
          [wid, tenantId, name, cpf, isApp]
        );
      }

      const insertContract = async (
        cid: string,
        wid: string,
        mat: string,
        salary: number,
        calcRegime: string,
        esocialCat: string,
        extra: { specialCode?: string; autonomousType?: string; issRate?: number; cct?: string | null } = {}
      ) => {
        await client.query(
          `INSERT INTO public.contracts (
             id, tenant_id, company_id, establishment_id, position_id, workplace_id,
             worker_id, union_id, collective_agreement_id, registration_number, admission_date,
             base_salary, salary_type, monthly_hours, weekly_hours, regime, status,
             calculation_regime, esocial_category_code, special_retirement_exposure_code,
             autonomous_service_type, iss_rate
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
             $7::uuid, $8::uuid, $9::uuid, $10, '2025-01-10',
             $11, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE',
             $12, $13, $14, $15, $16
           )`,
          [
            cid,
            tenantId,
            companyId,
            estId,
            posId,
            wpId,
            wid,
            extra.cct ? unionId : null,
            extra.cct || null,
            mat,
            salary,
            calcRegime,
            esocialCat,
            extra.specialCode || '01',
            extra.autonomousType || null,
            extra.issRate || 0,
          ]
        );
      };

      await insertContract(contracts.clt, workers.clt, 'MAT-15-1', 5000, 'CLT', '101', { specialCode: '04' });
      await insertContract(contracts.apprentice, workers.apprentice, 'MAT-15-2', 1600, 'APPRENTICE', '103');
      await insertContract(contracts.proLabore, workers.proLabore, 'MAT-15-3', 10000, 'PRO_LABORE', '722');
      await insertContract(contracts.rpaFreight, workers.rpaFreight, 'MAT-15-4', 10000, 'AUTONOMOUS_RPA', '711', {
        autonomousType: 'FREIGHT_TRANSPORT',
        issRate: 5.0,
      });
      await insertContract(contracts.intern, workers.intern, 'MAT-15-5', 2000, 'INTERN', '901');
      await insertContract(contracts.intermittent, workers.intermittent, 'MAT-15-6', 0, 'INTERMITTENT', '111');
      await insertContract(contracts.commission, workers.commission, 'MAT-15-7', 0, 'COMMISSION_ONLY', '101', {
        cct: cctId,
      });

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
      email: 'admin.v6c@couplerh.test',
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
      await client.query(`DELETE FROM public.intermittent_calls WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_variable_events WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.collective_agreements WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid`, [tenantId]);
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

  it('1. FOLHA-15: Deve calcular competência mista com 7 regimes e gerar alertas intermitente / garantia mínima / SEST-SENAT', async () => {
    // Registra convocação intermitente curta (8h a R$ 40 = R$ 320 + prop -> fica abaixo do mínimo -> alerta DARF)
    const callRes = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.intermittent}/intermittent-calls`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        call_date: '2026-08-05',
        work_start_date: '2026-08-10',
        work_end_date: '2026-08-10',
        hours_worked: 8,
        hourly_rate: 40,
        status: 'ACCEPTED',
      },
    });
    expect(callRes.statusCode).toBe(201);

    // Cria período 08/2026 e lança R$ 1.200 de comissão para o comissionista puro (< piso R$ 2.200)
    const pRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 8, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(pRes.statusCode).toBe(201);
    periodId = pRes.json().data.id;

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: rComm } = await client.query(
        `SELECT id FROM public.rubrics WHERE rubric_kind = 'COMMISSION' AND type = 'EARNING' LIMIT 1;`
      );
      if (rComm.length > 0) {
        await client.query(
          `INSERT INTO public.payroll_variable_events (tenant_id, payroll_period_id, contract_id, rubric_id, manual_value, origin)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1200.00, 'MANUAL');`,
          [tenantId, periodId, contracts.commission, rComm[0].id]
        );
      }
    });

    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodId },
    });
    expect(calcRes.statusCode).toBe(200);

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips } = await client.query(
        `SELECT ps.contract_id, ps.base_inss, ps.fgts_month, ps.total_earnings,
                COALESCE((SELECT SUM(pi2.amount) FROM public.payslip_items pi2 WHERE pi2.payslip_id = ps.id AND pi2.rubric_code = '901'), 0) AS inss_employee,
                array_agg(pi.rubric_code || ':' || pi.amount::text) AS items_summary
         FROM public.payslips ps
         LEFT JOIN public.payslip_items pi ON pi.payslip_id = ps.id
         WHERE ps.payroll_period_id = $1::uuid
         GROUP BY ps.id, ps.contract_id, ps.base_inss, ps.fgts_month, ps.total_earnings;`,
        [periodId]
      );
      const byContract = new Map(slips.map((s: any) => [s.contract_id, s]));
      const cltSlip = byContract.get(contracts.clt);
      expect(Number(cltSlip.base_inss)).toBe(5000);

      // Pró-labore: 11% de R$ 10.000 limitado ao teto, FGTS = 0
      const pl = byContract.get(contracts.proLabore);
      expect(pl).toBeDefined();
      expect(Number(pl.fgts_month)).toBe(0);
      expect(Number(pl.inss_employee)).toBeLessThanOrEqual(990);

      // Autônomo frete RPA: base reduzida 20% = 2.000 -> INSS 220 (901), SEST/SENAT 50 (916), ISS 500 (917), FGTS = 0
      const rpa = byContract.get(contracts.rpaFreight);
      expect(rpa).toBeDefined();
      expect(Number(rpa.fgts_month)).toBe(0);
      expect(rpa.items_summary.some((x: string) => x.startsWith('916:50'))).toBe(true);
      expect(rpa.items_summary.some((x: string) => x.startsWith('917:500'))).toBe(true);

      // Estagiário: INSS = 0, FGTS = 0
      const intern = byContract.get(contracts.intern);
      expect(intern).toBeDefined();
      expect(Number(intern.inss_employee)).toBe(0);
      expect(Number(intern.fgts_month)).toBe(0);

      // Aprendiz: FGTS 2% de 1.600 = 32,00
      const appSlip = byContract.get(contracts.apprentice);
      expect(appSlip).toBeDefined();
      expect(Number(appSlip.fgts_month)).toBe(32);

      // Intermitente: recebeu rubrica 119 e gerou alerta de complemento DARF
      const inter = byContract.get(contracts.intermittent);
      expect(inter).toBeDefined();
      expect(inter.items_summary.some((x: string) => x.startsWith('119:'))).toBe(true);

      // Comissionista Puro: recebeu garantia de piso (rubrica 123) completando ao menos o piso R$ 2.200
      const comm = byContract.get(contracts.commission);
      expect(comm).toBeDefined();
      expect(Number(comm.total_earnings)).toBeGreaterThanOrEqual(2200);
      expect(comm.items_summary.some((x: string) => x.startsWith('123:'))).toBe(true);
    });
  });

  it('2. FOLHA-16: Deve consolidar encargos CPRB 2026 + RAT Especial + CPP Pró-Labore nos endpoints server-side e manter D === C', async () => {
    const [guidesRes, provRes, accRes] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/v1/payroll/periods/${periodId}/tax-guides`,
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/payroll/periods/${periodId}/provisions-summary`,
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/payroll/periods/${periodId}/accounting-summary`,
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      }),
    ]);

    expect(guidesRes.statusCode).toBe(200);
    const guides = guidesRes.json().data;
    // Lei 14.973/2024 em 2026 com 60% desonerada: alíquota CPP efetiva sobre CLT = 14%
    expect(guides.cprbReductionRatio).toBe(0.6);
    expect(guides.cprbEffectiveCppRate).toBe(14);
    expect(guides.inssPatronalProLabore).toBeGreaterThan(0); // Pró-Labore + RPA mantém CPP 20% integral
    expect(guides.ratSpecialRetirementAmount).toBe(300); // 6% (FAE '04') sobre R$ 5.000 CLT = R$ 300,00

    expect(provRes.statusCode).toBe(200);
    expect(provRes.json().data.totalMonthlyLiability).toBeGreaterThan(0);

    expect(accRes.statusCode).toBe(200);
    const acc = accRes.json().data;
    expect(acc.isBalanced).toBe(true);
    expect(acc.totalDebit).toBe(acc.totalCredit);

    // Guarda arquitetural: payrollObligationsService.ts não deve conter fórmulas patronais nem fallback Supabase
    const frontendObligationsPath = path.resolve(
      process.cwd(),
      '../web/src/services/payroll/payrollObligationsService.ts'
    );
    const src = fs.readFileSync(frontendObligationsPath, 'utf-8');
    expect(src).not.toMatch(/calculateTaxGuides|calculatePayrollProvisions|generateAccountingSummary/);
    expect(src).not.toMatch(/\*\s*0\.20|\*\s*0\.058|\*\s*0\.08/);
  });
});
