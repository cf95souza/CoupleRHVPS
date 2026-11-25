import { describe, it, expect } from 'vitest';
import { INSSCalculator } from '../src/legal/INSSCalculator.js';
import { IRRFCalculator } from '../src/legal/IRRFCalculator.js';
import { FGTSCalculator } from '../src/legal/FGTSCalculator.js';

describe('Calculadoras Legais CLT (INSS, IRRF, FGTS)', () => {
  const inssBrackets = [
    { bracket_number: 1, base_limit: 1518.00, aliquot: 7.5 },
    { bracket_number: 2, base_limit: 2793.88, aliquot: 9.0 },
    { bracket_number: 3, base_limit: 4190.83, aliquot: 12.0 },
    { bracket_number: 4, base_limit: 8157.41, aliquot: 14.0 }
  ];

  const generalParams = {
    minimum_wage: 1518.00,
    inss_ceiling: 8157.41,
    dependent_deduction: 189.59,
    simplified_discount: 564.80,
    family_salary_ceiling: 1819.26,
    family_salary_value: 62.04,
    fgts_standard_aliquot: 8.0,
    fgts_apprentice_aliquot: 2.0,
    irrf_exemption_limit: 5000.00,
    irrf_reduction_formula_limit: 7350.00,
    irrf_reduction_a: 978.62,
    irrf_reduction_b: 0.133145
  };

  const irrfBrackets = [
    { bracket_number: 1, base_limit: 2259.20, aliquot: 0.0, deduction: 0.0 },
    { bracket_number: 2, base_limit: 2826.65, aliquot: 7.5, deduction: 169.44 },
    { bracket_number: 3, base_limit: 3751.05, aliquot: 15.0, deduction: 381.44 },
    { bracket_number: 4, base_limit: 4664.68, aliquot: 22.5, deduction: 662.77 },
    { bracket_number: 5, base_limit: 999999.00, aliquot: 27.5, deduction: 896.00 }
  ];

  it('deve calcular INSS progressivo na 1a faixa (salario minimo)', () => {
    const res = INSSCalculator.calculate(1518.00, inssBrackets as any);
    expect(res.value).toBe(113.85); // 1518 * 0.075
  });

  it('deve respeitar o teto do INSS para salarios acima do limite maximo', () => {
    const res = INSSCalculator.calculate(15000.00, inssBrackets as any);
    expect(res.value).toBeGreaterThan(950);
    expect(res.value).toBeLessThan(955);
  });

  it('deve isentar de IRRF rendimento bruto ate R$ 5.000 pela regra 2026', () => {
    const res = IRRFCalculator.calculate(
      3500.00,
      350.00,
      1,
      irrfBrackets as any,
      generalParams as any
    );
    expect(res.value).toBe(0);
    expect(res.reductionAmount).toBeGreaterThan(0);
  });

  it('deve tributar IRRF para rendimentos acima de R$ 7.350', () => {
    const res = IRRFCalculator.calculate(
      9000.00,
      951.63,
      0,
      irrfBrackets as any,
      generalParams as any
    );
    expect(res.value).toBeGreaterThan(1000);
  });

  it('deve calcular FGTS padrao de 8% e menor aprendiz de 2%', () => {
    const fgtsStd = FGTSCalculator.calculate(3000.00, false);
    expect(fgtsStd.value).toBe(240.00);
    expect(fgtsStd.rate).toBe(8.0);

    const fgtsApp = FGTSCalculator.calculate(1518.00, true);
    expect(fgtsApp.value).toBe(30.36);
    expect(fgtsApp.rate).toBe(2.0);
  });
});