import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V5 — FOLHA-09: Sindicatos e Convenções Coletivas (CCT)
 * 
 * Validações:
 * 1. CRUD de Sindicatos e Convenções Coletivas (CCT / ACT) via API REST
 * 2. Cálculo de Folha com ATS (Quinquênio) e Diferença de Piso da Categoria (Rubricas 106 e 107)
 * 3. Base de Insalubridade vinculada ao Piso da Categoria da CCT (Rubrica 302)
 * 4. Manutenção de CCT e Soft-delete em Cascata
 */
describe('FOLHA-09: Sindicatos e Convenções Coletivas (CCT, Pisos, ATS e Insalubridade)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let tokenAdmin: string;

  const tenantId = 'f5090000-0000-0000-0000-000000000001';
  const companyId = 'f5090000-0000-0000-0000-000000000011';
  const estId = 'f5090000-0000-0000-0000-000000000021';
  const posId = 'f5090000-0000-0000-0000-000000000031';
  const wpId = 'f5090000-0000-0000-0000-000000000041';
  const userId = 'f5090000-0000-0000-0000-000000000101';

  const workers = {
    w1: 'f5090000-0000-0000-0000-000000000201', // Admitido em 2021 (5 anos de casa -> Quinquênio 5%)
    w2: 'f5090000-0000-0000-0000-000000000202', // Salário R$ 3.000 abaixo do piso de R$ 3.500
  };

  const contracts = {
    c1: 'f5090000-0000-0000-0000-000000000301',
    c2: 'f5090000-0000-0000-0000-000000000302',
  };

  let periodId = '';
  let unionId = '';
  let agreementId = '';
  let rubricInsalubridadeId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Folha09Pass!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`DELETE FROM public.collective_agreements WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_fixed_events WHERE tenant_id = $1::uuid`, [tenantId]);
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
         VALUES ($1::uuid, 'admin.folha09@couplerh.test', 'Admin FOLHA 09', $2, TRUE)`,
        [userId, pwHash]
      );

      await client.query(
        `INSERT INTO public.tenants (id, name, status)
         VALUES ($1::uuid, 'Tenant FOLHA-09 Sindicatos e CCT', 'ACTIVE')`,
        [tenantId]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
         VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Empresa CCT Homologada S.A.', '89123456000189', 'LUCRO_PRESUMIDO', 'ACTIVE')`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz Central SP', '89123456000189')`,
        [estId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Sede Administrativa', 'SP', '3550308')`,
        [wpId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1::uuid, $2::uuid, 'Analista de Recursos Humanos', '252405')`,
        [posId, tenantId]
      );

      // Descobre id da rubrica 302 (Insalubridade)
      const { rows: r302 } = await client.query(
        `SELECT id FROM public.rubrics WHERE code = '302' LIMIT 1;`
      );
      if (r302.length > 0) {
        rubricInsalubridadeId = r302[0].id;
      }

      // Colaborador 1: Admitido em 01/03/2021 (5 anos de casa em 09/2026), Salário R$ 4.000,00
      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES ($1::uuid, $2::uuid, 'Carlos Silva (5 Anos ATS)', '89100000001', '1988-06-10', TRUE)`,
        [workers.w1, tenantId]
      );
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, registration_number, admission_date, base_salary, salary_type,
           monthly_hours, weekly_hours, regime, status, receives_advance
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, 'MAT-901', '2021-03-01', 4000.0, 'MONTHLY',
           220, 44, 'CLT', 'ACTIVE', FALSE
         )`,
        [contracts.c1, tenantId, companyId, estId, posId, wpId, workers.w1]
      );

      // Colaborador 2: Admitido em 01/01/2025, Salário R$ 3.000,00 (Abaixo do piso da CCT de R$ 3.500)
      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, is_active)
         VALUES ($1::uuid, $2::uuid, 'Mariana Souza (Piso CCT)', '89100000002', '1995-10-22', TRUE)`,
        [workers.w2, tenantId]
      );
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, registration_number, admission_date, base_salary, salary_type,
           monthly_hours, weekly_hours, regime, status, receives_advance
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, 'MAT-902', '2025-01-01', 3000.0, 'MONTHLY',
           220, 44, 'CLT', 'ACTIVE', FALSE
         )`,
        [contracts.c2, tenantId, companyId, estId, posId, wpId, workers.w2]
      );

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
      email: 'admin.folha09@couplerh.test',
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
      await client.query(`DELETE FROM public.collective_agreements WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_fixed_events WHERE tenant_id = $1::uuid`, [tenantId]);
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

  it('1. Deve cadastrar sindicato e convenção coletiva (CCT) via API REST', async () => {
    // 1.1 Cadastro do Sindicato Profissional
    const resUnion = await app.inject({
      method: 'POST',
      url: '/api/v1/unions',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        code: 'SIND-COM-SP',
        cnpj: '60.123.456/0001-90',
        name: 'Sindicato dos Empregados no Comércio de São Paulo',
        tradeName: 'SECSP',
        unionType: 'EMPLOYEE',
        baseMonth: 5, // Maio
        state: 'SP',
        city: 'São Paulo',
        phone: '(11) 3222-1000',
        email: 'contato@secsp.org.br',
      },
    });

    expect(resUnion.statusCode).toBe(201);
    const bodyUnion = resUnion.json();
    expect(bodyUnion.success).toBe(true);
    expect(bodyUnion.data.trade_name).toBe('SECSP');
    expect(bodyUnion.data.base_month).toBe(5);
    unionId = bodyUnion.data.id;

    // 1.2 Cadastro da Convenção Coletiva (CCT 2026/2027) vinculada ao sindicato
    const resCct = await app.inject({
      method: 'POST',
      url: `/api/v1/unions/${unionId}/agreements`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        title: 'CCT Comércio Varejista SP 2026/2027',
        agreementType: 'CCT',
        startDate: '2026-05-01',
        endDate: '2027-04-30',
        baseSalaryFloor: 2500.0, // Piso geral R$ 2.500
        floorPositions: [
          { cbo: '252405', floor: 3500.0 }, // Piso de Analista de RH: R$ 3.500
        ],
        atsType: 'QUINQUENIO',
        atsPercentagePerCycle: 5.0, // 5% a cada 5 anos
        atsMaxPercentage: 20.0,
        unhealthinessBaseType: 'CATEGORY_FLOOR', // Insalubridade calculada sobre o piso da CCT
        overtimePercentageTier1: 60.0,
        overtimePercentageTier2: 100.0,
        nightShiftPercentage: 30.0,
        postVacationStabilityDays: 30,
      },
    });

    expect(resCct.statusCode).toBe(201);
    const bodyCct = resCct.json();
    expect(bodyCct.success).toBe(true);
    expect(bodyCct.data.ats_type).toBe('QUINQUENIO');
    expect(Number(bodyCct.data.base_salary_floor)).toBe(2500.0);
    agreementId = bodyCct.data.id;

    // 1.3 Listagem global de convenções
    const resList = await app.inject({
      method: 'GET',
      url: '/api/v1/collective-agreements',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(resList.statusCode).toBe(200);
    expect(resList.json().data).toHaveLength(1);
    expect(resList.json().data[0].union_trade_name).toBe('SECSP');
  });

  it('2. Deve vincular CCT aos contratos e apurar ATS Quinquênio (rubrica 106) e Piso da Categoria (rubrica 107)', async () => {
    // 2.1 Vincula CCT aos dois contratos de teste
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      await client.query(
        `UPDATE public.contracts
         SET union_id = $1::uuid, collective_agreement_id = $2::uuid
         WHERE id IN ($3::uuid, $4::uuid);`,
        [unionId, agreementId, contracts.c1, contracts.c2]
      );
    });

    // 2.2 Cria período 09/2026
    const pRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 9, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(pRes.statusCode).toBe(201);
    periodId = pRes.json().data.id;

    // 2.3 Calcula a folha
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodId },
    });
    expect(calcRes.statusCode).toBe(200);

    // 2.4 Verifica holerite do Contrato 1: Quinquênio (5% de R$ 4.000 = R$ 200,00 na rubrica 106)
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips1 } = await client.query(
        `SELECT ps.*,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '106'), 0) AS ats_quinquenio,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '107'), 0) AS dif_piso
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
        [tenantId, periodId, contracts.c1]
      );
      expect(slips1).toHaveLength(1);
      // Admitido em 01/03/2021 -> 5 anos completos em 09/2026 -> 1 Quinquênio (5% de R$ 4.000,00 = R$ 200,00)
      expect(Number(slips1[0].ats_quinquenio)).toBe(200.0);
      // Salário R$ 4.000 > piso R$ 3.500 -> sem diferença de piso
      expect(Number(slips1[0].dif_piso)).toBe(0.0);
    });

    // 2.5 Verifica holerite do Contrato 2: Diferença de Piso CCT (Piso CBO R$ 3.500 - Salário R$ 3.000 = R$ 500,00 na rubrica 107)
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips2 } = await client.query(
        `SELECT ps.*,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '106'), 0) AS ats_quinquenio,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '107'), 0) AS dif_piso
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
        [tenantId, periodId, contracts.c2]
      );
      expect(slips2).toHaveLength(1);
      // Admitido em 2025 -> 0 quinquênios -> R$ 0,00
      expect(Number(slips2[0].ats_quinquenio)).toBe(0.0);
      // Salário R$ 3.000 < Piso CBO 252405 (R$ 3.500) -> Diferença apurada: R$ 500,00
      expect(Number(slips2[0].dif_piso)).toBe(500.0);
    });
  });

  it('3. Deve calcular insalubridade sobre a base da CCT (Piso da Categoria R$ 2.500 em vez do Salário Mínimo)', async () => {
    // 3.1 Adiciona evento fixo de insalubridade (rubrica 302 a 20%) para o Contrato 1
    if (rubricInsalubridadeId) {
      await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
        await client.query(
          `INSERT INTO public.payroll_fixed_events (
             id, tenant_id, contract_id, rubric_id, value_type, percentage, is_active
           ) VALUES (
             gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'PERCENT', 20.0, TRUE
           );`,
          [tenantId, contracts.c1, rubricInsalubridadeId]
        );
      });

      // 3.2 Recalcula a folha de 09/2026
      const calcRes = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/calculate',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
        payload: { period_id: periodId },
      });
      expect(calcRes.statusCode).toBe(200);

      // 3.3 Verifica se a insalubridade foi calculada sobre o piso da categoria da CCT (20% de R$ 2.500 = R$ 500,00)
      await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
        const { rows: slips1 } = await client.query(
          `SELECT ps.*,
                  COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '302'), 0) AS valor_insalubridade
           FROM public.payslips ps
           WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid AND ps.contract_id = $3::uuid;`,
          [tenantId, periodId, contracts.c1]
        );
        expect(slips1).toHaveLength(1);
        // CCT define unhealthiness_base_type = 'CATEGORY_FLOOR' (piso geral R$ 2.500,00)
        // 20% de R$ 2.500,00 = exatamente R$ 500,00 (não os R$ 324,20 do salário mínimo)
        expect(Number(slips1[0].valor_insalubridade)).toBe(500.0);
      });
    }
  });

  it('4. Deve atualizar CCT e realizar soft-delete com cascata nos acordos vinculados', async () => {
    // 4.1 Atualiza parâmetros da CCT via PUT
    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/unions/agreements/${agreementId}`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        title: 'CCT Comércio Varejista SP 2026/2027 (Aditivo Homologado)',
        overtimePercentageTier1: 70.0, // Ampliado para 70%
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().data.title).toContain('Aditivo Homologado');
    expect(Number(putRes.json().data.overtime_percentage_tier1)).toBe(70.0);

    // 4.2 Exclui o sindicato (soft-delete)
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/unions/${unionId}`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(delRes.statusCode).toBe(200);

    // 4.3 Confere que a CCT também foi inativada/soft-deleted
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/unions/agreements/${agreementId}`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(getRes.statusCode).toBe(404);
  });
});
