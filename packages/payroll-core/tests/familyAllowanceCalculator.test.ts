import { describe, it, expect } from 'vitest';
import {
  FamilyAllowanceCalculator,
  PayrollContext,
  PayrollEngine,
  calculateConsolidatedEmployerTaxes,
  aggregateCompanyBases,
  type Rubric,
  type InssBracket,
  type IrrfBracket,
  type GeneralLegalParameters,
} from '../src/index.js';

const inss2026: InssBracket[] = [
  { bracket_number: 1, base_limit: 1518.0, aliquot: 7.5, deduction: 0 },
  { bracket_number: 2, base_limit: 2793.88, aliquot: 9.0, deduction: 0 },
  { bracket_number: 3, base_limit: 4190.83, aliquot: 12.0, deduction: 0 },
  { bracket_number: 4, base_limit: 8157.41, aliquot: 14.0, deduction: 0 },
];

const irrf2026: IrrfBracket[] = [
  { bracket_number: 1, base_limit: 2259.2, aliquot: 0, deduction: 0 },
  { bracket_number: 2, base_limit: 2826.65, aliquot: 7.5, deduction: 169.44 },
  { bracket_number: 3, base_limit: 3751.05, aliquot: 15.0, deduction: 381.44 },
  { bracket_number: 4, base_limit: 4664.68, aliquot: 22.5, deduction: 662.77 },
  { bracket_number: 5, base_limit: null, aliquot: 27.5, deduction: 896.0 },
];

const legal2026: GeneralLegalParameters = {
  minimum_wage: 1518.0,
  dependent_deduction: 189.59,
  simplified_discount: 564.8,
  family_salary_value: 62.04,
  family_salary_ceiling: 1819.26,
  fgts_standard_aliquot: 8.0,
  fgts_apprentice_aliquot: 2.0,
};

const baseRubrics: Rubric[] = [
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
    id: 'r-102',
    code: '102',
    name: 'Horas Extras 50%',
    type: 'EARNING',
    category: 'OVERTIME',
    rubric_kind: 'OVERTIME',
    calculation_form: 'HORAS',
    factor: 1.5,
    divisor: 220,
    calculation_order: 20,
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
      integra_dsr: true,
    },
  },
  {
    id: 'r-305',
    code: '305',
    name: 'Salário-Família',
    type: 'EARNING',
    category: 'FAMILY_SALARY',
    rubric_kind: 'FAMILY_SALARY',
    calculation_form: 'SYSTEM',
    calculation_order: 35,
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
    id: 'r-901',
    code: '901',
    name: 'INSS',
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
    id: 'r-902',
    code: '902',
    name: 'IRRF',
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
    id: 'r-903',
    code: '903',
    name: 'FGTS',
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
];

