/**
 * AveragesCalculator.ts
 * FASE V6 — FOLHA-10: Motor de Médias Configurável por CCT.
 *
 * Regras trabalhistas implementadas:
 * - Súmula 347 TST: Horas extras / noturnas apuradas pela MÉDIA FÍSICA (quantidade de horas)
 *   valorizada pelo salário-hora ATUAL da competência do pagamento.
 * - Súmulas 45, 60 e 253 TST / CLT Art. 142 §3º e §5º: Comissões, prêmios e DSR apurados pela
 *   média dos valores recebidos (com suporte a atualização monetária quando previsto em CCT).
 * - Janelas configuráveis por CCT: período aquisitivo, últimos 12m, últimos 6m, ano civil ou
 *   "melhor média entre 6m e 12m" (`BEST_OF_6M_OR_12M`).
 * - Memória de cálculo detalhada mês a mês para auditoria e holerite.
 */

import { addMoney, divideMoney, multiplyMoney, round2, sumMoney } from '../utils/money.js';

export type AverageType = 'NONE' | 'HOURS_QUANTITY' | 'MONETARY_VALUE' | 'MONETARY_INDEXED';
export type AverageTarget = 'VACATION' | 'THIRTEENTH' | 'NOTICE';
export type AverageWindowMode =
  | 'ACQUISITIVE_OR_12M'
  | 'LAST_12M'
  | 'LAST_6M'
  | 'BEST_OF_6M_OR_12M'
  | 'CALENDAR_YEAR';

export interface HistoricalRubricEntry {
  year: number;
  month: number; // 1..12
  rubricId: string;
  rubricCode: string;
  rubricName: string;
  averageType: AverageType;
  quantity: number;
  amount: number;
  factor?: number;
  integraDsr?: boolean;
  includeInVacationAvg?: boolean;
  includeIn13thAvg?: boolean;
  includeInNoticeAvg?: boolean;
}

export interface AverageMonthDetail {
  year: number;
  month: number;
  competence: string;
  rubricCode: string;
  rubricName: string;
  averageType: AverageType;
  quantity: number;
  originalAmount: number;
  updatedAmount: number;
  factor: number;
  integraDsr: boolean;
}

export interface AverageRubricSummary {
  rubricId: string;
  rubricCode: string;
  rubricName: string;
  averageType: AverageType;
  totalQuantity: number;
  totalAmount: number;
  divisorMonths: number;
  averageQuantity: number;
  currentUnitHourlyRate: number;
  factorApplied: number;
  averageAmount: number;
  integraDsr: boolean;
  formulaDescription: string;
}

export interface AveragesCalculationInput {
  target: AverageTarget;
  referenceYear: number;
  referenceMonth: number;
  currentHourlyBase: number; // Salário base atual + adicionais fixos habituais
  divisor?: number; // padrão 220
  windowMode?: AverageWindowMode;
  windowMonths?: number; // ex.: 12 ou 6
  acquisitiveStart?: string | null; // YYYY-MM-DD
  acquisitiveEnd?: string | null; // YYYY-MM-DD
  monthsWorkedInWindow?: number; // se admitido dentro da janela
  monthlyIndexRate?: number; // ex.: 0.005 (0,5% a.m.) para MONETARY_INDEXED
  includeDsrReflex?: boolean; // padrão true
  diasUteis?: number; // padrão 25
  diasInuteis?: number; // padrão 5
  entries: HistoricalRubricEntry[];
}

export interface AveragesCalculationResult {
  target: AverageTarget;
  windowUsed: string;
  divisorMonths: number;
  hoursAverageTotal: number;
  monetaryAverageTotal: number;
  dsrReflexAmount: number;
  totalAverage: number;
  byRubric: AverageRubricSummary[];
  monthlyBreakdown: AverageMonthDetail[];
  formulaSummary: string;
}

function toYearMonthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function isEligibleForTarget(entry: HistoricalRubricEntry, target: AverageTarget): boolean {
  if (!entry.averageType || entry.averageType === 'NONE') return false;
  if (target === 'VACATION') return Boolean(entry.includeInVacationAvg);
  if (target === 'THIRTEENTH') return Boolean(entry.includeIn13thAvg);
  return Boolean(entry.includeInNoticeAvg);
}

