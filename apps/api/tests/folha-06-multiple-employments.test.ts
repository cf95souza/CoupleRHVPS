import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V5 — FOLHA-06: Múltiplos Vínculos (INSS Outro Empregador — indMV 1/2/3)
 * Valida CRUD employee_other_employments, indMV 1/2/3 no motor e persistência em payslips,
 * além de consolidação automática de múltiplas matrículas do mesmo CPF na mesma empresa e
 * entre empresas diferentes do grupo econômico até o teto INSS 2026 (R$ 8.157,41 -> máx R$ 951,63).
 */
describe('FOLHA-06: Múltiplos Vínculos (INSS Outro Empregador — indMV 1/2/3)', () => {
  let app: FastifyInstance;
  let tokenService: TokenService;
  let tokenAdmin: string;

  const tenantId = 'f5060000-0000-0000-0000-000000000001';
  const companyAId = 'f5060000-0000-0000-0000-000000000011';
  const companyBId = 'f5060000-0000-0000-0000-000000000012';
  const estAId = 'f5060000-0000-0000-0000-000000000021';
  const estBId = 'f5060000-0000-0000-0000-000000000022';
  const posId = 'f5060000-0000-0000-0000-000000000031';
  const wpAId = 'f5060000-0000-0000-0000-000000000041';
  const wpBId = 'f5060000-0000-0000-0000-000000000042';
  const userId = 'f5060000-0000-0000-0000-000000000101';

  const workers = {
    extMv1: 'f5060000-0000-0000-0000-000000000201',
    extMv2: 'f5060000-0000-0000-0000-000000000202',
    extMv3: 'f5060000-0000-0000-0000-000000000203',
    multiCpfA: 'f5060000-0000-0000-0000-000000000204',
  };

  const contracts = {
    extMv1: 'f5060000-0000-0000-0000-000000000301',
    extMv2: 'f5060000-0000-0000-0000-000000000302',
    extMv3: 'f5060000-0000-0000-0000-000000000303',
    groupMat1A: 'f5060000-0000-0000-0000-000000000304',
    groupMat2A: 'f5060000-0000-0000-0000-000000000305',
    groupMat3B: 'f5060000-0000-0000-0000-000000000306',
  };

  let periodAId = '';
  let periodBId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Folha06Pass!2026');

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
         VALUES ($1::uuid, 'admin.folha06@couplerh.test', 'Admin FOLHA 06', $2, TRUE)`,
        [userId, pwHash]
      );

      await client.query(
        `INSERT INTO public.tenants (id, name, status)
         VALUES ($1::uuid, 'Grupo Economico FOLHA-06', 'ACTIVE')`,
        [tenantId]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, scope_mode, is_active)
         VALUES ($1::uuid, $2::uuid, 'system_admin', 'ALL', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES
           ($1::uuid, $3::uuid, 'Empresa Alfa Grupo F6', '61111111000161', 'LUCRO_PRESUMIDO', 'ACTIVE'),
           ($2::uuid, $3::uuid, 'Empresa Beta Grupo F6', '62222222000162', 'LUCRO_PRESUMIDO', 'ACTIVE')`,
        [companyAId, companyBId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES
           ($1::uuid, $3::uuid, $4::uuid, 'Matriz Alfa', '61111111000161'),
           ($2::uuid, $3::uuid, $5::uuid, 'Matriz Beta', '62222222000162')`,
        [estAId, estBId, tenantId, companyAId, companyBId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1::uuid, $2::uuid, 'Especialista', '252105')`,
        [posId, tenantId]
      );

      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name, state_code, city_code)
         VALUES
           ($1::uuid, $3::uuid, $4::uuid, 'Unidade Alfa', 'SP', '3550308'),
           ($2::uuid, $3::uuid, $5::uuid, 'Unidade Beta', 'SP', '3550308')`,
        [wpAId, wpBId, tenantId, companyAId, companyBId]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, full_name, cpf, birth_date, email)
         VALUES
           ($1::uuid, $5::uuid, 'Medico indMV 1', '61000000001', '1985-03-10', 'mv1@f506.test'),
           ($2::uuid, $5::uuid, 'Professor indMV 2', '62000000002', '1987-06-15', 'mv2@f506.test'),
           ($3::uuid, $5::uuid, 'Diretora indMV 3', '63000000003', '1982-09-20', 'mv3@f506.test'),
           ($4::uuid, $5::uuid, 'Engenheiro Grupo Multi-Matricula', '64000000004', '1989-11-05', 'grp@f506.test')`,
        [workers.extMv1, workers.extMv2, workers.extMv3, workers.multiCpfA, tenantId]
      );

      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, position_id, workplace_id,
           worker_id, registration_number, admission_date, base_salary, salary_type,
           monthly_hours, weekly_hours, regime, status, receives_advance
         ) VALUES
           ($1::uuid, $7::uuid, $8::uuid, $10::uuid, $12::uuid, $13::uuid, $15::uuid, 'MV-01', '2024-01-10', 5000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', FALSE),
           ($2::uuid, $7::uuid, $8::uuid, $10::uuid, $12::uuid, $13::uuid, $16::uuid, 'MV-02', '2024-01-10', 2500.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', FALSE),
           ($3::uuid, $7::uuid, $8::uuid, $10::uuid, $12::uuid, $13::uuid, $17::uuid, 'MV-03', '2024-01-10', 4000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', FALSE),
           ($4::uuid, $7::uuid, $8::uuid, $10::uuid, $12::uuid, $13::uuid, $18::uuid, 'GRP-01', '2023-05-01', 4000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', FALSE),
           ($5::uuid, $7::uuid, $8::uuid, $10::uuid, $12::uuid, $13::uuid, $18::uuid, 'GRP-02', '2024-02-01', 3000.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', FALSE),
           ($6::uuid, $7::uuid, $9::uuid, $11::uuid, $12::uuid, $14::uuid, $18::uuid, 'GRP-03', '2025-01-10', 3500.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE', FALSE)`,
        [
          contracts.extMv1,
          contracts.extMv2,
          contracts.extMv3,
          contracts.groupMat1A,
          contracts.groupMat2A,
          contracts.groupMat3B,
          tenantId,
          companyAId,
          companyBId,
          estAId,
          estBId,
          posId,
          wpAId,
          wpBId,
          workers.extMv1,
          workers.extMv2,
          workers.extMv3,
          workers.multiCpfA,
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
      email: 'admin.folha06@couplerh.test',
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

  it('cadastra vínculos externos (indMV 1/2/3), consolida múltiplas matrículas do mesmo CPF na mesma folha e entre empresas até o teto 2026', async () => {
    // 1. CRUD em /other-employments para MV-01, MV-02, MV-03
    const c1 = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.extMv1}/other-employments`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        employer_cnpj: '11.222.333/0001-81',
        employer_name: 'Hospital Externo Alpha',
        esocial_category_code: '101',
        ind_mv: 1,
        competence_year: 2026,
        competence_month: 6,
        remuneration_amount: 5000.0,
      },
    });
    expect(c1.statusCode).toBe(201);

    // Duplicidade CNPJ/competência deve retornar 409
    const dup = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.extMv1}/other-employments`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        employer_cnpj: '11.222.333/0001-81',
        employer_name: 'Hospital Externo Alpha',
        ind_mv: 1,
        competence_year: 2026,
        competence_month: 6,
        remuneration_amount: 5000.0,
      },
    });
    expect(dup.statusCode).toBe(409);

    const c2 = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.extMv2}/other-employments`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        employer_cnpj: '22.333.444/0001-99',
        employer_name: 'Colégio Externo Beta',
        ind_mv: 2,
        competence_year: 2026,
        competence_month: 6,
        remuneration_amount: 3500.0,
        inss_withheld: 316.0,
      },
    });
    expect(c2.statusCode).toBe(201);

    const c3 = await app.inject({
      method: 'POST',
      url: `/api/v1/employees/${contracts.extMv3}/other-employments`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        employer_cnpj: '33.444.555/0001-00',
        employer_name: 'Banco Centralizado Ltda',
        ind_mv: 3,
        competence_year: 2026,
        competence_month: 6,
        remuneration_amount: 9500.0,
        inss_withheld: 951.63,
      },
    });
    expect(c3.statusCode).toBe(201);

    // Verifica listagem de contratos no grupo econômico para o Engenheiro (3 matrículas no mesmo CPF)
    const grpList = await app.inject({
      method: 'GET',
      url: `/api/v1/employees/${contracts.groupMat1A}/other-employments`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(grpList.statusCode).toBe(200);
    expect(grpList.json().data.groupContracts.length).toBe(3);

    // 2. Cria e calcula Folha 06/2026 da Empresa Alfa (contendo extMv1, extMv2, extMv3, groupMat1A=4000, groupMat2A=3000)
    const pARes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyAId, month: 6, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(pARes.statusCode).toBe(201);
    periodAId = pARes.json().data.id;

    const calcARes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodAId },
    });
    expect(calcARes.statusCode).toBe(200);

    // 3. Cria e calcula Folha 06/2026 da Empresa Beta (contendo groupMat3B=3500 do mesmo CPF do Engenheiro -> deve consolidar 4000 + 3000 = 7000 anteriores e só reter saldo até 8157,41!)
    const pBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyBId, month: 6, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(pBRes.statusCode).toBe(201);
    periodBId = pBRes.json().data.id;

    const calcBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { period_id: periodBId },
    });
    expect(calcBRes.statusCode).toBe(200);

    // 4. Confere todos os valores persistidos no PostgreSQL
    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows: slips } = await client.query(
        `SELECT ps.contract_id, ps.base_inss, ps.base_fgts, ps.fgts_month,
                ps.ind_mv, ps.other_employments_base, ps.other_employments_inss,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '901'), 0) AS inss_retido
         FROM public.payslips ps
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id IN ($2::uuid, $3::uuid);`,
        [tenantId, periodAId, periodBId]
      );

      const slipByContract = new Map<string, any>(slips.map((s) => [s.contract_id, s]));

      // MV-01 (indMV = 1): 5000 externo + 5000 atual -> INSS(8157.41) - INSS(5000) = 951.63 - 509.60 = 442.03
      const sMv1 = slipByContract.get(contracts.extMv1);
      expect(sMv1).toBeDefined();
      expect(Number(sMv1.ind_mv)).toBe(1);
      expect(Number(sMv1.other_employments_base)).toBe(5000.0);
      expect(Number(sMv1.inss_retido)).toBe(442.03);

      // MV-02 (indMV = 2): 3500 externo (retido 316) + 2500 atual = 6000 -> INSS(6000) 649.60 - 316.00 = 333.60
      const sMv2 = slipByContract.get(contracts.extMv2);
      expect(sMv2).toBeDefined();
      expect(Number(sMv2.ind_mv)).toBe(2);
      expect(Number(sMv2.other_employments_inss)).toBe(316.0);
      expect(Number(sMv2.inss_retido)).toBe(333.6);

      // MV-03 (indMV = 3): teto atingido fora -> INSS segurado = 0, mas base INSS patronal (4000) e FGTS (320) mantidos!
      const sMv3 = slipByContract.get(contracts.extMv3);
      expect(sMv3).toBeDefined();
      expect(Number(sMv3.ind_mv)).toBe(3);
      expect(Number(sMv3.inss_retido)).toBe(0);
      expect(Number(sMv3.base_inss)).toBe(4000.0);
      expect(Number(sMv3.base_fgts)).toBe(4000.0);
      expect(Number(sMv3.fgts_month)).toBe(320.0);

      // Grupo Econômico mesmo CPF (4000 + 3000 na Empresa Alfa + 3500 na Empresa Beta = 10500 > 8157.41)
      // A soma do INSS retido nas 3 matrículas do Engenheiro deve fechar EXATAMENTE R$ 951,63 (teto 2026)!
      const sG1 = slipByContract.get(contracts.groupMat1A);
      const sG2 = slipByContract.get(contracts.groupMat2A);
      const sG3 = slipByContract.get(contracts.groupMat3B);
      expect(sG1).toBeDefined();
      expect(sG2).toBeDefined();
      expect(sG3).toBeDefined();
      const totalGroupInss = Number(
        (Number(sG1.inss_retido) + Number(sG2.inss_retido) + Number(sG3.inss_retido)).toFixed(2)
      );
      expect(totalGroupInss).toBe(951.63);
      expect(Number(sG2.ind_mv)).toBe(1);
      expect(Number(sG3.ind_mv)).toBe(1);
      expect(Number(sG3.other_employments_base)).toBe(7000.0); // 4000 + 3000 anteriores
    });
  });
});
