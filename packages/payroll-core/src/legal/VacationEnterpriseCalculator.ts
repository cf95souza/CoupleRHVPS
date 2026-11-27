/**
 * VacationEnterpriseCalculator.ts
 * FASE V6 — FOLHA-11: Motor de Férias Enterprise Completo (CLT).
 *
 * Regras implementadas:
 * - Art. 130 CLT: Redução automática de dias de férias por faltas injustificadas no período aquisitivo.
 * - Art. 134 §1º CLT: Fracionamento em até 3 períodos (1 >= 14 dias, nenhum < 5 dias).
 * - Art. 134 §3º CLT: Vedação de início nos 2 dias que antecedem feriado ou DSR.
 * - Art. 137 CLT: Férias em dobro após término do período concessivo (parcela indenizatória isenta de INSS/IRRF/FGTS).
 * - Art. 139–140 CLT: Férias coletivas em lote com proporcionalidade e reinício do período aquisitivo para < 1 ano.
 * - Férias partidas entre dois meses: rateio exato de INSS/FGTS por competência vs IRRF integral no caixa do pagamento.
 * - Art. 142 CLT + Súmula 347 TST: Integração de médias de horas extras/adicionais + adiantamento de 13º com adicionais.
 */

import { addMoney, divideMoney, multiplyMoney, round2, subtractMoney, sumMoney } from '../utils/money.js';
import { diffDaysInclusive, formatDate, getDaysInMonth, parseDateParts } from '../engine/VacationOverlapCalculator.js';

export interface VacationFractionationValidationInput {
  startDate: string;
  endDate: string;
  daysCount: number;
  sellDaysCount?: number;
  daysRemaining?: number;
  existingSplitsDays?: number[];
  holidays?: string[]; // YYYY-MM-DD
  dsrWeekday?: number; // 0=Domingo (padrão) .. 6=Sábado
  isCollective?: boolean;
}

export interface VacationFractionationValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface VacationMonthSplitItem {
  year: number;
  month: number;
  competence: string;
  daysInMonth: number;
  proportionalFactor: number;
  inssBaseShare: number;
  fgtsBaseShare: number;
  irrfAppliesInFullOnPayment: boolean;
}

export interface DoubleVacationResult {
  normalDays: number;
  doubleDays: number;
  hasDoublePenalty: boolean;
}

export interface CollectiveVacationEvaluationInput {
  admissionDate: string;
  collectiveStartDate: string;
  collectiveDays: number;
  monthlySalary: number;
  fixedAdditionals?: number;
}

export interface CollectiveVacationEvaluationResult {
  isUnderOneYear: boolean;
  monthsWorked: number;
  proportionalVacationDays: number;
  paidLeaveDays: number;
  vacationPayAmount: number;
  vacationOneThirdAmount: number;
  paidLeaveAmount: number;
  resetAcquisitionStartDate: string | null;
  resetAcquisitionEndDate: string | null;
  resetConcessiveEndDate: string | null;
}

export interface EnterpriseVacationCalculationInput {
  baseSalary: number;
  fixedAdditionals?: number;
  averagesAmount?: number;
  daysTaken: number;
  sellDaysCount?: number;
  wantsThirteenthAdvance?: boolean;
  startDate: string;
  endDate: string;
  concessiveEndDate?: string | null;
}

export interface EnterpriseVacationCalculationOutput {
  remunerationBase: number;
  vacationGross: number;
  vacationOneThird: number;
  abonoGross: number;
  abonoOneThird: number;
  averagesVacationGross: number;
  doubleVacationIndemnity: number;
  doubleVacationOneThirdIndemnity: number;
  thirteenthAdvanceGross: number;
  totalTaxableInssFgtsBase: number;
  totalTaxableIrrfBase: number;
  totalExemptIndemnity: number;
  totalGross: number;
  doubleInfo: DoubleVacationResult;
  monthSplits: VacationMonthSplitItem[];
}

