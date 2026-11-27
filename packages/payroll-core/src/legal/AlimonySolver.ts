import {
  IRRFCalculator,
  type IrrfCalculationResult,
  type IrrfCashConsolidatedResult,
  type IrrfTaxationBucket,
  type PriorIrrfCashEntry,
} from './IRRFCalculator.js';
import type { GeneralLegalParameters, IrrfBracket } from '../engine/PayrollContext.js';
import { addMoney, round2 } from '../utils/money.js';

export type AlimonyCalculationBasis =
  | 'NET_SALARY'
  | 'GROSS_SALARY'
  | 'BASE_SALARY'
  | 'MINIMUM_WAGE'
  | 'FIXED_AMOUNT';

export interface AlimonyBeneficiaryRule {
  id: string;
  rubric_id?: string | null;
  beneficiary_name: string;
  beneficiary_cpf?: string | null;
  court_process_number?: string | null;
  calculation_basis: AlimonyCalculationBasis;
  percentage?: number | null;
  fixed_amount?: number | null;
  min_amount?: number | null;
  max_amount?: number | null;
  payment_method?: string | null;
  pix_key_type?: string | null;
  pix_key?: string | null;
  bank_code?: string | null;
  bank_name?: string | null;
  bank_agency?: string | null;
  bank_account?: string | null;
  bank_account_type?: string | null;
  apply_on_monthly?: boolean;
  apply_on_advance?: boolean;
  apply_on_vacation?: boolean;
  apply_on_thirteenth?: boolean;
  apply_on_termination?: boolean;
  apply_on_complementary?: boolean;
  start_date?: string | null;
  end_date?: string | null;
  is_active?: boolean;
}

export interface AlimonySolverTraceStep {
  iteration: number;
  estimatedIrrf: number;
  netBaseForAlimony: number;
  alimonyAmount: number;
  irrfCalculated: number;
  deltaAlimony: number;
  deltaIrrf: number;
}

export interface AlimonySplitResult {
  beneficiary_id: string | null;
  rubric_id: string | null;
  beneficiary_name: string;
  beneficiary_cpf: string | null;
  court_process_number: string | null;
  calculation_basis: AlimonyCalculationBasis;
  percentage_applied: number;
  base_amount: number;
  amount: number;
  irrf_converged: number;
  solver_iterations: number;
  payment_method: string;
  payment_details: Record<string, any>;
}

export interface AlimonySolveInput {
  beneficiaries: AlimonyBeneficiaryRule[];
  grossForAlimony: number;
  baseSalary: number;
  minimumWage: number;
  inss: number;
  manualNonSolverAlimony?: number;
  grossForIrrf: number;
  dependents: number;
  irrfRegime: 'CASH' | 'COMPETENCE';
  irrfBucket: IrrfTaxationBucket;
  priorCashIrrfEntries?: PriorIrrfCashEntry[];
  irrfBrackets?: IrrfBracket[];
  generalLegalParameters?: GeneralLegalParameters;
  skipIrrfCalculation?: boolean;
  tolerance?: number;
  maxIterations?: number;
}

export interface AlimonySolveResult {
  solvedAlimonyTotal: number;
  totalAlimonyWithManual: number;
  splits: AlimonySplitResult[];
  irrfResult: IrrfCalculationResult;
  cashIrrfResult: IrrfCashConsolidatedResult | null;
  iterations: number;
  converged: boolean;
  hasCircularDependency: boolean;
  finalNetBase: number;
  netPercentageSum: number;
  trace: AlimonySolverTraceStep[];
  traceSummary: string;
}

function getLastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Verifica vigência temporal e incidência por tipo de folha para beneficiário de pensão.
 */
