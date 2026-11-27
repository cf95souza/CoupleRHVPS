import { describe, expect, it } from 'vitest';
import { RetroactiveDissidioCalculator } from '../src/engine/RetroactiveDissidioCalculator.js';
import { INSSCalculator } from '../src/legal/INSSCalculator.js';

const inss2026 = [
  { bracket_number: 1, base_limit: 1518.0, aliquot: 7.5, deduction: 0 },
  { bracket_number: 2, base_limit: 2793.88, aliquot: 9.0, deduction: 0 },
  { bracket_number: 3, base_limit: 4190.83, aliquot: 12.0, deduction: 0 },
  { bracket_number: 4, base_limit: 8157.41, aliquot: 14.0, deduction: 0 },
];

const irrf2026 = [
  { bracket_number: 1, base_limit: 2259.2, aliquot: 0, deduction: 0 },
  { bracket_number: 2, base_limit: 2826.65, aliquot: 7.5, deduction: 169.44 },
  { bracket_number: 3, base_limit: 3751.05, aliquot: 15.0, deduction: 381.44 },
  { bracket_number: 4, base_limit: 4664.68, aliquot: 22.5, deduction: 662.77 },
  { bracket_number: 5, base_limit: null, aliquot: 27.5, deduction: 896.0 },
];

const params2026 = {
  minimum_wage: 1518.0,
  dependent_deduction: 189.59,
  simplified_discount: 564.8,
  fgts_standard_aliquot: 8.0,
  fgts_apprentice_aliquot: 2.0,
  irrf_exemption_limit: 5000.0,
  irrf_reduction_formula_limit: 7350.0,
  irrf_reduction_a: 978.62,
  irrf_reduction_b: 0.133145,
};

describe('FOLHA-14: Dissídio Coletivo Retroativo Multi-Competência + RRA (Art. 12-A)', () => {
  it('recalcula dissídio 8% retroativo 3 meses com HE + DSR em Junho e apura INSS/FGTS/IRRF sem dupla subtração', () => {
    const res = RetroactiveDissidioCalculator.calculate({
      contractId: 'c-1',
      adjustmentType: 'PERCENTAGE',
      percentage: 8,
      paymentYear: 2026,
      paymentMonth: 8, // Pago em Agosto/2026
      defaultInssBrackets: inss2026,
      paymentIrrfBrackets: irrf2026,
      generalLegalParameters: params2026,
      competences: [
        {
          year: 2026,
          month: 5,
          periodType: 'MONTHLY',
          originalBaseSalary: 3000,
          originalBaseInss: 3000,
          originalBaseFgts: 3000,
          originalInssEmployee: INSSCalculator.calculate(3000, inss2026).value,
          items: [
            { rubricCode: '101', rubricName: 'Salário Base', category: 'SALARY', originalAmount: 3000 },
          ],
        },
        {
          year: 2026,
          month: 6, // Mês com HE 50% (R$ 300) + DSR (R$ 60)
          periodType: 'MONTHLY',
          originalBaseSalary: 3000,
          originalBaseInss: 3360,
          originalBaseFgts: 3360,
          originalInssEmployee: INSSCalculator.calculate(3360, inss2026).value,
          items: [
            { rubricCode: '101', rubricName: 'Salário Base', category: 'SALARY', originalAmount: 3000 },
            { rubricCode: '102', rubricName: 'Horas Extras 50%', category: 'OVERTIME', originalAmount: 300 },
            { rubricCode: '401', rubricName: 'DSR sobre HE', category: 'DSR', originalAmount: 60 },
          ],
        },
        {
          year: 2026,
          month: 7,
          periodType: 'MONTHLY',
          originalBaseSalary: 3000,
          originalBaseInss: 3000,
          originalBaseFgts: 3000,
          originalInssEmployee: INSSCalculator.calculate(3000, inss2026).value,
          items: [
            { rubricCode: '101', rubricName: 'Salário Base', category: 'SALARY', originalAmount: 3000 },
          ],
        },
      ],
    });

    // Diferenças: Salário 3 * 240 = 720 (rubrica 110); Reflexos Junho = 24 + 4.80 = 28.80 (rubrica 111) -> Total = 748.80
    expect(res.totalDiffSalary110).toBe(720);
    expect(res.totalDiffReflexes111).toBe(28.8);
    expect(res.totalGrossDiff).toBe(748.8);

    // INSS diferencial exato na faixa de 12% sobre 748.80 = R$ 89.86 (sem dupla subtração)
    const expInss5 = INSSCalculator.calculate(3240, inss2026).value - INSSCalculator.calculate(3000, inss2026).value;
    const expInss6 = INSSCalculator.calculate(3628.8, inss2026).value - INSSCalculator.calculate(3360, inss2026).value;
    const expInss7 = INSSCalculator.calculate(3240, inss2026).value - INSSCalculator.calculate(3000, inss2026).value;
    expect(res.totalInssDiff).toBe(Number((expInss5 + expInss6 + expInss7).toFixed(2)));

    // FGTS diferencial = 8% de 748.80 = R$ 59.90
    expect(res.totalFgtsDiff).toBe(59.9);
    expect(res.breakdown).toHaveLength(5);
    expect(res.breakdown[1].ideAdc.perRef).toBe('2026-06');
  });

  it('aplica tabela RRA Art. 12-A (escalonamento por NM meses) quando há competências de ano-calendário anterior', () => {
    // 6 meses de 2025 pagos em 2026 -> R$ 4.000/mês de diferença = R$ 24.000 bruto (NM = 6)
    const months2025 = [7, 8, 9, 10, 11, 12].map((m) => ({
      year: 2025,
      month: m,
      periodType: 'MONTHLY',
      originalBaseSalary: 5000,
      originalBaseInss: 5000,
      originalBaseFgts: 5000,
      originalInssEmployee: INSSCalculator.calculate(5000, inss2026).value,
      items: [
        { rubricCode: '101', rubricName: 'Salário Base', category: 'SALARY', originalAmount: 5000 },
      ],
    }));

    const res = RetroactiveDissidioCalculator.calculate({
      contractId: 'c-rra',
      adjustmentType: 'PERCENTAGE',
      percentage: 80, // +4000/mês para testar faixa RRA claramente acima da isenção escalonada
      paymentYear: 2026,
      paymentMonth: 2,
      applyRra: true,
      defaultInssBrackets: inss2026,
      paymentIrrfBrackets: irrf2026,
      generalLegalParameters: params2026,
      competences: months2025,
    });

    expect(res.priorYearsMonthsCount).toBe(6);
    expect(res.priorYearsGrossDiff).toBe(24000);
    expect(res.priorYearsIrrfRra).toBeGreaterThan(0);
    expect(res.currentYearIrrf).toBe(0);
  });
});
