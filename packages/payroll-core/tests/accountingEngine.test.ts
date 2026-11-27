import { describe, expect, it } from 'vitest';
import { AccountingEngine } from '../src/accounting/AccountingEngine.js';

describe('CONT-03: AccountingEngine (Partidas Dobradas D === C e Exportadores ERP)', () => {
  const journal = AccountingEngine.generateDoubleEntryJournal({
    entryDate: '2026-08-31',
    competenceLabel: '08/2026',
    companyCnpj: '12.345.678/0001-90',
    totalEarnings: 10000,
    totalNetSalary: 7900,
    totalInssEmployee: 900,
    totalIrrfEmployee: 500,
    totalAlimonyDeductions: 400,
    totalOtherDeductions: 300,
    employerInssPatronalTotal: 2780,
    employerFgtsTotal: 800,
    vacationProvisionNetEntry: -200, // Reversão líquida após gozo
    thirteenthProvisionNetEntry: 833.33,
    vacationChargesNetEntry: -71.6,
    thirteenthChargesNetEntry: 298.33,
    costCenterBreakdown: [
      { costCenterCode: 'CC-ADM', earningsAmount: 6000, employerInssAmount: 1668, fgtsAmount: 480 },
      { costCenterCode: 'CC-OBRA', cnoNumber: '900012345678', earningsAmount: 4000, employerInssAmount: 1112, fgtsAmount: 320 },
    ],
  });

  it('garante equilíbrio rigoroso D === C inclusive com reversão líquida de provisão e rateio por CC', () => {
    expect(journal.isBalanced).toBe(true);
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.entries.some((e) => e.costCenterCode === 'CC-OBRA')).toBe(true);
    expect(journal.entries.some((e) => e.history.includes('(Reversão)'))).toBe(true);
  });

  it('exporta os 5 leiautes ERP: Domínio, Alterdata, Protheus, Senior e CSV configurável', () => {
    const dominio = AccountingEngine.exportAccountingBatch('DOMINIO', journal.entries, { companyCnpj: '12345678000190' });
    expect(dominio.content).toContain('|0000|12345678000190|');
    expect(dominio.content).toContain('|6100|31/08/2026|');

    const alterdata = AccountingEngine.exportAccountingBatch('ALTERDATA', journal.entries, { companyCnpj: '12345678000190' });
    expect(alterdata.content).toContain('31/08/2026;');

    const protheus = AccountingEngine.exportAccountingBatch('PROTHEUS', journal.entries, { companyCnpj: '12345678000190' });
    expect(protheus.content).toContain('CT2_FILIAL;CT2_DATA;');
    expect(protheus.content).toContain(';20260831;');

    const senior = AccountingEngine.exportAccountingBatch('SENIOR', journal.entries, { companyCnpj: '12345678000190' });
    expect(senior.content).toContain('12345678000190|31/08/2026|');

    const csv = AccountingEngine.exportAccountingBatch('CSV_CONFIGURABLE', journal.entries, {
      companyCnpj: '12345678000190',
      csvOptions: { delimiter: ',' },
    });
    expect(csv.content).toContain('DATA,EVENTO,CONTA,');
  });
});
