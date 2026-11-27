import { describe, expect, it } from 'vitest';
import { EmployerTaxesCalculator, getLei14973CppRate } from '../src/legal/EmployerTaxesCalculator.js';
import { aggregateCompanyBases, calculateConsolidatedEmployerTaxes } from '../src/engine/CompanyTaxesAggregator.js';

describe('FOLHA-16: Encargos Patronais Avançados (CPRB Mista, Lei 14.973/2024, RAT Especial, Pró-Labore e DCTFWeb)', () => {
  it('aplica tabela gradual de reoneração da CPRB conforme Lei 14.973/2024', () => {
    expect(getLei14973CppRate(2024)).toBe(0);
    expect(getLei14973CppRate(2025)).toBe(5);
    expect(getLei14973CppRate(2026)).toBe(10);
    expect(getLei14973CppRate(2027)).toBe(15);
    expect(getLei14973CppRate(2028)).toBe(20);
  });

  it('calcula CPRB proporcional para empresa com receita mista em 2026 (60% desonerada a 10% + 40% tributada a 20% = 14%)', () => {
    const res = EmployerTaxesCalculator.calculateAdvanced({
      baseInssEmployees: 10000,
      baseInssIndividualContributors: 5000, // Pró-Labore: paga 14% CPP, sem RAT/Terceiros
      baseFgts: 10000,
      fgtsMonthSum: 800,
      config: {
        tax_regime: 'LUCRO_REAL',
        is_cprb_exempted: true,
        cprb_gross_revenue_exempt: 600000,
        cprb_gross_revenue_total: 1000000,
        competence_year: 2026,
      },
    });

    // Taxa efetiva = (0.40 * 20%) + (0.60 * 10%) = 8% + 6% = 14%
    expect(res.cprb_reduction_ratio).toBe(0.6);
    expect(res.cprb_effective_cpp_rate).toBe(14);
    expect(res.inss_patronal).toBe(1400);
    expect(res.inss_patronal_pro_labore).toBe(700);
    expect(res.rat_adjusted).toBe(200);
    expect(res.terceiros).toBe(580);
    expect(res.fgts_patronal).toBe(800);
  });

  it('fecha empresa mista (CLT + Aprendiz 2% + Pró-Labore + Maternidade + Salário-Família + RAT 6%) ao centavo na DCTFWeb e FGTS Digital', () => {
    const contractCompanyMap = {
      'c-clt': 'comp-1',
      'c-apr': 'comp-1',
      'c-pro': 'comp-1',
      'c-mat': 'comp-1',
    };

    const totals = aggregateCompanyBases({
      contractCompanyMap,
      calculatedPayslips: [
        {
          contract_id: 'c-clt',
          base_inss: 10000, // exposto FAE '04' -> +6% = R$ 600,00
          base_fgts: 10000,
          fgts_month: 800,
          inss_employee: 1100,
          family_salary_deduction: 62.04,
          calculation_regime: 'CLT',
          special_retirement_exposure_code: '04',
        },
        {
          contract_id: 'c-apr',
          base_inss: 1518,
          base_fgts: 1518,
          fgts_month: 30.36, // 2% aprendiz
          inss_employee: 113.85,
          calculation_regime: 'APPRENTICE',
          special_retirement_exposure_code: '01',
        },
        {
          contract_id: 'c-pro',
          base_inss: 5000, // Pró-Labore: 20% = 1.000, 0% RAT, 0% Terceiros, 0% FGTS
          base_fgts: 0,
          fgts_month: 0,
          inss_employee: 550, // 11%
          calculation_regime: 'PRO_LABORE',
        },
        {
          contract_id: 'c-mat',
          base_inss: 3000,
          base_fgts: 3000,
          fgts_month: 240,
          inss_employee: 258,
          maternity_deduction: 3000,
          calculation_regime: 'CLT',
        },
      ],
    });

    const taxes = calculateConsolidatedEmployerTaxes({
      tenant_id: 't-1',
      period_id: 'p-1',
      competence_year: 2026,
      companyTotals: totals,
      companies: [
        {
          id: 'comp-1',
          tax_regime: 'LUCRO_PRESUMIDO',
          labor_config: { rat_percentage: 2, fap_multiplier: 1.0, terceiros_percentage: 5.8 },
        },
      ],
    });

    expect(taxes).toHaveLength(1);
    const t = taxes[0];
    // Base empregados = 10000 + 1518 + 3000 = 14518
    // INSS Patronal empregados = 20% * 14518 = 2903.60
    // INSS Patronal pró-labore = 20% * 5000 = 1000.00
    // RAT 2% * 14518 = 290.36; RAT Especial 6% * 10000 = 600.00
    // Terceiros 5.8% * 14518 = 842.04
    // Segurados = 1100 + 113.85 + 550 + 258 = 2021.85
    // Bruto DCTFWeb = 2021.85 + 2903.60 + 1000.00 + 290.36 + 600.00 + 842.04 = 7657.85
    // Deduções = 3000 + 62.04 = 3062.04 -> Líquido DCTFWeb = 4595.81
    // FGTS Digital = 800 + 30.36 + 0 + 240 = 1070.36
    expect(t.inss_patronal).toBe(2903.6);
    expect(t.inss_patronal_pro_labore).toBe(1000);
    expect(t.rat_adjusted).toBe(290.36);
    expect(t.rat_special_retirement_amount).toBe(600);
    expect(t.terceiros).toBe(842.04);
    expect(t.fgts_patronal).toBe(1070.36);
    expect(t.net_inss_due).toBe(4595.81);
  });
});
