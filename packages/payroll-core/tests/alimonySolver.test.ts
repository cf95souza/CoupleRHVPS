import { describe, it, expect } from 'vitest';
import {
  AlimonySolver,
  INSSCalculator,
  IRRFCalculator,
  PayrollContext,
  PayrollEngine,
  isAlimonyBeneficiaryEligible,
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

describe('FOLHA-03: Pensão Alimentícia Enterprise (Solver Circular Pensão ↔ IRRF + Multi-Beneficiário)', () => {
  it('1. converge exatamente no ponto fixo Pensão (30% sobre Bruto - INSS - IRRF) ↔ IRRF com tolerância <= R$ 0,01', () => {
    const gross = 10000;
    const inss = INSSCalculator.calculate(gross, inssBrackets2026).value;

    const result = AlimonySolver.solve({
      beneficiaries: [
        {
          id: 'ben-1',
          beneficiary_name: 'Maria Clara Silva',
          beneficiary_cpf: '11122233344',
          court_process_number: '0001234-56.2026.8.26.0100',
          calculation_basis: 'NET_SALARY',
          percentage: 30,
          payment_method: 'PIX',
          pix_key_type: 'CPF',
          pix_key: '11122233344',
        },
      ],
      grossForAlimony: gross,
      baseSalary: gross,
      minimumWage: 1518.0,
      inss,
      grossForIrrf: gross,
      dependents: 0,
      irrfRegime: 'COMPETENCE',
      irrfBucket: 'MONTHLY_CASH',
      irrfBrackets,
      generalLegalParameters: generalParams2026,
    });

    expect(result.converged).toBe(true);
    expect(result.hasCircularDependency).toBe(true);
    expect(result.iterations).toBeGreaterThanOrEqual(3);
    expect(result.iterations).toBeLessThanOrEqual(15);
    expect(result.trace.length).toBe(result.iterations);

    // Verifica invariante matemática do ponto fixo com tolerância de R$ 0,01
    const recomputedIrrf = IRRFCalculator.calculate(
      gross,
      inss,
      0,
      irrfBrackets,
      generalParams2026,
      result.solvedAlimonyTotal
    );
    expect(recomputedIrrf.value).toBe(result.irrfResult.value);

    const recomputedAlimony = round2((gross - inss - recomputedIrrf.value) * 0.3);
    expect(Math.abs(recomputedAlimony - result.solvedAlimonyTotal)).toBeLessThanOrEqual(0.01);

    expect(result.splits).toHaveLength(1);
    expect(result.splits[0].irrf_converged).toBe(result.irrfResult.value);
    expect(result.splits[0].solver_iterations).toBe(result.iterations);
    expect(result.traceSummary).toContain('CONVERGIDO');
  });

  it('2. calcula rateio Multi-Beneficiário (20% Líquido + 10% Líquido + R$ 500 Fixo) somando na dedução do IRRF', () => {
    const gross = 12000;
    const inss = INSSCalculator.calculate(gross, inssBrackets2026).value;

    const result = AlimonySolver.solve({
      beneficiaries: [
        {
          id: 'ben-a',
          beneficiary_name: 'Filho A',
          calculation_basis: 'NET_SALARY',
          percentage: 20,
          payment_method: 'PIX',
          pix_key_type: 'EMAIL',
          pix_key: 'mae.filhoa@test.com',
        },
        {
          id: 'ben-b',
          beneficiary_name: 'Filho B',
          calculation_basis: 'NET_SALARY',
          percentage: 10,
          payment_method: 'BANK_TRANSFER',
          bank_code: '341',
          bank_agency: '1234',
          bank_account: '56789-0',
        },
        {
          id: 'ben-c',
          beneficiary_name: 'Ex-Cônjuge C',
          calculation_basis: 'FIXED_AMOUNT',
          fixed_amount: 500,
          payment_method: 'JUDICIAL_DEPOSIT',
        },
      ],
      grossForAlimony: gross,
      baseSalary: gross,
      minimumWage: 1518.0,
      inss,
      grossForIrrf: gross,
      dependents: 1,
      irrfRegime: 'COMPETENCE',
      irrfBucket: 'MONTHLY_CASH',
      irrfBrackets,
      generalLegalParameters: generalParams2026,
    });

    expect(result.converged).toBe(true);
    expect(result.splits).toHaveLength(3);
    const sumSplits = round2(result.splits.reduce((s, x) => s + x.amount, 0));
    expect(sumSplits).toBe(result.solvedAlimonyTotal);

    expect(result.splits[2].amount).toBe(500);
    // Filho A deve receber exatamente o dobro de Filho B (20% vs 10% do mesmo líquido)
    expect(Math.abs(result.splits[0].amount - result.splits[1].amount * 2)).toBeLessThanOrEqual(0.02);

    const checkIrrf = IRRFCalculator.calculate(
      gross,
      inss,
      1,
      irrfBrackets,
      generalParams2026,
      result.solvedAlimonyTotal
    );
    expect(checkIrrf.value).toBe(result.irrfResult.value);
  });

  it('3. compõe Solver Circular com IRRF em Regime de Caixa (FOLHA-02 + FOLHA-03)', () => {
    const gross = 8000;
    const inss = INSSCalculator.calculate(gross, inssBrackets2026).value;

    const result = AlimonySolver.solve({
      beneficiaries: [
        {
          id: 'ben-cash',
          beneficiary_name: 'Beneficiário Caixa',
          calculation_basis: 'NET_SALARY',
          percentage: 25,
        },
      ],
      grossForAlimony: gross,
      baseSalary: gross,
      minimumWage: 1518.0,
      inss,
      grossForIrrf: gross,
      dependents: 0,
      irrfRegime: 'CASH',
      irrfBucket: 'MONTHLY_CASH',
      priorCashIrrfEntries: [
        {
          gross_taxable: 2000,
          inss_deducted: 0,
          alimony_deducted: 0,
          irrf_withheld: 0,
        },
      ],
      irrfBrackets,
      generalLegalParameters: generalParams2026,
    });

    expect(result.converged).toBe(true);
    expect(result.cashIrrfResult).not.toBeNull();
    expect(result.cashIrrfResult!.accumulatedGross).toBe(10000);
    expect(result.cashIrrfResult!.accumulatedAlimony).toBe(result.solvedAlimonyTotal);

    const expectedAlimony = round2((gross - inss - result.irrfResult.value) * 0.25);
    expect(Math.abs(expectedAlimony - result.solvedAlimonyTotal)).toBeLessThanOrEqual(0.01);
  });

  it('4. respeita piso/teto judicial e bases diretas (MINIMUM_WAGE, GROSS_SALARY, BASE_SALARY)', () => {
    const result = AlimonySolver.solve({
      beneficiaries: [
        {
          id: 'ben-mw',
          beneficiary_name: 'Beneficiário SM',
          calculation_basis: 'MINIMUM_WAGE',
          percentage: 50,
          min_amount: 900,
        },
        {
          id: 'ben-gross',
          beneficiary_name: 'Beneficiário Bruto',
          calculation_basis: 'GROSS_SALARY',
          percentage: 15,
          max_amount: 600,
        },
      ],
      grossForAlimony: 5000,
      baseSalary: 4000,
      minimumWage: 1518.0,
      inss: 400,
      grossForIrrf: 5000,
      dependents: 0,
      irrfRegime: 'COMPETENCE',
      irrfBucket: 'MONTHLY_CASH',
      irrfBrackets,
      generalLegalParameters: generalParams2026,
    });

    expect(result.hasCircularDependency).toBe(false);
    // 50% de 1518 = 759, clampado pelo piso min_amount = 900
    expect(result.splits[0].amount).toBe(900);
    // 15% de 5000 = 750, clampado pelo teto max_amount = 600
    expect(result.splits[1].amount).toBe(600);
    expect(result.solvedAlimonyTotal).toBe(1500);
  });

  it('5. integra perfeitamente no PayrollEngine gravando rubrica 904, trace do solver na memória e alimony_splits', async () => {
    const rubrics: Rubric[] = [
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
        id: 'rub-901',
        code: '901',
        name: 'Contribuição INSS',
        type: 'DEDUCTION',
        category: 'TAX',
        rubric_kind: 'INSS',
        calculation_form: 'SYSTEM',
        calculation_order: 90,
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
        id: 'rub-902',
        code: '902',
        name: 'IRRF Mensal',
        type: 'DEDUCTION',
        category: 'TAX',
        rubric_kind: 'IRRF',
        calculation_form: 'SYSTEM',
        calculation_order: 95,
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
        id: 'rub-903',
        code: '903',
        name: 'FGTS Mensal',
        type: 'NEUTRAL',
        category: 'TAX',
        rubric_kind: 'FGTS',
        calculation_form: 'SYSTEM',
        calculation_order: 99,
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
        id: 'rub-904',
        code: '904',
        name: 'Pensão Alimentícia Judicial',
        type: 'DEDUCTION',
        category: 'ALIMONY',
        rubric_kind: 'ALIMONY',
        calculation_form: 'SYSTEM',
        calculation_order: 85,
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

    const ctx = new PayrollContext({
      competencia: '11/2026',
      tipo_folha: 'MONTHLY',
      empregado_id: 'wrk-1',
      contrato_id: 'ctr-1',
      salario_base: 10000,
      salario_minimo: 1518.0,
      rubricas: rubrics,
      eventos: [{ rubric_id: 'rub-101', quantity: 30, manual_value: null }],
      alimony_beneficiaries: [
        {
          id: 'ben-1',
          beneficiary_name: 'Helena Souza',
          calculation_basis: 'NET_SALARY',
          percentage: 30,
          payment_method: 'PIX',
          pix_key_type: 'CPF',
          pix_key: '99988877766',
        },
      ],
      inss_parameters: inssBrackets2026,
      irrf_parameters: irrfBrackets,
      general_legal_parameters: generalParams2026,
      irrf_regime: 'COMPETENCE',
    });

    const res = await new PayrollEngine(ctx).run();
    expect(res.status).toBe('CALCULADA');
    expect(res.alimony_splits).toHaveLength(1);
    expect(res.alimony_solver_trace?.length).toBeGreaterThanOrEqual(3);

    const solvedAlimony = res.alimony_splits![0].amount;
    expect(res.total_descontos).toBe(round2(res.total_inss + res.total_irrf + solvedAlimony));
    expect(res.liquido).toBe(round2(res.total_proventos - res.total_descontos));

    const memAlimony = res.memoria_calculo.find((m) => m.rubric_id === 'rub-904');
    const memTrace = res.memoria_calculo.find((m) => m.rubric_id === 'SOLVER_PENSAO');
    expect(memAlimony?.result_value).toBe(solvedAlimony);
    expect(memTrace?.origin).toBe('SOLVER_TRACE');
    expect(memTrace?.parsed_formula).toContain('CONVERGIDO');
  });

  it('6. filtra elegibilidade temporal e por tipo de folha corretamente', () => {
    const ben = {
      id: 'b1',
      beneficiary_name: 'Teste',
      calculation_basis: 'NET_SALARY' as const,
      percentage: 20,
      apply_on_monthly: true,
      apply_on_advance: false,
      apply_on_vacation: true,
      apply_on_thirteenth: true,
      start_date: '2026-06-01',
      end_date: '2026-12-31',
    };

    expect(isAlimonyBeneficiaryEligible(ben, 'MONTHLY', 2026, 5)).toBe(false);
    expect(isAlimonyBeneficiaryEligible(ben, 'MONTHLY', 2026, 11)).toBe(true);
    expect(isAlimonyBeneficiaryEligible(ben, 'ADVANCE', 2026, 11)).toBe(false);
    expect(isAlimonyBeneficiaryEligible(ben, 'THIRTEENTH_1', 2026, 11)).toBe(false);
    expect(isAlimonyBeneficiaryEligible(ben, 'THIRTEENTH_2', 2026, 12)).toBe(true);
    expect(isAlimonyBeneficiaryEligible(ben, 'VACATION', 2026, 7)).toBe(true);
  });
});
