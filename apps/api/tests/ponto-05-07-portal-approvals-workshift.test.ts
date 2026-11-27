import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { withTenantContext } from '../src/shared/db/context.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';

/**
 * FASE V8 — PONTO-05, PONTO-06 e PONTO-07 (Integração API + PostgreSQL Real)
 *
 * Validações E2E:
 * 1. PONTO-05: Portal 2.0 (`/portal/time-bank` sem auto-débito, `/portal/timesheet` multi-mês + aceite,
 *    `/portal/schedule` 12x36, `/portal/benefits`, `get_my_lgpd_dossier` com `positions.title`/`base_salary`,
 *    e `/portal/justifications` com upload privado de atestado médico).
 * 2. PONTO-06: Workflow Multinível (`/api/v1/approvals`) com isolamento de equipe (`can_access_contract`),
 *    ocultação obrigatória de `cid10_code` para o Gestor, pré-aprovação Gestor e homologação DP (só então debita saldo).
 * 3. PONTO-07: HE Noturna OJ 97 (rubrica 108), Sobreaviso 1/3 (rubrica 124) e Prontidão 2/3 (rubrica 125)
 *    recalculados e integrados na folha sem `manual_value`.
 */
describe('PONTO-05 a 07: Portal 2.0, Aprovações Multinível (Sigilo CID) e Jornada Avançada', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;
  let tokenManagerA: string;
  let tokenEmpA: string;
  let tokenEmpB: string;

  const tenantId = 'f8050000-0000-0000-0000-000000000001';
  const companyId = 'f8050000-0000-0000-0000-000000000011';
  const estId = 'f8050000-0000-0000-0000-000000000021';
  const posId = 'f8050000-0000-0000-0000-000000000031';
  const wpId = 'f8050000-0000-0000-0000-000000000041';
  const depAId = 'f8050000-0000-0000-0000-000000000051';
  const depBId = 'f8050000-0000-0000-0000-000000000052';
  const shift12x36Id = 'f8050000-0000-0000-0000-000000000061';
  const catHealthId = 'f8050000-0000-0000-0000-000000000071';

  const runSuffix = crypto.randomBytes(4).toString('hex');
  const adminUserId = crypto.randomUUID();
  const managerUserId = crypto.randomUUID();
  const empAUserId = crypto.randomUUID();
  const empBUserId = crypto.randomUUID();

  const workerManagerId = crypto.randomUUID();
  const workerAId = crypto.randomUUID();
  const workerBId = crypto.randomUUID();

  const contractAId = crypto.randomUUID();
  const contractBId = crypto.randomUUID();

  let dayOffAdjId = '';
  let medAdjAId = '';
  let medAdjBId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Ponto0507!2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(
        `INSERT INTO public.tenants (id, name, status) VALUES ($1::uuid, 'Tenant V8 Portal & Aprovacoes', 'ACTIVE')
         ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';`,
        [tenantId]
      );
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Hospital & Servicos V8 S.A.', '80500000000105', 'LUCRO_REAL', 'ACTIVE')
         ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';`,
        [companyId, tenantId]
      );
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz V8B', '80500000000105')
         ON CONFLICT (id) DO NOTHING;`,
        [estId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.workplaces (id, tenant_id, company_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Unidade Hospitalar V8')
         ON CONFLICT (id) DO NOTHING;`,
        [wpId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1::uuid, $2::uuid, 'Tecnico de Enfermagem', '322205')
         ON CONFLICT (id) DO NOTHING;`,
        [posId, tenantId]
      );
      await client.query(
        `INSERT INTO public.departments (id, tenant_id, company_id, name) VALUES
           ($1::uuid, $3::uuid, $4::uuid, 'UTI Norte (Equipe A)'),
           ($2::uuid, $3::uuid, $4::uuid, 'Pronto Atendimento (Equipe B)')
         ON CONFLICT (id) DO NOTHING;`,
        [depAId, depBId, tenantId, companyId]
      );
      await client.query(
        `INSERT INTO public.work_shifts (id, tenant_id, name, shift_type, weekly_hours, rotation_anchor_date, night_start_hour, night_end_hour, night_extended_prorrogation)
         VALUES ($1::uuid, $2::uuid, 'Plantao 12x36 Noturno', 'ROTATING_12X36', 36, '2026-10-01', 22, 5, TRUE)
         ON CONFLICT (id) DO UPDATE SET shift_type = 'ROTATING_12X36', rotation_anchor_date = '2026-10-01';`,
        [shift12x36Id, tenantId]
      );
      await client.query(
        `INSERT INTO public.benefit_catalogs (id, tenant_id, name, code, benefit_type, default_provider, ans_code)
         VALUES ($1::uuid, $2::uuid, 'Plano Saude Enfermagem', 'SAUDE_V8', 'HEALTH_PLAN', 'Unimed V8', '339679')
         ON CONFLICT (id) DO NOTHING;`,
        [catHealthId, tenantId]
      );

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active) VALUES
           ($1::uuid, $5, 'DP Admin V8', $9, TRUE),
           ($2::uuid, $6, 'Gestora Equipe A', $9, TRUE),
           ($3::uuid, $7, 'Colaborador A', $9, TRUE),
           ($4::uuid, $8, 'Colaborador B', $9, TRUE);`,
        [
          adminUserId,
          managerUserId,
          empAUserId,
          empBUserId,
          `dp.v8.${runSuffix}@couplerh.test`,
          `mgr.v8.${runSuffix}@couplerh.test`,
          `empa.v8.${runSuffix}@couplerh.test`,
          `empb.v8.${runSuffix}@couplerh.test`,
          pwHash,
        ]
      );

      await client.query(
        `INSERT INTO public.workers (id, tenant_id, user_id, full_name, cpf, birth_date, is_active) VALUES
           ($1::uuid, $4::uuid, $5::uuid, 'Helena Gestora A', $8, '1985-04-10', TRUE),
           ($2::uuid, $4::uuid, $6::uuid, 'Lucas Plantonista A', $9, '1992-08-15', TRUE),
           ($3::uuid, $4::uuid, $7::uuid, 'Bruno Outro Setor B', $10, '1994-12-01', TRUE);`,
        [
          workerManagerId,
          workerAId,
          workerBId,
          tenantId,
          managerUserId,
          empAUserId,
          empBUserId,
          `8051${String(Math.floor(Math.random() * 9000000 + 1000000))}`,
          `8052${String(Math.floor(Math.random() * 9000000 + 1000000))}`,
          `8053${String(Math.floor(Math.random() * 9000000 + 1000000))}`,
        ]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, worker_id, scope_mode, is_active) VALUES
           ($1::uuid, $2::uuid, 'system_admin', NULL, 'ALL', TRUE),
           ($1::uuid, $3::uuid, 'manager', $6::uuid, 'OWN_TEAM', TRUE),
           ($1::uuid, $4::uuid, 'employee', $7::uuid, 'SELF_ONLY', TRUE),
           ($1::uuid, $5::uuid, 'employee', $8::uuid, 'SELF_ONLY', TRUE);`,
        [tenantId, adminUserId, managerUserId, empAUserId, empBUserId, workerManagerId, workerAId, workerBId]
      );

      // Contrato A pertence à equipe da Gestora A; Contrato B pertence a outra gerência
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, company_id, establishment_id, department_id, position_id, workplace_id,
           worker_id, manager_worker_id, registration_number, admission_date, base_salary, salary_type,
           monthly_hours, weekly_hours, regime, status
         ) VALUES
           ($1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $8::uuid, $9::uuid, $10::uuid, $12::uuid, $13, '2025-01-01', 4400.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE'),
           ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $7::uuid, $8::uuid, $9::uuid, $11::uuid, NULL, $14, '2025-01-01', 3500.00, 'MONTHLY', 220, 44, 'CLT', 'ACTIVE');`,
        [
          contractAId,
          contractBId,
          tenantId,
          companyId,
          estId,
          depAId,
          depBId,
          posId,
          wpId,
          workerAId,
          workerBId,
          workerManagerId,
          `MAT-805A-${runSuffix}`,
          `MAT-805B-${runSuffix}`,
        ]
      );

      await client.query(
        `INSERT INTO public.contract_work_shifts (tenant_id, contract_id, work_shift_id, valid_from)
         VALUES ($1::uuid, $2::uuid, $3::uuid, '2025-01-01');`,
        [tenantId, contractAId, shift12x36Id]
      );

      await client.query(
        `INSERT INTO public.time_bank_accounts (tenant_id, company_id, contract_id, balance_minutes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 600);`,
        [tenantId, companyId, contractAId]
      );

      await client.query(
        `INSERT INTO public.employee_benefits (tenant_id, contract_id, benefit_catalog_id, holder_discount_value, start_date, is_active)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 185.00, '2025-01-01', TRUE);`,
        [tenantId, contractAId, catHealthId]
      );

      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }

    const [sAdm, sMgr, sEA, sEB] = await Promise.all([
      tokenService.createSession({ userId: adminUserId, tenantId, role: 'system_admin', aal: 'aal2' }),
      tokenService.createSession({ userId: managerUserId, tenantId, role: 'manager', workerId: workerManagerId }),
      tokenService.createSession({ userId: empAUserId, tenantId, role: 'employee', workerId: workerAId }),
      tokenService.createSession({ userId: empBUserId, tenantId, role: 'employee', workerId: workerBId }),
    ]);

    tokenAdmin = sAdm.accessToken;
    tokenManagerA = sMgr.accessToken;
    tokenEmpA = sEA.accessToken;
    tokenEmpB = sEB.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. PONTO-05: Portal 2.0 deve consultar banco (sem auto-débito), escala 12x36, benefícios, dossiê LGPD corrigido e atestado privado', async () => {
    const tbRes = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/time-bank',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
    });
    expect(tbRes.statusCode).toBe(200);
    expect(tbRes.json().data.account.balance_minutes).toBe(600);

    // Solicita folga de 240 min (4h): NÃO pode debitar saldo imediatamente!
    const dayOffRes = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/time-bank/request-day-off',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
      payload: { workDate: '2026-10-20', requestedMinutes: 240, justification: 'Consulta odontológica programada' },
    });
    expect(dayOffRes.statusCode).toBe(201);
    expect(dayOffRes.json().data.status).toBe('PENDING_MANAGER');
    dayOffAdjId = dayOffRes.json().data.id;

    const tbAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/time-bank',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
    });
    expect(tbAfter.json().data.account.balance_minutes).toBe(600);

    // Espelho multi-mês + aceite
    const tsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/timesheet?year=2026&month=10',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
    });
    expect(tsRes.statusCode).toBe(200);

    const signRes = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/timesheet/sign',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
      payload: { year: 2026, month: 10 },
    });
    expect(signRes.statusCode).toBe(200);
    expect(signRes.json().data.status).toBe('SIGNED_EMPLOYEE');

    // Escala rotativa 12x36
    const schedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/schedule?year=2026&month=10',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
    });
    expect(schedRes.statusCode).toBe(200);
    expect(schedRes.json().data.days).toHaveLength(31);
    expect(schedRes.json().data.days[0].isWorkDay).toBe(true);
    expect(schedRes.json().data.days[1].isWorkDay).toBe(false);

    // Benefícios do colaborador
    const benRes = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/benefits',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
    });
    expect(benRes.statusCode).toBe(200);
    expect(benRes.json().data).toHaveLength(1);
    expect(benRes.json().data[0].ans_code).toBe('339679');

    // Dossiê LGPD corrigido (positions.title e contracts.base_salary sem erro SQL)
    const dossierRes = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/lgpd/dossier',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
    });
    expect(dossierRes.statusCode).toBe(200);
    const dossier = dossierRes.json().data;
    expect(dossier.contratos[0].cargo).toBe('Tecnico de Enfermagem');
    expect(Number(dossier.contratos[0].salario_base)).toBe(4400);

    // Envio de atestado médico privado (Equipes A e B)
    const fakePdf = Buffer.from('%PDF-1.4 Atestado Medico Teste').toString('base64');
    const medARes = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/justifications',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
      payload: {
        adjustmentType: 'MEDICAL_CERTIFICATE',
        workDate: '2026-10-18',
        endDate: '2026-10-18',
        justification: 'Repouso médico 24h',
        cid10Code: 'J06.9',
        doctorCrm: 'CRM-SP 123456',
        fileName: 'atestado_a.pdf',
        mimeType: 'application/pdf',
        fileBase64: fakePdf,
      },
    });
    expect(medARes.statusCode).toBe(201);
    expect(medARes.json().data.attachment_file_id).toBeTruthy();
    medAdjAId = medARes.json().data.id;

    const medBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/justifications',
      headers: { Authorization: `Bearer ${tokenEmpB}` },
      payload: {
        adjustmentType: 'MEDICAL_CERTIFICATE',
        workDate: '2026-10-18',
        justification: 'Atestado outro setor B',
        cid10Code: 'M54.5',
      },
    });
    expect(medBRes.statusCode).toBe(201);
    medAdjBId = medBRes.json().data.id;
  });

  it('2. PONTO-06: Gestor deve ver apenas própria equipe, ter CID-10 oculto e DP homologar debitando saldo só na etapa final', async () => {
    const mgrQueue = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: { Authorization: `Bearer ${tokenManagerA}` },
    });
    expect(mgrQueue.statusCode).toBe(200);
    const mgrData = mgrQueue.json().data;
    expect(mgrData.canViewMedicalCid).toBe(false);
    expect(mgrData.timeAdjustments.some((x: any) => x.id === medAdjAId)).toBe(true);
    expect(mgrData.timeAdjustments.some((x: any) => x.id === medAdjBId)).toBe(false); // Isolamento estrito de equipe

    const medAForMgr = mgrData.timeAdjustments.find((x: any) => x.id === medAdjAId);
    expect(medAForMgr.cid10_code).toBeNull();
    expect(medAForMgr.cid_masked).toBe(true);
    expect(medAForMgr.attachment_signed_url).toContain('signature=');

    // Gestor tentando aprovar item da Equipe B recebe 403 ou 404 (can_access_contract bloqueia)
    const crossTeamDecision = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/time-adjustment/${medAdjBId}/manager-decision`,
      headers: { Authorization: `Bearer ${tokenManagerA}` },
      payload: { decision: 'APPROVE' },
    });
    expect([403, 404]).toContain(crossTeamDecision.statusCode);

    // Gestor pré-aprova folga e atestado do Colaborador A
    const mgrApp1 = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/time-adjustment/${dayOffAdjId}/manager-decision`,
      headers: { Authorization: `Bearer ${tokenManagerA}` },
      payload: { decision: 'APPROVE', notes: 'Escala coberta' },
    });
    expect(mgrApp1.statusCode).toBe(200);
    expect(mgrApp1.json().data.status).toBe('APPROVED_MANAGER');

    const mgrApp2 = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/time-adjustment/${medAdjAId}/manager-decision`,
      headers: { Authorization: `Bearer ${tokenManagerA}` },
      payload: { decision: 'APPROVE' },
    });
    expect(mgrApp2.statusCode).toBe(200);

    // Saldo continua intacto até homologação final do DP
    const tbMid = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/time-bank',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
    });
    expect(tbMid.json().data.account.balance_minutes).toBe(600);

    // DP (system_admin) homologa ambos -> debita 240 min e marca dia como LEAVE
    const dpQueue = await app.inject({
      method: 'GET',
      url: '/api/v1/approvals/pending',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    expect(dpQueue.statusCode).toBe(200);
    expect(dpQueue.json().data.canViewMedicalCid).toBe(true);
    expect(dpQueue.json().data.timeAdjustments.find((x: any) => x.id === medAdjAId)?.cid10_code).toBe('J06.9');

    const dpApp1 = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/time-adjustment/${dayOffAdjId}/dp-decision`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { decision: 'APPROVE' },
    });
    expect(dpApp1.statusCode).toBe(200);
    expect(dpApp1.json().data.status).toBe('APPROVED_DP');

    const dpApp2 = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/time-adjustment/${medAdjAId}/dp-decision`,
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { decision: 'APPROVE' },
    });
    expect(dpApp2.statusCode).toBe(200);

    const tbFinal = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/time-bank',
      headers: { Authorization: `Bearer ${tokenEmpA}` },
    });
    expect(tbFinal.json().data.account.balance_minutes).toBe(360); // 600 - 240 debitado na homologação DP!
  });

  it('3. PONTO-07: Deve recalcular HE Noturna OJ 97 + Sobreaviso + Prontidão, integrar na folha e manter guarda anti-Supabase', async () => {
    // Registra jornada noturna estendida (18h->22h e 23h->05h) via offline sync no Colaborador B (salário 3500)
    const syncNight = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/punch/sync-offline',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        punches: [
          { workerId: workerBId, punchType: 'ENTRY', deviceTimestamp: '2026-10-15T18:00:00.000Z', clientUuid: crypto.randomUUID() },
          { workerId: workerBId, punchType: 'INTERVAL_START', deviceTimestamp: '2026-10-15T22:00:00.000Z', clientUuid: crypto.randomUUID() },
          { workerId: workerBId, punchType: 'INTERVAL_END', deviceTimestamp: '2026-10-15T23:00:00.000Z', clientUuid: crypto.randomUUID() },
          { workerId: workerBId, punchType: 'EXIT', deviceTimestamp: '2026-10-16T05:00:00.000Z', clientUuid: crypto.randomUUID() },
        ],
      },
    });
    expect(syncNight.statusCode).toBe(200);
    expect(syncNight.json().data.syncedCount).toBe(4);

    const recalcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/daily-summary/recalculate',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: {
        contractId: contractBId,
        workDate: '2026-10-15',
        standbyMinutes: 180,
        readinessMinutes: 60,
      },
    });
    expect(recalcRes.statusCode).toBe(200);
    const rec = recalcRes.json().data.record;
    expect(Number(rec.night_overtime_50_hours)).toBeGreaterThan(0);
    expect(Number(rec.standby_hours)).toBe(3);
    expect(Number(rec.readiness_hours)).toBe(1);

    const pRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/periods',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { company_id: companyId, month: 10, year: 2026, type: 'MONTHLY', irrf_regime: 'COMPETENCE' },
    });
    expect(pRes.statusCode).toBe(201);
    const periodId = pRes.json().data.id;

    const intRes = await app.inject({
      method: 'POST',
      url: '/api/v1/time-tracking/integrate-payroll',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      payload: { periodId, year: 2026, month: 10, contractId: contractBId },
    });
    expect(intRes.statusCode).toBe(200);
    expect(intRes.json().data.eventsInserted).toBeGreaterThanOrEqual(3);

    await withTenantContext({ tenantId, role: 'system_admin' }, async (client) => {
      const { rows } = await client.query(
        `SELECT r.code, pve.quantity, pve.manual_value
         FROM public.payroll_variable_events pve
         JOIN public.rubrics r ON r.id = pve.rubric_id
         WHERE pve.payroll_period_id = $1::uuid AND pve.contract_id = $2::uuid`,
        [periodId, contractBId]
      );
      expect(rows.some((x: any) => x.code === '108' && x.manual_value === null)).toBe(true);
      expect(rows.some((x: any) => x.code === '124' && Number(x.quantity) === 3 && x.manual_value === null)).toBe(true);
      expect(rows.some((x: any) => x.code === '125' && Number(x.quantity) === 1 && x.manual_value === null)).toBe(true);
    });

    // Guarda estática V8: zero `supabase` nos modais migrados do Portal 2.0
    const timeBankModalSrc = fs.readFileSync(
      path.resolve(process.cwd(), '../web/src/components/timeTracking/TimeBankModal.tsx'),
      'utf-8'
    );
    const timesheetModalSrc = fs.readFileSync(
      path.resolve(process.cwd(), '../web/src/components/timeTracking/TimesheetViewModal.tsx'),
      'utf-8'
    );
    const lgpdModalSrc = fs.readFileSync(
      path.resolve(process.cwd(), '../web/src/components/security/LgpdPrivacyModal.tsx'),
      'utf-8'
    );
    expect(timeBankModalSrc).not.toMatch(/supabase/);
    expect(timesheetModalSrc).not.toMatch(/supabase/);
    expect(lgpdModalSrc).not.toMatch(/supabase/);
  });
});
