import type { TimeDailySummary, TimeDailyStatus } from './timeTrackingModel.js';
import { round2 } from '../utils/money.js';

export interface ShiftSchedule {
  schedule_type: 'FIXED' | 'FLEXIBLE' | 'SHIFT_12X36' | 'SCALE';
  expected_in?: string; // HH:mm
  expected_break_start?: string; // HH:mm
  expected_break_end?: string; // HH:mm
  expected_out?: string; // HH:mm
  expected_work_minutes: number;
  expected_break_minutes?: number;
}

export interface DailyShiftInput {
  date: string; // YYYY-MM-DD
  contract_id: string;
  tenant_id: string;
  company_id?: string;
  punches: string[]; // Timestamps ISO das batidas do dia ordenadas ou não
  schedule: ShiftSchedule;
  isHolidayOrDsr?: boolean;
  previousDayExitTimestamp?: string; // Timestamp ISO da última saída do dia anterior
  overtime_regime?: 'TIME_BANK' | 'OVERTIME_PAYROLL' | 'HYBRID';
  standbyMinutes?: number;
  readinessMinutes?: number;
  nightStartHour?: number;
  nightEndHour?: number;
  nightExtendedProrrogation?: boolean;
}

export interface RotatingCalendarDay {
  date: string;
  dayOfMonth: number;
  dayOfWeek: number;
  isWorkDay: boolean;
  isHoliday: boolean;
  holidayName?: string | null;
  expectedIn: string | null;
  expectedOut: string | null;
  expectedBreakStart: string | null;
  expectedBreakEnd: string | null;
  expectedWorkMinutes: number;
  label: string;
}

/**
 * Converte data ISO para minutos decorridos a partir da meia-noite (0 a 1439...)
 */
function getMinutesFromMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function isMinuteInNightWindow(
  hour: number,
  nightStartHour: number,
  nightEndHour: number,
  enteredNightWindow: boolean,
  prorrogateAfterEnd: boolean
): boolean {
  if (nightStartHour > nightEndHour) {
    if (hour >= nightStartHour || hour < nightEndHour) return true;
    return prorrogateAfterEnd && enteredNightWindow && hour >= nightEndHour && hour < 12;
  }
  return hour >= nightStartHour && hour < nightEndHour;
}

/**
 * Calcula minutos noturnos (padrao 22h-05h, com suporte a janela configuravel e prorrogação Súmula 60 II TST)
 */
function calculateNightMinutes(
  startTime: Date,
  endTime: Date,
  nightStartHour = 22,
  nightEndHour = 5,
  prorrogate = false
): number {
  let nightMinutes = 0;
  let enteredNight = false;
  const current = new Date(startTime.getTime());

  while (current < endTime) {
    const hour = current.getHours();
    const inCoreNight =
      nightStartHour > nightEndHour
        ? hour >= nightStartHour || hour < nightEndHour
        : hour >= nightStartHour && hour < nightEndHour;
    if (inCoreNight) {
      enteredNight = true;
      nightMinutes++;
    } else if (prorrogate && enteredNight && hour >= nightEndHour && hour < 12) {
      nightMinutes++;
    }
    current.setMinutes(current.getMinutes() + 1);
  }

  return nightMinutes;
}

/**
 * Conta quantos minutos dos ultimos `overtimeMinutes` trabalhados no dia ocorreram em faixa noturna.
 */