function resolveMonthRange(params: {
  target: AverageTarget;
  referenceYear: number;
  referenceMonth: number;
  windowMode: AverageWindowMode;
  windowMonths?: number;
  acquisitiveStart?: string | null;
  acquisitiveEnd?: string | null;
}): { startIdx: number; endIdx: number; defaultMonthsCount: number; label: string } {
  const refIdx = toYearMonthIndex(params.referenceYear, params.referenceMonth);

  if (params.windowMode === 'CALENDAR_YEAR' || params.target === 'THIRTEENTH') {
    const startIdx = toYearMonthIndex(params.referenceYear, 1);
    const endIdx = refIdx;
    const monthsCount = Math.max(1, endIdx - startIdx + 1);
    return {
      startIdx,
      endIdx,
      defaultMonthsCount: monthsCount,
      label: `Ano Civil ${params.referenceYear} (${monthsCount}m)`,
    };
  }

  if (
    params.windowMode === 'ACQUISITIVE_OR_12M' &&
    params.acquisitiveStart &&
    params.acquisitiveEnd &&
    /^\d{4}-\d{2}/.test(params.acquisitiveStart) &&
    /^\d{4}-\d{2}/.test(params.acquisitiveEnd)
  ) {
    const sy = Number(params.acquisitiveStart.slice(0, 4));
    const sm = Number(params.acquisitiveStart.slice(5, 7));
    const ey = Number(params.acquisitiveEnd.slice(0, 4));
    const em = Number(params.acquisitiveEnd.slice(5, 7));
    const startIdx = toYearMonthIndex(sy, sm);
    const endIdx = Math.min(refIdx, toYearMonthIndex(ey, em));
    const monthsCount = Math.max(1, Math.min(12, endIdx - startIdx + 1));
    return {
      startIdx,
      endIdx,
      defaultMonthsCount: monthsCount,
      label: `Período Aquisitivo (${monthsCount}m)`,
    };
  }

  const months =
    params.windowMode === 'LAST_6M'
      ? 6
      : params.windowMonths && params.windowMonths > 0
        ? Math.min(24, params.windowMonths)
        : 12;

  const endIdx = refIdx;
  const startIdx = endIdx - months + 1;
  return {
    startIdx,
    endIdx,
    defaultMonthsCount: months,
    label: `Últimos ${months} meses`,
  };
}

export class AveragesCalculator {
  public static calculate(input: AveragesCalculationInput): AveragesCalculationResult {
    const windowMode: AverageWindowMode = input.windowMode || 'ACQUISITIVE_OR_12M';

    if (windowMode === 'BEST_OF_6M_OR_12M') {
      const res6 = this.calculateSingleWindow({
        ...input,
        windowMode: 'LAST_6M',
        windowMonths: 6,
      });
      const res12 = this.calculateSingleWindow({
        ...input,
        windowMode: 'LAST_12M',
        windowMonths: 12,
      });

      const best = res6.totalAverage >= res12.totalAverage ? res6 : res12;
      return {
        ...best,
        windowUsed: `Melhor Média (${best.windowUsed}: R$ ${best.totalAverage.toFixed(2)} vs ${best === res6 ? '12m' : '6m'}: R$ ${(best === res6 ? res12 : res6).totalAverage.toFixed(2)})`,
      };
    }

    return this.calculateSingleWindow({ ...input, windowMode });
  }