export function isAlimonyBeneficiaryEligible(
  beneficiary: AlimonyBeneficiaryRule,
  periodType: string,
  periodYear: number,
  periodMonth: number
): boolean {
  if (beneficiary.is_active === false) {
    return false;
  }

  const lastDay = getLastDayOfMonth(periodYear, periodMonth);
  const startOfPeriod = `${periodYear}-${String(periodMonth).padStart(2, '0')}-01`;
  const endOfPeriod = `${periodYear}-${String(periodMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  if (beneficiary.start_date && beneficiary.start_date.slice(0, 10) > endOfPeriod) {
    return false;
  }
  if (beneficiary.end_date && beneficiary.end_date.slice(0, 10) < startOfPeriod) {
    return false;
  }

  const normalized = String(periodType || 'MONTHLY').toUpperCase();
  if (normalized === 'MONTHLY') return beneficiary.apply_on_monthly !== false;
  if (normalized === 'ADVANCE') return beneficiary.apply_on_advance === true;
  if (normalized === 'VACATION') return beneficiary.apply_on_vacation !== false;
  if (['THIRTEENTH_2', 'THIRTEENTH_SINGLE', 'THIRTEENTH_COMPLEMENTARY', 'THIRTEENTH', '13TH'].includes(normalized)) {
    return beneficiary.apply_on_thirteenth !== false;
  }
  if (normalized === 'THIRTEENTH_1') {
    // 1ª parcela do 13º não sofre retenção de INSS/IRRF nem pensão sobre líquido na fonte para evitar bitributação com 603
    return false;
  }
  if (normalized === 'TERMINATION') return beneficiary.apply_on_termination !== false;
  if (normalized === 'COMPLEMENTARY') return beneficiary.apply_on_complementary !== false;

  return false;
}

function clampBeneficiaryAmount(rawAmount: number, b: AlimonyBeneficiaryRule): number {
  let val = Math.max(0, rawAmount);
  if (b.min_amount !== null && b.min_amount !== undefined && Number(b.min_amount) > 0) {
    val = Math.max(val, Number(b.min_amount));
  }
  if (b.max_amount !== null && b.max_amount !== undefined && Number(b.max_amount) > 0) {
    val = Math.min(val, Number(b.max_amount));
  }
  return round2(val);
}

function computeSingleBeneficiarySplit(
  b: AlimonyBeneficiaryRule,
  params: {
    grossForAlimony: number;
    baseSalary: number;
    minimumWage: number;
    inss: number;
    estimatedIrrf: number;
    iterations: number;
  }
): AlimonySplitResult {
  const pct = Number(b.percentage || 0);
  const fixedVal = Number(b.fixed_amount || 0);

  let baseAmount = 0;
  let rawAmount = 0;

  switch (b.calculation_basis) {
    case 'FIXED_AMOUNT':
      baseAmount = round2(fixedVal);
      rawAmount = fixedVal;
      break;
    case 'MINIMUM_WAGE':
      baseAmount = round2(params.minimumWage);
      rawAmount = (baseAmount * pct) / 100;
      break;
    case 'BASE_SALARY':
      baseAmount = round2(params.baseSalary);
      rawAmount = (baseAmount * pct) / 100;
      break;
    case 'GROSS_SALARY':
      baseAmount = round2(params.grossForAlimony);
      rawAmount = (baseAmount * pct) / 100;
      break;
    case 'NET_SALARY':
    default:
      baseAmount = Math.max(0, round2(params.grossForAlimony - params.inss - params.estimatedIrrf));
      rawAmount = (baseAmount * pct) / 100;
      break;
  }

  const amount = clampBeneficiaryAmount(rawAmount, b);

  return {
    beneficiary_id: b.id || null,
    rubric_id: b.rubric_id || null,
    beneficiary_name: b.beneficiary_name,
    beneficiary_cpf: b.beneficiary_cpf || null,
    court_process_number: b.court_process_number || null,
    calculation_basis: b.calculation_basis,
    percentage_applied: b.calculation_basis === 'FIXED_AMOUNT' ? 0 : round2(pct),
    base_amount: baseAmount,
    amount,
    irrf_converged: round2(params.estimatedIrrf),
    solver_iterations: params.iterations,
    payment_method: b.payment_method || 'BANK_TRANSFER',
    payment_details: {
      pix_key_type: b.pix_key_type || null,
      pix_key: b.pix_key || null,
      bank_code: b.bank_code || null,
      bank_name: b.bank_name || null,
      bank_agency: b.bank_agency || null,
      bank_account: b.bank_account || null,
      bank_account_type: b.bank_account_type || null,
    },
  };
}

/**
 * Solver Enterprise de Pensão Alimentícia com Dependência Circular (Pensão ↔ IRRF):
 * Quando há beneficiário sobre o Líquido (`Bruto - INSS - IRRF`), aplica algoritmo iterativo
 * de ponto fixo até convergência de ambos (Pensão e IRRF) dentro da tolerância de R$ 0,01.
 */
export class AlimonySolver {
  public static solve(input: AlimonySolveInput): AlimonySolveResult {
    const tolerance = input.tolerance ?? 0.01;
    const maxIterations = Math.max(2, input.maxIterations ?? 30);
    const manualBase = round2(input.manualNonSolverAlimony || 0);
    const beneficiaries = input.beneficiaries || [];

    const hasCircularDependency =
      !input.skipIrrfCalculation &&
      beneficiaries.some((b) => b.calculation_basis === 'NET_SALARY');

    const netPercentageSum = round2(
      beneficiaries
        .filter((b) => b.calculation_basis === 'NET_SALARY')
        .reduce((sum, b) => sum + Number(b.percentage || 0), 0)
    );

    const evaluateIrrf = (
      totalAlimony: number
    ): { irrf: IrrfCalculationResult; cash: IrrfCashConsolidatedResult | null } => {
      if (input.skipIrrfCalculation) {
        return {
          irrf: {
            value: 0,
            usedSimplified: false,
            legalBase: 0,
            grossIncome: round2(input.grossForIrrf),
            reductionAmount: 0,
          },
          cash: null,
        };
      }

      if (input.irrfRegime === 'CASH') {
        const cash = IRRFCalculator.calculateCashConsolidated({
          current: {
            grossIncome: input.grossForIrrf,
            inss: input.inss,
            dependents: input.dependents,
            alimony: totalAlimony,
          },
          priorEntries: input.priorCashIrrfEntries || [],
          bucket: input.irrfBucket,
          brackets: input.irrfBrackets,
          params: input.generalLegalParameters,
        });
        return { irrf: cash, cash };
      }

      const irrf = IRRFCalculator.calculate(
        input.grossForIrrf,
        input.inss,
        input.dependents,
        input.irrfBrackets,
        input.generalLegalParameters,
        totalAlimony
      );
      return { irrf, cash: null };
    };

    const trace: AlimonySolverTraceStep[] = [];
    let currentSplits: AlimonySplitResult[] = [];
    let solvedTotal = 0;
    let totalWithManual = manualBase;
    let estimatedIrrf = 0;
    let lastEval = evaluateIrrf(manualBase);
    let converged = true;
    let iterationsExecuted = 1;

    if (!hasCircularDependency) {
      // Sem circularidade: avaliação direta em 1 passo
      const fixedIrrf = input.skipIrrfCalculation ? 0 : lastEval.irrf.value;
      currentSplits = beneficiaries.map((b) =>
        computeSingleBeneficiarySplit(b, {
          grossForAlimony: input.grossForAlimony,
          baseSalary: input.baseSalary,
          minimumWage: input.minimumWage,
          inss: input.inss,
          estimatedIrrf: fixedIrrf,
          iterations: 1,
        })
      );
      solvedTotal = round2(currentSplits.reduce((acc, s) => addMoney(acc, s.amount), 0));
      totalWithManual = addMoney(solvedTotal, manualBase);
      lastEval = evaluateIrrf(totalWithManual);
      estimatedIrrf = lastEval.irrf.value;

      currentSplits = currentSplits.map((s) => ({
        ...s,
        irrf_converged: estimatedIrrf,
        solver_iterations: 1,
      }));

      const netBase = Math.max(0, round2(input.grossForAlimony - input.inss - estimatedIrrf));
      trace.push({
        iteration: 1,
        estimatedIrrf,
        netBaseForAlimony: netBase,
        alimonyAmount: solvedTotal,
        irrfCalculated: estimatedIrrf,
        deltaAlimony: 0,
        deltaIrrf: 0,
      });
    } else {
      // Solver iterativo de ponto fixo: P_{k} = F(I_{k-1}), I_{k} = IRRF(P_{k})
      converged = false;
      let prevAlimony = 0;

      for (let iter = 1; iter <= maxIterations; iter++) {
        iterationsExecuted = iter;

        currentSplits = beneficiaries.map((b) =>
          computeSingleBeneficiarySplit(b, {
            grossForAlimony: input.grossForAlimony,
            baseSalary: input.baseSalary,
            minimumWage: input.minimumWage,
            inss: input.inss,
            estimatedIrrf,
            iterations: iter,
          })
        );

        solvedTotal = round2(currentSplits.reduce((acc, s) => addMoney(acc, s.amount), 0));
        totalWithManual = addMoney(solvedTotal, manualBase);
        lastEval = evaluateIrrf(totalWithManual);

        const calculatedIrrf = lastEval.irrf.value;
        const netBase = Math.max(0, round2(input.grossForAlimony - input.inss - estimatedIrrf));
        const deltaAlimony = iter === 1 ? solvedTotal : round2(Math.abs(solvedTotal - prevAlimony));
        const deltaIrrf = round2(Math.abs(calculatedIrrf - estimatedIrrf));

        trace.push({
          iteration: iter,
          estimatedIrrf: round2(estimatedIrrf),
          netBaseForAlimony: netBase,
          alimonyAmount: solvedTotal,
          irrfCalculated: calculatedIrrf,
          deltaAlimony,
          deltaIrrf,
        });

        const isFixedPoint =
          deltaIrrf <= tolerance && (iter === 1 ? deltaIrrf === 0 : deltaAlimony <= tolerance);

        if (isFixedPoint) {
          converged = true;
          estimatedIrrf = calculatedIrrf;
          // Recalcula splits finais com IRRF convergido exato caso deltaIrrf fosse 0.01
          if (deltaIrrf > 0) {
            currentSplits = beneficiaries.map((b) =>
              computeSingleBeneficiarySplit(b, {
                grossForAlimony: input.grossForAlimony,
                baseSalary: input.baseSalary,
                minimumWage: input.minimumWage,
                inss: input.inss,
                estimatedIrrf,
                iterations: iter,
              })
            );
            solvedTotal = round2(currentSplits.reduce((acc, s) => addMoney(acc, s.amount), 0));
            totalWithManual = addMoney(solvedTotal, manualBase);
            lastEval = evaluateIrrf(totalWithManual);
            estimatedIrrf = lastEval.irrf.value;
          }
          break;
        }

        prevAlimony = solvedTotal;
        // Amortecimento apenas se houver micro-oscilação de centavo após muitas iterações
        if (iter >= 15) {
          estimatedIrrf = round2((estimatedIrrf + calculatedIrrf) / 2);
        } else {
          estimatedIrrf = calculatedIrrf;
        }
      }

      currentSplits = currentSplits.map((s) => ({
        ...s,
        irrf_converged: lastEval.irrf.value,
        solver_iterations: iterationsExecuted,
      }));
    }

    const finalNetBase = Math.max(
      0,
      round2(input.grossForAlimony - input.inss - lastEval.irrf.value)
    );

    const compactTrace = trace
      .map(
        (t) =>
          `It${t.iteration}:IRRF=${t.estimatedIrrf.toFixed(2)}->Pensao=${t.alimonyAmount.toFixed(2)}->IRRF=${t.irrfCalculated.toFixed(2)}`
      )
      .join(' | ');

    const traceSummary = hasCircularDependency
      ? `Solver Circular (${iterationsExecuted} it., tol=R$0,01, ${converged ? 'CONVERGIDO' : 'LIMITE'}): Líq Base = ${input.grossForAlimony.toFixed(2)} - ${input.inss.toFixed(2)} - ${lastEval.irrf.value.toFixed(2)} = R$ ${finalNetBase.toFixed(2)} | [${compactTrace}]`
      : `Pensão Direta (${beneficiaries.length} benef.): Total R$ ${solvedTotal.toFixed(2)} | IRRF R$ ${lastEval.irrf.value.toFixed(2)}`;

    return {
      solvedAlimonyTotal: solvedTotal,
      totalAlimonyWithManual: totalWithManual,
      splits: currentSplits,
      irrfResult: lastEval.irrf,
      cashIrrfResult: lastEval.cash,
      iterations: iterationsExecuted,
      converged,
      hasCircularDependency,
      finalNetBase,
      netPercentageSum,
      trace,
      traceSummary,
    };
  }
}
