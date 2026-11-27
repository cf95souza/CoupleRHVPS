import { addMoney, round2, sumMoney } from '../utils/money.js';

export interface LaborConfig {
  inss_patronal_percentage?: number; // default 20%
  rat_percentage?: number;           // default 2%
  fap_multiplier?: number;           // default 1.0
  terceiros_percentage?: number;     // default 5.8%
  tax_regime?: string;               // SIMPLES, SIMPLES_NACIONAL, LUCRO_PRESUMIDO, LUCRO_REAL
  simples_anexo?: string;            // 'I', 'II', 'III', 'IV', 'V'
  is_cprb_exempted?: boolean;        // true = Desoneração da Folha de Pagamento (CPRB Lei 12.546/2011)
  cprb_gross_revenue_exempt?: number;
  cprb_gross_revenue_total?: number;
  competence_year?: number;          // Para reoneração gradual Lei 14.973/2024
  apply_lei_14973_reoneration?: boolean;
}

export type SpecialRetirementExposureCode = '01' | '02' | '03' | '04';

export interface AdvancedEmployerTaxesInput {
  baseInssEmployees: number;
  baseInssIndividualContributors?: number; // Pró-Labore e Autônomos (20% CPP, 0% RAT, 0% Terceiros)
  baseFgts: number;
  fgtsMonthSum?: number; // Soma real exata (8% CLT, 2% Aprendiz, 0% Pró-Labore/RPA/Estágio)
  specialRetirementBases?: {
    code02_15y?: number; // 12% adicional
    code03_20y?: number; // 9% adicional
    code04_25y?: number; // 6% adicional
  };
  config?: LaborConfig;
}

export interface EmployerTaxesOutput {
  inss_patronal: number;
  inss_patronal_pro_labore: number;
  rat_adjusted: number;
  rat_special_retirement_amount: number;
  terceiros: number;
  fgts_patronal: number;
  cprb_reduction_ratio: number;
  cprb_effective_cpp_rate: number;
  total: number;
  regimeApplied: string;
}

/**
 * Tabela de reoneração gradual da CPRB (Lei nº 14.973/2024 Art. 1º):
 * - Até 2024: 0% CPP sobre a parcela desonerada
 * - 2025: 5% CPP sobre a parcela desonerada
 * - 2026: 10% CPP sobre a parcela desonerada
 * - 2027: 15% CPP sobre a parcela desonerada
 * - A partir de 2028: 20% CPP integral (fim da desoneração)
 */
export function getLei14973CppRate(year: number): number {
  if (year <= 2024) return 0;
  if (year === 2025) return 5;
  if (year === 2026) return 10;
  if (year === 2027) return 15;
  return 20;
}

/**
 * Alíquota adicional de RAT para financiamento de Aposentadoria Especial (Lei 8.212/91 art. 57 §6º):
 * 01 = Não exposto (0%) | 04 = 25 anos (6%) | 03 = 20 anos (9%) | 02 = 15 anos (12%)
 */
export function getSpecialRetirementRatAliquot(code?: string | null): number {
  switch (String(code || '01')) {
    case '02':
      return 12;
    case '03':
      return 9;
    case '04':
      return 6;
    default:
      return 0;
  }
}

