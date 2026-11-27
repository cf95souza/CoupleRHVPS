import { describe, expect, it } from 'vitest';
import { ProvisionsLedgerCalculator } from '../src/accounting/ProvisionsLedgerCalculator.js';

describe('CONT-02: ProvisionsLedgerCalculator (Saldo Acumulado, Reajuste Salarial e Baixas Reais)', () => {
  it('apura 1º mês de provisão de Férias + 1/3 com encargos reais do Lucro Real (20% + 2% RAT + 5,8% Terceiros + 8% FGTS)', () => {
    const res = ProvisionsLedgerCalculator.calculate({
      contractId: 'c-1',
      provisionType: 'VACATION',
      year: 2026,
      month: 6,
      currentSalary: 3000,
      avosPreviouslyAccumulated: 5,
      earnedAvoInMonth: true,
      openingBalance: 1666.67,
      chargesOpeningBalance: 596.67,
      settlementsPaid: 0,
      calculationRegime: 'CLT',
      companyConfig: {
        tax_regime: 'LUCRO_REAL',
        rat_percentage: 2,
        fap_multiplier: 1,
        terceiros_percentage: 5.8,
      },
    });

    // 1/12 de (3000 * 4/3) = 4000 / 12 = 333.33
    expect(res.monthlyAccrual).toBe(333.33);
    expect(res.closingBalance).toBe(2000);
    expect(res.netAccountingEntry).toBe(333.33);
    expect(res.effectiveEmployerRate).toBeCloseTo(0.358, 4);
    expect(res.avosAccumulated).toBe(6);
  });

  it('calcula impacto de aumento salarial sobre avos anteriores e realiza baixa real de férias gozadas', () => {
    const res = ProvisionsLedgerCalculator.calculate({
      contractId: 'c-1',
      provisionType: 'VACATION',
      year: 2026,
      month: 7,
      currentSalary: 3600,
      previousSalary: 3000,
      avosPreviouslyAccumulated: 6,
      earnedAvoInMonth: true,
      openingBalance: 2000,
      chargesOpeningBalance: 716,
      settlementsPaid: 1800,
      calculationRegime: 'CLT',
      companyConfig: {
        tax_regime: 'SIMPLES_NACIONAL',
        simples_anexo: 'I',
      },
    });

    // Reajuste: +600 * (4/3) * 6 / 12 = +400,00; avo mensal: (3600 * 4/3)/12 = 400,00; baixa -1800 -> fechamento 1000
    expect(res.salaryAdjustmentDiff).toBe(400);
    expect(res.monthlyAccrual).toBe(400);
    expect(res.closingBalance).toBe(1000);
    expect(res.netAccountingEntry).toBe(-1000); // Reversão líquida contábil
    // Simples Anexo I paga apenas 8% FGTS sobre provisão
    expect(res.effectiveEmployerRate).toBeCloseTo(0.08, 4);
    expect(res.chargesClosingBalance).toBe(80);
  });

  it('zera provisão e encargos para Pró-Labore e Estagiário', () => {
    const res = ProvisionsLedgerCalculator.calculate({
      contractId: 'c-pl',
      provisionType: 'THIRTEENTH',
      year: 2026,
      month: 7,
      currentSalary: 10000,
      avosPreviouslyAccumulated: 0,
      earnedAvoInMonth: true,
      openingBalance: 0,
      chargesOpeningBalance: 0,
      settlementsPaid: 0,
      calculationRegime: 'PRO_LABORE',
    });

    expect(res.closingBalance).toBe(0);
    expect(res.chargesClosingBalance).toBe(0);
    expect(res.breakdown.exemptByRegime).toBe(true);
  });
});
