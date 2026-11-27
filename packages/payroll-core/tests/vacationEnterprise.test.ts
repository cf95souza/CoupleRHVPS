import { describe, expect, it } from 'vitest';
import { VacationEnterpriseCalculator } from '../src/legal/VacationEnterpriseCalculator.js';

describe('FOLHA-11: Férias Enterprise (6 Cenários Dourados CLT)', () => {
  it('Cenário 1: reduz dias de direito por faltas injustificadas no período aquisitivo (CLT Art. 130)', () => {
    expect(VacationEnterpriseCalculator.calculateAccruedDaysByAbsences(5)).toBe(30);
    expect(VacationEnterpriseCalculator.calculateAccruedDaysByAbsences(6)).toBe(24);
    expect(VacationEnterpriseCalculator.calculateAccruedDaysByAbsences(14)).toBe(24);
    expect(VacationEnterpriseCalculator.calculateAccruedDaysByAbsences(15)).toBe(18);
    expect(VacationEnterpriseCalculator.calculateAccruedDaysByAbsences(24)).toBe(12);
    expect(VacationEnterpriseCalculator.calculateAccruedDaysByAbsences(33)).toBe(0);
  });

  it('Cenário 2: valida fracionamento 14+5+5 e bloqueia início 2 dias antes de feriado ou DSR (CLT Art. 134 §§1º/3º)', () => {
    // 2026-11-20 é Sexta-feira (Feriado Consciência Negra); iniciar dia 18/11 (quarta) ou 19/11 (quinta) deve ser bloqueado.
    const blockedHoliday = VacationEnterpriseCalculator.validateVacationFractionation({
      startDate: '2026-11-18',
      endDate: '2026-12-01',
      daysCount: 14,
      daysRemaining: 30,
      holidays: ['2026-11-20'],
    });
    expect(blockedHoliday.valid).toBe(false);
    expect(blockedHoliday.errors[0]).toContain('Art. 134 §3º');

    // 2026-11-13 é Sexta-feira (2 dias antes do Domingo 15/11) -> vedado pelo Art. 134 §3º
    const blockedDsr = VacationEnterpriseCalculator.validateVacationFractionation({
      startDate: '2026-11-13',
      endDate: '2026-11-26',
      daysCount: 14,
      daysRemaining: 30,
    });
    expect(blockedDsr.valid).toBe(false);

    // 2026-11-09 é Segunda-feira -> válido! Mas 3 períodos sem nenhum >= 14 dias deve falhar.
    const blockedSplit = VacationEnterpriseCalculator.validateVacationFractionation({
      startDate: '2026-11-09',
      endDate: '2026-11-18',
      daysCount: 10,
      daysRemaining: 10,
      existingSplitsDays: [10, 10],
    });
    expect(blockedSplit.valid).toBe(false);
    expect(blockedSplit.errors[0]).toContain('14 dias');

    // Fracionamento válido: 14 + 8 + 8 iniciando na segunda-feira 2026-11-09
    const validSplit = VacationEnterpriseCalculator.validateVacationFractionation({
      startDate: '2026-11-09',
      endDate: '2026-11-16',
      daysCount: 8,
      daysRemaining: 16,
      existingSplitsDays: [14],
    });
    expect(validSplit.valid).toBe(true);
  });

  it('Cenário 3: calcula Férias em Dobro (CLT Art. 137) com parcela indenizatória isenta de encargos', () => {
    // Período concessivo venceu em 2026-10-10; férias de 2026-10-01 a 2026-10-20 (20 dias: 10 normais + 10 em dobro)
    const res = VacationEnterpriseCalculator.calculateEnterpriseVacation({
      baseSalary: 3000,
      daysTaken: 20,
      startDate: '2026-10-01',
      endDate: '2026-10-20',
      concessiveEndDate: '2026-10-10',
    });

    expect(res.doubleInfo.normalDays).toBe(10);
    expect(res.doubleInfo.doubleDays).toBe(10);
    // Normal: 2000 + 666.67 = 2666.67 (tributável)
    expect(res.vacationGross).toBe(2000);
    expect(res.vacationOneThird).toBe(666.67);
    expect(res.totalTaxableInssFgtsBase).toBe(2666.67);
    // Dobra indenizatória: 10 dias = 1000 + 333.33 = 1333.33 (isenta!)
    expect(res.doubleVacationIndemnity).toBe(1000);
    expect(res.doubleVacationOneThirdIndemnity).toBe(333.33);
    expect(res.totalExemptIndemnity).toBe(1333.33);
  });

  it('Cenário 4: rateia INSS e FGTS em férias partidas entre dois meses mantendo IRRF integral no caixa', () => {
    // Férias de 21/11/2026 a 20/12/2026 (10 dias em Nov + 20 dias em Dez = 30 dias)
    const res = VacationEnterpriseCalculator.calculateEnterpriseVacation({
      baseSalary: 3000,
      daysTaken: 30,
      startDate: '2026-11-21',
      endDate: '2026-12-20',
    });

    expect(res.monthSplits).toHaveLength(2);
    expect(res.monthSplits[0].competence).toBe('11/2026');
    expect(res.monthSplits[0].daysInMonth).toBe(10);
    expect(res.monthSplits[0].inssBaseShare).toBe(1333.33); // 1/3 de 4000
    expect(res.monthSplits[0].irrfAppliesInFullOnPayment).toBe(true);

    expect(res.monthSplits[1].competence).toBe('12/2026');
    expect(res.monthSplits[1].daysInMonth).toBe(20);
    expect(res.monthSplits[1].inssBaseShare).toBe(2666.67); // 2/3 de 4000
    expect(res.monthSplits[1].irrfAppliesInFullOnPayment).toBe(false);
    expect(res.monthSplits[0].inssBaseShare + res.monthSplits[1].inssBaseShare).toBe(4000);
  });

  it('Cenário 5: férias coletivas para colaborador com < 1 ano paga licença remunerada e reinicia aquisitivo (CLT Arts. 139–140)', () => {
    // Admitido em 01/07/2026; férias coletivas de 20 dias iniciando em 21/12/2026 -> ~5,6 meses -> 6 avos = 15 dias férias + 5 dias licença remunerada
    const col = VacationEnterpriseCalculator.evaluateCollectiveVacationContract({
      admissionDate: '2026-07-01',
      collectiveStartDate: '2026-12-21',
      collectiveDays: 20,
      monthlySalary: 3000,
    });

    expect(col.isUnderOneYear).toBe(true);
    expect(col.monthsWorked).toBe(6);
    expect(col.proportionalVacationDays).toBe(15);
    expect(col.paidLeaveDays).toBe(5);
    expect(col.vacationPayAmount).toBe(1500);
    expect(col.vacationOneThirdAmount).toBe(500);
    expect(col.paidLeaveAmount).toBe(500);
    expect(col.resetAcquisitionStartDate).toBe('2026-12-21');
    expect(col.resetAcquisitionEndDate).toBe('2027-12-20');
  });

  it('Cenário 6: integra médias automáticas de horas extras e adicionais no adiantamento de 13º nas férias', () => {
    const res = VacationEnterpriseCalculator.calculateEnterpriseVacation({
      baseSalary: 3000,
      fixedAdditionals: 600,
      averagesAmount: 300,
      daysTaken: 30,
      sellDaysCount: 0,
      wantsThirteenthAdvance: true,
      startDate: '2026-11-02',
      endDate: '2026-12-01',
    });

    expect(res.remunerationBase).toBe(3600);
    expect(res.vacationGross).toBe(3600);
    expect(res.vacationOneThird).toBe(1200);
    expect(res.averagesVacationGross).toBe(400); // 300 * 4/3
    // 13º adiantamento = metade de (3600 + 300) = 1950
    expect(res.thirteenthAdvanceGross).toBe(1950);
  });
});
