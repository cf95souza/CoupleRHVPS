/**
 * AccountingEngine.ts
 * FASE V7 — CONT-03: Motor Contábil Parametrizável (Partidas Dobradas D === C) + Exportadores ERP.
 * Suporta Plano de Contas editável, rateio por Centro de Custo/CNO e leiautes Domínio, Alterdata,
 * TOTVS Protheus, Senior e CSV configurável.
 */

import { addMoney, round2, sumMoney } from '../utils/money.js';

function formatMoneyBr(value: number): string {
  return round2(value).toFixed(2).replace('.', ',');
}

export type AccountingAccountType = 'ASSET' | 'LIABILITY' | 'EXPENSE' | 'REVENUE' | 'TRANSITORY';
export type AccountingRuleScope = 'RUBRIC' | 'EMPLOYER_TAX' | 'PROVISION' | 'NET_SALARY';
export type AccountingErpFormat = 'DOMINIO' | 'ALTERDATA' | 'PROTHEUS' | 'SENIOR' | 'CSV_CONFIGURABLE';

export interface ChartAccountDefinition {
  id?: string;
  accountCode: string;
  accountName: string;
  reducedCode?: string | null;
  accountType: AccountingAccountType;
  nature: 'DEBIT' | 'CREDIT';
  requiresCostCenter: boolean;
}

export interface AccountingRuleDefinition {
  ruleScope: AccountingRuleScope;
  rubricCode?: string | null;
  eventKey: string;
  debitAccountCode: string;
  debitAccountName: string;
  creditAccountCode: string;
  creditAccountName: string;
  historyTemplate: string;
  erpHistoryCode?: string | null;
  splitByCostCenter: boolean;
}

export interface AccountingJournalEntry {
  entryDate: string; // YYYY-MM-DD
  eventKey: string;
  accountCode: string;
  accountName: string;
  contraAccountCode?: string | null;
  type: 'DEBIT' | 'CREDIT';
  amount: number;
  costCenterCode?: string | null;
  costCenterName?: string | null;
  cnoNumber?: string | null;
  erpHistoryCode?: string | null;
  history: string;
}

export interface AccountingPeriodAmountsInput {
  entryDate: string; // YYYY-MM-DD
  competenceLabel: string; // MM/YYYY
  companyCnpj: string;
  totalEarnings: number;
  totalNetSalary: number;
  totalInssEmployee: number;
  totalIrrfEmployee: number;
  totalAlimonyDeductions: number;
  totalOtherDeductions: number;
  employerInssPatronalTotal: number; // CPP CLT + Pró-Labore + RAT + RAT Esp + Terceiros
  employerFgtsTotal: number;
  vacationProvisionNetEntry?: number; // Pode ser positivo (constituição) ou negativo (reversão líquida)
  vacationChargesNetEntry?: number;
  thirteenthProvisionNetEntry?: number;
  thirteenthChargesNetEntry?: number;
  costCenterBreakdown?: Array<{
    costCenterCode: string;
    costCenterName?: string | null;
    cnoNumber?: string | null;
    earningsAmount: number;
    employerInssAmount: number;
    fgtsAmount: number;
    vacationProvisionAmount?: number;
    thirteenthProvisionAmount?: number;
  }>;
  customRules?: AccountingRuleDefinition[];
}

export interface AccountingJournalResult {
  isBalanced: boolean;
  totalDebit: number;
  totalCredit: number;
  entries: AccountingJournalEntry[];
}

export interface CsvExportOptions {
  delimiter?: string;
  includeHeader?: boolean;
}