  private static calculateSingleWindow(
    input: AveragesCalculationInput & { windowMode: AverageWindowMode }
  ): AveragesCalculationResult {
    const divisor = input.divisor && input.divisor > 0 ? input.divisor : 220;
    const diasUteis = input.diasUteis && input.diasUteis > 0 ? input.diasUteis : 25;
    const diasInuteis = input.diasInuteis !== undefined && input.diasInuteis >= 0 ? input.diasInuteis : 5;
    const includeDsrReflex = input.includeDsrReflex !== false;
    const indexRate = Number(input.monthlyIndexRate || 0);

    const range = resolveMonthRange({
      target: input.target,
      referenceYear: input.referenceYear,
      referenceMonth: input.referenceMonth,
      windowMode: input.windowMode,
      windowMonths: input.windowMonths,
      acquisitiveStart: input.acquisitiveStart,
      acquisitiveEnd: input.acquisitiveEnd,
    });

    const refIdx = toYearMonthIndex(input.referenceYear, input.referenceMonth);
    const eligibleEntries = (input.entries || []).filter((e) => {
      if (!isEligibleForTarget(e, input.target)) return false;
      const idx = toYearMonthIndex(e.year, e.month);
      return idx >= range.startIdx && idx <= range.endIdx;
    });

    const divisorMonths = Math.max(
      1,
      input.monthsWorkedInWindow && input.monthsWorkedInWindow > 0
        ? Math.min(range.defaultMonthsCount, input.monthsWorkedInWindow)
        : range.defaultMonthsCount
    );

    const hourlyRate = input.currentHourlyBase > 0 ? input.currentHourlyBase / divisor : 0;
    const monthlyBreakdown: AverageMonthDetail[] = [];
    const grouped = new Map<
      string,
      {
        rubricId: string;
        rubricCode: string;
        rubricName: string;
        averageType: AverageType;
        totalQuantity: number;
        totalAmount: number;
        factor: number;
        integraDsr: boolean;
      }
    >();

    for (const entry of eligibleEntries) {
      const idx = toYearMonthIndex(entry.year, entry.month);
      const monthsDiff = Math.max(0, refIdx - idx);
      const originalAmount = round2(Number(entry.amount || 0));
      let updatedAmount = originalAmount;

      if (entry.averageType === 'MONETARY_INDEXED' && indexRate > 0 && monthsDiff > 0) {
        const multiplier = Math.pow(1 + indexRate, monthsDiff);
        updatedAmount = round2(originalAmount * multiplier);
      }

      const qty = Number(entry.quantity || 0);
      const factor = entry.factor && entry.factor > 0 ? entry.factor : 1;
      const integraDsr = Boolean(entry.integraDsr);

      monthlyBreakdown.push({
        year: entry.year,
        month: entry.month,
        competence: `${String(entry.month).padStart(2, '0')}/${entry.year}`,
        rubricCode: entry.rubricCode,
        rubricName: entry.rubricName,
        averageType: entry.averageType,
        quantity: round2(qty),
        originalAmount,
        updatedAmount,
        factor,
        integraDsr,
      });

      const key = entry.rubricId || entry.rubricCode;
      const prev = grouped.get(key) || {
        rubricId: entry.rubricId,
        rubricCode: entry.rubricCode,
        rubricName: entry.rubricName,
        averageType: entry.averageType,
        totalQuantity: 0,
        totalAmount: 0,
        factor,
        integraDsr,
      };
      prev.totalQuantity = round2(prev.totalQuantity + qty);
      prev.totalAmount = addMoney(prev.totalAmount, updatedAmount);
      if (entry.factor && entry.factor > 0) prev.factor = entry.factor;
      if (integraDsr) prev.integraDsr = true;
      grouped.set(key, prev);
    }

    monthlyBreakdown.sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      if (a.month !== b.month) return a.month - b.month;
      return a.rubricCode.localeCompare(b.rubricCode);
    });

    const byRubric: AverageRubricSummary[] = [];
    let hoursAverageTotal = 0;
    let monetaryAverageTotal = 0;
    let hoursAverageIntegratingDsr = 0;
    let hasExplicitDsrRubric = false;

    for (const grp of grouped.values()) {
      if (['401', '402', '170', '171'].includes(grp.rubricCode) || grp.rubricName.toUpperCase().includes('DSR')) {
        hasExplicitDsrRubric = true;
      }

      if (grp.averageType === 'HOURS_QUANTITY') {
        const avgQty = grp.totalQuantity / divisorMonths;
        const avgAmount = round2(avgQty * hourlyRate * grp.factor);
        hoursAverageTotal = addMoney(hoursAverageTotal, avgAmount);
        if (grp.integraDsr) {
          hoursAverageIntegratingDsr = addMoney(hoursAverageIntegratingDsr, avgAmount);
        }

        byRubric.push({
          rubricId: grp.rubricId,
          rubricCode: grp.rubricCode,
          rubricName: grp.rubricName,
          averageType: grp.averageType,
          totalQuantity: grp.totalQuantity,
          totalAmount: grp.totalAmount,
          divisorMonths,
          averageQuantity: round2(avgQty),
          currentUnitHourlyRate: round2(hourlyRate),
          factorApplied: grp.factor,
          averageAmount: avgAmount,
          integraDsr: grp.integraDsr,
          formulaDescription: `(${grp.totalQuantity.toFixed(2)}h / ${divisorMonths}m = ${avgQty.toFixed(4)}h) * (${input.currentHourlyBase.toFixed(2)} / ${divisor}) * ${grp.factor}`,
        });
      } else {
        const avgAmount = divideMoney(grp.totalAmount, divisorMonths);
        monetaryAverageTotal = addMoney(monetaryAverageTotal, avgAmount);

        byRubric.push({
          rubricId: grp.rubricId,
          rubricCode: grp.rubricCode,
          rubricName: grp.rubricName,
          averageType: grp.averageType,
          totalQuantity: grp.totalQuantity,
          totalAmount: grp.totalAmount,
          divisorMonths,
          averageQuantity: 0,
          currentUnitHourlyRate: 0,
          factorApplied: 1,
          averageAmount: avgAmount,
          integraDsr: grp.integraDsr,
          formulaDescription: `R$ ${grp.totalAmount.toFixed(2)} / ${divisorMonths}m = R$ ${avgAmount.toFixed(2)}`,
        });
      }
    }

    let dsrReflexAmount = 0;
    if (includeDsrReflex && !hasExplicitDsrRubric && hoursAverageIntegratingDsr > 0 && diasUteis > 0) {
      dsrReflexAmount = multiplyMoney(divideMoney(hoursAverageIntegratingDsr, diasUteis), diasInuteis);
    }

    const totalAverage = sumMoney([hoursAverageTotal, monetaryAverageTotal, dsrReflexAmount]);

    return {
      target: input.target,
      windowUsed: range.label,
      divisorMonths,
      hoursAverageTotal,
      monetaryAverageTotal,
      dsrReflexAmount,
      totalAverage,
      byRubric,
      monthlyBreakdown,
      formulaSummary: `Médias ${input.target} [${range.label}]: Horas R$ ${hoursAverageTotal.toFixed(2)} + Monetárias R$ ${monetaryAverageTotal.toFixed(2)} + DSR R$ ${dsrReflexAmount.toFixed(2)} = R$ ${totalAverage.toFixed(2)}`,
    };
  }
}
