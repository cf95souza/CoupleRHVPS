/**
 * Calculadora Pura de INSS para Múltiplos Vínculos (eSocial S-1200 infoMV — indMV 1/2/3)
 * Legislação: IN RFB nº 2.110/2022 Art. 43, Decreto 3.048/99 Art. 214 §14, Manual S-1200.
 *
 * Regras:
 * - Consolida outras matrículas do mesmo CPF no grupo econômico + vínculos declarados em outros empregadores.
 * - indMV = 1: Cálculo progressivo considerando a soma das bases já tributadas até o teto INSS vigente.
 * - indMV = 2: Cálculo complementar considerando o valor de INSS efetivamente retido informado em outras fontes,
 *              garantindo que a soma total de retenções não ultrapasse o INSS devido sobre a base combinada (até o teto).
 * - indMV = 3: Teto INSS já atingido em outro(s) vínculo(s) -> INSS do segurado nesta matrícula = R$ 0,00.
 * - Contribuição patronal (20%, RAT, Terceiros) e FGTS não sofrem teto e continuam sobre base_inss integral.
 */

import type { InssBracket } from '../engine/PayrollContext.js';
import { INSSCalculator } from './INSSCalculator.js';
import { addMoney, round2, subtractMoney } from '../utils/money.js';

export type IndMVCode = 1 | 2 | 3;

export interface OtherEmploymentInput {
  id?: string;
  employer_cnpj?: string;
  employer_name?: string;
  esocial_category_code?: string;
  ind_mv: IndMVCode;
  remuneration_amount: number;
  inss_withheld?: number;
  source?: 'EXTERNAL_EMPLOYER' | 'INTERNAL_GROUP_CONTRACT';
}

export interface MultipleEmploymentINSSInput {
  currentBaseInss: number;
  priorSameContractBaseInss?: number;
  otherEmployments: OtherEmploymentInput[];
  inssBrackets: InssBracket[];
}

export interface MultipleEmploymentINSSResult {
  value: number;
  breakdown: { bracket: number; amount: number; rate: number }[];
  indMv: IndMVCode | null;
  hasMultipleEmployments: boolean;
  externalBaseTotal: number;
  externalInssWithheldTotal: number;
  priorSameContractBaseInss: number;
  consolidatedAlreadyTaxedBase: number;
  totalCombinedInssContribution: number;
  maxInssCeilingContribution: number;
  ceilingLimit: number;
  formulaDescription: string;
}