export const DEFAULT_CHART_OF_ACCOUNTS: ChartAccountDefinition[] = [
  { accountCode: '3.1.1.01', accountName: 'Despesas com Salários e Ordenados', reducedCode: '31101', accountType: 'EXPENSE', nature: 'DEBIT', requiresCostCenter: true },
  { accountCode: '3.1.2.01', accountName: 'Encargos Sociais - INSS Patronal / RAT / Terceiros', reducedCode: '31201', accountType: 'EXPENSE', nature: 'DEBIT', requiresCostCenter: true },
  { accountCode: '3.1.2.02', accountName: 'Encargos Sociais - FGTS Despesa', reducedCode: '31202', accountType: 'EXPENSE', nature: 'DEBIT', requiresCostCenter: true },
  { accountCode: '3.1.3.01', accountName: 'Despesa com Provisão de Férias e 1/3', reducedCode: '31301', accountType: 'EXPENSE', nature: 'DEBIT', requiresCostCenter: true },
  { accountCode: '3.1.3.02', accountName: 'Despesa com Provisão de 13º Salário', reducedCode: '31302', accountType: 'EXPENSE', nature: 'DEBIT', requiresCostCenter: true },
  { accountCode: '3.1.3.03', accountName: 'Encargos sobre Provisões (Férias e 13º)', reducedCode: '31303', accountType: 'EXPENSE', nature: 'DEBIT', requiresCostCenter: true },
  { accountCode: '2.1.2.01', accountName: 'Salários a Pagar (Líquido)', reducedCode: '21201', accountType: 'LIABILITY', nature: 'CREDIT', requiresCostCenter: false },
  { accountCode: '2.1.2.02', accountName: 'Outros Descontos / Benefícios / Consignados a Repassar', reducedCode: '21202', accountType: 'LIABILITY', nature: 'CREDIT', requiresCostCenter: false },
  { accountCode: '2.1.2.03', accountName: 'Pensão Alimentícia a Pagar', reducedCode: '21203', accountType: 'LIABILITY', nature: 'CREDIT', requiresCostCenter: false },
  { accountCode: '2.1.3.01', accountName: 'INSS e Outras Entidades a Recolher (DCTFWeb)', reducedCode: '21301', accountType: 'LIABILITY', nature: 'CREDIT', requiresCostCenter: false },
  { accountCode: '2.1.3.02', accountName: 'IRRF a Recolher (DARF 0561 / RRA)', reducedCode: '21302', accountType: 'LIABILITY', nature: 'CREDIT', requiresCostCenter: false },
  { accountCode: '2.1.3.03', accountName: 'FGTS Digital a Recolher', reducedCode: '21303', accountType: 'LIABILITY', nature: 'CREDIT', requiresCostCenter: false },
  { accountCode: '2.1.4.01', accountName: 'Provisão de Férias e 1/3 a Pagar', reducedCode: '21401', accountType: 'LIABILITY', nature: 'CREDIT', requiresCostCenter: false },
  { accountCode: '2.1.4.02', accountName: 'Provisão de 13º Salário a Pagar', reducedCode: '21402', accountType: 'LIABILITY', nature: 'CREDIT', requiresCostCenter: false },
  { accountCode: '2.1.4.03', accountName: 'Provisão de Encargos sobre Férias e 13º', reducedCode: '21403', accountType: 'LIABILITY', nature: 'CREDIT', requiresCostCenter: false },
];

