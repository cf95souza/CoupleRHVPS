import { describe, expect, it } from 'vitest';
import { MultiRegimeCalculator } from '../src/legal/MultiRegimeCalculator.js';

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

describe('FOLHA-15: Categorias Especiais de Vínculos (5 Suítes Douradas Multi-Regime eSocial)', () => {
  it('Suíte 1 — Pró-Labore (722): INSS 11% limitado ao teto, FGTS 0%, marca contribuinte individual', () => {
    const res = MultiRegimeCalculator.calculateTaxesByRegime({
      regime: 'PRO_LABORE',
      grossRemuneration: 10000,
      inssCeiling: 8157.41,
      minimumWage: 1518,
      inssParameters: inss2026,
      irrfParameters: irrf2026,
      generalLegalParameters: params2026,
    });

    expect(res.esocialCategoryCode).toBe('722');
    expect(res.inssEmployee).toBe(897.32); // 11% de 8157.41
    expect(res.fgtsAmount).toBe(0);
    expect(res.employerCategory).toBe('INDIVIDUAL_CONTRIBUTOR');
    expect(res.irrfEmployee).toBeGreaterThan(0);
  });

  it('Suíte 2 — Autônomo / RPA Transporte de Carga (711): INSS 20% base + SEST/SENAT 2,5% + IRRF 10% + ISS', () => {
    const res = MultiRegimeCalculator.calculateTaxesByRegime({
      regime: 'AUTONOMOUS_RPA',
      autonomousServiceType: 'FREIGHT_TRANSPORT',
      grossRemuneration: 10000,
      inssCeiling: 8157.41,
      minimumWage: 1518,
      issRate: 2.0,
      inssParameters: inss2026,
      irrfParameters: irrf2026,
      generalLegalParameters: params2026,
    });

    expect(res.esocialCategoryCode).toBe('711');
    // Base INSS = 20% de 10.000 = 2.000 -> INSS 11% = 220; SEST/SENAT 2,5% = 50; ISS 2% = 200
    expect(res.baseInss).toBe(2000);
    expect(res.inssEmployee).toBe(220);
    expect(res.sestSenatDeduction).toBe(50);
    expect(res.issDeduction).toBe(200);
    // Base IRRF Carga = 10% de 10.000 = 1.000 (isento de IRRF)
    expect(res.baseIrrfGross).toBe(1000);
    expect(res.irrfEmployee).toBe(0);
    expect(res.fgtsAmount).toBe(0);
  });

  it('Suíte 3 — Estagiário (901 — Lei 11.788): sem INSS/FGTS e recesso remunerado sem 1/3', () => {
    const taxes = MultiRegimeCalculator.calculateTaxesByRegime({
      regime: 'INTERN',
      grossRemuneration: 2000,
      inssCeiling: 8157.41,
      minimumWage: 1518,
      inssParameters: inss2026,
      irrfParameters: irrf2026,
      generalLegalParameters: params2026,
    });
    expect(taxes.esocialCategoryCode).toBe('901');
    expect(taxes.inssEmployee).toBe(0);
    expect(taxes.fgtsAmount).toBe(0);
    expect(taxes.employerCategory).toBe('EXEMPT');

    const recess = MultiRegimeCalculator.calculateInternRecess(2000, 6);
    expect(recess.recessDays).toBe(15);
    expect(recess.recessAmount).toBe(1000); // 15/30 de 2000, sem 1/3
  });

  it('Suíte 4 — Intermitente (111 — Art. 452-A): verbas imediatas na convocação + alerta DARF complementação INSS', () => {
    const call = MultiRegimeCalculator.calculateIntermittentCall({
      hoursWorked: 40,
      hourlyRate: 15, // 600 trabalho + 120 DSR = 720 -> Férias 60 + 1/3 20 + 13º 60 -> total 860
      diasUteis: 25,
      diasInuteis: 5,
    });
    expect(call.grossWorked).toBe(600);
    expect(call.dsrAmount).toBe(120);
    expect(call.vacationProportional).toBe(60);
    expect(call.vacationThird).toBe(20);
    expect(call.thirteenthProportional).toBe(60);
    expect(call.totalGross).toBe(860);

    const taxes = MultiRegimeCalculator.calculateTaxesByRegime({
      regime: 'INTERMITTENT',
      grossRemuneration: call.totalGross,
      inssCeiling: 8157.41,
      minimumWage: 1518,
      inssParameters: inss2026,
      irrfParameters: irrf2026,
      generalLegalParameters: params2026,
    });

    expect(taxes.esocialCategoryCode).toBe('111');
    expect(taxes.inssComplementationAlert).toBe(true);
    expect(taxes.inssComplementationDarfEstimate).toBe(49.35); // (1518 - 860) * 7.5%
    expect(taxes.fgtsAmount).toBe(68.8); // 8% de 860
  });

  it('Suíte 5 — Horista & Comissionista Puro: DSR separado e Complemento de Garantia Mínima (Piso)', () => {
    const horista = MultiRegimeCalculator.calculateVariableBaseRemuneration({
      regime: 'HOURLY',
      unitsWorked: 150,
      unitRate: 20, // 3000 + DSR (3000/25*5 = 600) = 3600
      diasUteis: 25,
      diasInuteis: 5,
    });
    expect(horista.baseProduced).toBe(3000);
    expect(horista.dsrAmount).toBe(600);
    expect(horista.totalGross).toBe(3600);

    const comissionista = MultiRegimeCalculator.calculateVariableBaseRemuneration({
      regime: 'COMMISSION_ONLY',
      unitsWorked: 0,
      unitRate: 0,
      commissionsTotal: 1000, // + DSR 200 = 1200 < Garantia Mínima 1800 -> Complemento 600
      diasUteis: 25,
      diasInuteis: 5,
      minimumGuaranteeAmount: 1800,
    });
    expect(comissionista.baseProduced).toBe(1000);
    expect(comissionista.dsrAmount).toBe(200);
    expect(comissionista.minimumGuaranteeSupplement).toBe(600);
    expect(comissionista.totalGross).toBe(1800);
  });
});
