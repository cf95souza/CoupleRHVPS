import { describe, it, expect } from 'vitest';
import {
  PayrollContext,
  PayrollEngine,
  DiscountPriorityManager,
  Rubric,
  InssBracket,
  IrrfBracket,
  GeneralLegalParameters,
} from '../src/index.js';

describe('FOLHA-07: Prioridade de Descontos, Margem Consignável 35% e Insuficiência de Saldo (499/899)', () => {
  const inssBrackets: InssBracket[] = [
    { bracket_number: 1, base_limit: 1518.0, aliquot: 7.5, deduction: 0.0 },
    { bracket_number: 2, base_limit: 2793.88, aliquot: 9.0, deduction: 22.77 },
    { bracket_number: 3, base_limit: 4190.83, aliquot: 12.0, deduction: 106.59 },
    { bracket_number: 4, base_limit: 8157.41, aliquot: 14.0, deduction: 190.4 },
  ];

  const irrfBrackets: IrrfBracket[] = [
    { bracket_number: 1, base_limit: 2259.2, aliquot: 0.0, deduction: 0.0 },
    { bracket_number: 2, base_limit: 2826.65, aliquot: 7.5, deduction: 169.44 },
    { bracket_number: 3, base_limit: 3751.05, aliquot: 15.0, deduction: 381.44 },
    { bracket_number: 4, base_limit: 4664.68, aliquot: 22.5, deduction: 662.77 },
    { bracket_number: 5, base_limit: null, aliquot: 27.5, deduction: 896.0 },
  ];

  const generalParams: GeneralLegalParameters = {
    minimum_wage: 1518.0,
    dependent_deduction: 189.59,
    simplified_discount: 564.8,
    family_salary_ceiling: 1819.26,
    family_salary_value: 62.04,
    fgts_standard_aliquot: 8.0,
    fgts_apprentice_aliquot: 2.0,
  };

  const createBaseRubrics = (): Map<string, Rubric> => {
    const list: Rubric[] = [
      {
        id: 'r-101',
        code: '101',
        name: 'Salário Base Contratual',
        type: 'EARNING',
        category: 'SALARY',
        rubric_kind: 'SALARY_BASE',
        calculation_form: 'FIXO',
        calculation_order: 10,
        incidencias: {
          inss: true,
          irrf: true,
          fgts: true,
          inss_patronal: true,
          rat: true,
          terceiros: true,
          gera_base_inss: true,
          gera_base_irrf: true,
          gera_base_fgts: true,
        },
      },
      {
        id: 'r-901',
        code: '901',
        name: 'Contribuição INSS',
        type: 'DEDUCTION',
        category: 'TAX',
        rubric_kind: 'INSS',
        discount_priority: 10,
        calculation_form: 'SYSTEM',
        calculation_order: 901,
        incidencias: {
          inss: false,
          irrf: false,
          fgts: false,
          inss_patronal: false,
          rat: false,
          terceiros: false,
          gera_base_inss: false,
          gera_base_irrf: false,
          gera_base_fgts: false,
        },
      },
      {
        id: 'r-902',
        code: '902',
        name: 'IRRF Mensal',
        type: 'DEDUCTION',
        category: 'TAX',
        rubric_kind: 'IRRF',
        discount_priority: 10,
        calculation_form: 'SYSTEM',
        calculation_order: 902,
        incidencias: {
          inss: false,
          irrf: false,
          fgts: false,
          inss_patronal: false,
          rat: false,
          terceiros: false,
          gera_base_inss: false,
          gera_base_irrf: false,
          gera_base_fgts: false,
        },
      },
      {
        id: 'r-903',
        code: '903',
        name: 'FGTS Mensal',
        type: 'NEUTRAL',
        category: 'TAX',
        rubric_kind: 'FGTS',
        calculation_form: 'SYSTEM',
        calculation_order: 903,
        incidencias: {
          inss: false,
          irrf: false,
          fgts: false,
          inss_patronal: false,
          rat: false,
          terceiros: false,
          gera_base_inss: false,
          gera_base_irrf: false,
          gera_base_fgts: false,
        },
      },
      {
        id: 'r-801',
        code: '801',
        name: 'Faltas Injustificadas',
        type: 'DEDUCTION',
        category: 'ABSENCE',
        rubric_kind: 'ABSENCE',
        discount_priority: 30,
        calculation_form: 'FIXO',
        calculation_order: 30,
        incidencias: {
          inss: false,
          irrf: false,
          fgts: false,
          inss_patronal: false,
          rat: false,
          terceiros: false,
          gera_base_inss: false,
          gera_base_irrf: false,
          gera_base_fgts: false,
        },
      },
      {
        id: 'r-805',
        code: '805',
        name: 'Empréstimo Consignado',
        type: 'DEDUCTION',
        category: 'LOAN',
        rubric_kind: 'LOAN',
        discount_priority: 40,
        calculation_form: 'FIXO',
        calculation_order: 40,
        incidencias: {
          inss: false,
          irrf: false,
          fgts: false,
          inss_patronal: false,
          rat: false,
          terceiros: false,
          gera_base_inss: false,
          gera_base_irrf: false,
          gera_base_fgts: false,
        },
      },
      {
        id: 'r-803',
        code: '803',
        name: 'Plano de Saúde',
        type: 'DEDUCTION',
        category: 'BENEFIT',
        rubric_kind: 'BENEFIT',
        discount_priority: 50,
        calculation_form: 'FIXO',
        calculation_order: 50,
        incidencias: {
          inss: false,
          irrf: false,
          fgts: false,
          inss_patronal: false,
          rat: false,
          terceiros: false,
          gera_base_inss: false,
          gera_base_irrf: false,
          gera_base_fgts: false,
        },
      },
      {
        id: 'r-499',
        code: '499',
        name: 'Insuficiência de Saldo',
        type: 'EARNING',
        category: 'OTHER',
        rubric_kind: 'INSUFFICIENCY_CREDIT',
        calculation_form: 'SYSTEM',
        calculation_order: 999,
        incidencias: {
          inss: false,
          irrf: false,
          fgts: false,
          inss_patronal: false,
          rat: false,
          terceiros: false,
          gera_base_inss: false,
          gera_base_irrf: false,
          gera_base_fgts: false,
        },
      },
      {
        id: 'r-899',
        code: '899',
        name: 'Desconto Insuficiência Mês Anterior',
        type: 'DEDUCTION',
        category: 'OTHER',
        rubric_kind: 'INSUFFICIENCY_DEBIT',
        discount_priority: 35,
        calculation_form: 'FIXO',
        calculation_order: 899,
        incidencias: {
          inss: false,
          irrf: false,
          fgts: false,
          inss_patronal: false,
          rat: false,
          terceiros: false,
          gera_base_inss: false,
          gera_base_irrf: false,
          gera_base_fgts: false,
        },
      },
    ];

    const map = new Map<string, Rubric>();
    for (const r of list) map.set(r.id, r);
    return map;
  };

  it('1. Cenário Dourado Aceite FOLHA-07: Descontos superam proventos em R$ 350 -> gera 499 = 350 e líquido R$ 0,00', async () => {
    const rubricas = createBaseRubrics();
    const context = new PayrollContext({
      competencia: '05/2026',
      tipo_folha: 'MONTHLY',
      empregado_id: 'emp-01',
      contrato_id: 'cnt-01',
      salario_base: 1518.0,
      dias_trabalhados: 30,
      salario_minimo: 1518.0,
      rubricas,
      eventos: [
        { rubric_id: 'r-101', quantity: 30, manual_value: null },
        { rubric_id: 'r-803', manual_value: 1754.15, quantity: 1 },
      ],
      inss_parameters: inssBrackets,
      irrf_parameters: irrfBrackets,
      general_legal_parameters: generalParams,
      negative_net_policy: 'INSUFFICIENCY_CARRYOVER',
    });

    const engine = new PayrollEngine(context);
    const result = await engine.run();

    expect(result.status).toBe('CALCULADA');
    expect(result.has_insufficiency).toBe(true);
    expect(result.insufficiency_credit).toBe(350.0);
    // Com a verba 499 (R$ 350), total de proventos vai a 1518 + 350 = 1868.00
    expect(result.total_proventos).toBe(1868.0);
    expect(result.total_descontos).toBe(1868.0);
    // O líquido é estritamente zero (CLT Art. 462)
    expect(result.liquido).toBe(0.0);

    // Valida presença da rubrica 499 na memória de cálculo
    const mem499 = result.memoria_calculo.find(
      (m) => m.step_name.includes('Insuficiência de Saldo') || m.origin === 'INSUFFICIENCY_CARRYOVER'
    );
    expect(mem499).toBeDefined();
    expect(mem499?.result_value).toBe(350.0);
  });

  it('2. Trava Legal de Consignados (Lei 10.820/2003): limita parcela em 35% da remuneração líquida disponível', async () => {
    const rubricas = createBaseRubrics();
    // Salário R$ 3.000,00
    // INSS R$ 268.68 (progressivo)
    // Disponível antes do consignado: 3000.00 - 268.68 = R$ 2.731,32
    // Margem Consignável 35%: 2731.32 * 0.35 = R$ 955,96
    // Parcela de empréstimo solicitada: R$ 1.500,00
    // Deve travar e limitar a R$ 955,96
    const context = new PayrollContext({
      competencia: '05/2026',
      tipo_folha: 'MONTHLY',
      empregado_id: 'emp-02',
      contrato_id: 'cnt-02',
      salario_base: 3000.0,
      dias_trabalhados: 30,
      salario_minimo: 1518.0,
      rubricas,
      eventos: [
        { rubric_id: 'r-101', quantity: 30, manual_value: null },
        { rubric_id: 'r-805', manual_value: 1500.0, quantity: 1 },
      ],
      inss_parameters: inssBrackets,
      irrf_parameters: irrfBrackets,
      general_legal_parameters: generalParams,
      negative_net_policy: 'INSUFFICIENCY_CARRYOVER',
    });

    const engine = new PayrollEngine(context);
    const result = await engine.run();

    expect(result.consignable_loan_capped).toBe(true);
    expect(result.consignable_margin).toBeGreaterThan(950.0);
    expect(result.consignable_margin).toBeLessThan(960.0);

    const memLoan = result.memoria_calculo.find((m) => m.rubric_id === 'r-805');
    expect(memLoan).toBeDefined();
    expect(memLoan?.result_value).toBe(result.consignable_margin);
    expect(result.liquido).toBeGreaterThan(0);
  });

  it('3. Competência Seguinte: Amortização automática do débito do mês anterior via Rubrica 899', async () => {
    const rubricas = createBaseRubrics();
    // No mês seguinte, o colaborador ganha R$ 2.000,00 e o débito anterior de R$ 350,00
    // é lançado na rubrica 899 (Desconto de Insuficiência do Mês Anterior)
    const context = new PayrollContext({
      competencia: '06/2026',
      tipo_folha: 'MONTHLY',
      empregado_id: 'emp-01',
      contrato_id: 'cnt-01',
      salario_base: 2000.0,
      dias_trabalhados: 30,
      salario_minimo: 1518.0,
      rubricas,
      eventos: [
        { rubric_id: 'r-101', quantity: 30, manual_value: null },
        { rubric_id: 'r-899', manual_value: 350.0, quantity: 1 },
      ],
      inss_parameters: inssBrackets,
      irrf_parameters: irrfBrackets,
      general_legal_parameters: generalParams,
      negative_net_policy: 'INSUFFICIENCY_CARRYOVER',
    });

    const engine = new PayrollEngine(context);
    const result = await engine.run();

    expect(result.has_insufficiency).toBe(false);
    expect(result.total_proventos).toBe(2000.0);
    // Descontos: INSS sobre 2000 (157.23) + 899 (350.00) = 507.23
    expect(result.total_descontos).toBe(507.23);
    expect(result.liquido).toBe(1492.77);

    const mem899 = result.memoria_calculo.find((m) => m.rubric_id === 'r-899');
    expect(mem899).toBeDefined();
    expect(mem899?.result_value).toBe(350.0);
  });

  it('4. Política CAP_OPTIONAL_DISCOUNTS: corta descontos facultativos para evitar líquido negativo sem gerar 499', async () => {
    const rubricas = createBaseRubrics();
    const context = new PayrollContext({
      competencia: '05/2026',
      tipo_folha: 'MONTHLY',
      empregado_id: 'emp-03',
      contrato_id: 'cnt-03',
      salario_base: 1518.0,
      dias_trabalhados: 30,
      salario_minimo: 1518.0,
      rubricas,
      eventos: [
        { rubric_id: 'r-101', quantity: 30, manual_value: null },
        { rubric_id: 'r-803', manual_value: 1600.0, quantity: 1 },
      ],
      inss_parameters: inssBrackets,
      irrf_parameters: irrfBrackets,
      general_legal_parameters: generalParams,
      negative_net_policy: 'CAP_OPTIONAL_DISCOUNTS',
    });

    const engine = new PayrollEngine(context);
    const result = await engine.run();

    // Na política CAP_OPTIONAL_DISCOUNTS, não gera 499
    expect(result.has_insufficiency).toBe(false);
    expect(result.total_proventos).toBe(1518.0);
    // Descontos foram limitados para igualar exatamente os proventos
    expect(result.total_descontos).toBe(1518.0);
    expect(result.liquido).toBe(0.0);
  });
});
