import { describe, it, expect } from 'vitest';
import {
  PayrollContext,
  PayrollEngine,
  IRRFCalculator,
  DAGResolver,
  TerminationCalculator,
  PUBLISHED_PAYROLL_VARIABLES,
  normalizeFormulaVariables,
  calculateDeductionAmount,
  aggregateCompanyBases,
  calculateConsolidatedEmployerTaxes,
  addMoney,
  divideMoney,
  round2,
  type Rubric,
} from '../src/index.js';

const inssBrackets2026 = [
  { bracket_number: 1, base_limit: 1518.0, aliquot: 7.5, deduction: 0 },
  { bracket_number: 2, base_limit: 2793.88, aliquot: 9.0, deduction: 0 },
  { bracket_number: 3, base_limit: 4190.83, aliquot: 12.0, deduction: 0 },
  { bracket_number: 4, base_limit: 8157.41, aliquot: 14.0, deduction: 0 },
];

const irrfBrackets = [
  { bracket_number: 1, base_limit: 2259.2, aliquot: 0.0, deduction: 0.0 },
  { bracket_number: 2, base_limit: 2826.65, aliquot: 7.5, deduction: 169.44 },
  { bracket_number: 3, base_limit: 3751.05, aliquot: 15.0, deduction: 381.44 },
  { bracket_number: 4, base_limit: 4664.68, aliquot: 22.5, deduction: 662.77 },
  { bracket_number: 5, base_limit: null, aliquot: 27.5, deduction: 896.0 },
];

const generalParams2026 = {
  minimum_wage: 1518.0,
  inss_ceiling: 8157.41,
  dependent_deduction: 189.59,
  simplified_discount: 564.8,
  family_salary_ceiling: 1819.26,
  family_salary_value: 62.04,
  fgts_standard_aliquot: 8.0,
  fgts_apprentice_aliquot: 2.0,
  irrf_exemption_limit: 5000.0,
  irrf_reduction_formula_limit: 7350.0,
  irrf_reduction_a: 978.62,
  irrf_reduction_b: 0.133145,
};

const generalParams2025NoRedutor = {
  minimum_wage: 1518.0,
  inss_ceiling: 8157.41,
  dependent_deduction: 189.59,
  simplified_discount: 564.8,
  fgts_standard_aliquot: 8.0,
  fgts_apprentice_aliquot: 2.0,
  // Sem irrf_exemption_limit -> não deve aplicar redutor 2026!
};

const baseRubrics: Rubric[] = [
  {
    id: 'rub-101',
    code: '101',
    name: 'Salário Base',
    type: 'EARNING',
    category: 'SALARY',
    rubric_kind: 'SALARY_BASE',
    calculation_form: 'FIXO',
    calculation_order: 10,
    incidencias: {
      inss: true, irrf: true, fgts: true,
      inss_patronal: true, rat: true, terceiros: true,
      gera_base_inss: true, gera_base_irrf: true, gera_base_fgts: true,
    },
  },
  {
    id: 'rub-102',
    code: '102',
    name: 'Horas Extras 50%',
    type: 'EARNING',
    category: 'OVERTIME',
    rubric_kind: 'OVERTIME',
    calculation_form: 'HORAS',
    calculation_base: 'BASE_HORA_EXTRA',
    factor: 1.5,
    calculation_order: 20,
    incidencias: {
      inss: true, irrf: true, fgts: true,
      inss_patronal: true, rat: true, terceiros: true,
      gera_base_inss: true, gera_base_irrf: true, gera_base_fgts: true,
      integra_dsr: true,
    },
  },
  {
    id: 'rub-301',
    code: '301',
    name: 'Adicional Noturno 20%',
    type: 'EARNING',
    category: 'NIGHT_SHIFT',
    rubric_kind: 'ADIC_NOTURNO',
    calculation_form: 'HORAS',
    calculation_base: 'SALARIO_BASE',
    factor: 0.2,
    calculation_order: 25,
    incidencias: {
      inss: true, irrf: true, fgts: true,
      inss_patronal: true, rat: true, terceiros: true,
      gera_base_inss: true, gera_base_irrf: true, gera_base_fgts: true,
      integra_dsr: true,
    },
  },
  {
    id: 'rub-401',
    code: '401',
    name: 'DSR sobre Variáveis',
    type: 'EARNING',
    category: 'DSR',
    rubric_kind: 'DSR',
    calculation_form: 'PERCENTUAL',
    calculation_base: 'BASE_DSR',
    calculation_order: 30,
    incidencias: {
      inss: true, irrf: true, fgts: true,
      inss_patronal: true, rat: true, terceiros: true,
      gera_base_inss: true, gera_base_irrf: true, gera_base_fgts: true,
    },
  },
  {
    id: 'rub-801',
    code: '801',
    name: 'Faltas Injustificadas',
    type: 'DEDUCTION',
    category: 'ABSENCE',
    rubric_kind: 'ABSENCE',
    calculation_form: 'DIAS',
    calculation_base: 'SALARIO_BASE',
    calculation_order: 50,
    incidencias: {
      inss: true, irrf: true, fgts: true,
      inss_patronal: true, rat: true, terceiros: true,
      gera_base_inss: true, gera_base_irrf: true, gera_base_fgts: true,
    },
  },
  {
    id: 'rub-901',
    code: '901',
    name: 'INSS',
    type: 'DEDUCTION',
    category: 'TAX',
    rubric_kind: 'INSS',
    calculation_form: 'AUTOMATICA',
    calculation_order: 90,
    incidencias: {
      inss: false, irrf: false, fgts: false,
      inss_patronal: false, rat: false, terceiros: false,
      gera_base_inss: false, gera_base_irrf: false, gera_base_fgts: false,
    },
  },
  {
    id: 'rub-902',
    code: '902',
    name: 'IRRF',
    type: 'DEDUCTION',
    category: 'TAX',
    rubric_kind: 'IRRF',
    calculation_form: 'AUTOMATICA',
    calculation_order: 95,
    incidencias: {
      inss: false, irrf: false, fgts: false,
      inss_patronal: false, rat: false, terceiros: false,
      gera_base_inss: false, gera_base_irrf: false, gera_base_fgts: false,
    },
  },
  {
    id: 'rub-903',
    code: '903',
    name: 'FGTS',
    type: 'NEUTRAL',
    category: 'TAX',
    rubric_kind: 'FGTS',
    calculation_form: 'AUTOMATICA',
    calculation_order: 99,
    incidencias: {
      inss: false, irrf: false, fgts: false,
      inss_patronal: false, rat: false, terceiros: false,
      gera_base_inss: false, gera_base_irrf: false, gera_base_fgts: false,
    },
  },
];