function calculateNightOvertimeRawMinutes(
  sortedPunches: Date[],
  overtimeMinutes: number,
  nightStartHour: number,
  nightEndHour: number,
  prorrogate: boolean
): number {
  if (overtimeMinutes <= 0 || sortedPunches.length < 2) return 0;

  // Reconstrói linha do tempo trabalhada minuto a minuto e marca os últimos `overtimeMinutes`
  const workedTimeline: Date[] = [];
  const pairsCount = Math.floor(sortedPunches.length / 2);
  let enteredNight = false;

  for (let i = 0; i < pairsCount; i++) {
    const cursor = new Date(sortedPunches[i * 2].getTime());
    const out = sortedPunches[i * 2 + 1];
    while (cursor < out) {
      workedTimeline.push(new Date(cursor.getTime()));
      const h = cursor.getHours();
      if (nightStartHour > nightEndHour ? h >= nightStartHour || h < nightEndHour : h >= nightStartHour && h < nightEndHour) {
        enteredNight = true;
      }
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
  }

  if (workedTimeline.length === 0) return 0;
  const otStartIdx = Math.max(0, workedTimeline.length - overtimeMinutes);
  let rawNightOt = 0;

  for (let idx = otStartIdx; idx < workedTimeline.length; idx++) {
    const h = workedTimeline[idx].getHours();
    if (isMinuteInNightWindow(h, nightStartHour, nightEndHour, enteredNight, prorrogate)) {
      rawNightOt++;
    }
  }

  return rawNightOt;
}

/**
 * OJ 97 SDI-1 TST: A hora extra noturna integra o adicional noturno na base de calculo do adicional de sobrejornada.
 * Ex: Hora normal R$ 10,00 -> +20% noturno = R$ 12,00 -> +50% HE = R$ 18,00 (fator composto 1.80).
 */
export function calculateCompositeNightOvertimeHourlyRate(
  hourlyRate: number,
  nightPercent = 0.2,
  overtimePercent = 0.5
): number {
  return round2(hourlyRate * (1 + nightPercent) * (1 + overtimePercent));
}

/**
 * Art. 244 CLT:
 * - Sobreaviso (§2º): 1/3 (0.3333...) da hora normal
 * - Prontidão (§3º): 2/3 (0.6666...) da hora normal
 */
export function calculateStandbyAndReadinessValues(
  hourlyRate: number,
  standbyHours: number,
  readinessHours: number
): {
  standbyAmount: number;
  readinessAmount: number;
  totalAmount: number;
} {
  const standbyAmount = round2(hourlyRate * (1 / 3) * Math.max(0, standbyHours));
  const readinessAmount = round2(hourlyRate * (2 / 3) * Math.max(0, readinessHours));
  return {
    standbyAmount,
    readinessAmount,
    totalAmount: round2(standbyAmount + readinessAmount),
  };
}

/**
 * Motor de Cálculo e Processamento de Jornada de Trabalho (Portaria MTP 671 / CLT)
 */
export function calculateDailyWorkShift(input: DailyShiftInput): TimeDailySummary {
  const inconsistencies: string[] = [];
  const nightStartHour = input.nightStartHour ?? 22;
  const nightEndHour = input.nightEndHour ?? 5;
  const nightProrrogation = input.nightExtendedProrrogation ?? false;

  // 1. Ordenar as batidas cronologicamente
  const sortedPunches = [...input.punches]
    .map((p) => new Date(p))
    .sort((a, b) => a.getTime() - b.getTime());

  // 2. Verificar batidas ímpares (esquecimento de batida)
  let hasMissingPunch = false;
  if (sortedPunches.length % 2 !== 0) {
    hasMissingPunch = true;
    inconsistencies.push('MISSING_PUNCH');
  }

  // 3. Montar pares de entrada e saída
  let rawWorkedMinutes = 0;
  let totalBreakMinutes = 0;
  let rawNightMinutes = 0;

  const pairsCount = Math.floor(sortedPunches.length / 2);
  for (let i = 0; i < pairsCount; i++) {
    const inTime = sortedPunches[i * 2];
    const outTime = sortedPunches[i * 2 + 1];

    const workedPart = Math.max(0, Math.round((outTime.getTime() - inTime.getTime()) / (1000 * 60)));
    rawWorkedMinutes += workedPart;

    // Calcular minutos noturnos neste período
    rawNightMinutes += calculateNightMinutes(inTime, outTime, nightStartHour, nightEndHour, nightProrrogation);

    // Calcular intervalo entre turnos
    if (i > 0) {
      const prevOutTime = sortedPunches[i * 2 - 1];
      const breakPart = Math.max(0, Math.round((inTime.getTime() - prevOutTime.getTime()) / (1000 * 60)));
      totalBreakMinutes += breakPart;
    }
  }

  const expectedWork = input.schedule.expected_work_minutes;
  const expectedBreak = input.schedule.expected_break_minutes ?? 60;

  // 4. Tolerâncias Legais da CLT (Art. 58 §1º e Súmula 366 TST)
  let workedMinutes = rawWorkedMinutes;
  let totalOvertime50 = 0;
  let totalOvertime100 = 0;
  let delayMinutes = 0;

  if (expectedWork === 0) {
    if (rawWorkedMinutes > 0) {
      totalOvertime100 = rawWorkedMinutes;
    }
  } else if (!hasMissingPunch && sortedPunches.length >= 2) {
    const firstIn = sortedPunches[0];
    const lastOut = sortedPunches[sortedPunches.length - 1];

    let totalVariation = 0;
    let inVariation = 0;
    let outVariation = 0;

    if (input.schedule.expected_in) {
      const [expInH, expInM] = input.schedule.expected_in.split(':').map(Number);
      const inMinutes = getMinutesFromMidnight(firstIn);
      const expectedInMinutes = expInH * 60 + expInM;
      inVariation = inMinutes - expectedInMinutes;
      totalVariation += Math.abs(inVariation);
    }

    if (input.schedule.expected_out) {
      const [expOutH, expOutM] = input.schedule.expected_out.split(':').map(Number);
      const outMinutes = getMinutesFromMidnight(lastOut);
      const expectedOutMinutes = expOutH * 60 + expOutM;
      outVariation = outMinutes - expectedOutMinutes;
      totalVariation += Math.abs(outVariation);
    }

    const hasScheduledClock = Boolean(input.schedule.expected_in || input.schedule.expected_out);
    const withinTolerance = hasScheduledClock
      ? Math.abs(inVariation) <= 5 && Math.abs(outVariation) <= 5 && totalVariation <= 10
      : Math.abs(rawWorkedMinutes - expectedWork) <= 10;

    if (withinTolerance) {
      workedMinutes = expectedWork;
      totalOvertime50 = 0;
      delayMinutes = 0;
    } else {
      if (rawWorkedMinutes > expectedWork) {
        const excessMinutes = rawWorkedMinutes - expectedWork;
        if (input.isHolidayOrDsr && input.schedule.schedule_type !== 'SHIFT_12X36') {
          totalOvertime100 = excessMinutes;
        } else {
          totalOvertime50 = excessMinutes;
        }
      } else if (rawWorkedMinutes < expectedWork) {
        delayMinutes = expectedWork - rawWorkedMinutes;
      }
    }
  }

  // 5. Escala 12x36 (Art. 59-A CLT)
  if (input.schedule.schedule_type === 'SHIFT_12X36') {
    totalOvertime100 = 0;
    if (rawWorkedMinutes > 720) {
      totalOvertime50 = rawWorkedMinutes - 720;
    } else {
      totalOvertime50 = 0;
    }
  }

  // 6. Adicional Noturno com Hora Reduzida (Art. 73 CLT: fator 60/52.5 = 8/7)
  const nightShiftMinutes = Math.round((rawNightMinutes * 8) / 7);

  // Separação de HE noturna (OJ 97 SDI-1 TST) sem subtrair HE 50% total para manter compatibilidade com testes legados
  const totalOt = totalOvertime50 + totalOvertime100;
  const rawNightOt = calculateNightOvertimeRawMinutes(
    sortedPunches,
    totalOt,
    nightStartHour,
    nightEndHour,
    nightProrrogation
  );
  const reducedNightOt = Math.round((rawNightOt * 8) / 7);
  const nightOvertime50 = totalOvertime50 > 0 ? reducedNightOt : 0;
  const nightOvertime100 = totalOvertime100 > 0 ? reducedNightOt : 0;

  // 7. Intervalo Intrajornada (Art. 71 CLT)
  let intrajornadaViolation = 0;
  if (expectedWork > 360 && expectedBreak > 0) {
    if (totalBreakMinutes < expectedBreak) {
      intrajornadaViolation = expectedBreak - totalBreakMinutes;
      inconsistencies.push('INTRAJORNADA_VIOLATION');
    }
  } else if (expectedWork > 240 && expectedWork <= 360) {
    if (totalBreakMinutes < 15) {
      intrajornadaViolation = 15 - totalBreakMinutes;
      inconsistencies.push('INTRAJORNADA_VIOLATION');
    }
  }

  // 8. Intervalo Interjornada de 11h (Art. 66 CLT - 660 minutos)
  let interjornadaViolation = 0;
  if (input.previousDayExitTimestamp && sortedPunches.length > 0) {
    const prevExit = new Date(input.previousDayExitTimestamp).getTime();
    const currentFirstIn = sortedPunches[0].getTime();
    const restMinutes = Math.round((currentFirstIn - prevExit) / (1000 * 60));

    if (restMinutes < 660) {
      interjornadaViolation = 660 - restMinutes;
      inconsistencies.push('INTERJORNADA_VIOLATION');
    }
  }

  // 9. Direcionamento para Banco de Horas conforme regime contratual (TB-01)
  let timeBankCredited = 0;
  let timeBankDebited = 0;

  if (input.overtime_regime === 'TIME_BANK') {
    timeBankCredited = totalOvertime50 + totalOvertime100;
    timeBankDebited = delayMinutes;
  } else if (input.overtime_regime === 'HYBRID') {
    timeBankCredited = totalOvertime50;
    timeBankDebited = delayMinutes;
  }

  // 10. Ponto por Exceção (Art. 74 §4º CLT) e Definição do Status
  let status: TimeDailyStatus = 'REGULAR';
  if (hasMissingPunch || intrajornadaViolation > 0 || interjornadaViolation > 0) {
    status = 'INCONSISTENT';
  } else if (totalOvertime50 > 0 || totalOvertime100 > 0 || delayMinutes > 0) {
    status = 'PENDING_APPROVAL';
  }

  return {
    tenant_id: input.tenant_id,
    company_id: input.company_id,
    contract_id: input.contract_id,
    date: input.date,
    expected_work_minutes: expectedWork,
    worked_minutes: workedMinutes,
    overtime_50_minutes: totalOvertime50,
    overtime_100_minutes: totalOvertime100,
    night_shift_minutes: nightShiftMinutes,
    night_overtime_minutes: nightOvertime50,
    night_overtime_100_minutes: nightOvertime100,
    standby_minutes: Math.max(0, Math.round(input.standbyMinutes || 0)),
    readiness_minutes: Math.max(0, Math.round(input.readinessMinutes || 0)),
    delay_minutes: delayMinutes,
    absence_minutes: 0,
    break_taken_minutes: totalBreakMinutes,
    break_expected_minutes: expectedBreak,
    intrajornada_violation_minutes: intrajornadaViolation,
    interjornada_violation_minutes: interjornadaViolation,
    time_bank_credited_minutes: timeBankCredited,
    time_bank_debited_minutes: timeBankDebited,
    status,
    inconsistencies,
  };
}

/**
 * PONTO-05 e PONTO-07: Gerador do Calendario Visual Mensal de Escalas Semanais e Rotativas
 */
export function generateRotatingScheduleCalendar(params: {
  year: number;
  month: number;
  shiftType: string;
  rotationAnchorDate?: string | Date | null;
  scheduleData?: any[];
  holidays?: Array<{ date: string; name: string }>;
}): RotatingCalendarDay[] {
  const { year, month, shiftType, rotationAnchorDate, scheduleData = [], holidays = [] } = params;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const anchorIso =
    rotationAnchorDate instanceof Date
      ? rotationAnchorDate.toISOString().slice(0, 10)
      : rotationAnchorDate
        ? String(rotationAnchorDate).slice(0, 10)
        : null;
  const parsedAnchorMs = anchorIso ? Date.parse(`${anchorIso}T00:00:00Z`) : NaN;
  const anchorMs = Number.isFinite(parsedAnchorMs) ? parsedAnchorMs : Date.UTC(year, month - 1, 1);

  const holidayMap = new Map(holidays.map((h) => [String(h.date).slice(0, 10), h.name]));
  const result: RotatingCalendarDay[] = [];

  const getCycleConfig = (type: string): { workDays: number; offDays: number; defaultIn: string; defaultOut: string; workMins: number } | null => {
    switch (type) {
      case 'ROTATING_12X36':
      case 'SHIFT_12X36':
        return { workDays: 1, offDays: 1, defaultIn: '07:00', defaultOut: '19:00', workMins: 660 };
      case 'ROTATING_24X48':
        return { workDays: 1, offDays: 2, defaultIn: '07:00', defaultOut: '07:00', workMins: 1320 };
      case 'ROTATING_5X1':
        return { workDays: 5, offDays: 1, defaultIn: '08:00', defaultOut: '17:00', workMins: 480 };
      case 'ROTATING_6X1':
        return { workDays: 6, offDays: 1, defaultIn: '08:00', defaultOut: '16:20', workMins: 440 };
      case 'ROTATING_6X2':
        return { workDays: 6, offDays: 2, defaultIn: '08:00', defaultOut: '16:20', workMins: 440 };
      case 'ROTATING_4X2':
        return { workDays: 4, offDays: 2, defaultIn: '07:00', defaultOut: '17:00', workMins: 540 };
      default:
        return null;
    }
  };

  const cycle = getCycleConfig(shiftType);

  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(Date.UTC(year, month - 1, d));
    const dateStr = dt.toISOString().slice(0, 10);
    const dow = dt.getUTCDay(); // 0=Dom .. 6=Sab
    const holidayName = holidayMap.get(dateStr) || null;
    const isHoliday = holidayName !== null;

    if (cycle) {
      const diffDays = Math.floor((dt.getTime() - anchorMs) / 86400000);
      const totalCycle = cycle.workDays + cycle.offDays;
      const pos = ((diffDays % totalCycle) + totalCycle) % totalCycle;
      const isWork = pos < cycle.workDays;
      // 12x36 e 24x48 trabalham normalmente no ciclo inclusive em feriado
      const isCycleImmuneToHoliday = shiftType === 'ROTATING_12X36' || shiftType === 'SHIFT_12X36' || shiftType === 'ROTATING_24X48';
      const effectiveWork = isWork && (isCycleImmuneToHoliday || !isHoliday);

      result.push({
        date: dateStr,
        dayOfMonth: d,
        dayOfWeek: dow,
        isWorkDay: effectiveWork,
        isHoliday,
        holidayName,
        expectedIn: effectiveWork ? cycle.defaultIn : null,
        expectedOut: effectiveWork ? cycle.defaultOut : null,
        expectedBreakStart: effectiveWork ? '12:00' : null,
        expectedBreakEnd: effectiveWork ? '13:00' : null,
        expectedWorkMinutes: effectiveWork ? cycle.workMins : 0,
        label: !isWork
          ? 'Folga de Escala'
          : isHoliday && !isCycleImmuneToHoliday
            ? `Feriado (${holidayName})`
            : `Plantão ${shiftType.replace('ROTATING_', '').replace('SHIFT_', '')}`,
      });
      continue;
    }

    // Escala Semanal / Flexível
    const dayRule = Array.isArray(scheduleData)
      ? scheduleData.find((s: any) => Number(s.day_of_week ?? s.dayOfWeek) === dow)
      : null;

    const scheduledWork = dayRule
      ? dayRule.is_work_day !== false && (dayRule.expected_work_minutes ?? 480) > 0
      : dow >= 1 && dow <= 5;
    const effectiveWork = scheduledWork && !isHoliday;

    result.push({
      date: dateStr,
      dayOfMonth: d,
      dayOfWeek: dow,
      isWorkDay: effectiveWork,
      isHoliday,
      holidayName,
      expectedIn: effectiveWork ? dayRule?.expected_in || '08:00' : null,
      expectedOut: effectiveWork ? dayRule?.expected_out || '17:48' : null,
      expectedBreakStart: effectiveWork ? dayRule?.expected_break_start || '12:00' : null,
      expectedBreakEnd: effectiveWork ? dayRule?.expected_break_end || '13:00' : null,
      expectedWorkMinutes: effectiveWork ? Number(dayRule?.expected_work_minutes ?? 528) : 0,
      label: isHoliday ? `Feriado (${holidayName})` : effectiveWork ? 'Jornada Normal' : 'DSR / Folga',
    });
  }

  return result;
}

