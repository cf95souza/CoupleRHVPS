import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V5 — FOLHA-05: Salário-Família Automático + Dedução DCTFWeb
 * Valida elegibilidade por remuneração bruta INSS <= teto, filhos <= 14 ou inválidos,
 * comprovantes de vacina (<=6a) e frequência escolar (7..14a), proporcionalidade na
 * admissão/demissão, rubrica 305 isenta de tributos e abatimento automático na DCTFWeb.
 */
describe('FOLHA-05: Salário-Família Automático + Dedução DCTFWeb', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let tokenAdmin: string;

  const tenantId = 'f5050000-0000-0000-0000-000000000001';
  const companyId = 'f5050000-0000-0000-0000-000000000011';
  const estId = 'f5050000-0000-0000-0000-000000000021';
  const posId = 'f5050000-0000-0000-0000-000000000031';
  const wpId = 'f5050000-0000-0000-0000-000000000041';
  const userId = 'f5050000-0000-0000-0000-000000000101';

  const workers = {
    fullEligible: 'f5050000-0000-0000-0000-000000000201',
    overWithHe: 'f5050000-0000-0000-0000-000000000202',
    admittedMid: 'f5050000-0000-0000-0000-000000000203',
    pendingVacc: 'f5050000-0000-0000-0000-000000000204',
  };

  const contracts = {
    fullEligible: 'f5050000-0000-0000-0000-000000000301',
    overWithHe: 'f5050000-0000-0000-0000-000000000302',
    admittedMid: 'f5050000-0000-0000-0000-000000000303',
    pendingVacc: 'f5050000-0000-0000-0000-000000000304',
  };

  let periodId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Folha05Pass!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid`, [userId]);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active)
         VALUES ($1::uuid, 'admin.folha05@couplerh.test', 'Admin FOLHA 05', $2, TRUE)`,
        [userId, pwHash]
      );

      await client.query(
        `INSERT INTO public.tenants (id, name, status)
         VALUES ($1::uuid, 'Empresa Teste FOLHA-05 Ltda', 'ACTIVE')`,
        [tenantId]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1::uuid, $2::uuid, 'system_admin', 'ALL', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status, labor_config)
         VALUES ($1::uuid, $2::uuid, 'Empresa FOLHA-05 S.A.', '11555666000188', 'LUCRO_PRESUMIDO', 'ACTIVE',
         '{"rat_aliquot": 2.0, "fap_multiplier": 1.0, "terceiros_aliquot": 5.8}'::jsonb)`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz F5', '11555666000188')`,
        [estId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1::uuid, $2::uuid, 'Auxiliar Operacional', '411005')`,
        [posId, tenantId]
      );

      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Unidade Centro', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );

      const workerList = [
        { id: workers.fullEligible, name: 'Ana Salario Familia', cpf: '51111111111', email: 'ana@f505.test' },
        { id: workers.overWithHe, name: 'Bruno Estourou Teto HE', cpf: '52222222222', email: 'bruno@f505.test' },
        { id: workers.admittedMid, name: 'Carla Admitida Dia 17', cpf: '53333333333', email: 'carla@f505.test' },
        { id: workers.pendingVacc, name: 'Diego Sem Vacina', cpf: '54444444444', email: 'diego@f505.test' },
      ];

      for (const w of workerList) {
        await client.query(
          `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, email)
           VALUES ($1::uuid, $2::uuid, $3, $4, '1992-04-12', $5)`,
          [w.id, tenantId, w.name, w.cpf, w.email]
        );
      }

      const contractList = [
        { id: contracts.fullEligible, wid: workers.fullEligible, reg: 'SF-001', sal: 1600.0, adm: '2024-02-01' },
        { id: contracts.overWithHe, wid: workers.overWithHe, reg: 'SF-002', sal: 1700.0, adm: '2024-02-01' },
        { id: contracts.admittedMid, wid: workers.admittedMid, reg: 'SF-003', sal: 1750.0, adm: '2026-05-17' },
        { id: contracts.pendingVacc, wid: workers.pendingVacc, reg: 'SF-004', sal: 1650.0, adm: '2024-02-01' },
      ];

      for (const c of contractList) {
        await client.query(
          `INSERT INTO public.contracts (
             id, tenant_id, company_id, establishment_id, position_id, workplace_id,
             worker_id, registration_number, admission_date, base_salary, salary_type,
             monthly_hours, weekly_hours, regime, status, receives_advance
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
             $7::uuid, $8, $9::date, $10, 'MONTHLY',
             220, 44, 'CLT', 'ACTIVE', FALSE
           )`,
          [c.id, tenantId, companyId, estId, posId, wpId, c.wid, c.reg, c.adm, c.sal]
        );
      }

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
      email: 'admin.folha05@couplerh.test',
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

  it('cadastra e gerencia dependentes com vacina/escola via REST e aplica regras de Salário-Família + DCTFWeb na folha', async () => {
    // 1. Cadastra 4 dependentes para fullEligible (apenas 3 elegíveis: 4a vacinado, 11a escola, 22a inválido; 16a rejeitado)
    const d1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.fullEligible}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Lucas Silva',
        relationship: 'FILHO',
        birth_date: '2022-03-10',
        is_irrf_dependent: false,
        is_family_salary: true,
        vaccination_card_date: '2026-01-15',
      },
    });
    expect(d1Res.statusCode).toBe(201);

    const d2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.fullEligible}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Mariana Silva',
        relationship: 'FILHO',
        birth_date: '2015-04-01',
        is_irrf_dependent: true,
        is_family_salary: true,
        school_frequency_date: '2026-03-01',
      },
    });
    expect(d2Res.statusCode).toBe(201);

    const d3Res = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.fullEligible}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Pedro Silva (Invalido)',
        relationship: 'FILHO',
        birth_date: '2004-02-01',
        is_irrf_dependent: true,
        is_family_salary: true,
        is_incapacitated: true,
      },
    });
    expect(d3Res.statusCode).toBe(201);

    const d4Res = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.fullEligible}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Rafael Silva (16 anos)',
        relationship: 'FILHO',
        birth_date: '2010-01-10',
        is_irrf_dependent: true,
        is_family_salary: true,
      },
    });
    expect(d4Res.statusCode).toBe(201);

    // Lista e verifica PUT
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contracts.fullEligible}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().data.length).toBe(4);

    // Dependente para overWithHe (vacina em dia, mas terá HE)
    await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.overWithHe}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Beto Filho',
        relationship: 'FILHO',
        birth_date: '2021-05-01',
        is_irrf_dependent: false,
        is_family_salary: true,
        vaccination_card_date: '2026-02-01',
      },
    });

    // Dependente para admittedMid (admissão dia 17/05 -> 15/31 dias)
    await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.admittedMid}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Clara Filha',
        relationship: 'FILHO',
        birth_date: '2022-07-10',
        is_irrf_dependent: false,
        is_family_salary: true,
        vaccination_card_date: '2026-01-20',
      },
    });

    // Dependente sem vacina para pendingVacc -> bloqueado + alerta na pré-auditoria
    await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.pendingVacc}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        name: 'Daniel Sem Vacina',
        relationship: 'FILHO',
        birth_date: '2022-08-15',
        is_irrf_dependent: false,
        is_family_salary: true,
        vaccination_card_date: null,
      },
    });

    // 2. Cria competência Mensal 05/2026 e lança 30h de HE 50% para overWithHe (elevando bruto INSS > 1819.26)
    const createPeriodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        company_id: companyId,
        month: 5,
        year: 2026,
        type: 'MONTHLY',
        irrf_regime: 'COMPETENCE',
      },
    });
    expect(createPeriodRes.statusCode).toBe(201);
    periodId = createPeriodRes.json().data.id;

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      await client.query(
        `INSERT INTO public.payroll_variable_events (
           tenant_id, payroll_period_id, contract_id, rubric_id, quantity, origin
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'a0000000-0000-0000-0000-000000000102'::uuid, 30, 'MANUAL'
         )`,
        [tenantId, periodId, contracts.overWithHe]
      );
    });

    // 3. Pré-auditoria detecta pendência de vacina para Diego Sem Vacina
    const preAuditRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodId}/pre-flight-audit`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(preAuditRes.statusCode).toBe(200);
    const preAudit = preAuditRes.json().data;
    expect(preAudit.familyAllowanceAlertsCount).toBe(1);
    expect(preAudit.familyAllowanceAlerts[0].reason_code).toBe('VACCINATION_MISSING');

    // 4. Calcula folha mensal
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodId },
    });
    expect(calcRes.statusCode).toBe(200);
    expect(calcRes.json().success).toBe(true);

    // 5. Confere itens e bases de cada holerite no PostgreSQL
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips } = await client.query(
        `SELECT ps.id, ps.contract_id, ps.total_earnings, ps.base_inss, ps.base_fgts,
                COALESCE((SELECT pi.amount FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '305'), 0) AS sf_amount
         FROM public.payslips ps
         WHERE ps.payroll_period_id = $1::uuid;`,
        [periodId]
      );

      const slipMap = new Map<string, any>(slips.map((s) => [s.contract_id, s]));

      // Ana: 3 cotas = 186.12, sem incidir em INSS/FGTS (bases = 1600.00)
      const sAna = slipMap.get(contracts.fullEligible);
      expect(Number(sAna.sf_amount)).toBe(186.12);
      expect(Number(sAna.base_inss)).toBe(1600.0);
      expect(Number(sAna.base_fgts)).toBe(1600.0);

      // Bruno: com HE passou de 1819.26 -> Salário-Família = 0
      const sBruno = slipMap.get(contracts.overWithHe);
      expect(Number(sBruno.base_inss)).toBeGreaterThan(1819.26);
      expect(Number(sBruno.sf_amount)).toBe(0);

      // Carla: admitida em 17/05/2026 (15/31 dias) -> 62.04 * 15 / 31 = 30.02
      const sCarla = slipMap.get(contracts.admittedMid);
      expect(Number(sCarla.sf_amount)).toBe(30.02);

      // Diego: sem comprovante de vacina -> Salário-Família = 0
      const sDiego = slipMap.get(contracts.pendingVacc);
      expect(Number(sDiego.sf_amount)).toBe(0);

      // Encargos patronais DCTFWeb devem refletir 186.12 + 30.02 = 216.14
      const { rows: taxRows } = await client.query(
        `SELECT * FROM public.payroll_company_taxes WHERE payroll_period_id = $1::uuid;`,
        [periodId]
      );
      expect(taxRows.length).toBe(1);
      expect(Number(taxRows[0].family_salary_deduction)).toBe(216.14);
    });

    // 6. Guia DCTFWeb retornada pela API aplica abatimento líquido do Salário-Família
    const guidesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodId}/tax-guides`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(guidesRes.statusCode).toBe(200);
    const guides = guidesRes.json().data;
    expect(guides.familySalaryDeduction).toBe(216.14);
    expect(guides.totalDarfPrevidenciario).toBe(
      Math.max(
        0,
        Number(
          (
            guides.totalDarfPrevidenciarioBruto -
            guides.maternityDeduction -
            guides.familySalaryDeduction
          ).toFixed(2)
        )
      )
    );

    // 7. Verifica proporcionalidade na rescisão (/api/v1/termination/calculate)
    const termRes = await app.inject({
      method: 'POST',
      url: '/api/v1/termination/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contracts.fullEligible,
        resignationDate: '2026-05-15',
        dismissalType: 'WITHOUT_CAUSE',
        noticeType: 'INDEMNIFIED',
      },
    });
    expect(termRes.statusCode).toBe(200);
    const termData = termRes.json().data;
    // 3 dependentes elegíveis * 62.04 * (15 / 31) = 90.06
    expect(termData.proventos.salarioFamilia.dependentes).toBe(3);
    expect(termData.proventos.salarioFamilia.proporcaoDias).toBe(15);
    expect(termData.proventos.salarioFamilia.totalDiasMes).toBe(31);
    expect(termData.proventos.salarioFamilia.valor).toBe(90.06);
  });

  it('suporta recálculo individual preservando dedução DCTFWeb dos demais holerites e remoção de dependente', async () => {
    const listBefore = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contracts.fullEligible}/dependents`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const pedro = listBefore.json().data.find((d: any) => String(d.name).includes('Pedro'));
    expect(pedro).toBeTruthy();

    // Remove Pedro (de 3 cotas passa para 2 cotas)
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/employees/${contracts.fullEligible}/dependents/${pedro.id}`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(delRes.statusCode).toBe(200);

    // Recalcula apenas o contrato de Ana (contract_id filter)
    const recalcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        period_id: periodId,
        contract_id: contracts.fullEligible,
      },
    });
    expect(recalcRes.statusCode).toBe(200);

    // Verifica que DCTFWeb preservou Carla (30.02) + Ana atualizada (2 * 62.04 = 124.08) = 154.10
    const guidesAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/payroll/periods/${periodId}/tax-guides`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(guidesAfter.statusCode).toBe(200);
    expect(guidesAfter.json().data.familySalaryDeduction).toBe(154.1);
  });
});