export const DEFAULT_ACCOUNTING_RULES: AccountingRuleDefinition[] = [
  {
    ruleScope: 'RUBRIC',
    eventKey: 'GROSS_EARNINGS',
    debitAccountCode: '3.1.1.01',
    debitAccountName: 'Despesas com Salários e Ordenados',
    creditAccountCode: '2.1.2.01',
    creditAccountName: 'Salários a Pagar (Líquido)',
    historyTemplate: 'Proventos da folha {competence}',
    erpHistoryCode: '001',
    splitByCostCenter: true,
  },
  {
    ruleScope: 'RUBRIC',
    eventKey: 'INSS_EMPLOYEE',
    debitAccountCode: '2.1.2.01',
    debitAccountName: 'Salários a Pagar (Líquido)',
    creditAccountCode: '2.1.3.01',
    creditAccountName: 'INSS e Outras Entidades a Recolher (DCTFWeb)',
    historyTemplate: 'INSS retido de segurados {competence}',
    erpHistoryCode: '002',
    splitByCostCenter: false,
  },
  {
    ruleScope: 'RUBRIC',
    eventKey: 'IRRF_EMPLOYEE',
    debitAccountCode: '2.1.2.01',
    debitAccountName: 'Salários a Pagar (Líquido)',
    creditAccountCode: '2.1.3.02',
    creditAccountName: 'IRRF a Recolher (DARF 0561 / RRA)',
    historyTemplate: 'IRRF retido na fonte {competence}',
    erpHistoryCode: '003',
    splitByCostCenter: false,
  },
  {
    ruleScope: 'RUBRIC',
    eventKey: 'ALIMONY_DEDUCTION',
    debitAccountCode: '2.1.2.01',
    debitAccountName: 'Salários a Pagar (Líquido)',
    creditAccountCode: '2.1.2.03',
    creditAccountName: 'Pensão Alimentícia a Pagar',
    historyTemplate: 'Pensão alimentícia retida em folha {competence}',
    erpHistoryCode: '004',
    splitByCostCenter: false,
  },
  {
    ruleScope: 'RUBRIC',
    eventKey: 'OTHER_DEDUCTIONS',
    debitAccountCode: '2.1.2.01',
    debitAccountName: 'Salários a Pagar (Líquido)',
    creditAccountCode: '2.1.2.02',
    creditAccountName: 'Outros Descontos / Benefícios / Consignados a Repassar',
    historyTemplate: 'Descontos diversos e benefícios {competence}',
    erpHistoryCode: '005',
    splitByCostCenter: false,
  },
  {
    ruleScope: 'EMPLOYER_TAX',
    eventKey: 'EMPLOYER_INSS',
    debitAccountCode: '3.1.2.01',
    debitAccountName: 'Encargos Sociais - INSS Patronal / RAT / Terceiros',
    creditAccountCode: '2.1.3.01',
    creditAccountName: 'INSS e Outras Entidades a Recolher (DCTFWeb)',
    historyTemplate: 'INSS patronal, RAT e terceiros {competence}',
    erpHistoryCode: '006',
    splitByCostCenter: true,
  },
  {
    ruleScope: 'EMPLOYER_TAX',
    eventKey: 'EMPLOYER_FGTS',
    debitAccountCode: '3.1.2.02',
    debitAccountName: 'Encargos Sociais - FGTS Despesa',
    creditAccountCode: '2.1.3.03',
    creditAccountName: 'FGTS Digital a Recolher',
    historyTemplate: 'FGTS patronal incidente na folha {competence}',
    erpHistoryCode: '007',
    splitByCostCenter: true,
  },
  {
    ruleScope: 'PROVISION',
    eventKey: 'PROVISION_VACATION',
    debitAccountCode: '3.1.3.01',
    debitAccountName: 'Despesa com Provisão de Férias e 1/3',
    creditAccountCode: '2.1.4.01',
    creditAccountName: 'Provisão de Férias e 1/3 a Pagar',
    historyTemplate: 'Movimento líquido provisão férias + 1/3 {competence}',
    erpHistoryCode: '008',
    splitByCostCenter: true,
  },
  {
    ruleScope: 'PROVISION',
    eventKey: 'PROVISION_THIRTEENTH',
    debitAccountCode: '3.1.3.02',
    debitAccountName: 'Despesa com Provisão de 13º Salário',
    creditAccountCode: '2.1.4.02',
    creditAccountName: 'Provisão de 13º Salário a Pagar',
    historyTemplate: 'Movimento líquido provisão 13º salário {competence}',
    erpHistoryCode: '009',
    splitByCostCenter: true,
  },
  {
    ruleScope: 'PROVISION',
    eventKey: 'PROVISION_CHARGES',
    debitAccountCode: '3.1.3.03',
    debitAccountName: 'Encargos sobre Provisões (Férias e 13º)',
    creditAccountCode: '2.1.4.03',
    creditAccountName: 'Provisão de Encargos sobre Férias e 13º',
    historyTemplate: 'Encargos patronais líquidos sobre provisões {competence}',
    erpHistoryCode: '010',
    splitByCostCenter: false,
  },
];

