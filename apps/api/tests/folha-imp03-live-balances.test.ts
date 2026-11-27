import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dbPool } from '../src/shared/db/pool.js';
import { hashPassword } from '../src/shared/security/passwordHasher.js';
import { TokenService } from '../src/modules/auth/tokenService.js';
import { withTenantContext } from '../src/shared/db/context.js';

/**
 * FASE V9.5 — IMP-03: Carga de Saldos Vivos de Implantação
 * (Férias Aquisitivas, Afastamentos, Banco de Horas, Consignados, Débitos 899 & Provisões Contábeis)
 */
describe('IMP-03: Carga de Saldos Vivos de Implantação & Validação de Virada', () => {
  let app: FastifyInstance;
  let tokenAdmin: string;

  const tenantId = 'e9300000-0000-0000-0000-000000000001';
  const companyId = 'e9300000-0000-0000-0000-000000000011';
  const estId = 'e9300000-0000-0000-0000-000000000021';
  const posId = 'e9300000-0000-0000-0000-000000000031';
  const deptId = 'e9300000-0000-0000-0000-000000000051';
  const userId = 'e9300000-0000-0000-0000-000000000101';
  const unionId = 'e9300000-0000-0000-0000-000000000501';
  const cctId = 'e9300000-0000-0000-0000-000000000502';

  const cpfWorker1 = '11122233344'; // Joao Carlos (com HE e saldo BH positivo)
  const cpfWorker2 = '55566677788'; // Maria Fernanda (com faltas e debito 899)

  // 1. CSV Colaboradores
  const rawWorkersCsv = `cnpj_empresa;cnpj_filial;cpf;pis_pasep;matricula;nome_completo;data_nascimento;data_admissao;departamento;centro_custo;cargo;cbo;regime_calculo;categoria_esocial;tipo_salario;salario_base;horas_mensais_divisor;horas_semanais;recebe_adiantamento;percentual_adiantamento;banco_codigo;agencia;conta;tipo_conta;chave_pix;qtd_dependentes_irrf;qtd_dependentes_sal_familia;email;telefone;observacao
12345678000190;12345678000190;${cpfWorker1};12345678901;MAT-001;Joao Carlos da Silva;1988-04-12;2025-03-01;Operações;CC-001;Analista de Operações;252105;CLT;101;MONTHLY;6000.00;220;44;SIM;40;;;;;;0;0;joao.imp03@teste.com;;Contrato Ativo
12345678000190;12345678000190;${cpfWorker2};98765432100;MAT-002;Maria Fernanda Souza;1992-08-20;2026-02-10;Operações;CC-001;Analista de Operações;252105;CLT;101;MONTHLY;4000.00;220;44;SIM;40;;;;;;0;0;maria.imp03@teste.com;;Contrato Ativo`;

  // 2. CSV Histórico Ficha Financeira Jan-Out/2026
  const generateHistoryRows = () => {
    const lines: string[] = [
      'cpf;matricula;nome;ano;mes;tipo_folha;data_pagamento;codigo_rubrica_legado;codigo_rubrica_couplerh;descricao_rubrica;tipo_evento;unidade_referencia;quantidade_referencia;valor_reais;base_inss_holerite;base_irrf_holerite;base_fgts_holerite;observacao',
    ];

    for (let mes = 1; mes <= 10; mes++) {
      const payDate = `2026-${String(mes).padStart(2, '0')}-05`;
      // Worker 1: Salario 6000 + 10h HE 50% (R$ 409,09) + INSS
      const heValor = 409.09;
      const inssW1 = 751.99;
      const liqW1 = Math.round((6000 + heValor - inssW1) * 100) / 100;

      lines.push(`${cpfWorker1};MAT-001;Joao Carlos da Silva;2026;${mes};MONTHLY;${payDate};101;101;Salário Base;EARNING;DIAS;30;6000.00;6409.09;6409.09;6409.09;Folha Histórica`);
      lines.push(`${cpfWorker1};MAT-001;Joao Carlos da Silva;2026;${mes};MONTHLY;${payDate};102;102;Horas Extras 50%;EARNING;HORAS;10.00;${heValor};6409.09;6409.09;6409.09;Horas Extras Físicas`);
      lines.push(`${cpfWorker1};MAT-001;Joao Carlos da Silva;2026;${mes};MONTHLY;${payDate};901;901;INSS;DEDUCTION;PERCENTUAL;14.00;${inssW1};0;0;0;Desconto INSS`);

      // Worker 2: Salario 4000 + INSS
      const inssW2 = 398.82;
      lines.push(`${cpfWorker2};MAT-002;Maria Fernanda Souza;2026;${mes};MONTHLY;${payDate};101;101;Salário Base;EARNING;DIAS;30;4000.00;4000.00;4000.00;4000.00;Folha Histórica`);
      lines.push(`${cpfWorker2};MAT-002;Maria Fernanda Souza;2026;${mes};MONTHLY;${payDate};901;901;INSS;DEDUCTION;PERCENTUAL;12.00;${inssW2};0;0;0;Desconto INSS`);
    }

    return lines.join('\n');
  };

  const rawHistoryCsv = generateHistoryRows();

  // 3. CSV Saldos de Férias e Períodos Aquisitivos
  const rawVacationsCsv = `cpf_colaborador;matricula;nome_colaborador;inicio_aquisitivo;fim_aquisitivo;limite_concessivo;dias_direito;dias_gozados;dias_vendidos_abono;dias_saldo_restante;faltas_injustificadas_aquisitivo;status;observacao
${cpfWorker1};MAT-001;Joao Carlos da Silva;2025-03-01;2026-02-28;2027-02-28;30;15;0;15;0;IN_PROGRESS;Periodo 2025/2026 com 15 dias gozados e 15 dias restantes
${cpfWorker2};MAT-002;Maria Fernanda Souza;2026-02-10;2027-02-09;2028-02-09;24;0;0;24;7;OPEN;Periodo em curso com 7 faltas injustificadas (reducao CLT Art. 130 para 24 dias)`;

  // 4. CSV Afastamentos 2026 e em Curso
  const rawLeavesCsv = `cpf_colaborador;matricula;nome_colaborador;tipo_afastamento;codigo_motivo_esocial;data_inicio;data_fim_prevista;data_retorno_efetivo;dias_pagos_empresa;cid10_sigiloso;mesma_cid_60dias;maternidade_estendida_180d;estabilidade_ate;observacao
${cpfWorker1};MAT-001;Joao Carlos da Silva;AUXILIO_DOENCA;03;2026-04-01;2026-04-25;2026-04-26;15;M545;NAO;NAO;;Afastamento medico 25 dias no ano de 2026
${cpfWorker2};MAT-002;Maria Fernanda Souza;LICENCA_MATERNIDADE;17;2026-08-10;2026-12-07;;120;Z370;NAO;NAO;;Maternidade 120 dias em curso na data da virada`;

  // 5. CSV Saldo Inicial de Banco de Horas
  const rawTimeBankCsv = `cpf_colaborador;matricula;nome_colaborador;data_corte_saldo;saldo_horas_hhmm;saldo_minutos_liquido;regime_horas_extras;observacao
${cpfWorker1};MAT-001;Joao Carlos da Silva;2026-10-31;+14:30;870;BANCO_HORAS;Saldo credor de 14h30 (+870 min)
${cpfWorker2};MAT-002;Maria Fernanda Souza;2026-10-31;-04:15;-255;BANCO_HORAS;Saldo devedor de -4h15 (-255 min)`;

  // 6. CSV Consignados e Débitos Anteriores
  const rawLoansAndDebtsCsv = `cpf_colaborador;matricula;nome_colaborador;tipo_registro;instituicao_financeira;numero_contrato;valor_total;valor_parcela;total_parcelas;parcelas_ja_pagas;data_inicio;competencia_origem_debito;saldo_restante_debito;observacao
${cpfWorker1};MAT-001;Joao Carlos da Silva;CONSIGNADO;Banco do Brasil;CONS-2026-9981;12000.00;500.00;24;5;2026-06-01;;;Consignado em curso com 5 de 24 parcelas pagas
${cpfWorker2};MAT-002;Maria Fernanda Souza;DEBITO_INSUFICIENCIA_899;;;;;;;2026-10-31;2026-10;142.80;Saldo devedor de insuficiencia de folha anterior`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const tokenService = new TokenService(dbPool);
    const pwHash = await hashPassword('Imp03!SaldosVivos2026');

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN;');
      await client.query("SELECT set_config('app.current_role', 'system_admin', true);");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true);", [tenantId]);

      await client.query(`UPDATE public.payroll_periods SET status = 'OPEN' WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.accounting_provisions_ledger WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.employee_balance_debts WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.payroll_loans WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.time_bank_transactions WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.time_bank_accounts WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.vacation_schedules WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.vacation_periods WHERE tenant_id = $1::uuid;`, [tenantId]);
      await client.query(`DELETE FROM public.leaves WHERE tenant_id = $1::uuid;`, [tenantId]);
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
         VALUES ($1::uuid, 'admin.imp03@couplerh.test', 'Admin IMP-03 Saldos', $2, TRUE)`,
        [userId, pwHash]
      );

      await client.query(
        `INSERT INTO public.tenants (id, name, status)
         VALUES ($1::uuid, 'Tenant IMP-03 Saldos Vivos', 'ACTIVE')`,
        [tenantId]
      );

      await client.query(
        `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
         VALUES ($1::uuid, $2::uuid, 'system_admin', TRUE)`,
        [tenantId, userId]
      );

      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, cnpj, tax_regime, status)
         VALUES ($1::uuid, $2::uuid, 'Empresa Carga Saldos LTDA', '12345678000190', 'LUCRO_PRESUMIDO', 'ACTIVE')`,
        [companyId, tenantId]
      );

      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Matriz IMP-03', '12345678000190')`,
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

    const tokenResult = await tokenService.createSession({
      userId,
      tenantId,
      role: 'system_admin',
      email: 'admin.imp03@couplerh.test',
      aal: 'aal2',
    });
    tokenAdmin = tokenResult.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Dry-Run: deve processar os 6 CSVs com reconciliação contábil R$ 0,00 e resumos de saldos vivos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/migration/preview',
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
      payload: {
        rawWorkersCsv,
        rawHistoryCsv,
        rawVacationsCsv,
        rawLeavesCsv,
        rawTimeBankCsv,
        rawLoansAndDebtsCsv,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    const p = body.preview;

    expect(p.valid).toBe(true);
    expect(p.totalWorkers).toBe(2);
    expect(p.totalPeriods).toBe(10); // Jan a Out/2026
    expect(p.reconciliationDiff).toBe(0); // R$ 0,00
    expect(p.totalOvertimeHours).toBe(100); // 10h x 10 meses

    // Verifica resumos de saldos vivos
    expect(p.vacationsSummary).toBeDefined();
    expect(p.vacationsSummary.totalVacationPeriods).toBe(2);
    expect(p.vacationsSummary.totalDaysRemaining).toBe(39); // 15 + 24
    expect(p.vacationsSummary.totalAbsencesImpact).toBe(1); // Maria com 7 faltas (Art. 130)

    expect(p.leavesSummary).toBeDefined();
    expect(p.leavesSummary.totalLeaves).toBe(2);
    expect(p.leavesSummary.activeLeavesCount).toBe(1); // Maternidade em curso

    expect(p.timeBankSummary).toBeDefined();
    expect(p.timeBankSummary.totalAccounts).toBe(2);
    expect(p.timeBankSummary.totalPositiveMinutes).toBe(870); // +14:30
    expect(p.timeBankSummary.totalNegativeMinutes).toBe(255); // -04:15

    expect(p.loansAndDebtsSummary).toBeDefined();
    expect(p.loansAndDebtsSummary.totalConsignados).toBe(1);
    expect(p.loansAndDebtsSummary.totalDebitos899).toBe(1);
    expect(p.loansAndDebtsSummary.totalDebito899Amount).toBe(142.80);
  });

  it('2. Commit Atômico: deve persistir trabalhadores, folhas fechadas, férias, afastamentos, banco de horas, consignados e provisões', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/migration/execute',
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
      payload: {
        rawWorkersCsv,
        rawHistoryCsv,
        rawVacationsCsv,
        rawLeavesCsv,
        rawTimeBankCsv,
        rawLoansAndDebtsCsv,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    const r = body.result;

    expect(r.workersImported).toBe(2);
    expect(r.contractsImported).toBe(2);
    expect(r.periodsImported).toBe(10);
    expect(r.payslipsImported).toBe(20);
    expect(r.vacationPeriodsImported).toBe(2);
    expect(r.leavesImported).toBe(2);
    expect(r.timeBankAccountsImported).toBe(2);
    expect(r.loansImported).toBe(1);
    expect(r.balanceDebtsImported).toBe(1);
    expect(r.provisionsImported).toBeGreaterThanOrEqual(2);

    // Validação direta no PostgreSQL 17 sob RLS
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      // 1. Férias
      const { rows: vacs } = await client.query(
        `SELECT * FROM public.vacation_periods WHERE tenant_id = $1::uuid ORDER BY acquisition_start;`,
        [tenantId]
      );
      expect(vacs.length).toBe(2);
      expect(vacs[0].days_remaining).toBe(15);
      expect(vacs[1].days_remaining).toBe(24);
      expect(vacs[1].absences_count).toBe(7);

      // 2. Afastamentos
      const { rows: leaves } = await client.query(
        `SELECT * FROM public.leaves WHERE tenant_id = $1::uuid ORDER BY start_date;`,
        [tenantId]
      );
      expect(leaves.length).toBe(2);
      expect(leaves[0].leave_type).toBe('SICK_LEAVE');
      expect(leaves[0].company_paid_days).toBe(15);
      expect(leaves[0].status).toBe('COMPLETED');
      expect(leaves[1].leave_type).toBe('MATERNITY');
      expect(leaves[1].status).toBe('ACTIVE');

      // 3. Banco de Horas
      const { rows: tbAccounts } = await client.query(
        `SELECT * FROM public.time_bank_accounts WHERE tenant_id = $1::uuid;`,
        [tenantId]
      );
      expect(tbAccounts.length).toBe(2);
      const { rows: tbTx } = await client.query(
        `SELECT * FROM public.time_bank_transactions WHERE tenant_id = $1::uuid;`,
        [tenantId]
      );
      expect(tbTx.length).toBe(2);

      // 4. Empréstimos Consignados
      const { rows: loans } = await client.query(
        `SELECT * FROM public.payroll_loans WHERE tenant_id = $1::uuid;`,
        [tenantId]
      );
      expect(loans.length).toBe(1);
      expect(loans[0].contract_number).toBe('CONS-2026-9981');
      expect(loans[0].paid_installments).toBe(5);
      expect(loans[0].total_installments).toBe(24);
      expect(loans[0].is_active).toBe(true);

      // 5. Débito de Insuficiência 899
      const { rows: debts } = await client.query(
        `SELECT * FROM public.employee_balance_debts WHERE tenant_id = $1::uuid;`,
        [tenantId]
      );
      expect(debts.length).toBe(1);
      expect(parseFloat(debts[0].amount)).toBe(142.80);
      expect(debts[0].status).toBe('PENDING');

      // 6. Provisões Contábeis Acumuladas
      const { rows: provs } = await client.query(
        `SELECT * FROM public.accounting_provisions_ledger WHERE tenant_id = $1::uuid;`,
        [tenantId]
      );
      expect(provs.length).toBeGreaterThanOrEqual(4); // 13º e Férias para os 2 contratos
    });
  });

  it('3. Validação de Virada: Cálculo da 1ª Parcela do 13º Salário (THIRTEENTH_1) com médias físicas do histórico importado', async () => {
    let period13Id: string;

    // Vincula CCT aos contratos
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      await client.query(
        `UPDATE public.contracts SET collective_agreement_id = $1::uuid WHERE tenant_id = $2::uuid;`,
        [cctId, tenantId]
      );

      // Cria período de 1ª Parcela em Novembro/2026
      const { rows: p13 } = await client.query(
        `INSERT INTO public.payroll_periods (
           tenant_id, company_id, month, year, type, status,
           payment_date, competence_date
         ) VALUES (
           $1::uuid, $2::uuid, 11, 2026, 'THIRTEENTH_1', 'OPEN',
           '2026-11-30', '2026-11-01'
         ) RETURNING id;`,
        [tenantId, companyId]
      );
      period13Id = p13[0].id;
    });

    // Dispara cálculo do período de 13º
    const calcRes = await app.inject({
      method: 'POST',
      url: '/api/v1/payroll/calculate',
      headers: {
        authorization: `Bearer ${tokenAdmin}`,
      },
      payload: {
        period_id: period13Id,
      },
    });

    expect(calcRes.statusCode).toBe(200);

    // Valida os holerites calculados
    await withTenantContext({ tenantId, userId, role: 'system_admin' }, async (client) => {
      const { rows: slips } = await client.query(
        `SELECT p.*, w.cpf, w.full_name
         FROM public.payslips p
         JOIN public.contracts c ON p.contract_id = c.id
         JOIN public.workers w ON c.worker_id = w.id
         WHERE p.payroll_period_id = $1::uuid;`,
        [period13Id]
      );

      expect(slips.length).toBe(2);

      // Colaborador 1: Joao Carlos (Salário R$ 6.000, 10 avos de Jan-Out + 1 em Nov = 9 a 11 avos, com médias de HE)
      const slipW1 = slips.find((s) => s.cpf === cpfWorker1)!;
      expect(slipW1).toBeDefined();

      const { rows: itemsW1 } = await client.query(
        `SELECT * FROM public.payslip_items WHERE payslip_id = $1::uuid;`,
        [slipW1.id]
      );

      // Rubrica 601: Adiantamento 13º Salário
      const r601 = itemsW1.find((i) => i.rubric_code === '601');
      expect(r601).toBeDefined();
      expect(parseFloat(r601.amount)).toBeGreaterThan(0);

      // Rubrica 604: Médias de Horas Extras no 13º Salário (Súmula 347 TST)
      // Como o CCT prevê include_averages_in_13th_first_installment = TRUE e o histórico foi importado de Jan a Out,
      // a rubrica 604 DEVE ser calculada com 50% das médias apuradas!
      const r604 = itemsW1.find((i) => i.rubric_code === '604');
      expect(r604).toBeDefined();
      expect(parseFloat(r604.amount)).toBeGreaterThan(0);

      // Sem retenção de INSS e IRRF na 1ª parcela
      const rInss = itemsW1.find((i) => i.rubric_code === '901');
      const rIrrf = itemsW1.find((i) => i.rubric_code === '902');
      expect(rInss).toBeUndefined();
      expect(rIrrf).toBeUndefined();
    });
  });
});
