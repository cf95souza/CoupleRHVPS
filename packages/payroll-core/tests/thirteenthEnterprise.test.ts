import { describe, expect, it } from 'vitest';
import {
  calculateThirteenthAvos,
  calculateThirteenthComplementary,
  calculateThirteenthMaternityDeduction,
  calculateThirteenthWorkAccidentComplement,
  calculateThirteenthValues,
} from '../src/engine/ThirteenthSalaryCalculator.js';
import { INSSCalculator } from '../src/legal/INSSCalculator.js';
import { IRRFCalculator } from '../src/legal/IRRFCalculator.js';

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

describe('FOLHA-12: 13º Salário Enterprise (Nov + Dez + Complementar Janeiro)', () => {
  it('fecha ciclo Novembro (1ª Parc) + Dezembro (2ª Parc) + Janeiro (Complementar Decreto 10.854/2021) ao centavo', () => {
    const baseSalary = 6000;
    const avosInfo = calculateThirteenthAvos('2025-01-10', 2026, 12, { 3: 16 }); // 16 faltas em Março -> perde 1 avo -> 11/12
    expect(avosInfo.totalAvos).toBe(11);

    // Novembro: 1ª parcela sem variáveis (ou médias até out) = (6000 / 12 * 11) / 2 = 2750
    const nov = calculateThirteenthValues(baseSalary, 0, avosInfo.totalAvos, 'THIRTEENTH_1');
    expect(nov.firstInstallmentGross).toBe(2750);

    // Dezembro: médias apuradas até Novembro = R$ 600,00 -> total 13º = (6600 / 12) * 11 = 6050
    const dez = calculateThirteenthValues(baseSalary, 600, avosInfo.totalAvos, 'THIRTEENTH_2', nov.firstInstallmentGross);
    expect(dez.secondInstallmentGross).toBe(6050);
    expect(dez.advanceDeduction).toBe(2750);

    const inssDez = INSSCalculator.calculate(dez.secondInstallmentGross, inss2026).value;
    const irrfDez = IRRFCalculator.calculate(dez.secondInstallmentGross, inssDez, 0, irrf2026, params2026).value;

    // Janeiro: após fechamento de Dezembro com comissões/HE extras, média real anual subiu para R$ 1.200,00 -> total devido = (7200 / 12) * 11 = 6600
    const jan = calculateThirteenthComplementary({
      baseSalary,
      recalculatedFullYearAverages: 1200,
      avos: avosInfo.totalAvos,
      priorSecondInstallmentGross: dez.secondInstallmentGross,
      priorInss13Withheld: inssDez,
      priorIrrf13Withheld: irrfDez,
      priorFgts13Base: dez.secondInstallmentGross,
      inssParameters: inss2026,
      irrfParameters: irrf2026,
      generalLegalParameters: params2026,
    });

    const expectedTotalInss = INSSCalculator.calculate(6600, inss2026).value;
    const expectedTotalIrrf = IRRFCalculator.calculate(6600, expectedTotalInss, 0, irrf2026, params2026).value;

    expect(jan.recalculatedTotalGross).toBe(6600);
    expect(jan.grossDifference).toBe(550);
    expect(jan.positiveComplementGross).toBe(550);
    expect(jan.inssDifference).toBe(Number((expectedTotalInss - inssDez).toFixed(2)));
    expect(jan.irrfDifference).toBe(Number((expectedTotalIrrf - irrfDez).toFixed(2)));
    expect(jan.fgtsDifferentialBase).toBe(550);
    expect(jan.fgtsDifference).toBe(44); // 8% de 550
  });

  it('apura dedução proporcional de 13º Salário-Maternidade na DCTFWeb (Decreto 3.048/99 art. 96 e IN RFB 2.110/2022)', () => {
    // 12 avos, 120 dias de licença-maternidade no ano (120/360 = 1/3 de R$ 6.000 = R$ 2.000,00)
    const dedIntegral = calculateThirteenthMaternityDeduction(6000, 12, 120);
    expect(dedIntegral).toBe(2000);

    // Admitida no meio do ano (6 avos, 13º devido de R$ 3.000):
    // Denominador fixo de 360 dias impede superestimar dedução: 120/360 = 1/3 de R$ 3.000 = R$ 1.000,00
    const dedProporcional = calculateThirteenthMaternityDeduction(3000, 6, 120);
    expect(dedProporcional).toBe(1000);
  });

  it('apura complementação de 13º Salário por Acidente de Trabalho (Súmula nº 46 do TST)', () => {
    // Empregado com remuneração de R$ 3.600,00 (12 avos integrais = R$ 3.600,00)
    // Ficou afastado por acidente de trabalho (B91), a empresa apurou 6 avos trabalhados: R$ 1.800,00
    // O INSS pagou Abono Anual de R$ 1.600,00
    // Diferença a complementar pelo empregador: R$ 3.600 - (R$ 1.800 + R$ 1.600) = R$ 200,00
    const comp = calculateThirteenthWorkAccidentComplement({
      baseSalary: 3600,
      variableAverages: 0,
      companyAvos: 6,
      inssAnnualBonusAmount: 1600,
    });

    expect(comp.fullYearThirteenthGross).toBe(3600);
    expect(comp.companyProportionalGross).toBe(1800);
    expect(comp.inssAnnualBonusAmount).toBe(1600);
    expect(comp.complementAmount).toBe(200);
    expect(comp.isComplementDue).toBe(true);

    // Se a soma (Empresa + Abono INSS) cobrir o valor integral, complemento é 0
    const semComplemento = calculateThirteenthWorkAccidentComplement({
      baseSalary: 3600,
      variableAverages: 0,
      companyAvos: 6,
      inssAnnualBonusAmount: 1800,
    });
    expect(semComplemento.complementAmount).toBe(0);
    expect(semComplemento.isComplementDue).toBe(false);
  });

  it('IMP-01: apura 1ª Parcela com Médias de variáveis decomposta em base e médias', () => {
    const baseSalary = 4800;
    const variableAverages = 1200; // Média de horas extras / adicionais apuradas no ano
    const avos = 12;

    const res = calculateThirteenthValues(baseSalary, variableAverages, avos, 'THIRTEENTH_1');

    // Base: 4800 / 12 * 12 = 4800 -> 50% = 2400
    // Médias: 1200 / 12 * 12 = 1200 -> 50% = 600
    // Total 1ª Parcela: 3000
    expect(res.firstInstallmentBase).toBe(2400);
    expect(res.firstInstallmentAverages).toBe(600);
    expect(res.firstInstallmentGross).toBe(3000);
    expect(res.totalThirteenthGross).toBe(6000);
    expect(res.netPayable).toBe(3000);
  });

  it('IMP-01: apura Parcela Única (THIRTEENTH_SINGLE) com médias e dedução de adiantamento anterior de férias', () => {
    const baseSalary = 5000;
    const variableAverages = 1000;
    const avos = 12;
    const vacationAdvance = 2500; // Colaborador adiantou 50% do 13º nas férias de julho

    const res = calculateThirteenthValues(baseSalary, variableAverages, avos, 'THIRTEENTH_SINGLE', vacationAdvance);

    // Total Bruto: (5000 + 1000) = 6000
    // Dedução Adiantamento Férias: 2500
    // Líquido antes de impostos: 3500
    expect(res.totalThirteenthGross).toBe(6000);
    expect(res.secondInstallmentGross).toBe(6000);
    expect(res.advanceDeduction).toBe(2500);
    expect(res.netPayable).toBe(3500);
  });
});
