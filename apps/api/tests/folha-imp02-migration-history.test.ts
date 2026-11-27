import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { withTenantContext } from '../src/shared/db/context.js';

/**
 * FASE V9.5 — IMP-02: Motor de Carga Inicial & Importação de Histórico de Folha Externa
 *
 * 1. Download dos Modelos Oficiais de Importação com UTF-8 BOM para Excel PT-BR
 * 2. Dry-Run / Prévia com Validação Contábil (Proventos - Descontos = Líquido -> R$ 0,00)
 * 3. Commit Atômico Idempotente (Gravação de Períodos CLOSED, Holerites, Itens e IRRF Caixa)
 * 4. Validação de Virada: Motor de 13º calcula a 1ª Parcela com médias lidas do histórico importado!
 */
describe('IMP-02: Motor de Carga Inicial & Importação de Histórico de Folha Externa', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;

  const tenantId = 'e9200000-0000-0000-0000-000000000001';
  const companyId = 'e9200000-0000-0000-0000-000000000011';
  const estId = 'e9200000-0000-0000-0000-000000000021';
  const posId = 'e9200000-0000-0000-0000-000000000031';
  const deptId = 'e9200000-0000-0000-0000-000000000051';
  const userId = 'e9200000-0000-0000-0000-000000000101';
  const unionId = 'e9200000-0000-0000-0000-000000000501';
  const cctId = 'e9200000-0000-0000-0000-000000000502';

  const testWorkerCpf = '12398745601';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Imp02!Migracao2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`UPDATE public.payroll_periods SET status = 'OPEN' WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.irrf_cash_ledger WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.payslip_items WHERE payslip_id IN (SELECT id FROM public.payslips WHERE tenant_id = $1::uuid);`, [tenantId]);
      await client.query(`DELETE FROM public.payslips WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_periods WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.contracts WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.collective_agreements WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.unions WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.departments WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.workers WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.establishments WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.positions WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.companies WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.tenant_users WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.tenants WHERE id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.users WHERE id = $1::uuid;`, [userId]);

      await client.query(
        `INSERT INTO public.users (id, email, full_name, password_hash, is_active)
         VALUES ($1::uuid, 'admin.imp02@couplerh.test', 'Admin IMP-02', $2, TRUE)`,
        [userId, pwHash]
      );

      await client.query(
        `INSERT INTO public.tenants (id, name, status)
         VALUES ($1::uuid, 'Tenant IMP-02 Implantação', 'ACTIVE')`,
        [tenantId]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
         VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Empresa Migração LTDA', '12345678000190', 'LUCRO_PRESUMIDO', 'ACTIVE')`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz IMP-02', '12345678000190')`,
        [estId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1::uuid, $2::uuid, 'Analista de Operações', '252105')`,
        [posId, tenantId]
      );

      await client.query(
        `INSERT INTO public.departments (id, tenant_id, company_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Operações')`,
        [deptId, tenantId, companyId]
      );

      await client.query(
        `INSERT INTO public.unions (id, tenant_id, code, cnpj, name, trade_name, union_type, base_month)
         VALUES ($1::uuid, $2::uuid, 'SINDOPS', '11222333000144', 'Sindicato de Operações', 'SINDOPS', 'EMPLOYEE', 5)`,
        [unionId, tenantId]
      );

      await client.query(
        `INSERT INTO public.collective_agreements (
           id, tenant_id, union_id, title, agreement_type, start_date, end_date,
           average_calculation_months, average_window_mode, average_monetary_index_rate,
           include_averages_in_13th_first_installment
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'CCT Operações 2026', 'CCT', '2026-01-01', '2026-12-31',
           12, 'CALENDAR_YEAR', 0, TRUE
         )`,
        [cctId, tenantId, unionId]
      );

      await client.query('COMMIT;');
    } catch (e) {
      await client.query('ROLLBACK;');
      throw e;
    } finally {
      client.release();
    }

    const auth = await tokenService.createSession({
      userId,
      tenantId,
      role: 'system_admin',
      email: 'admin.imp02@couplerh.test',
      aal: 'aal2',
    });
    tokenAdmin = auth.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Central de Download: deve listar modelos e disponibilizar download de CSV com UTF-8 BOM', async () => {
    // 1.1 Listagem de modelos
    const resList = await app.inject({
      method: 'GET',
      url: '/api/v1/migration/templates',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(resList.statusCode).toBe(200);
    const bodyList = resList.json();
    expect(bodyList.success).toBe(true);
    expect(Array.isArray(bodyList.templates)).toBe(true);
    expect(bodyList.templates.length).toBe(7);

    const keys = bodyList.templates.map((t: any) => t.key);
    expect(keys).toContain('colaboradores_contratos');
    expect(keys).toContain('historico_folha');
    expect(keys).toContain('saldos_ferias');
    expect(keys).toContain('afastamentos');
    expect(keys).toContain('banco_horas');
    expect(keys).toContain('consignados_debitos');
    expect(keys).toContain('guia_rh');

    // 1.2 Download do template de histórico de folha com UTF-8 BOM
    const resDownload = await app.inject({
      method: 'GET',
      url: '/api/v1/migration/templates/historico_folha',
      headers: { authorization: `Bearer ${tokenAdmin}` },
    });

    expect(resDownload.statusCode).toBe(200);
    expect(resDownload.headers['content-type']).toContain('text/csv');
    expect(resDownload.headers['content-disposition']).toContain('02_historico_folha_2026_ficha_financeira.csv');

    const rawBuffer = resDownload.rawPayload;
    // Verifica os 3 primeiros bytes do Byte Order Mark UTF-8: 0xEF, 0xBB, 0xBF
    expect(rawBuffer[0]).toBe(0xef);
    expect(rawBuffer[1]).toBe(0xbb);
    expect(rawBuffer[2]).toBe(0xbf);

    const textContent = rawBuffer.toString('utf8');
    expect(textContent).toContain('cpf_colaborador;matricula;nome_colaborador');
    expect(textContent).toContain('Salario Base Contratual');
  });

  it('2. Dry-Run / Prévia: deve validar dados de entrada e conferir reconciliação contábil (Diferença R$ 0,00)', async () => {
    // CSV de colaborador
    const rawWorkersCsv = `cnpj_empresa;cnpj_filial;cpf_colaborador;pis_pasep;matricula;nome_completo;data_nascimento;data_admissao;departamento;centro_custo;cargo;cbo;regime_calculo;categoria_esocial;tipo_salario;salario_base;horas_mensais_divisor;horas_semanais;recebe_adiantamento;percentual_adiantamento;banco_codigo;agencia;conta;tipo_conta;chave_pix;qtd_dependentes_irrf;qtd_dependentes_sal_familia;email;telefone;observacao
12345678000190;12345678000190;${testWorkerCpf};12345678901;MAT-990;Carlos Eduardo Santos;1988-06-15;2024-01-10;Operações;CC-010;Analista de Operações;252105;CLT;101;MONTHLY;4000.00;220;44;SIM;40;341;1234;56789-0;CHECKING;${testWorkerCpf};1;0;carlos.santos@empresa.com;11999990001;Colaborador de teste`;

    // CSV de Histórico Jan a Out/2026 (10 competências):
    // Cada mês: Salário Base (4.000,00) + 12h de HE 50% (327.27) + DSR (65.45) - INSS (415.80) - Desconto VT (240.00)
    // Líquido = 4.392,72 - 655,80 = 3.736,92
    let rawHistoryCsv = `cpf_colaborador;matricula;nome_colaborador;ano_competencia;mes_competencia;tipo_folha;data_pagamento;codigo_rubrica_legado;codigo_rubrica_couplerh;descricao_rubrica;tipo_evento;unidade_referencia;quantidade_referencia;valor_reais;base_inss_holerite;base_irrf_holerite;base_fgts_holerite;observacao\n`;

    for (let mes = 1; mes <= 10; mes++) {
      const dtPgto = `2026-${String(mes + 1).padStart(2, '0')}-05`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0001;101;Salario Base;EARNING;DIAS;30.00;4000.00;4392.72;4392.72;4392.72;Salario do mes\n`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0150;102;Horas Extras 50%;EARNING;HORAS;12.00;327.27;4392.72;4392.72;4392.72;HE 50%\n`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0170;401;DSR s/ Horas Extras;EARNING;VALOR;1.00;65.45;4392.72;4392.72;4392.72;DSR\n`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0901;901;INSS;DEDUCTION;VALOR;1.00;415.80;4392.72;4392.72;4392.72;INSS\n`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0905;905;Vale Transporte;DEDUCTION;VALOR;1.00;240.00;4392.72;4392.72;4392.72;VT\n`;
    }

    const resPreview = await app.inject({
      method: 'POST',
      url: '/api/v1/migration/preview',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        rawWorkersCsv,
        rawHistoryCsv,
      },
    });

    expect(resPreview.statusCode).toBe(200);
    const bodyPreview = resPreview.json();
    expect(bodyPreview.success).toBe(true);
    const preview = bodyPreview.preview;

    expect(preview.valid).toBe(true);
    expect(preview.totalWorkers).toBe(1);
    expect(preview.totalPeriods).toBe(10);
    expect(preview.totalOvertimeHours).toBe(120.0); // 12h * 10 meses = 120h
    expect(preview.totalAbsenceDays).toBe(0);

    // Reconciliação Contábil rigorosa: Proventos - Descontos = Líquido (Diferença ZERO)
    expect(preview.reconciliationDiff).toBe(0.0);
    expect(preview.totalEarnings).toBe(43927.2); // 4.392,72 * 10
    expect(preview.totalDeductions).toBe(6558.0); // 655,80 * 10
    expect(preview.totalNet).toBe(37369.2); // 3.736,92 * 10
  });

  it('3. Commit Atômico: deve persistir períodos fechados, holerites, itens com horas e irrf_cash_ledger', async () => {
    const rawWorkersCsv = `cnpj_empresa;cnpj_filial;cpf_colaborador;pis_pasep;matricula;nome_completo;data_nascimento;data_admissao;departamento;centro_custo;cargo;cbo;regime_calculo;categoria_esocial;tipo_salario;salario_base;horas_mensais_divisor;horas_semanais;recebe_adiantamento;percentual_adiantamento;banco_codigo;agencia;conta;tipo_conta;chave_pix;qtd_dependentes_irrf;qtd_dependentes_sal_familia;email;telefone;observacao
12345678000190;12345678000190;${testWorkerCpf};12345678901;MAT-990;Carlos Eduardo Santos;1988-06-15;2024-01-10;Operações;CC-010;Analista de Operações;252105;CLT;101;MONTHLY;4000.00;220;44;SIM;40;341;1234;56789-0;CHECKING;${testWorkerCpf};1;0;carlos.santos@empresa.com;11999990001;Importacao Oficial`;

    let rawHistoryCsv = `cpf_colaborador;matricula;nome_colaborador;ano_competencia;mes_competencia;tipo_folha;data_pagamento;codigo_rubrica_legado;codigo_rubrica_couplerh;descricao_rubrica;tipo_evento;unidade_referencia;quantidade_referencia;valor_reais;base_inss_holerite;base_irrf_holerite;base_fgts_holerite;observacao\n`;

    for (let mes = 1; mes <= 10; mes++) {
      const dtPgto = `2026-${String(mes + 1).padStart(2, '0')}-05`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0001;101;Salario Base;EARNING;DIAS;30.00;4000.00;4392.72;4392.72;4392.72;Salario\n`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0150;102;Horas Extras 50%;EARNING;HORAS;12.00;327.27;4392.72;4392.72;4392.72;12 Horas de HE\n`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0170;401;DSR s/ Horas Extras;EARNING;VALOR;1.00;65.45;4392.72;4392.72;4392.72;DSR\n`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0901;901;INSS;DEDUCTION;VALOR;1.00;415.80;4392.72;4392.72;4392.72;INSS\n`;
      rawHistoryCsv += `${testWorkerCpf};MAT-990;Carlos Eduardo Santos;2026;${mes};MONTHLY;${dtPgto};0905;905;Vale Transporte;DEDUCTION;VALOR;1.00;240.00;4392.72;4392.72;4392.72;VT\n`;
    }

    const resExecute = await app.inject({
      method: 'POST',
      url: '/api/v1/migration/execute',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        rawWorkersCsv,
        rawHistoryCsv,
      },
    });

    expect(resExecute.statusCode).toBe(200);
    const bodyExec = resExecute.json();
    expect(bodyExec.success).toBe(true);
    expect(bodyExec.result.workersImported).toBe(1);
    expect(bodyExec.result.contractsImported).toBe(1);
    expect(bodyExec.result.periodsImported).toBe(10);
    expect(bodyExec.result.payslipsImported).toBe(10);
    expect(bodyExec.result.itemsImported).toBe(50); // 5 rubricas * 10 meses
    expect(bodyExec.result.irrfLedgerEntries).toBe(10);

    // Valida no PostgreSQL real sob RLS
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      // 1. Verifica trabalhador e contrato
      const { rows: workers } = await client.query(
        `SELECT id, full_name, cpf FROM public.workers WHERE tenant_id = $1::uuid AND cpf = $2;`,
        [tenantId, testWorkerCpf]
      );
      expect(workers.length).toBe(1);
      expect(workers[0].full_name).toBe('Carlos Eduardo Santos');

      const { rows: contracts } = await client.query(
        `SELECT id, base_salary, registration_number, union_id, collective_agreement_id FROM public.contracts WHERE tenant_id = $1::uuid AND worker_id = $2::uuid;`,
        [tenantId, workers[0].id]
      );
      expect(contracts.length).toBe(1);
      expect(Number(contracts[0].base_salary)).toBe(4000.0);
      expect(contracts[0].registration_number).toBe('MAT-990');

      // Vincula sindicato e CCT no contrato para permitir cálculo de 13º com médias CCT
      await client.query(
        `UPDATE public.contracts
         SET union_id = $1::uuid, collective_agreement_id = $2::uuid
         WHERE id = $3::uuid;`,
        [unionId, cctId, contracts[0].id]
      );

      // 2. Verifica períodos fechados (CLOSED)
      const { rows: periods } = await client.query(
        `SELECT id, month, year, type, status FROM public.payroll_periods WHERE tenant_id = $1::uuid ORDER BY month ASC;`,
        [tenantId]
      );
      expect(periods.length).toBe(10);
      for (const p of periods) {
        expect(p.status).toBe('CLOSED');
        expect(p.type).toBe('MONTHLY');
      }

      // 3. Verifica holerites e itens preservando 12h de HE 50%
      const { rows: itemsHe } = await client.query(
        `SELECT pi.rubric_code, pi.reference, pi.amount
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.tenant_id = $1::uuid AND pi.rubric_code = '102';`,
        [tenantId]
      );
      expect(itemsHe.length).toBe(10);
      for (const item of itemsHe) {
        expect(Number(item.reference)).toBe(12.0); // 12 horas físicas preservadas
        expect(Number(item.amount)).toBe(327.27);
      }

      // 4. Verifica entries de IRRF Regime de Caixa
      const { rows: irrfEntries } = await client.query(
        `SELECT cash_year, cash_month, taxation_bucket, gross_taxable, inss_deducted
         FROM public.irrf_cash_ledger WHERE tenant_id = $1::uuid ORDER BY cash_month ASC;`,
        [tenantId]
      );
      expect(irrfEntries.length).toBe(10);
      expect(irrfEntries[0].taxation_bucket).toBe('MONTHLY_CASH');
      expect(Number(irrfEntries[0].gross_taxable)).toBe(4392.72);
      expect(Number(irrfEntries[0].inss_deducted)).toBe(415.8);
    });
  });

  it('4. Validação de Virada: Motor de 13º calcula a 1ª Parcela apurando médias reais a partir do histórico importado', async () => {
    // Agora que o histórico Jan a Out/2026 foi importado e está com status CLOSED no banco:
    // Cria período de Novembro/2026 para a 1ª Parcela do 13º (THIRTEENTH_1)
    let period13Id = '';
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      const { rows: p13 } = await client.query(
        `INSERT INTO public.payroll_periods (
           tenant_id, company_id, month, year, type, status, payment_date, competence_date
         ) VALUES (
           $1::uuid, $2::uuid, 11, 2026, 'THIRTEENTH_1', 'DRAFT', '2026-11-30', '2026-11-01'
         )
         RETURNING id;`,
        [tenantId, companyId]
      );
      period13Id = p13[0].id;
    });

    // Dispara o cálculo oficial de folha via API REST
    const resCalc = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: {
        period_id: period13Id,
      },
    });

    expect(resCalc.statusCode).toBe(200);

    // Consulta os itens gerados na 1ª Parcela do 13º Salário
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (checkClient) => {
      const { rows: pItems } = await checkClient.query(
        `SELECT pi.rubric_code, pi.rubric_name, pi.amount, pi.reference
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         WHERE ps.tenant_id = $1::uuid AND ps.payroll_period_id = $2::uuid
         ORDER BY pi.rubric_code ASC;`,
        [tenantId, period13Id]
      );

      const codes = pItems.map((i: any) => i.rubric_code);
      // Rubrica 601: 1ª Parcela do 13º (Salário base)
      expect(codes).toContain('601');
      // Rubrica 604: Médias de Variáveis da 1ª Parcela do 13º
      expect(codes).toContain('604');

      const item601 = pItems.find((i: any) => i.rubric_code === '601');
      const item604 = pItems.find((i: any) => i.rubric_code === '604');

      // Salário base = 4.000,00 -> 11 avos na 1ª parcela em novembro (4000 * 11/12 * 50% = 1833.34)
      expect(Number(item601.amount)).toBe(1833.34);

      // Médias: 120 horas de HE apuradas no ano histórico importado!
      // Média física de horas extras apurada e valorizada > 0
      expect(Number(item604.amount)).toBeGreaterThan(0);

      // Na 1ª parcela não pode haver retenção de INSS nem de IRRF
      expect(codes).not.toContain('901');
      expect(codes).not.toContain('902');
    });
  });
});