describe('FASE V4 — Saneamento de Bugs Críticos do Motor (BUG-03 a BUG-10)', () => {
  it('BUG-03: FGTS diferencial na 2ª parcela do 13º (salário R$ 3.000: 1ª = 120 + 2ª = 120 = 240 exatos)', async () => {
    const r601: Rubric = {
      id: 'r-601', code: '601', name: '13º 1ª Parcela', type: 'EARNING', category: 'THIRTEENTH',
      rubric_kind: 'THIRTEENTH', calculation_form: 'FIXO', calculation_order: 40,
      incidencias: { inss: false, irrf: false, fgts: true, inss_patronal: false, rat: false, terceiros: false, gera_base_inss: false, gera_base_irrf: false, gera_base_fgts: true },
    };
    const r602: Rubric = {
      id: 'r-602', code: '602', name: '13º 2ª Parcela', type: 'EARNING', category: 'THIRTEENTH',
      rubric_kind: 'THIRTEENTH', calculation_form: 'FIXO', calculation_order: 41,
      incidencias: { inss: true, irrf: true, fgts: true, inss_patronal: true, rat: true, terceiros: true, gera_base_inss: true, gera_base_irrf: true, gera_base_fgts: true },
    };
    const r603: Rubric = {
      id: 'r-603', code: '603', name: 'Dedução 1ª Parcela 13º', type: 'DEDUCTION', category: 'THIRTEENTH',
      rubric_kind: 'THIRTEENTH', calculation_form: 'FIXO', calculation_order: 55,
      incidencias: { inss: false, irrf: false, fgts: false, inss_patronal: false, rat: false, terceiros: false, gera_base_inss: false, gera_base_irrf: false, gera_base_fgts: false },
    };
    const taxes = baseRubrics.filter((r) => ['901', '902', '903'].includes(r.code));

    // 1ª parcela (R$ 1.500 -> FGTS = R$ 120,00)
    const ctx1 = new PayrollContext({
      competencia: '11/2026', tipo_folha: 'THIRTEENTH_1', empregado_id: 'w1', contrato_id: 'c1',
      salario_base: 3000, dias_trabalhados: 30, dias_uteis: 25, dias_inuteis: 5, divisor: 220,
      rubricas: [r601, taxes[2]],
      eventos: [{ rubric_id: r601.id, manual_value: 1500, quantity: 12 }],
      inss_parameters: inssBrackets2026, irrf_parameters: irrfBrackets, general_legal_parameters: generalParams2026,
    });
    const res1 = await new PayrollEngine(ctx1).run();
    expect(res1.status).toBe('CALCULADA');
    expect(res1.total_fgts).toBe(120);

    // 2ª parcela (Bruto R$ 3.000 - Base já tributada R$ 1.500 -> FGTS diferencial = R$ 120,00)
    const ctx2 = new PayrollContext({
      competencia: '12/2026', tipo_folha: 'THIRTEENTH_2', empregado_id: 'w1', contrato_id: 'c1',
      salario_base: 3000, dias_trabalhados: 30, dias_uteis: 26, dias_inuteis: 5, divisor: 220,
      fgts_base_already_taxed: 1500,
      rubricas: [r602, r603, ...taxes],
      eventos: [
        { rubric_id: r602.id, manual_value: 3000, quantity: 12 },
        { rubric_id: r603.id, manual_value: 1500, quantity: 1 },
      ],
      inss_parameters: inssBrackets2026, irrf_parameters: irrfBrackets, general_legal_parameters: generalParams2026,
    });
    const res2 = await new PayrollEngine(ctx2).run();
    expect(res2.status).toBe('CALCULADA');
    expect(res2.total_fgts).toBe(120);
    expect(addMoney(res1.total_fgts, res2.total_fgts)).toBe(240);
  });

  it('BUG-04: Eventos por quantidade com manual_value=0 ou null não zeram HE, Noturno e Faltas + geram DSR', async () => {
    const ctx = new PayrollContext({
      competencia: '11/2026', tipo_folha: 'MONTHLY', empregado_id: 'w1', contrato_id: 'c1',
      salario_base: 2200, dias_trabalhados: 30, dias_uteis: 25, dias_inuteis: 5, divisor: 220,
      rubricas: baseRubrics,
      eventos: [
        { rubric_id: 'rub-101', quantity: 30, manual_value: null },
        { rubric_id: 'rub-102', quantity: 10, manual_value: 0 }, // 10h HE 50% com amount 0 -> deve calcular!
        { rubric_id: 'rub-301', quantity: 2, manual_value: null }, // 2h noturno
        { rubric_id: 'rub-801', quantity: 1, manual_value: 0 }, // 1 falta
      ],
      inss_parameters: inssBrackets2026, irrf_parameters: irrfBrackets, general_legal_parameters: generalParams2026,
    });
    const res = await new PayrollEngine(ctx).run();
    expect(res.status).toBe('CALCULADA');

    const mem102 = res.memoria_calculo.find((m) => m.rubric_id === 'rub-102');
    const mem301 = res.memoria_calculo.find((m) => m.rubric_id === 'rub-301');
    const mem401 = res.memoria_calculo.find((m) => m.rubric_id === 'rub-401');
    const mem801 = res.memoria_calculo.find((m) => m.rubric_id === 'rub-801');

    // Salário hora = 2200 / 220 = 10 -> HE50 (10h * 1.5 * 10) = 150.00
    expect(mem102?.result_value).toBe(150);
    // Noturno (2h * 0.2 * 10) = 4.00
    expect(mem301?.result_value).toBe(4);
    // DSR = (150 + 4) * (5/25) = 30.80
    expect(mem401?.result_value).toBe(30.8);
    // Falta 1 dia = 2200 / 30 = 73.33
    expect(mem801?.result_value).toBe(73.33);
  });

  it('BUG-04: force_zero_override=true permite zerar explicitamente evento manual', async () => {
    const ctx = new PayrollContext({
      competencia: '11/2026', tipo_folha: 'MONTHLY', empregado_id: 'w1', contrato_id: 'c1',
      salario_base: 2200, dias_trabalhados: 30, dias_uteis: 25, dias_inuteis: 5, divisor: 220,
      rubricas: baseRubrics,
      eventos: [
        { rubric_id: 'rub-101', quantity: 30, manual_value: null },
        { rubric_id: 'rub-102', quantity: 10, manual_value: 0, force_zero_override: true },
      ],
      inss_parameters: inssBrackets2026, irrf_parameters: irrfBrackets, general_legal_parameters: generalParams2026,
    });
    const res = await new PayrollEngine(ctx).run();
    const mem102 = res.memoria_calculo.find((m) => m.rubric_id === 'rub-102');
    expect(mem102?.result_value).toBe(0);
    expect(mem102?.parsed_formula).toBe('MANUAL_VALUE_ZERO');
  });

  it('BUG-05: Catálogo único PT-BR compartilhado e normalização transparente de fórmulas', async () => {
    expect(PUBLISHED_PAYROLL_VARIABLES).toContain('SALARIO_BASE');
    expect(PUBLISHED_PAYROLL_VARIABLES).toContain('SALARIO_MINIMO');
    expect(PUBLISHED_PAYROLL_VARIABLES).toContain('BASE_HORA_EXTRA_NOTURNA');
    expect(normalizeFormulaVariables('(SALARY / DIVISOR) * FACTOR * QUANTITY')).toBe(
      '(SALARIO_BASE / DIVISOR) * FATOR * QUANTIDADE'
    );

    const formulaRubric: Rubric = {
      id: 'rub-custom-he', code: '190', name: 'Hora Extra Custom', type: 'EARNING', category: 'OVERTIME',
      rubric_kind: 'OTHER', calculation_form: 'FORMULA', factor: 1.5, divisor: 220,
      formula: '(SALARIO_BASE / DIVISOR) * FATOR * QUANTIDADE', calculation_order: 22,
      incidencias: {
        inss: true, irrf: true, fgts: true, inss_patronal: true, rat: true, terceiros: true,
        gera_base_inss: true, gera_base_irrf: true, gera_base_fgts: true, integra_dsr: true,
      },
    };

    const ctx = new PayrollContext({
      competencia: '11/2026', tipo_folha: 'MONTHLY', empregado_id: 'w1', contrato_id: 'c1',
      salario_base: 2200, dias_trabalhados: 30, dias_uteis: 25, dias_inuteis: 5, divisor: 220,
      rubricas: [...baseRubrics, formulaRubric],
      eventos: [
        { rubric_id: 'rub-101', quantity: 30, manual_value: null },
        { rubric_id: 'rub-custom-he', quantity: 4, manual_value: null },
      ],
      inss_parameters: inssBrackets2026, irrf_parameters: irrfBrackets, general_legal_parameters: generalParams2026,
    });
    const res = await new PayrollEngine(ctx).run();
    const mem190 = res.memoria_calculo.find((m) => m.rubric_id === 'rub-custom-he');
    expect(mem190?.result_value).toBe(60); // (2200/220)*1.5*4 = 60
  });

  it('BUG-06: IRRF sem redutor em vigência 2025 vs com redutor em 2026 + 1/3 exato com divideMoney', () => {
    const res2025 = IRRFCalculator.calculate(4500, 443.97, 0, irrfBrackets as any, generalParams2025NoRedutor);
    expect(res2025.reductionAmount).toBe(0);
    expect(res2025.value).toBeGreaterThan(200);

    const res2026 = IRRFCalculator.calculate(4500, 443.97, 0, irrfBrackets as any, generalParams2026);
    expect(res2026.value).toBe(0);
    expect(res2026.reductionAmount).toBeGreaterThan(0);

    // 1/3 de R$ 1.000,00 deve ser R$ 333,33 exatos (sem 33.3333 -> 333.333)
    expect(divideMoney(1000, 3)).toBe(333.33);
    expect(divideMoney(3000, 3)).toBe(1000);
  });

  it('BUG-07: DAGResolver sem falso ciclo numérico, BASE_HORA_EXTRA integral (Súmula 264) e separação de Noturno (OJ 97)', async () => {
    const formulaWithNumber: Rubric = {
      id: 'rub-220-const', code: '220', name: 'Auxílio Fixo', type: 'EARNING', category: 'ALLOWANCE',
      rubric_kind: 'OTHER', calculation_form: 'FORMULA', formula: 'SALARIO_BASE / 220', calculation_order: 12,
      incidencias: { inss: false, irrf: false, fgts: false, inss_patronal: false, rat: false, terceiros: false, gera_base_inss: false, gera_base_irrf: false, gera_base_fgts: false },
    };
    const rubricRef220: Rubric = {
      id: 'rub-ref', code: '221', name: 'Hora Base', type: 'EARNING', category: 'OTHER',
      rubric_kind: 'OTHER', calculation_form: 'FORMULA', formula: 'SALARIO_BASE / 220 * 10', calculation_order: 13,
      incidencias: { inss: false, irrf: false, fgts: false, inss_patronal: false, rat: false, terceiros: false, gera_base_inss: false, gera_base_irrf: false, gera_base_fgts: false },
    };
    // Antes do fix, '220' na fórmula criava dependência de código numérico solto; não pode lançar ciclo nem falso match
    const resolved = DAGResolver.resolve(new Map([
      [formulaWithNumber.id, formulaWithNumber],
      [rubricRef220.id, rubricRef220],
    ]));
    expect(resolved).toHaveLength(2);

    // Admitido no dia 16 (15 dias trabalhados no mês) com salário integral R$ 2.200 e 2h noturnas + 10h HE diurna
    // A HE diurna deve usar salário contratual INTEGRAL (R$ 2.200 -> R$ 10/h * 1.5 * 10 = R$ 150) e NÃO incluir noturno!
    const ctx = new PayrollContext({
      competencia: '11/2026', tipo_folha: 'MONTHLY', empregado_id: 'w1', contrato_id: 'c1',
      salario_base: 2200, dias_trabalhados: 15, dias_uteis: 25, dias_inuteis: 5, divisor: 220,
      rubricas: baseRubrics,
      eventos: [
        { rubric_id: 'rub-101', quantity: 15, manual_value: null },
        { rubric_id: 'rub-301', quantity: 20, manual_value: null },
        { rubric_id: 'rub-102', quantity: 10, manual_value: null },
      ],
      inss_parameters: inssBrackets2026, irrf_parameters: irrfBrackets, general_legal_parameters: generalParams2026,
    });
    const res = await new PayrollEngine(ctx).run();
    const mem101 = res.memoria_calculo.find((m) => m.rubric_id === 'rub-101');
    const mem102 = res.memoria_calculo.find((m) => m.rubric_id === 'rub-102');
    expect(mem101?.result_value).toBe(1100); // Salário proporcional (15/30)
    expect(mem102?.result_value).toBe(150);  // HE diurna sobre integral (2200/220 * 1.5 * 10) sem contaminar com noturno
  });

  it('BUG-08: Rescisão em 20/12 com aviso de 45 dias projeta virada Dez->Jan (> 1 avo) e não deduz INSS 2x no IRRF', () => {
    // Admitido em 01/01/2021, demitido em 20/12/2026 -> 5 anos completos -> 30 + 15 = 45 dias de aviso prévio
    // 20/12/2026 + 45 dias = 03/02/2027 (ganha Janeiro/2027 inteiro = 1 avo adicional!)
    const trct = TerminationCalculator.calculate({
      baseSalary: 9000,
      admissionDate: '2021-01-01',
      resignationDate: '2026-12-20',
      dismissalType: 'WITHOUT_CAUSE',
      noticeType: 'INDEMNIFIED',
      dependentsCount: 1,
      inssParameters: inssBrackets2026 as any,
      irrfParameters: irrfBrackets as any,
      generalLegalParameters: generalParams2026,
    });

    expect(trct.metadados.diasAvisoReal).toBe(45);
    expect(trct.metadados.dataProjetada).toBe('2027-02-03');
    expect(trct.proventos.decimoTerceiro.avos).toBe(12);
    expect(trct.proventos.decimoTerceiroAviso.avos).toBe(1); // Jan/2027 completo (>= 15d); Fev/2027 tem 3d (< 15d)

    // Valida IRRF sem dupla dedução de INSS:
    const expectedSaldo = round2((9000 / 30) * 20); // 6000.00
    expect(trct.proventos.saldoSalario.valor).toBe(expectedSaldo);
    const expectedIrrf = IRRFCalculator.calculate(
      expectedSaldo,
      trct.descontos.inssSaldo.valor,
      1,
      irrfBrackets as any,
      generalParams2026
    );
    expect(trct.descontos.irrf.valor).toBe(expectedIrrf.value);
    expect(trct.descontos.irrf.baseLegal).toBe(expectedIrrf.legalBase);
  });

  it('BUG-09 & BUG-10: Agregação patronal usa FGTS real de Aprendiz (2%) + CLT (8%) e dedução percentual respeita total_limit', () => {
    const totals = aggregateCompanyBases({
      calculatedPayslips: [
        { contract_id: 'c-clt', base_inss: 3000, base_fgts: 3000, fgts_month: 240 },     // 8%
        { contract_id: 'c-apr', base_inss: 1500, base_fgts: 1500, fgts_month: 30 },      // 2% aprendiz
      ],
      contractCompanyMap: { 'c-clt': 'comp-1', 'c-apr': 'comp-1' },
    });

    const taxes = calculateConsolidatedEmployerTaxes({
      tenant_id: 't1',
      period_id: 'p1',
      companyTotals: totals,
      companies: [{ id: 'comp-1', tax_regime: 'LUCRO_PRESUMIDO' }],
    });

    expect(taxes[0].fgts_patronal).toBe(270); // 240 + 30 (não 360 = 8% sobre tudo!)

    // Dedução percentual com total_limit
    const dedVal = calculateDeductionAmount(
      { amount_type: 'PERCENTAGE', value: 10, total_limit: 250 },
      5000 // 10% seria 500, limitado a 250
    );
    expect(dedVal).toBe(250);
  });
});