export class MultipleEmploymentINSSCalculator {
  static calculate(input: MultipleEmploymentINSSInput): MultipleEmploymentINSSResult {
    const {
      currentBaseInss,
      priorSameContractBaseInss = 0,
      otherEmployments = [],
      inssBrackets = [],
    } = input;

    if (!inssBrackets || inssBrackets.length === 0) {
      throw new Error('Parâmetros legais de INSS ausentes para a competência.');
    }

    const safeCurrent = Math.max(0, round2(currentBaseInss));
    const safePriorContract = Math.max(0, round2(priorSameContractBaseInss));

    // O(1) Fast-path quando não há outros vínculos externos/internos
    if (!otherEmployments || otherEmployments.length === 0) {
      const std = INSSCalculator.calculate(safeCurrent, inssBrackets, safePriorContract);
      return {
        value: std.value,
        breakdown: std.breakdown,
        indMv: null,
        hasMultipleEmployments: false,
        externalBaseTotal: 0,
        externalInssWithheldTotal: 0,
        priorSameContractBaseInss: safePriorContract,
        consolidatedAlreadyTaxedBase: safePriorContract,
        totalCombinedInssContribution: std.totalCalculated,
        maxInssCeilingContribution: 0,
        ceilingLimit: 0,
        formulaDescription:
          safePriorContract > 0
            ? `INSS_CONSOLIDADO(Base Atual: R$ ${safeCurrent.toFixed(2)}, Base Já Tributada: R$ ${safePriorContract.toFixed(2)}, INSS Devido: R$ ${std.value.toFixed(2)})`
            : JSON.stringify(std.breakdown),
      };
    }

    const sortedBrackets = [...inssBrackets].sort((a, b) => a.bracket_number - b.bracket_number);
    const ceilingLimit = Number(sortedBrackets[sortedBrackets.length - 1].base_limit || 0);
    const maxInssCeilingContribution =
      ceilingLimit > 0 ? INSSCalculator.calculateSingle(ceilingLimit, sortedBrackets).value : 0;

    const validOthers = otherEmployments.filter(
      (o) => Number(o.remuneration_amount || 0) > 0 || Number(o.inss_withheld || 0) > 0 || o.ind_mv === 3
    );

    if (validOthers.length === 0) {
      const std = INSSCalculator.calculate(safeCurrent, sortedBrackets, safePriorContract);
      return {
        value: std.value,
        breakdown: std.breakdown,
        indMv: null,
        hasMultipleEmployments: false,
        externalBaseTotal: 0,
        externalInssWithheldTotal: 0,
        priorSameContractBaseInss: safePriorContract,
        consolidatedAlreadyTaxedBase: safePriorContract,
        totalCombinedInssContribution: std.totalCalculated,
        maxInssCeilingContribution,
        ceilingLimit,
        formulaDescription:
          safePriorContract > 0
            ? `INSS_CONSOLIDADO(Base Atual: R$ ${safeCurrent.toFixed(2)}, Base Já Tributada: R$ ${safePriorContract.toFixed(2)}, INSS Devido: R$ ${std.value.toFixed(2)})`
            : JSON.stringify(std.breakdown),
      };
    }

    // Precedência oficial eSocial: se qualquer fonte indicar indMV = 3, predomina 3; senão 2 se houver 2 explícito com retenção; caso contrário 1
    let resolvedIndMv: IndMVCode = 1;
    if (validOthers.some((o) => Number(o.ind_mv) === 3)) {
      resolvedIndMv = 3;
    } else if (validOthers.some((o) => Number(o.ind_mv) === 2)) {
      resolvedIndMv = 2;
    }

    const externalBaseTotal = round2(
      validOthers.reduce((acc, o) => addMoney(acc, Math.max(0, Number(o.remuneration_amount || 0))), 0)
    );
    const externalInssWithheldTotal = round2(
      validOthers.reduce((acc, o) => addMoney(acc, Math.max(0, Number(o.inss_withheld || 0))), 0)
    );

    const sourcesSummary = validOthers
      .map((o) => {
        const label = o.employer_name || o.employer_cnpj || (o.source === 'INTERNAL_GROUP_CONTRACT' ? 'Matrícula Grupo' : 'Outro Vínculo');
        return `${label} [indMV=${o.ind_mv}, Base: R$ ${Number(o.remuneration_amount || 0).toFixed(2)}${o.inss_withheld ? `, Retido: R$ ${Number(o.inss_withheld).toFixed(2)}` : ''}]`;
      })
      .join('; ');

    // indMV = 3: Trabalhador já recolheu pelo teto no(s) outro(s) vínculo(s)
    if (resolvedIndMv === 3 || (ceilingLimit > 0 && addMoney(safePriorContract, externalBaseTotal) >= ceilingLimit)) {
      return {
        value: 0,
        breakdown: [],
        indMv: resolvedIndMv,
        hasMultipleEmployments: true,
        externalBaseTotal,
        externalInssWithheldTotal,
        priorSameContractBaseInss: safePriorContract,
        consolidatedAlreadyTaxedBase: addMoney(safePriorContract, externalBaseTotal),
        totalCombinedInssContribution: maxInssCeilingContribution,
        maxInssCeilingContribution,
        ceilingLimit,
        formulaDescription: `MÚLTIPLOS_VÍNCULOS indMV=${resolvedIndMv} (Teto INSS R$ ${ceilingLimit.toFixed(2)} já atingido — Retenção zerada neste vínculo; Base Patronal/FGTS preservada) | Fontes: ${sourcesSummary}`,
      };
    }

    const consolidatedAlreadyTaxedBase = addMoney(safePriorContract, externalBaseTotal);

    if (resolvedIndMv === 1) {
      const prog = INSSCalculator.calculate(safeCurrent, sortedBrackets, consolidatedAlreadyTaxedBase);
      return {
        value: prog.value,
        breakdown: prog.breakdown,
        indMv: 1,
        hasMultipleEmployments: true,
        externalBaseTotal,
        externalInssWithheldTotal,
        priorSameContractBaseInss: safePriorContract,
        consolidatedAlreadyTaxedBase,
        totalCombinedInssContribution: prog.totalCalculated,
        maxInssCeilingContribution,
        ceilingLimit,
        formulaDescription: `MÚLTIPLOS_VÍNCULOS indMV=1 (Progressivo Acumulado — Base Atual: R$ ${safeCurrent.toFixed(2)}, Outros Vínculos/Mesmo CPF: R$ ${consolidatedAlreadyTaxedBase.toFixed(2)}, INSS Devido: R$ ${prog.value.toFixed(2)}) | Fontes: ${sourcesSummary}`,
      };
    }

    // indMV = 2: Considera o valor de INSS efetivamente retido nos outros vínculos para complementar até o devido sobre a soma (limitado ao teto)
    const combinedBase = addMoney(consolidatedAlreadyTaxedBase, safeCurrent);
    const totalCombinedInss = INSSCalculator.calculateSingle(combinedBase, sortedBrackets).value;
    const priorContractInss =
      safePriorContract > 0 ? INSSCalculator.calculateSingle(safePriorContract, sortedBrackets).value : 0;

    // Se remuneração externa não foi detalhada mas retenção sim, considera o teto máximo global de contribuição como limite superior
    const targetCap =
      externalBaseTotal > 0 ? totalCombinedInss : maxInssCeilingContribution;
    const maxStandaloneCurrent = INSSCalculator.calculateSingle(safeCurrent, sortedBrackets).value;

    const alreadyRetainedTotal = addMoney(priorContractInss, externalInssWithheldTotal);
    const rawComplement = Math.max(0, subtractMoney(targetCap, alreadyRetainedTotal));
    // Em indMV=2 nunca retém acima do teto máximo remanescente nem acima do que caberia ao saldo tributável até o teto
    const remainingMaxToCeiling = Math.max(0, subtractMoney(maxInssCeilingContribution, alreadyRetainedTotal));
    const finalValue = Math.min(rawComplement, remainingMaxToCeiling, Math.max(rawComplement, maxStandaloneCurrent));

    const breakdown = INSSCalculator.calculate(safeCurrent, sortedBrackets, consolidatedAlreadyTaxedBase).breakdown;

    return {
      value: round2(finalValue),
      breakdown,
      indMv: 2,
      hasMultipleEmployments: true,
      externalBaseTotal,
      externalInssWithheldTotal,
      priorSameContractBaseInss: safePriorContract,
      consolidatedAlreadyTaxedBase,
      totalCombinedInssContribution: Math.min(maxInssCeilingContribution, addMoney(alreadyRetainedTotal, round2(finalValue))),
      maxInssCeilingContribution,
      ceilingLimit,
      formulaDescription: `MÚLTIPLOS_VÍNCULOS indMV=2 (Complemento Retido — Alvo Combinado: R$ ${targetCap.toFixed(2)}, Já Retido Externo: R$ ${externalInssWithheldTotal.toFixed(2)}, INSS Devido: R$ ${round2(finalValue).toFixed(2)}) | Fontes: ${sourcesSummary}`,
    };
  }
}
