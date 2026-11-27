import { describe, it, expect } from 'vitest';
import {
  calculateCompositeNightOvertimeHourlyRate,
  calculateDailyWorkShift,
  calculateStandbyAndReadinessValues,
  evaluateNegativeTimeBankPolicy,
  generateRotatingScheduleCalendar,
} from '../src/index.js';

describe('advancedWorkShift (PONTO-07)', () => {
  it('1. Deve calcular HE noturna composta OJ 97 e valores de Sobreaviso (1/3) e Prontidão (2/3)', () => {
    const rate = calculateCompositeNightOvertimeHourlyRate(10, 0.2, 0.5);
    expect(rate).toBe(18);

    const extra = calculateStandbyAndReadinessValues(30, 6, 3);
    expect(extra.standbyAmount).toBe(60); // 30 * 1/3 * 6
    expect(extra.readinessAmount).toBe(60); // 30 * 2/3 * 3
    expect(extra.totalAmount).toBe(120);
  });

  it('2. Deve separar horas extras noturnas com hora reduzida 8/7 na jornada', () => {
    const res = calculateDailyWorkShift({
      date: '2026-10-15',
      contract_id: 'c1',
      tenant_id: 't1',
      punches: [
        '2026-10-15T18:00:00',
        '2026-10-15T22:00:00',
        '2026-10-15T23:00:00',
        '2026-10-16T04:00:00',
      ],
      schedule: {
        schedule_type: 'FIXED',
        expected_work_minutes: 480,
        expected_break_minutes: 60,
      },
      standbyMinutes: 180,
      readinessMinutes: 60,
    });

    // 4h + 5h = 540 min trabalhados -> 60 min extras reais ocorridos entre 03h e 04h (noturno) -> 60 * 8/7 = 69 min
    expect(res.overtime_50_minutes).toBe(60);
    expect(res.night_overtime_minutes).toBe(69);
    expect(res.standby_minutes).toBe(180);
    expect(res.readiness_minutes).toBe(60);
  });

  it('3. Deve gerar escala rotativa 12x36 e respeitar teto negativo da CCT no banco de horas', () => {
    const cal = generateRotatingScheduleCalendar({
      year: 2026,
      month: 10,
      shiftType: 'ROTATING_12X36',
      rotationAnchorDate: '2026-10-01',
    });
    expect(cal).toHaveLength(31);
    expect(cal[0].isWorkDay).toBe(true);
    expect(cal[1].isWorkDay).toBe(false);
    expect(cal[2].isWorkDay).toBe(true);

    const bankDaily = evaluateNegativeTimeBankPolicy({
      currentBalanceMinutes: -300,
      requestedDebitMinutes: 200,
      allowNegative: true,
      maxNegativeMinutes: 400,
      deductionRule: 'DEDUCT_ON_TERMINATION_ONLY',
      eventContext: 'DAILY',
    });
    expect(bankDaily.allowedInBankMinutes).toBe(100);
    expect(bankDaily.excessToPayrollDeductionMinutes).toBe(100);
    expect(bankDaily.newBalanceMinutes).toBe(-400);
    expect(bankDaily.shouldDeductNow).toBe(true);
  });
});
