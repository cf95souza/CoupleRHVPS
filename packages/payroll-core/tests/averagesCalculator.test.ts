import { describe, expect, it } from 'vitest';
import { AveragesCalculator, type HistoricalRubricEntry } from '../src/legal/AveragesCalculator.js';

describe('FOLHA-10: Motor de Médias Configurável por CCT (AveragesCalculator)', () => {
  it('valoriza 20h HE 50% por 6 meses pelo salário-hora ATUAL pós-aumento em Novembro + reflexo DSR (Súmula 347 TST)', () => {
    // Cenário: colaborador recebia R$ 2.200 até Outubro e teve aumento para R$ 3.300 em Novembro.
    // Fez 20h de HE 50% em cada um dos 6 meses (Jun..Nov).
    // Salário-hora atual: 3300 / 220 = R$ 15,00. Com fator 1.5 = R$ 22,50/h.
    // Média física: 120h / 6 = 20h * 22,50 = R$ 450,00.
    // Reflexo DSR (25 úteis, 5 inúteis): (450 / 25) * 5 = R$ 90,00 -> Total: R$ 540,00.
    const entries: HistoricalRubricEntry[] = [6, 7, 8, 9, 10, 11].map((month) => ({
      year: 2026,
      month,
      rubricId: 'r-102',
      rubricCode: '102',
      rubricName: 'Horas Extras 50%',
      averageType: 'HOURS_QUANTITY',
      quantity: 20,
      amount: month < 11 ? 300 : 450,
      factor: 1.5,
      integraDsr: true,
      includeInVacationAvg: true,
      includeIn13thAvg: true,
      includeInNoticeAvg: true,
    }));

    const res = AveragesCalculator.calculate({
      target: 'VACATION',
      referenceYear: 2026,
      referenceMonth: 11,
      currentHourlyBase: 3300,
      divisor: 220,
      windowMode: 'LAST_6M',
      diasUteis: 25,
      diasInuteis: 5,
      entries,
    });

    expect(res.divisorMonths).toBe(6);
    expect(res.hoursAverageTotal).toBe(450);
    expect(res.dsrReflexAmount).toBe(90);
    expect(res.totalAverage).toBe(540);
    expect(res.monthlyBreakdown).toHaveLength(6);
    expect(res.byRubric[0].currentUnitHourlyRate).toBe(15);
  });

  it('apura média monetária (MONETARY_VALUE) de comissões e DSR sobre janela de 12 meses', () => {
    const entries: HistoricalRubricEntry[] = [
      {
        year: 2026,
        month: 1,
        rubricId: 'r-com',
        rubricCode: '205',
        rubricName: 'Comissões sobre Vendas',
        averageType: 'MONETARY_VALUE',
        quantity: 1,
        amount: 1200,
        includeInVacationAvg: true,
        includeIn13thAvg: true,
        includeInNoticeAvg: true,
      },
      {
        year: 2026,
        month: 2,
        rubricId: 'r-com',
        rubricCode: '205',
        rubricName: 'Comissões sobre Vendas',
        averageType: 'MONETARY_VALUE',
        quantity: 1,
        amount: 2400,
        includeInVacationAvg: true,
        includeIn13thAvg: true,
        includeInNoticeAvg: true,
      },
    ];

    const res = AveragesCalculator.calculate({
      target: 'THIRTEENTH',
      referenceYear: 2026,
      referenceMonth: 12,
      currentHourlyBase: 2200,
      windowMode: 'CALENDAR_YEAR',
      entries,
    });

    // 3600 / 12 meses = R$ 300,00
    expect(res.divisorMonths).toBe(12);
    expect(res.monetaryAverageTotal).toBe(300);
    expect(res.totalAverage).toBe(300);
  });

  it('aplica correção monetária composta em MONETARY_INDEXED conforme taxa da CCT', () => {
    const res = AveragesCalculator.calculate({
      target: 'VACATION',
      referenceYear: 2026,
      referenceMonth: 6,
      currentHourlyBase: 2200,
      windowMode: 'LAST_6M',
      monthlyIndexRate: 0.01, // 1% ao mês
      entries: [
        {
          year: 2026,
          month: 4, // 2 meses antes de junho -> (1.01)^2 = 1.0201 -> 1020.10
          rubricId: 'r-com',
          rubricCode: '205',
          rubricName: 'Comissões Indexadas',
          averageType: 'MONETARY_INDEXED',
          quantity: 1,
          amount: 1000,
          includeInVacationAvg: true,
        },
      ],
    });

    expect(res.monthlyBreakdown[0].updatedAmount).toBe(1020.1);
    expect(res.monetaryAverageTotal).toBe(170.02); // 1020.10 / 6
  });

  it('seleciona a melhor janela entre 6 meses e 12 meses quando CCT usa BEST_OF_6M_OR_12M', () => {
    // Nos últimos 6 meses fez 30h/mês; nos 6 meses anteriores não fez nenhuma hora extra.
    // 6m -> média 30h; 12m -> média 15h. Deve escolher 6m!
    const entries: HistoricalRubricEntry[] = [7, 8, 9, 10, 11, 12].map((month) => ({
      year: 2026,
      month,
      rubricId: 'r-102',
      rubricCode: '102',
      rubricName: 'Horas Extras 50%',
      averageType: 'HOURS_QUANTITY',
      quantity: 30,
      amount: 450,
      factor: 1.5,
      integraDsr: false,
      includeInNoticeAvg: true,
    }));

    const res = AveragesCalculator.calculate({
      target: 'NOTICE',
      referenceYear: 2026,
      referenceMonth: 12,
      currentHourlyBase: 2200, // 10/h * 1.5 = 15/h
      windowMode: 'BEST_OF_6M_OR_12M',
      includeDsrReflex: false,
      entries,
    });

    expect(res.divisorMonths).toBe(6);
    expect(res.hoursAverageTotal).toBe(450); // 30h * 15
    expect(res.windowUsed).toContain('Melhor Média');
  });
});