function addDaysUtcStr(dateStr: string, deltaDays: number): string {
  const p = parseDateParts(dateStr);
  if (!p) throw new Error(`Data inválida: '${dateStr}'`);
  const dt = new Date(Date.UTC(p.year, p.month - 1, p.day + deltaDays));
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function addYearsMinusOneDayUtcStr(dateStr: string, years: number): string {
  const p = parseDateParts(dateStr);
  if (!p) throw new Error(`Data inválida: '${dateStr}'`);
  const dt = new Date(Date.UTC(p.year + years, p.month - 1, p.day - 1));
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function getWeekdayUtc(dateStr: string): number {
  const p = parseDateParts(dateStr);
  if (!p) return -1;
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

export class VacationEnterpriseCalculator {
  /**
   * CLT Art. 130: Tabela de redução de dias de férias por faltas injustificadas no período aquisitivo.
   */
  public static calculateAccruedDaysByAbsences(absencesCount: number): number {
    const faltas = Math.max(0, Math.floor(Number(absencesCount || 0)));
    if (faltas <= 5) return 30;
    if (faltas <= 14) return 24;
    if (faltas <= 23) return 18;
    if (faltas <= 32) return 12;
    return 0;
  }

  /**
   * CLT Art. 134 §§1º e 3º: Valida regras de fracionamento (14+5+5) e vedação de início 2 dias antes de feriado/DSR.
   */
  public static validateVacationFractionation(
    input: VacationFractionationValidationInput
  ): VacationFractionationValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const existing = input.existingSplitsDays || [];
    const sellDays = Math.max(0, Number(input.sellDaysCount || 0));
    const daysCount = Number(input.daysCount || 0);
    const dsrWeekday = input.dsrWeekday ?? 0; // Domingo padrão

    if (daysCount < 5) {
      errors.push('CLT Art. 134 §1º: nenhum período de férias fracionado pode ser inferior a 5 dias corridos.');
    }

    if (sellDays > 10) {
      errors.push('CLT Art. 143: o abono pecuniário não pode exceder 1/3 do período (máximo 10 dias).');
    }

    // Férias coletivas (Art. 139) seguem regra própria de até 2 períodos anuais >= 10 dias; fracionamento individual até 3
    if (!input.isCollective) {
      if (existing.length >= 3) {
        errors.push('CLT Art. 134 §1º: as férias só podem ser usufruídas em até 3 períodos.');
      }

      const allSplits = [...existing, daysCount];
      const hasFourteenPlus = allSplits.some((d) => d >= 14);
      const remainingAfter = Math.max(0, Number(input.daysRemaining ?? 30) - daysCount - sellDays);

      // Se é a última fração possível ou já usou todos os dias e nenhum tem >= 14 dias -> bloqueia
      if (!hasFourteenPlus && remainingAfter < 14) {
        errors.push(
          'CLT Art. 134 §1º: ao fracionar férias, pelo menos um dos períodos deve ter no mínimo 14 dias corridos.'
        );
      }
      if (allSplits.length === 3 && !hasFourteenPlus) {
        errors.push(
          'CLT Art. 134 §1º: no 3º período de fracionamento é obrigatório que ao menos uma parcela tenha 14 dias ou mais.'
        );
      }
    }

    // Art. 134 §3º: É vedado o início das férias no período de 2 dias que antecede feriado ou dia de DSR.
    // Logo, nem startDate, nem startDate+1, nem startDate+2 podem cair em DSR ou feriado.
    const holidaySet = new Set((input.holidays || []).map((h) => h.slice(0, 10)));
    for (let offset = 0; offset <= 2; offset++) {
      const checkDate = addDaysUtcStr(input.startDate, offset);
      const wd = getWeekdayUtc(checkDate);
      if (holidaySet.has(checkDate)) {
        errors.push(
          `CLT Art. 134 §3º: início em ${input.startDate} vedado por anteceder em até 2 dias o feriado de ${checkDate}.`
        );
        break;
      }
      if (wd === dsrWeekday) {
        const label = offset === 0 ? 'no próprio dia de DSR' : `a ${offset} dia(s) do DSR`;
        errors.push(
          `CLT Art. 134 §3º: é vedado iniciar férias ${label} (${checkDate}).`
        );
        break;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * CLT Art. 137: Calcula quantos dias de gozo ultrapassaram o período concessivo e são devidos em dobro (indenizatória).
   */
  public static calculateDoubleVacationDays(
    startDate: string,
    endDate: string,
    concessiveEndDate?: string | null
  ): DoubleVacationResult {
    const totalDays = diffDaysInclusive(startDate, endDate);
    if (!concessiveEndDate || totalDays <= 0) {
      return { normalDays: totalDays, doubleDays: 0, hasDoublePenalty: false };
    }

    if (startDate > concessiveEndDate) {
      return { normalDays: 0, doubleDays: totalDays, hasDoublePenalty: true };
    }

    if (endDate <= concessiveEndDate) {
      return { normalDays: totalDays, doubleDays: 0, hasDoublePenalty: false };
    }

    const normalDays = diffDaysInclusive(startDate, concessiveEndDate);
    const doubleDays = Math.max(0, totalDays - normalDays);
    return {
      normalDays,
      doubleDays,
      hasDoublePenalty: doubleDays > 0,
    };
  }

  /**
   * Rateia a base de INSS e FGTS entre duas competências quando as férias iniciam em um mês e terminam no próximo.
   * O IRRF incide integralmente no mês de caixa do pagamento das férias (Lei 7.713/88).
   */
  public static splitVacationAcrossMonths(
    startDate: string,
    endDate: string,
    totalInssBase: number,
    totalFgtsBase: number
  ): VacationMonthSplitItem[] {
    const pStart = parseDateParts(startDate);
    const pEnd = parseDateParts(endDate);
    if (!pStart || !pEnd || endDate < startDate) return [];

    const totalDays = diffDaysInclusive(startDate, endDate);
    if (totalDays <= 0) return [];

    const buckets: Array<{ year: number; month: number; days: number }> = [];
    let curY = pStart.year;
    let curM = pStart.month;

    while (curY < pEnd.year || (curY === pEnd.year && curM <= pEnd.month)) {
      const mStart = formatDate(curY, curM, 1);
      const mEnd = formatDate(curY, curM, getDaysInMonth(curY, curM));
      const effStart = startDate > mStart ? startDate : mStart;
      const effEnd = endDate < mEnd ? endDate : mEnd;
      const days = diffDaysInclusive(effStart, effEnd);
      if (days > 0) {
        buckets.push({ year: curY, month: curM, days });
      }
      curM += 1;
      if (curM > 12) {
        curM = 1;
        curY += 1;
      }
    }

    let allocatedInss = 0;
    let allocatedFgts = 0;

    return buckets.map((b, idx) => {
      const isLast = idx === buckets.length - 1;
      const ratio = b.days / totalDays;
      const inssShare = isLast
        ? Math.max(0, subtractMoney(totalInssBase, allocatedInss))
        : round2(totalInssBase * ratio);
      const fgtsShare = isLast
        ? Math.max(0, subtractMoney(totalFgtsBase, allocatedFgts))
        : round2(totalFgtsBase * ratio);

      allocatedInss = addMoney(allocatedInss, inssShare);
      allocatedFgts = addMoney(allocatedFgts, fgtsShare);

      return {
        year: b.year,
        month: b.month,
        competence: `${String(b.month).padStart(2, '0')}/${b.year}`,
        daysInMonth: b.days,
        proportionalFactor: round2(ratio),
        inssBaseShare: inssShare,
        fgtsBaseShare: fgtsShare,
        irrfAppliesInFullOnPayment: idx === 0,
      };
    });
  }

  /**
   * CLT Arts. 139–140: Avalia férias coletivas para contratos (inclusive < 1 ano com licença remunerada + reinício de aquisitivo).
   */
  public static evaluateCollectiveVacationContract(
    input: CollectiveVacationEvaluationInput
  ): CollectiveVacationEvaluationResult {
    const adm = parseDateParts(input.admissionDate);
    const colStart = parseDateParts(input.collectiveStartDate);
    if (!adm || !colStart) {
      throw new Error('Datas inválidas para avaliação de férias coletivas.');
    }

    const totalDaysSinceAdm = diffDaysInclusive(input.admissionDate, input.collectiveStartDate) - 1;
    const isUnderOneYear = totalDaysSinceAdm < 365;

    const remunBase = addMoney(input.monthlySalary, input.fixedAdditionals || 0);

    if (!isUnderOneYear) {
      const vacPay = round2((remunBase / 30) * input.collectiveDays);
      const oneThird = divideMoney(vacPay, 3);
      return {
        isUnderOneYear: false,
        monthsWorked: 12,
        proportionalVacationDays: input.collectiveDays,
        paidLeaveDays: 0,
        vacationPayAmount: vacPay,
        vacationOneThirdAmount: oneThird,
        paidLeaveAmount: 0,
        resetAcquisitionStartDate: null,
        resetAcquisitionEndDate: null,
        resetConcessiveEndDate: null,
      };
    }

    // Conta avos completos (>= 15 dias) entre admissão e véspera das férias coletivas
    let monthsWorked = 0;
    let cursorY = adm.year;
    let cursorM = adm.month;
    let cursorD = adm.day;

    while (true) {
      const nextMonth = cursorM === 12 ? 1 : cursorM + 1;
      const nextYear = cursorM === 12 ? cursorY + 1 : cursorY;
      const maxDayNext = getDaysInMonth(nextYear, nextMonth);
      const nextDate = formatDate(nextYear, nextMonth, Math.min(cursorD, maxDayNext));
      if (nextDate <= input.collectiveStartDate) {
        monthsWorked++;
        cursorY = nextYear;
        cursorM = nextMonth;
      } else {
        const curStr = formatDate(cursorY, cursorM, Math.min(cursorD, getDaysInMonth(cursorY, cursorM)));
        const remDays = diffDaysInclusive(curStr, input.collectiveStartDate) - 1;
        if (remDays >= 15) monthsWorked++;
        break;
      }
      if (monthsWorked >= 12) break;
    }

    const proportionalVacationDays = Math.min(30, Math.round((monthsWorked / 12) * 30));
    const effectiveVacationDays = Math.min(input.collectiveDays, proportionalVacationDays);
    const paidLeaveDays = Math.max(0, input.collectiveDays - effectiveVacationDays);

    const vacPay = round2((remunBase / 30) * effectiveVacationDays);
    const oneThird = divideMoney(vacPay, 3);
    const paidLeaveAmount = round2((remunBase / 30) * paidLeaveDays);

    const newAcqStart = input.collectiveStartDate;
    const newAcqEnd = addYearsMinusOneDayUtcStr(newAcqStart, 1);
    const newConcEnd = addYearsMinusOneDayUtcStr(newAcqEnd, 1);

    return {
      isUnderOneYear: true,
      monthsWorked,
      proportionalVacationDays: effectiveVacationDays,
      paidLeaveDays,
      vacationPayAmount: vacPay,
      vacationOneThirdAmount: oneThird,
      paidLeaveAmount,
      resetAcquisitionStartDate: newAcqStart,
      resetAcquisitionEndDate: newAcqEnd,
      resetConcessiveEndDate: newConcEnd,
    };
  }

  /**
   * Cálculo completo das Férias Enterprise (férias gozadas, 1/3, abono, médias, dobro isento Art. 137, 13º e rateio).
   */
  public static calculateEnterpriseVacation(
    input: EnterpriseVacationCalculationInput
  ): EnterpriseVacationCalculationOutput {
    const fixed = Number(input.fixedAdditionals || 0);
    const averages = Number(input.averagesAmount || 0);
    const remunerationBase = addMoney(input.baseSalary, fixed);
    const daysTaken = Math.max(0, Number(input.daysTaken || 0));
    const sellDays = Math.max(0, Number(input.sellDaysCount || 0));

    const doubleInfo = this.calculateDoubleVacationDays(
      input.startDate,
      input.endDate,
      input.concessiveEndDate
    );

    const dailyRate = remunerationBase / 30;
    const vacationGross = round2(dailyRate * daysTaken);
    const vacationOneThird = divideMoney(vacationGross, 3);

    const averagesVacationGross =
      averages > 0 && daysTaken > 0 ? round2((averages / 30) * daysTaken * (1 + 1 / 3)) : 0;

    // Abono pecuniário CLT Art. 143 (isento de INSS, IRRF e FGTS conforme Art. 28 §9º Lei 8.212/91 e Súmula 386 STJ)
    const abonoBaseWithAvg = addMoney(remunerationBase, averages);
    const abonoGross = sellDays > 0 ? round2((abonoBaseWithAvg / 30) * sellDays) : 0;
    const abonoOneThird = sellDays > 0 ? divideMoney(abonoGross, 3) : 0;

    // CLT Art. 137 + Súmula 386 STJ: Parcela da dobra das férias tem natureza indenizatória (isenta de INSS/IRRF/FGTS)
    const doubleVacationIndemnity =
      doubleInfo.doubleDays > 0 ? round2(((remunerationBase + averages) / 30) * doubleInfo.doubleDays) : 0;
    const doubleVacationOneThirdIndemnity =
      doubleVacationIndemnity > 0 ? divideMoney(doubleVacationIndemnity, 3) : 0;

    // Adiantamento de 13º nas férias (metade da remuneração com adicionais fixos + médias)
    const thirteenthAdvanceGross = input.wantsThirteenthAdvance
      ? divideMoney(addMoney(remunerationBase, averages), 2)
      : 0;

    const totalTaxableInssFgtsBase = sumMoney([vacationGross, vacationOneThird, averagesVacationGross]);
    // Na 1ª parcela de 13º nas férias, FGTS incide sobre o adiantamento do 13º, mas IRRF e INSS não.
    const totalFgtsBase = addMoney(totalTaxableInssFgtsBase, thirteenthAdvanceGross);
    const totalTaxableIrrfBase = totalTaxableInssFgtsBase;
    const totalExemptIndemnity = sumMoney([
      abonoGross,
      abonoOneThird,
      doubleVacationIndemnity,
      doubleVacationOneThirdIndemnity,
    ]);
    const totalGross = sumMoney([totalTaxableInssFgtsBase, totalExemptIndemnity, thirteenthAdvanceGross]);

    const monthSplits = this.splitVacationAcrossMonths(
      input.startDate,
      input.endDate,
      totalTaxableInssFgtsBase,
      totalFgtsBase
    );

    return {
      remunerationBase,
      vacationGross,
      vacationOneThird,
      abonoGross,
      abonoOneThird,
      averagesVacationGross,
      doubleVacationIndemnity,
      doubleVacationOneThirdIndemnity,
      thirteenthAdvanceGross,
      totalTaxableInssFgtsBase,
      totalTaxableIrrfBase,
      totalExemptIndemnity,
      totalGross,
      doubleInfo,
      monthSplits,
    };
  }
}
