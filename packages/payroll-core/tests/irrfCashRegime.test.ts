import { describe, it, expect } from 'vitest';
import {
  IRRFCalculator,
  resolveIrrfTaxationBucket,
  calculateDefaultPaymentDate,
  calculateFifthBusinessDay,
} from '../src/index.js';

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

describe('FOLHA-02: IRRF em Regime de Caixa (Lei 7.713/88 / IN RFB 1.500)', () => {
  it('1. Aceite Blueprint: Salário Outubro pago em 06/11 (R$ 4.000) + Adiantamento Novembro pago em 20/11 (R$ 2.000) soma base R$ 6.000 no caixa Novembro com retenção incremental exata', () => {
    // 1º Pagamento no mês de caixa Novembro/2026: Salário Outubro pago em 06/11 = R$ 4.000 (INSS R$ 378,82)
    // Como R$ 4.000 <= R$ 5.000 (faixa de isenção 2026), IRRF em 06/11 = R$ 0,00
    const firstPayment = IRRFCalculator.calculateCashConsolidated({
      current: {
        grossIncome: 4000,
        inss: 378.82,
        dependents: 0,
        alimony: 0,
      },
      priorEntries: [],
      bucket: 'MONTHLY_CASH',
      brackets: irrfBrackets,
      params: generalParams2026,
    });

    expect(firstPayment.value).toBe(0);
    expect(firstPayment.accumulatedGross).toBe(4000);
    expect(firstPayment.priorIrrfWithheld).toBe(0);

    // 2º Pagamento no MESMO mês de caixa Novembro/2026: Adiantamento Novembro pago em 20/11 = R$ 2.000 (sem novo INSS)
    // Soma no caixa Novembro: R$ 4.000 + R$ 2.000 = R$ 6.000 (acima de R$ 5.000!)
    const secondPayment = IRRFCalculator.calculateCashConsolidated({
      current: {
        grossIncome: 2000,
        inss: 0,
        dependents: 0,
        alimony: 0,
      },
      priorEntries: [
        {
          gross_taxable: 4000,
          inss_deducted: 378.82,
          alimony_deducted: 0,
          irrf_withheld: firstPayment.value,
        },
      ],
      bucket: 'MONTHLY_CASH',
      brackets: irrfBrackets,
      params: generalParams2026,
    });

    // Compara exatamente contra IRRFCalculator.calculate(6000, 378.82, 0, ...)
    const expectedTotalCash = IRRFCalculator.calculate(6000, 378.82, 0, irrfBrackets, generalParams2026, 0);

    expect(secondPayment.accumulatedGross).toBe(6000);
    expect(secondPayment.accumulatedInss).toBe(378.82);
    expect(secondPayment.totalCashIrrf).toBe(expectedTotalCash.value);
    expect(secondPayment.value).toBe(expectedTotalCash.value);
    expect(secondPayment.value).toBeGreaterThan(0);
    expect(secondPayment.bucket).toBe('MONTHLY_CASH');
  });

  it('2. deve abater IRRF já retido anteriormente no mesmo mês de caixa (ex: salário R$ 8.000 + complementar R$ 1.500 no mesmo caixa)', () => {
    const first = IRRFCalculator.calculateCashConsolidated({
      current: { grossIncome: 8000, inss: 951.63, dependents: 1, alimony: 0 },
      priorEntries: [],
      bucket: 'MONTHLY_CASH',
      brackets: irrfBrackets,
      params: generalParams2026,
    });

    const second = IRRFCalculator.calculateCashConsolidated({
      current: { grossIncome: 1500, inss: 0, dependents: 1, alimony: 0 },
      priorEntries: [
        {
          gross_taxable: 8000,
          inss_deducted: 951.63,
          alimony_deducted: 0,
          irrf_withheld: first.value,
        },
      ],
      bucket: 'MONTHLY_CASH',
      brackets: irrfBrackets,
      params: generalParams2026,
    });

    const expectedTotal = IRRFCalculator.calculate(9500, 951.63, 1, irrfBrackets, generalParams2026, 0);

    expect(second.totalCashIrrf).toBe(expectedTotal.value);
    expect(second.priorIrrfWithheld).toBe(first.value);
    // Soma das retenções no mês de caixa == imposto total devido sobre R$ 9.500
    expect(Number((first.value + second.value).toFixed(2))).toBe(expectedTotal.value);
  });

  it('3. deve isolar Férias (VACATION_EXCLUSIVE) e 13º (THIRTEENTH_EXCLUSIVE) sem somar ao caixa MONTHLY_CASH', () => {
    const vacationRes = IRRFCalculator.calculateCashConsolidated({
      current: { grossIncome: 4500, inss: 430, dependents: 0, alimony: 0 },
      priorEntries: [
        {
          gross_taxable: 4000,
          inss_deducted: 378.82,
          alimony_deducted: 0,
          irrf_withheld: 0,
        },
      ],
      bucket: 'VACATION_EXCLUSIVE',
      brackets: irrfBrackets,
      params: generalParams2026,
    });

    expect(vacationRes.accumulatedGross).toBe(4500);
    expect(vacationRes.priorIrrfWithheld).toBe(0);
    expect(vacationRes.value).toBe(0); // R$ 4.500 isolado isento pela regra 2026

    const thirteenthRes = IRRFCalculator.calculateCashConsolidated({
      current: { grossIncome: 4500, inss: 430, dependents: 0, alimony: 0 },
      priorEntries: [
        {
          gross_taxable: 4000,
          inss_deducted: 378.82,
          alimony_deducted: 0,
          irrf_withheld: 0,
        },
      ],
      bucket: 'THIRTEENTH_EXCLUSIVE',
      brackets: irrfBrackets,
      params: generalParams2026,
    });

    expect(thirteenthRes.accumulatedGross).toBe(4500);
    expect(thirteenthRes.value).toBe(0);
  });

  it('4. deve mapear corretamente buckets de tributação e datas de pagamento (5º dia útil vs último dia)', () => {
    expect(resolveIrrfTaxationBucket('MONTHLY')).toBe('MONTHLY_CASH');
    expect(resolveIrrfTaxationBucket('ADVANCE')).toBe('MONTHLY_CASH');
    expect(resolveIrrfTaxationBucket('COMPLEMENTARY')).toBe('MONTHLY_CASH');
    expect(resolveIrrfTaxationBucket('VACATION')).toBe('VACATION_EXCLUSIVE');
    expect(resolveIrrfTaxationBucket('THIRTEENTH_2')).toBe('THIRTEENTH_EXCLUSIVE');
    expect(resolveIrrfTaxationBucket('PROFIT_SHARING')).toBe('PLR_EXCLUSIVE');

    // Outubro/2026 -> 5º dia útil de Novembro/2026 (02/11 Finados é feriado nacional! Sábado 07/11 conta como útil na CLT):
    // 01/11 dom, 02/11 seg (Finados), 03/11 ter (1º), 04/11 qua (2º), 05/11 qui (3º), 06/11 sex (4º), 07/11 sáb (5º)
    const fifthNovWithHoliday = calculateFifthBusinessDay(2026, 11, ['2026-11-02']);
    expect(fifthNovWithHoliday).toBe('2026-11-07');

    // Sem feriado em 02/11: 02(1), 03(2), 04(3), 05(4), 06(5) -> 06/11
    const fifthNovNoHoliday = calculateFifthBusinessDay(2026, 11, []);
    expect(fifthNovNoHoliday).toBe('2026-11-06');

    expect(
      calculateDefaultPaymentDate(2026, 10, 'MONTHLY', { salary_payment_rule: 'LAST_DAY_OF_MONTH' }, [])
    ).toBe('2026-10-31');

    expect(
      calculateDefaultPaymentDate(2026, 11, 'ADVANCE', { salary_payment_rule: 'FIFTH_BUSINESS_DAY' }, [])
    ).toBe('2026-11-20');
  });
});