function formatDateDdMmYyyy(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export class AccountingEngine {
  /**
   * Gera razão completo em partidas dobradas garantindo soma de Débitos === Créditos.
   */
  public static generateDoubleEntryJournal(input: AccountingPeriodAmountsInput): AccountingJournalResult {
    const ruleByKey = new Map<string, AccountingRuleDefinition>();
    for (const def of DEFAULT_ACCOUNTING_RULES) ruleByKey.set(def.eventKey, def);
    for (const custom of input.customRules || []) ruleByKey.set(custom.eventKey, custom);

    const entries: AccountingJournalEntry[] = [];
    const formatHistory = (tpl: string) => tpl.replace('{competence}', input.competenceLabel);

    const pushPair = (
      eventKey: string,
      amount: number,
      costCenterCode?: string | null,
      costCenterName?: string | null,
      cnoNumber?: string | null
    ) => {
      const val = round2(amount);
      if (Math.abs(val) < 0.01) return;
      const rule = ruleByKey.get(eventKey);
      if (!rule) return;

      // Valores negativos (ex: reversão líquida de provisão) invertem débito/crédito mantendo D === C
      const absVal = Math.abs(val);
      const debitCode = val >= 0 ? rule.debitAccountCode : rule.creditAccountCode;
      const debitName = val >= 0 ? rule.debitAccountName : rule.creditAccountName;
      const creditCode = val >= 0 ? rule.creditAccountCode : rule.debitAccountCode;
      const creditName = val >= 0 ? rule.creditAccountName : rule.debitAccountName;

      const hist = formatHistory(rule.historyTemplate) + (val < 0 ? ' (Reversão)' : '');

      entries.push({
        entryDate: input.entryDate,
        eventKey,
        accountCode: debitCode,
        accountName: debitName,
        contraAccountCode: creditCode,
        type: 'DEBIT',
        amount: absVal,
        costCenterCode: costCenterCode || null,
        costCenterName: costCenterName || null,
        cnoNumber: cnoNumber || null,
        erpHistoryCode: rule.erpHistoryCode || null,
        history: hist,
      });

      entries.push({
        entryDate: input.entryDate,
        eventKey,
        accountCode: creditCode,
        accountName: creditName,
        contraAccountCode: debitCode,
        type: 'CREDIT',
        amount: absVal,
        costCenterCode: costCenterCode || null,
        costCenterName: costCenterName || null,
        cnoNumber: cnoNumber || null,
        erpHistoryCode: rule.erpHistoryCode || null,
        history: hist,
      });
    };

    const ccList = input.costCenterBreakdown && input.costCenterBreakdown.length > 0 ? input.costCenterBreakdown : null;

    // 1. Despesas de folha e encargos patronais (rateados por CC/CNO quando informados)
    if (ccList) {
      for (const cc of ccList) {
        pushPair('GROSS_EARNINGS', cc.earningsAmount, cc.costCenterCode, cc.costCenterName, cc.cnoNumber);
        pushPair('EMPLOYER_INSS', cc.employerInssAmount, cc.costCenterCode, cc.costCenterName, cc.cnoNumber);
        pushPair('EMPLOYER_FGTS', cc.fgtsAmount, cc.costCenterCode, cc.costCenterName, cc.cnoNumber);
      }
    } else {
      pushPair('GROSS_EARNINGS', input.totalEarnings);
      pushPair('EMPLOYER_INSS', input.employerInssPatronalTotal);
      pushPair('EMPLOYER_FGTS', input.employerFgtsTotal);
    }

    // 2. Retenções sobre Salários a Pagar (transferem passivo bruto para INSS/IRRF/Pensão/Outros)
    pushPair('INSS_EMPLOYEE', input.totalInssEmployee);
    pushPair('IRRF_EMPLOYEE', input.totalIrrfEmployee);
    pushPair('ALIMONY_DEDUCTION', input.totalAlimonyDeductions);
    pushPair('OTHER_DEDUCTIONS', input.totalOtherDeductions);

    // 3. Movimento líquido de Provisões Contábeis Reais (CONT-02)
    pushPair('PROVISION_VACATION', input.vacationProvisionNetEntry || 0);
    pushPair('PROVISION_THIRTEENTH', input.thirteenthProvisionNetEntry || 0);
    const totalProvCharges = addMoney(input.vacationChargesNetEntry || 0, input.thirteenthChargesNetEntry || 0);
    pushPair('PROVISION_CHARGES', totalProvCharges);

    const totalDebit = sumMoney(entries.filter((e) => e.type === 'DEBIT').map((e) => e.amount));
    const totalCredit = sumMoney(entries.filter((e) => e.type === 'CREDIT').map((e) => e.amount));
    const isBalanced = Math.abs(totalDebit - totalCredit) <= 0.01;

    return {
      isBalanced,
      totalDebit,
      totalCredit,
      entries,
    };
  }

  /**
   * Exporta os lançamentos em partidas dobradas nos principais leiautes contábeis brasileiros.
   */
  public static exportAccountingBatch(
    format: AccountingErpFormat,
    entries: AccountingJournalEntry[],
    meta: { companyCnpj: string; batchNumber?: number; csvOptions?: CsvExportOptions }
  ): { fileName: string; content: string } {
    const cleanCnpj = String(meta.companyCnpj || '').replace(/\D/g, '').padStart(14, '0');
    const dateToken = (entries[0]?.entryDate || '2026-01-31').replace(/\D/g, '');
    const lines: string[] = [];

    if (format === 'DOMINIO') {
      // Leiaute Domínio Sistemas (|0000|CNPJ| seguida de pares |6000|X| e |6100|Data|Débito|Crédito|Valor|CodHist|Hist|CC|)
      lines.push(`|0000|${cleanCnpj}|`);
      // Agrupa por par Débito+Crédito sequencial (nossas entradas vêm aos pares D/C)
      for (let i = 0; i < entries.length; i += 2) {
        const deb = entries[i];
        const cred = entries[i + 1];
        if (!deb || !cred) continue;
        lines.push(`|6000|X|||`);
        lines.push(
          `|6100|${formatDateDdMmYyyy(deb.entryDate)}|${deb.accountCode}|${cred.accountCode}|${formatMoneyBr(deb.amount)}|${deb.erpHistoryCode || '001'}|${deb.history}|${deb.costCenterCode || ''}|`
        );
      }
      return { fileName: `CONTABIL_DOMINIO_${dateToken}.txt`, content: lines.join('\r\n') + '\r\n' };
    }

    if (format === 'ALTERDATA') {
      // Formato Alterdata WCont (; delimited)
      for (let i = 0; i < entries.length; i += 2) {
        const deb = entries[i];
        const cred = entries[i + 1];
        if (!deb || !cred) continue;
        lines.push(
          [
            formatDateDdMmYyyy(deb.entryDate),
            deb.accountCode,
            cred.accountCode,
            deb.amount.toFixed(2).replace('.', ','),
            deb.erpHistoryCode || '001',
            deb.history.replace(/;/g, ' '),
            deb.costCenterCode || '',
          ].join(';')
        );
      }
      return { fileName: `CONTABIL_ALTERDATA_${dateToken}.txt`, content: lines.join('\r\n') + '\r\n' };
    }

    if (format === 'PROTHEUS') {
      // Formato TOTVS Protheus CT2 (Tabela de Lançamentos Contábeis)
      lines.push('CT2_FILIAL;CT2_DATA;CT2_LOTE;CT2_SBLOTE;CT2_DOC;CT2_LINHA;CT2_MOEDLC;CT2_DC;CT2_DEBITO;CT2_CREDIT;CT2_VALOR;CT2_HIST;CT2_CCD;CT2_CCC');
      let lineNo = 1;
      for (let i = 0; i < entries.length; i += 2) {
        const deb = entries[i];
        const cred = entries[i + 1];
        if (!deb || !cred) continue;
        const seq = String(lineNo++).padStart(3, '0');
        const yyyymmdd = deb.entryDate.replace(/-/g, '');
        lines.push(
          [
            '01',
            yyyymmdd,
            '008890',
            '001',
            String(meta.batchNumber || 1).padStart(6, '0'),
            seq,
            '01',
            '3', // 3 = Partida Dobrada
            deb.accountCode,
            cred.accountCode,
            deb.amount.toFixed(2),
            deb.history.replace(/;/g, ' '),
            deb.costCenterCode || '',
            '',
          ].join(';')
        );
      }
      return { fileName: `CONTABIL_PROTHEUS_CT2_${dateToken}.csv`, content: lines.join('\r\n') + '\r\n' };
    }

    if (format === 'SENIOR') {
      // Formato Senior Sapiens/Rubi pipe-delimited
      for (let i = 0; i < entries.length; i += 2) {
        const deb = entries[i];
        const cred = entries[i + 1];
        if (!deb || !cred) continue;
        lines.push(
          [
            cleanCnpj,
            formatDateDdMmYyyy(deb.entryDate),
            deb.accountCode,
            cred.accountCode,
            deb.amount.toFixed(2).replace('.', ','),
            deb.costCenterCode || '0',
            deb.cnoNumber || '',
            deb.history.replace(/\|/g, ' '),
          ].join('|')
        );
      }
      return { fileName: `CONTABIL_SENIOR_${dateToken}.txt`, content: lines.join('\r\n') + '\r\n' };
    }

    // CSV_CONFIGURABLE
    const sep = meta.csvOptions?.delimiter || ';';
    if (meta.csvOptions?.includeHeader !== false) {
      lines.push(['DATA', 'EVENTO', 'CONTA', 'DESCRICAO', 'TIPO', 'VALOR', 'CENTRO_CUSTO', 'OBRA_CNO', 'HISTORICO'].join(sep));
    }
    for (const e of entries) {
      lines.push(
        [
          e.entryDate,
          e.eventKey,
          e.accountCode,
          e.accountName.replaceAll(sep, ' '),
          e.type,
          e.amount.toFixed(2),
          e.costCenterCode || '',
          e.cnoNumber || '',
          e.history.replaceAll(sep, ' '),
        ].join(sep)
      );
    }
    return { fileName: `CONTABIL_FOLHA_${dateToken}.csv`, content: lines.join('\r\n') + '\r\n' };
  }
}