export class EmployerTaxesCalculator {
  /**
   * Apura os encargos patronais completos (Simples Nacional, Lucro Presumido/Real,
   * CPRB proporcional mista + reoneração Lei 14.973/2024, RAT adicional especial e Pró-Labore/RPA).
   */
  public static calculateAdvanced(input: AdvancedEmployerTaxesInput): EmployerTaxesOutput {
    const config = input.config;
    const rawRegime = (config?.tax_regime || '').toUpperCase();
    const isSimples = rawRegime === 'SIMPLES' || rawRegime === 'SIMPLES_NACIONAL';
    const simplesAnexo = (config?.simples_anexo || '').toUpperCase();
    const isCprb = Boolean(config?.is_cprb_exempted);

    const baseEmp = Math.max(0, Number(input.baseInssEmployees || 0));
    const baseInd = Math.max(0, Number(input.baseInssIndividualContributors || 0));
    const baseFgts = Math.max(0, Number(input.baseFgts || 0));

    const inssPerc = config?.inss_patronal_percentage ?? 20;
    const ratPerc = config?.rat_percentage ?? 2;
    const fapMult = config?.fap_multiplier ?? 1.0;
    const terceirosPerc = config?.terceiros_percentage ?? 5.8;

    let inss_patronal = 0;
    let inss_patronal_pro_labore = 0;
    let rat_adjusted = 0;
    let rat_special_retirement_amount = 0;
    let terceiros = 0;
    let cprb_reduction_ratio = 0;
    let cprb_effective_cpp_rate = inssPerc;
    let regimeApplied = 'REGIME_GERAL';

    const computeSpecialRat = (): number => {
      const sp = input.specialRetirementBases;
      if (!sp) return 0;
      const r12 = round2((sp.code02_15y || 0) * 0.12);
      const r9 = round2((sp.code03_20y || 0) * 0.09);
      const r6 = round2((sp.code04_25y || 0) * 0.06);
      return sumMoney([r12, r9, r6]);
    };

    if (isSimples) {
      if (simplesAnexo === 'IV') {
        regimeApplied = 'SIMPLES_NACIONAL_ANEXO_IV';
        inss_patronal = round2(baseEmp * (inssPerc / 100));
        inss_patronal_pro_labore = round2(baseInd * (inssPerc / 100));
        rat_adjusted = round2(baseEmp * ((ratPerc * fapMult) / 100));
        rat_special_retirement_amount = computeSpecialRat();
        terceiros = 0;
        cprb_effective_cpp_rate = inssPerc;
      } else {
        regimeApplied = `SIMPLES_NACIONAL_${simplesAnexo || 'ISENTO'}`;
        cprb_effective_cpp_rate = 0;
      }
    } else if (isCprb) {
      // CPRB Proporcional (Receita Mista Lei 12.546/2011 art. 9º §1º) + Reoneração Lei 14.973/2024
      const revTotal = Number(config?.cprb_gross_revenue_total || 0);
      const revExempt = Number(config?.cprb_gross_revenue_exempt || 0);
      const exemptRatio = revTotal > 0 ? Math.min(1, Math.max(0, revExempt / revTotal)) : 1;

      const reoneratedCppOnExempt =
        config?.competence_year !== undefined && config?.apply_lei_14973_reoneration !== false
          ? getLei14973CppRate(config.competence_year)
          : 0;

      const effectiveCppRate = round2(
        (1 - exemptRatio) * inssPerc + exemptRatio * reoneratedCppOnExempt
      );

      cprb_reduction_ratio = Number(exemptRatio.toFixed(6));
      cprb_effective_cpp_rate = effectiveCppRate;
      regimeApplied =
        exemptRatio < 1 ? 'CPRB_MISTA_PROPORCIONAL' : 'CPRB_DESONERADO';

      inss_patronal = round2(baseEmp * (effectiveCppRate / 100));
      inss_patronal_pro_labore = round2(baseInd * (effectiveCppRate / 100));
      rat_adjusted = round2(baseEmp * ((ratPerc * fapMult) / 100));
      rat_special_retirement_amount = computeSpecialRat();
      terceiros = round2(baseEmp * (terceirosPerc / 100));
    } else {
      regimeApplied = 'REGIME_GERAL';
      inss_patronal = round2(baseEmp * (inssPerc / 100));
      inss_patronal_pro_labore = round2(baseInd * (inssPerc / 100));
      rat_adjusted = round2(baseEmp * ((ratPerc * fapMult) / 100));
      rat_special_retirement_amount = computeSpecialRat();
      terceiros = round2(baseEmp * (terceirosPerc / 100));
      cprb_effective_cpp_rate = inssPerc;
    }

    const fgts_patronal =
      input.fgtsMonthSum !== undefined ? round2(input.fgtsMonthSum) : round2(baseFgts * 0.08);

    const total = sumMoney([
      inss_patronal,
      inss_patronal_pro_labore,
      rat_adjusted,
      rat_special_retirement_amount,
      terceiros,
      fgts_patronal,
    ]);

    return {
      inss_patronal,
      inss_patronal_pro_labore,
      rat_adjusted,
      rat_special_retirement_amount,
      terceiros,
      fgts_patronal,
      cprb_reduction_ratio,
      cprb_effective_cpp_rate,
      total,
      regimeApplied,
    };
  }

  /**
   * Assinatura compatível com versões anteriores (calcula sobre base única de empregados).
   */
  public static calculate(
    baseInss: number,
    baseFgts: number,
    config?: LaborConfig
  ): EmployerTaxesOutput {
    return this.calculateAdvanced({
      baseInssEmployees: baseInss,
      baseFgts,
      config,
    });
  }
}

export { addMoney };
