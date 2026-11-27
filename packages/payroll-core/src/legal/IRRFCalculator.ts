import { IrrfBracket, GeneralLegalParameters } from '../engine/PayrollContext.js';
import { round2, subtractMoney, sumMoney } from '../utils/money.js';

export type IrrfTaxationBucket =
  | 'MONTHLY_CASH'
  | 'VACATION_EXCLUSIVE'
  | 'THIRTEENTH_EXCLUSIVE'
  | 'PLR_EXCLUSIVE'
  | 'RRA_EXCLUSIVE';

export interface PriorIrrfCashEntry {
  gross_taxable: number;
  inss_deducted: number;
  alimony_deducted: number;
  irrf_withheld: number;
}

export interface IrrfCalculationResult {
  value: number;
  usedSimplified: boolean;
  legalBase: number;
  grossIncome: number;
  reductionAmount: number;
}

export interface IrrfCashConsolidatedResult extends IrrfCalculationResult {
  bucket: IrrfTaxationBucket;
  accumulatedGross: number;
  accumulatedInss: number;
  accumulatedAlimony: number;
  totalCashIrrf: number;
  priorIrrfWithheld: number;
  priorEntriesCount: number;
}

/**
 * Mapeia o tipo da folha ao bucket oficial de tributação do IRRF (RIR/2018).
 * Férias, 13º, PLR e RRA nunca se somam ao bucket mensal de caixa.
 */
export function resolveIrrfTaxationBucket(periodType: string): IrrfTaxationBucket {
  const normalized = String(periodType || 'MONTHLY').toUpperCase();
  if (normalized === 'VACATION') return 'VACATION_EXCLUSIVE';
  if (['13TH', 'THIRTEENTH', 'THIRTEENTH_1', 'THIRTEENTH_2', 'THIRTEENTH_SINGLE', 'THIRTEENTH_COMPLEMENTARY'].includes(normalized)) {
    return 'THIRTEENTH_EXCLUSIVE';
  }
  if (['PLR', 'PROFIT_SHARING'].includes(normalized)) return 'PLR_EXCLUSIVE';
  if (normalized === 'RRA') return 'RRA_EXCLUSIVE';
  return 'MONTHLY_CASH';
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

  /**
   * Calcula o IRRF em Regime de Caixa (Lei 7.713/88 / IN RFB 1.500):
   * - Para o bucket `MONTHLY_CASH`, soma os rendimentos tributáveis, INSS e pensão já pagos
   *   no mesmo mês/ano de caixa (`payment_date`), aplica a tabela/redutor sobre o acumulado e
   *   abate o IRRF já retido anteriormente no mesmo mês de caixa.
   * - Buckets exclusivos (Férias, 13º, PLR, RRA) são tributados isoladamente conforme RIR/2018.
   */
  public static calculateCashConsolidated(input: {
    current: {
      grossIncome: number;
      inss: number;
      dependents: number;
      alimony?: number;
    };
    priorEntries?: PriorIrrfCashEntry[];
    bucket: IrrfTaxationBucket;
    brackets?: IrrfBracket[];
    params?: GeneralLegalParameters;
  }): IrrfCashConsolidatedResult {
    const { current, priorEntries = [], bucket, brackets, params } = input;
    const currentAlimony = current.alimony ?? 0;

    // Buckets exclusivos nunca somam com pagamentos do bucket MONTHLY_CASH
    const effectivePriors = bucket === 'MONTHLY_CASH' ? priorEntries : [];

    const accumulatedGross = sumMoney(
      effectivePriors.map((e) => Number(e.gross_taxable || 0)),
      current.grossIncome
    );
    const accumulatedInss = sumMoney(
      effectivePriors.map((e) => Number(e.inss_deducted || 0)),
      current.inss
    );
    const accumulatedAlimony = sumMoney(
      effectivePriors.map((e) => Number(e.alimony_deducted || 0)),
      currentAlimony
    );
    const priorIrrfWithheld = sumMoney(
      effectivePriors.map((e) => Number(e.irrf_withheld || 0))
    );

    const totalRes = IRRFCalculator.calculate(
      accumulatedGross,
      accumulatedInss,
      current.dependents,
      brackets,
      params,
      accumulatedAlimony
    );

    const incrementalValue = Math.max(0, subtractMoney(totalRes.value, priorIrrfWithheld));

    return {
      value: round2(incrementalValue),
      usedSimplified: totalRes.usedSimplified,
      legalBase: totalRes.legalBase,
      grossIncome: round2(current.grossIncome),
      reductionAmount: totalRes.reductionAmount,
      bucket,
      accumulatedGross,
      accumulatedInss,
      accumulatedAlimony,
      totalCashIrrf: totalRes.value,
      priorIrrfWithheld,
      priorEntriesCount: effectivePriors.length,
    };
  }

  /**
   * RRA — Rendimentos Recebidos Acumuladamente (Art. 12-A da Lei nº 7.713/88 / IN RFB 1.500):
   * Tributação exclusiva na fonte para diferenças salariais/dissídio referentes a anos-calendário anteriores.
   * Multiplica os limites das faixas e a parcela a deduzir pela quantidade de meses (`monthsCount`).
   * Não utiliza o desconto simplificado mensal (apenas INSS + Pensão + Dependentes).
   */
  public static calculateRRA(input: {
    grossRra: number;
    inssRra: number;
    alimonyRra?: number;
    dependents?: number;
    monthsCount: number;
    brackets?: IrrfBracket[];
    params?: GeneralLegalParameters;
  }): {
    value: number;
    legalBase: number;
    monthsCount: number;
    aliquotApplied: number;
    deductionApplied: number;
    formulaDescription: string;
  } {
    const nm = Math.max(1, Math.floor(Number(input.monthsCount || 1)));
    const brackets = input.brackets || [];
    if (brackets.length === 0) {
      throw new Error('Parâmetros legais de IRRF ausentes para cálculo RRA.');
    }

    const depDeduction = round2((input.dependents || 0) * Number(input.params?.dependent_deduction || 0));
    const legalBase = Math.max(
      0,
      subtractMoney(input.grossRra, sumMoney([input.inssRra, input.alimonyRra || 0, depDeduction]))
    );

    const sorted = [...brackets].sort((a, b) => a.bracket_number - b.bracket_number);
    let selected = sorted[sorted.length - 1];
    for (const b of sorted) {
      const scaledLimit = b.base_limit !== null ? round2(b.base_limit * nm) : Infinity;
      if (legalBase <= scaledLimit) {
        selected = b;
        break;
      }
    }

    const scaledDeduction = round2(selected.deduction * nm);
    const rawIrrf = subtractMoney(round2(legalBase * (selected.aliquot / 100)), scaledDeduction);
    const value = Math.max(0, round2(rawIrrf));

    return {
      value,
      legalBase,
      monthsCount: nm,
      aliquotApplied: selected.aliquot,
      deductionApplied: scaledDeduction,
      formulaDescription: `RRA Art. 12-A (${nm}m): Base R$ ${legalBase.toFixed(2)} * ${selected.aliquot}% - Ded. Escalonada R$ ${scaledDeduction.toFixed(2)} = R$ ${value.toFixed(2)}`,
    };
  }
}