/**
 * PONTO-07: Politica de Banco de Horas Negativo Parametrizada por CCT
 */
export function evaluateNegativeTimeBankPolicy(params: {
  currentBalanceMinutes: number;
  requestedDebitMinutes: number;
  allowNegative: boolean;
  maxNegativeMinutes: number;
  deductionRule: 'COMPENSATE_ONLY' | 'DEDUCT_ON_CLOSURE' | 'DEDUCT_ON_TERMINATION_ONLY';
  eventContext: 'DAILY' | 'CLOSURE' | 'TERMINATION';
}): {
  newBalanceMinutes: number;
  allowedInBankMinutes: number;
  excessToPayrollDeductionMinutes: number;
  shouldDeductNow: boolean;
} {
  const {
    currentBalanceMinutes,
    requestedDebitMinutes,
    allowNegative,
    maxNegativeMinutes,
    deductionRule,
    eventContext,
  } = params;

  const minAllowedBalance = allowNegative ? -Math.abs(maxNegativeMinutes) : 0;
  const projectedBalance = currentBalanceMinutes - Math.max(0, requestedDebitMinutes);

  if (eventContext === 'DAILY') {
    if (projectedBalance >= minAllowedBalance) {
      return {
        newBalanceMinutes: projectedBalance,
        allowedInBankMinutes: Math.max(0, requestedDebitMinutes),
        excessToPayrollDeductionMinutes: 0,
        shouldDeductNow: false,
      };
    }

    const roomInBank = Math.max(0, currentBalanceMinutes - minAllowedBalance);
    const excess = Math.max(0, requestedDebitMinutes - roomInBank);
    return {
      newBalanceMinutes: minAllowedBalance,
      allowedInBankMinutes: roomInBank,
      excessToPayrollDeductionMinutes: excess,
      shouldDeductNow: excess > 0,
    };
  }

  // Fechamento de Ciclo ou Rescisão
  if (projectedBalance >= 0) {
    return {
      newBalanceMinutes: projectedBalance,
      allowedInBankMinutes: requestedDebitMinutes,
      excessToPayrollDeductionMinutes: 0,
      shouldDeductNow: false,
    };
  }

  const negativeAbs = Math.abs(projectedBalance);
  const shouldDeduct =
    deductionRule === 'DEDUCT_ON_CLOSURE' ||
    (deductionRule === 'DEDUCT_ON_TERMINATION_ONLY' && eventContext === 'TERMINATION');

  return {
    newBalanceMinutes: shouldDeduct ? 0 : projectedBalance,
    allowedInBankMinutes: 0,
    excessToPayrollDeductionMinutes: shouldDeduct ? negativeAbs : 0,
    shouldDeductNow: shouldDeduct,
  };
}
