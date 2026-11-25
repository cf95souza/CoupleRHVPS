import { IrrfBracket, GeneralLegalParameters } from '../engine/PayrollContext.js';
import { round2 } from '../utils/money.js';

export interface IrrfCalculationResult {
  value: number;
  usedSimplified: boolean;
  legalBase: number;
  grossIncome: number;
  reductionAmount: number;
}

export class IRRFCalculator {
  public static calculate(
    grossIncome: number,
    inss: number,
    dependents: number,
    brackets?: IrrfBracket[],
    params?: GeneralLegalParameters,
    alimony: number = 0
  ): IrrfCalculationResult {
    if (!params || Object.keys(params).length === 0) {
      throw new Error('Parâmetros legais gerais ausentes para a competência.');
    }
    if (params.simplified_discount === undefined || params.simplified_discount === null) {
      throw new Error("Parâmetro legal 'simplified_discount' ausente.");
    }
    if (dependents > 0 && (params.dependent_deduction === undefined || params.dependent_deduction === null)) {
      throw new Error("Parâmetro legal 'dependent_deduction' ausente para cálculo com dependentes.");
    }

    // 1. Apuração da Dedução Legal (INSS + Dependentes + Pensão Alimentícia)
    const dependentesDeducao = dependents * (params.dependent_deduction || 0);
    const baseLegal = Math.max(0, grossIncome - inss - dependentesDeducao - alimony);

    // 2. Apuração da Dedução Simplificada (Desconto padrão sobre o bruto)
    const simplifiedDiscount = params.simplified_discount;
    const baseSimplificada = Math.max(0, grossIncome - simplifiedDiscount);

    // 3. Critério Legal: aplica-se a dedução mais benéfica ao trabalhador (menor base de cálculo tributável)
    const usedSimplified = baseSimplificada < baseLegal;
    const calcBase = usedSimplified ? baseSimplificada : baseLegal;

    // 4. Faixas da Tabela Progressiva do IRRF
    if (!brackets || brackets.length === 0) {
      throw new Error('Parâmetros legais de IRRF ausentes para a competência.');
    }

    const sortedBrackets = [...brackets].sort((a, b) => a.bracket_number - b.bracket_number);
    let irrfBruto = 0;
    let bracketFound = false;

    // Localizar faixa da base tributável
    for (let i = 0; i < sortedBrackets.length; i++) {
      const bracket = sortedBrackets[i];
      const limit = bracket.base_limit ?? Infinity;

      if (calcBase <= limit) {
        irrfBruto = (calcBase * (bracket.aliquot / 100)) - bracket.deduction;
        bracketFound = true;
        break;
      }
    }

    // Se ultrapassar a última faixa com teto definido, aplica a última faixa aberta
    if (!bracketFound && sortedBrackets.length > 0) {
      const lastBracket = sortedBrackets[sortedBrackets.length - 1];
      irrfBruto = (calcBase * (lastBracket.aliquot / 100)) - lastBracket.deduction;
    }

    irrfBruto = Math.max(0, irrfBruto);

    // 5. Redutor do IRRF (100% guiado por vigência em general_legal_parameters — BUG-06)
    // Se irrf_exemption_limit for nulo ou <= 0 (ex: tabelas 2024/2025 ou 2027+ sem redutor), não aplica redutor.
    let reductionAmount = 0;
    const exemptionLimit = params.irrf_exemption_limit ?? null;
    const formulaLimit = params.irrf_reduction_formula_limit ?? null;
    const reductionA = params.irrf_reduction_a ?? null;
    const reductionB = params.irrf_reduction_b ?? null;

    if (exemptionLimit !== null && exemptionLimit > 0) {
      if (grossIncome <= exemptionLimit) {
        // Isenção integral para rendimentos brutos até o limite vigente
        reductionAmount = irrfBruto;
      } else if (
        formulaLimit !== null &&
        grossIncome <= formulaLimit &&
        reductionA !== null &&
        reductionB !== null
      ) {
        // Redutor progressivo decrescente conforme fórmula parametrizada na vigência
        reductionAmount = Math.max(0, reductionA - (reductionB * grossIncome));
      }
    }

    const finalIrrf = Math.max(0, irrfBruto - reductionAmount);

    return {
      value: round2(finalIrrf),
      usedSimplified,
      legalBase: Math.max(0, round2(calcBase)),
      grossIncome: round2(grossIncome),
      reductionAmount: round2(reductionAmount)
    };
  }
}