describe('FamilyAllowanceCalculator & Integração Salário-Família (FOLHA-05)', () => {
  it('concede cotas integrais para filhos <= 14 com vacina/escola válidas e inválido de qualquer idade', () => {
    const res = FamilyAllowanceCalculator.calculate({
      competenceYear: 2026,
      competenceMonth: 5,
      monthlyInssBase: 1700.0,
      contractualSalary: 1700.0,
      familySalaryCeiling: 1819.26,
      quotaValue: 62.04,
      admissionDate: '2024-01-10',
      employeeRegime: 'CLT',
      dependents: [
        {
          id: 'd1',
          name: 'Filho 4 anos (vacinado)',
          birth_date: '2022-03-10',
          relationship: 'FILHO',
          is_family_salary: true,
          vaccination_card_date: '2026-01-15',
        },
        {
          id: 'd2',
          name: 'Filha 11 anos (escola em dia)',
          birth_date: '2015-02-20',
          relationship: 'FILHO',
          is_family_salary: true,
          school_frequency_date: '2026-03-01',
        },
        {
          id: 'd3',
          name: 'Filho 22 anos (inválido)',
          birth_date: '2004-01-05',
          relationship: 'FILHO',
          is_family_salary: true,
          is_incapacitated: true,
        },
        {
          id: 'd4',
          name: 'Filho 16 anos (acima do limite)',
          birth_date: '2010-01-05',
          relationship: 'FILHO',
          is_family_salary: true,
        },
      ],
    });

    expect(res.eligibleByRegime).toBe(true);
    expect(res.eligibleByCeiling).toBe(true);
    expect(res.eligibleDependentsCount).toBe(3);
    expect(res.totalAmount).toBe(186.12);
    expect(res.dctfWebDeductibleAmount).toBe(186.12);
    expect(res.rejectedDependents.some((r) => r.reasonCode === 'OVER_AGE_14')).toBe(true);
  });

  it('bloqueia cota quando vacinação (<=6 anos) ou frequência escolar (7..14 anos) está ausente/vencida', () => {
    const res = FamilyAllowanceCalculator.calculate({
      competenceYear: 2026,
      competenceMonth: 8,
      monthlyInssBase: 1600.0,
      familySalaryCeiling: 1819.26,
      quotaValue: 62.04,
      dependents: [
        {
          id: 'd-vac-exp',
          name: 'Vacina Vencida',
          birth_date: '2022-04-01',
          relationship: 'FILHO',
          is_family_salary: true,
          vaccination_card_date: '2025-05-01', // 15 meses antes de 2026-08
        },
        {
          id: 'd-esc-miss',
          name: 'Sem Escola',
          birth_date: '2016-06-01',
          relationship: 'FILHO',
          is_family_salary: true,
          school_frequency_date: null,
        },
        {
          id: 'd-esc-exp',
          name: 'Escola Vencida',
          birth_date: '2014-01-01',
          relationship: 'ENTEADO',
          is_family_salary: true,
          school_frequency_date: '2025-11-10', // 9 meses antes de 2026-08
        },
      ],
    });

    expect(res.eligibleDependentsCount).toBe(0);
    expect(res.totalAmount).toBe(0);
    expect(res.complianceAlerts.map((a) => a.reasonCode)).toEqual([
      'VACCINATION_EXPIRED',
      'SCHOOL_FREQUENCY_MISSING',
      'SCHOOL_FREQUENCY_EXPIRED',
    ]);
  });

  it('aplica proporcionalidade na admissão e demissão e avalia teto pelo salário contratual equivalente', () => {
    // Admitido em 17/03/2026 (15 dias corridos de março/31) com salário R$ 1.800 (<= teto)
    const admRes = FamilyAllowanceCalculator.calculate({
      competenceYear: 2026,
      competenceMonth: 3,
      monthlyInssBase: 870.97,
      contractualSalary: 1800.0,
      familySalaryCeiling: 1819.26,
      quotaValue: 62.04,
      admissionDate: '2026-03-17',
      dependents: [
        {
          id: 'd1',
          name: 'Filho 3 anos',
          birth_date: '2023-01-10',
          relationship: 'FILHO',
          is_family_salary: true,
          vaccination_card_date: '2026-01-10',
        },
      ],
    });

    expect(admRes.proportionalDays).toBe(15);
    expect(admRes.daysInMonth).toBe(31);
    expect(admRes.totalAmount).toBe(30.02);

    // Admitido em 17/03/2026 ganhando R$ 3.000/mês (saldo proporcional 1.451,61 < teto, mas contratual > teto!)
    const overCeilingPartialRes = FamilyAllowanceCalculator.calculate({
      competenceYear: 2026,
      competenceMonth: 3,
      monthlyInssBase: 1451.61,
      contractualSalary: 3000.0,
      familySalaryCeiling: 1819.26,
      quotaValue: 62.04,
      admissionDate: '2026-03-17',
      dependents: [
        {
          id: 'd1',
          name: 'Filho 3 anos',
          birth_date: '2023-01-10',
          relationship: 'FILHO',
          is_family_salary: true,
          vaccination_card_date: '2026-01-10',
        },
      ],
    });

    expect(overCeilingPartialRes.eligibleByCeiling).toBe(false);
    expect(overCeilingPartialRes.totalAmount).toBe(0);
  });

  it('integra rubrica 305 no PayrollEngine respeitando teto sobre remuneração bruta INSS (incl. HE) e abatimento DCTFWeb', async () => {
    // Caso 1: Salário R$ 1.600 sem HE -> recebe 1 cota R$ 62,04 sem incidir INSS/FGTS
    const ctxOk = new PayrollContext({
      competencia: '05/2026',
      tipo_folha: 'MONTHLY',
      empregado_id: 'w1',
      contrato_id: 'c1',
      salario_base: 1600.0,
      dias_trabalhados: 30,
      dias_uteis: 25,
      dias_inuteis: 5,
      divisor: 220,
      rubricas: baseRubrics,
      eventos: [{ rubric_id: 'r-101', quantity: 30 }],
      inss_parameters: inss2026,
      irrf_parameters: irrf2026,
      general_legal_parameters: legal2026,
      admission_date: '2025-01-01',
      employee_regime: 'CLT',
      family_salary_dependents: [
        {
          id: 'd1',
          name: 'Filha 5 anos',
          birth_date: '2021-01-10',
          relationship: 'FILHO',
          is_family_salary: true,
          vaccination_card_date: '2026-02-01',
        },
      ],
    });

    const resOk = await new PayrollEngine(ctxOk).run();
    expect(resOk.total_family_salary).toBe(62.04);
    expect(resOk.bases.inss).toBe(1600.0); // Salário-família NÃO integra base de INSS
    expect(resOk.bases.fgts).toBe(1600.0); // Salário-família NÃO integra base de FGTS
    expect(resOk.total_proventos).toBe(1662.04);

    // Abatimento na DCTFWeb
    const totals = aggregateCompanyBases({
      calculatedPayslips: [
        {
          contract_id: 'c1',
          base_inss: resOk.bases.inss,
          base_fgts: resOk.bases.fgts,
          fgts_month: resOk.total_fgts,
          inss_employee: resOk.total_inss,
          family_salary_deduction: resOk.total_family_salary,
        },
      ],
      contractCompanyMap: { c1: 'comp1' },
    });
    const companyTaxes = calculateConsolidatedEmployerTaxes({
      tenant_id: 't1',
      period_id: 'p1',
      companyTotals: totals,
      companies: [{ id: 'comp1', tax_regime: 'LUCRO_PRESUMIDO', labor_config: { rat_aliquot: 2, fap_multiplier: 1, terceiros_aliquot: 5.8 } }],
    });
    expect(companyTaxes[0].family_salary_deduction).toBe(62.04);
    const grossDctfWeb =
      resOk.total_inss +
      companyTaxes[0].inss_patronal +
      companyTaxes[0].rat_adjusted +
      companyTaxes[0].terceiros;
    expect(companyTaxes[0].net_inss_due).toBe(Number((grossDctfWeb - 62.04).toFixed(2)));

    // Caso 2: Mesmo colaborador com 40h de HE 50% (ultrapassa teto R$ 1.819,26) -> perde cota automaticamente
    const ctxOver = new PayrollContext({
      competencia: '05/2026',
      tipo_folha: 'MONTHLY',
      empregado_id: 'w1',
      contrato_id: 'c1',
      salario_base: 1600.0,
      dias_trabalhados: 30,
      dias_uteis: 25,
      dias_inuteis: 5,
      divisor: 220,
      rubricas: baseRubrics,
      eventos: [
        { rubric_id: 'r-101', quantity: 30 },
        { rubric_id: 'r-102', quantity: 40 },
      ],
      inss_parameters: inss2026,
      irrf_parameters: irrf2026,
      general_legal_parameters: legal2026,
      admission_date: '2025-01-01',
      employee_regime: 'CLT',
      family_salary_dependents: [
        {
          id: 'd1',
          name: 'Filha 5 anos',
          birth_date: '2021-01-10',
          relationship: 'FILHO',
          is_family_salary: true,
          vaccination_card_date: '2026-02-01',
        },
      ],
    });

    const resOver = await new PayrollEngine(ctxOver).run();
    expect(resOver.bases.inss).toBeGreaterThan(1819.26);
    expect(resOver.total_family_salary).toBe(0);
    expect(resOver.family_salary_evaluation?.eligibleByCeiling).toBe(false);
  });
});
