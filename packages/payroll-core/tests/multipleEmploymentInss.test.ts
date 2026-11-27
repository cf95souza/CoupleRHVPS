import { describe, it, expect } from 'vitest';
import {
  MultipleEmploymentINSSCalculator,
  PayrollContext,
  PayrollEngine,
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

const rubrics: Rubric[] = [
  {
    id: 'r-101',
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

describe('MultipleEmploymentINSSCalculator (FOLHA-06 — indMV 1/2/3)', () => {
  it('indMV = 1 aplica progressividade acumulada até o teto previdenciário 2026 (R$ 8.157,41)', () => {
    // Empregador A (externo): R$ 5.000,00 | Contrato B (atual): R$ 5.000,00 -> Soma 10.000 > teto 8.157,41
    // INSS(8.157,41) = 951,63 | INSS(5.000) = 509,60 -> Diferença devida em B = 442,03
    const res = MultipleEmploymentINSSCalculator.calculate({
      currentBaseInss: 5000.0,
      otherEmployments: [
        {
          employer_cnpj: '11222333000181',
          employer_name: 'Outro Empregador A',
          ind_mv: 1,
          remuneration_amount: 5000.0,
        },
      ],
      inssBrackets: inss2026,
    });

    expect(res.indMv).toBe(1);
    expect(res.hasMultipleEmployments).toBe(true);
    expect(res.externalBaseTotal).toBe(5000.0);
    expect(res.totalCombinedInssContribution).toBe(951.63);
    expect(res.value).toBe(442.03);
  });

  it('indMV = 2 complementa exatamente a diferença entre o devido combinado e o INSS comprovadamente retido', () => {
    // Soma R$ 6.000,00 (3.500 externo + 2.500 atual) -> INSS(6.000) = 649,60
    // Se empregador externo reteve R$ 316,00 -> complemento devido = 649,60 - 316,00 = 333,60
    const res = MultipleEmploymentINSSCalculator.calculate({
      currentBaseInss: 2500.0,
      otherEmployments: [
        {
          employer_cnpj: '22333444000199',
          employer_name: 'Clínica Externa Ltda',
          ind_mv: 2,
          remuneration_amount: 3500.0,
          inss_withheld: 316.0,
        },
      ],
      inssBrackets: inss2026,
    });

    expect(res.indMv).toBe(2);
    expect(res.value).toBe(333.6);
  });

  it('indMV = 3 zera retenção de INSS do segurado mas preserva base INSS patronal/FGTS no PayrollEngine', async () => {
    const ctx = new PayrollContext({
      competencia: '06/2026',
      tipo_folha: 'MONTHLY',
      empregado_id: 'w-mv3',
      contrato_id: 'c-mv3',
      salario_base: 4000.0,
      dias_trabalhados: 30,
      dias_uteis: 22,
      dias_inuteis: 8,
      divisor: 220,
      rubricas: rubrics,
      eventos: [{ rubric_id: 'r-101', quantity: 30 }],
      inss_parameters: inss2026,
      irrf_parameters: irrf2026,
      general_legal_parameters: legal2026,
      other_employments: [
        {
          employer_cnpj: '99888777000166',
          employer_name: 'Hospital Central S.A.',
          ind_mv: 3,
          remuneration_amount: 9500.0,
          inss_withheld: 951.63,
        },
      ],
    });

    const result = await new PayrollEngine(ctx).run();
    expect(result.ind_mv).toBe(3);
    expect(result.total_inss).toBe(0);
    expect(result.bases.inss).toBe(4000.0); // Base INSS Patronal continua 100% preservada
    expect(result.bases.fgts).toBe(4000.0);
    expect(result.total_fgts).toBe(320.0);
    expect(result.other_employments_base).toBe(9500.0);
    expect(result.other_employments_inss).toBe(951.63);
  });
});
