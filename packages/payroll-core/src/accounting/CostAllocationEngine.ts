/**
 * CostAllocationEngine.ts
 * FASE V7 — CONT-01: Rateio Multi-Centro de Custo, Projetos, Tomadores (Lei 9.711/98) e Obras CNO (S-1020).
 * Garante soma de percentuais === 100% e distribuição contábil sem perda de centavos.
 */

import { round2, subtractMoney, sumMoney } from '../utils/money.js';

export interface CostAllocationTarget {
  costCenterId?: string | null;
  costCenterCode?: string | null;
  costCenterName?: string | null;
  projectCode?: string | null;
  tomadorCnpj?: string | null;
  tomadorName?: string | null;
  cnoNumber?: string | null;
  esocialLotacaoCode?: string | null;
  percentage: number;
}

export interface CostAllocationValidationResult {
  valid: boolean;
  totalPercentage: number;
  errors: string[];
}

export interface DistributedAmountSlice {
  index: number;
  amount: number;
  isRoundingAdjusted: boolean;
}

export interface PayslipCostAllocationInput {
  payslipId: string;
  contractId: string;
  grossAmount: number;
  deductionsAmount: number;
  netAmount: number;
  inssEmployerAmount: number;
  ratAmount: number;
  terceirosAmount: number;
  fgtsAmount: number;
  vacationProvisionAmount: number;
  thirteenthProvisionAmount: number;
  allocations: CostAllocationTarget[];
}

export interface PayslipCostAllocationLine extends CostAllocationTarget {
  payslipId: string;
  contractId: string;
  grossAmount: number;
  deductionsAmount: number;
  netAmount: number;
  inssEmployerAmount: number;
  ratAmount: number;
  terceirosAmount: number;
  fgtsAmount: number;
  vacationProvisionAmount: number;
  thirteenthProvisionAmount: number;
  totalEmployerCost: number;
  isRoundingAdjusted: boolean;
}

/**
 * Valida regras de rateio: percentuais positivos, soma igual a 100% e ao menos uma dimensão alvo preenchida.
 */
export function validateCostAllocations(targets: CostAllocationTarget[]): CostAllocationValidationResult {
  const errors: string[] = [];
  if (!targets || targets.length === 0) {
    errors.push('Informe ao menos uma destinação de rateio.');
    return { valid: false, totalPercentage: 0, errors };
  }

  let total = 0;
  targets.forEach((t, idx) => {
    const pct = Number(t.percentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      errors.push(`Percentual inválido no item ${idx + 1}: deve estar entre 0,01% e 100%.`);
    } else {
      total += pct;
    }

    const hasTarget = Boolean(t.costCenterId || t.projectCode || t.tomadorCnpj || t.cnoNumber || t.esocialLotacaoCode);
    if (!hasTarget) {
      errors.push(`Item ${idx + 1} sem Centro de Custo, Projeto, Tomador ou Obra CNO associado.`);
    }
  });

  const roundedTotal = Number(total.toFixed(4));
  if (Math.abs(roundedTotal - 100) > 0.0001) {
    errors.push(`A soma dos percentuais de rateio deve totalizar exatamente 100% (atual: ${roundedTotal}%).`);
  }

  return {
    valid: errors.length === 0,
    totalPercentage: roundedTotal,
    errors,
  };
}

/**
 * Distribui um valor monetário proporcionalmente pelos percentuais aplicando ajuste exato de centavos
 * no item de maior percentual (tie-break determinístico pelo menor índice).
 */
export function distributeAmountWithRounding(
  totalAmount: number,
  targets: Array<{ percentage: number }>
): DistributedAmountSlice[] {
  const targetTotal = round2(totalAmount);
  if (targets.length === 0) return [];
  if (targets.length === 1) {
    return [{ index: 0, amount: targetTotal, isRoundingAdjusted: false }];
  }

  let maxIdx = 0;
  let maxPct = -1;
  const slices = targets.map((t, idx) => {
    const pct = Number(t.percentage || 0);
    if (pct > maxPct) {
      maxPct = pct;
      maxIdx = idx;
    }
    return {
      index: idx,
      amount: round2(targetTotal * (pct / 100)),
      isRoundingAdjusted: false,
    };
  });

  const sumAllocated = sumMoney(slices.map((s) => s.amount));
  const diff = subtractMoney(targetTotal, sumAllocated);

  if (Math.abs(diff) >= 0.01) {
    slices[maxIdx].amount = round2(slices[maxIdx].amount + diff);
    slices[maxIdx].isRoundingAdjusted = true;
  }

  return slices;
}

export class CostAllocationEngine {
  /**
   * Rateia todas as rubricas consolidadas de um holerite e encargos/provisões entre CCs/Projetos/Tomadores/CNOs.
   */
  public static allocatePayslipCosts(input: PayslipCostAllocationInput): PayslipCostAllocationLine[] {
    const check = validateCostAllocations(input.allocations);
    if (!check.valid) {
      throw new Error(check.errors[0]);
    }

    const grossSlices = distributeAmountWithRounding(input.grossAmount, input.allocations);
    const dedSlices = distributeAmountWithRounding(input.deductionsAmount, input.allocations);
    const netSlices = distributeAmountWithRounding(input.netAmount, input.allocations);
    const inssEmpSlices = distributeAmountWithRounding(input.inssEmployerAmount, input.allocations);
    const ratSlices = distributeAmountWithRounding(input.ratAmount, input.allocations);
    const tercSlices = distributeAmountWithRounding(input.terceirosAmount, input.allocations);
    const fgtsSlices = distributeAmountWithRounding(input.fgtsAmount, input.allocations);
    const vacProvSlices = distributeAmountWithRounding(input.vacationProvisionAmount, input.allocations);
    const thProvSlices = distributeAmountWithRounding(input.thirteenthProvisionAmount, input.allocations);

    return input.allocations.map((target, idx) => {
      const gross = grossSlices[idx].amount;
      const inssEmp = inssEmpSlices[idx].amount;
      const rat = ratSlices[idx].amount;
      const terc = tercSlices[idx].amount;
      const fgts = fgtsSlices[idx].amount;
      const vacProv = vacProvSlices[idx].amount;
      const thProv = thProvSlices[idx].amount;
      const totalEmployerCost = sumMoney([gross, inssEmp, rat, terc, fgts, vacProv, thProv]);

      const anyAdjusted =
        grossSlices[idx].isRoundingAdjusted ||
        dedSlices[idx].isRoundingAdjusted ||
        netSlices[idx].isRoundingAdjusted ||
        inssEmpSlices[idx].isRoundingAdjusted ||
        ratSlices[idx].isRoundingAdjusted ||
        tercSlices[idx].isRoundingAdjusted ||
        fgtsSlices[idx].isRoundingAdjusted ||
        vacProvSlices[idx].isRoundingAdjusted ||
        thProvSlices[idx].isRoundingAdjusted;

      return {
        ...target,
        payslipId: input.payslipId,
        contractId: input.contractId,
        grossAmount: gross,
        deductionsAmount: dedSlices[idx].amount,
        netAmount: netSlices[idx].amount,
        inssEmployerAmount: inssEmp,
        ratAmount: rat,
        terceirosAmount: terc,
        fgtsAmount: fgts,
        vacationProvisionAmount: vacProv,
        thirteenthProvisionAmount: thProv,
        totalEmployerCost,
        isRoundingAdjusted: anyAdjusted,
      };
    });
  }
}
