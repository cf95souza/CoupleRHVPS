/**
 * RetroactiveDissidioCalculator.ts
 * FASE V6 — FOLHA-14: Folha Complementar e Dissídio Coletivo Retroativo Multi-Competência + RRA.
 *
 * Funcionalidades:
 * - Recalcula mês a mês (competência de origem) mantendo as quantidades originais de eventos
 *   (Salário Base, HE 50%/100%, Adic. Noturno, Periculosidade, ATS, DSR, Férias, 13º).
 * - Apura INSS diferencial por competência de origem usando a tabela INSS vigente daquela competência
 *   (sem dupla subtração!).
 * - Apura FGTS diferencial por competência de origem (8% CLT ou 2% Aprendiz).
 * - Segrega competências do ano-calendário corrente (IRRF Caixa na data do pagamento) vs
 *   competências de anos-calendário anteriores (IRRF exclusivo RRA Art. 12-A Lei 7.713/88).
 * - Suporta parcelamento do pagamento em N parcelas e gera metadados `ideADC` para o eSocial S-1200.
 */

import { INSSCalculator } from '../legal/INSSCalculator.js';
import { IRRFCalculator, type PriorIrrfCashEntry } from '../legal/IRRFCalculator.js';
import { FGTSCalculator } from '../legal/FGTSCalculator.js';
import type { GeneralLegalParameters, InssBracket, IrrfBracket } from './PayrollContext.js';
import { addMoney, divideMoney, round2, subtractMoney, sumMoney } from '../utils/money.js';

export interface OriginalPayslipItemSnapshot {
  rubricCode: string;
  rubricName: string;
  category: string; // SALARY, OVERTIME, DSR, ALLOWANCE, NIGHT_SHIFT, VACATION, THIRTEENTH
  originalAmount: number;
  isSalaryDependent?: boolean; // true se varia proporcionalmente ao salário base (salário, HE, DSR, periculosidade, ATS, férias, 13º)
  inssIncidence?: boolean;
  irrfIncidence?: boolean;
  fgtsIncidence?: boolean;
}

export interface OriginalCompetenceSnapshot {
  year: number;
  month: number;
  periodType: string; // MONTHLY, VACATION, THIRTEENTH_2
  originalBaseSalary: number;
  originalBaseInss: number;
  originalBaseFgts: number;
  originalInssEmployee: number;
  items: OriginalPayslipItemSnapshot[];
  inssBracketsForOrigin?: InssBracket[];
}

export interface RetroactiveDissidioInput {
  contractId: string;
  adjustmentType: 'PERCENTAGE' | 'FIXED_TABLE';
  percentage?: number; // ex: 8 para +8%
  newBaseSalaryFixed?: number;
  paymentYear: number;
  paymentMonth: number;
  installmentsCount?: number;
  applyRra?: boolean;
  esocialTpAcConv?: string; // 'A'..'G'
  agreementSignatureDate?: string; // YYYY-MM-DD
  dependentsCount?: number;
  isApprentice?: boolean;
  priorCashEntriesInPaymentMonth?: PriorIrrfCashEntry[];
  defaultInssBrackets: InssBracket[];
  paymentIrrfBrackets: IrrfBracket[];
  generalLegalParameters: GeneralLegalParameters;
  competences: OriginalCompetenceSnapshot[];
}

export interface RetroactiveItemBreakdown {
  originYear: number;
  originMonth: number;
  originPeriodType: string;
  rubricCode: string;
  rubricName: string;
  targetComplementaryCode: '110' | '111' | '112';
  originalAmount: number;
  recalculatedAmount: number;
  diffAmount: number;
  inssOriginDiff: number;
  fgtsOriginDiff: number;
  isPriorCalendarYear: boolean;
  ideAdc: {
    dtAcConv: string;
    tpAcConv: string;
    perRef: string;
  };
}

export interface RetroactiveDissidioResult {
  totalDiffSalary110: number;
  totalDiffReflexes111: number;
  totalDiffVacation13th112: number;
  totalGrossDiff: number;
  totalInssDiff: number;
  totalFgtsDiff: number;
  currentYearGrossDiff: number;
  currentYearInssDiff: number;
  currentYearIrrf: number;
  priorYearsGrossDiff: number;
  priorYearsInssDiff: number;
  priorYearsMonthsCount: number;
  priorYearsIrrfRra: number;
  totalIrrf: number;
  totalDeductions: number;
  netPayableTotal: number;
  installmentGross: number;
  installmentNet: number;
  installmentsCount: number;
  breakdown: RetroactiveItemBreakdown[];
  memoryLines: string[];
}

function resolveTargetCode(item: OriginalPayslipItemSnapshot): '110' | '111' | '112' {
  const cat = String(item.category || '').toUpperCase();
  const code = String(item.rubricCode || '');
  if (cat === 'VACATION' || cat === 'THIRTEENTH' || ['601', '602', '604', '701', '702'].includes(code)) {
    return '112';
  }
  if (
    cat === 'OVERTIME' ||
    cat === 'DSR' ||
    cat === 'NIGHT_SHIFT' ||
    cat === 'ALLOWANCE' ||
    ['102', '103', '106', '151', '301', '401', '402'].includes(code)
  ) {
    return '111';
  }
  return '110';
}

function isItemSalaryDependent(item: OriginalPayslipItemSnapshot): boolean {
  if (item.isSalaryDependent !== undefined) return item.isSalaryDependent;
  const code = String(item.rubricCode || '');
  const cat = String(item.category || '').toUpperCase();
  // Insalubridade sobre mínimo (150) ou salário-família (305) não reajustam com salário contratual
  if (['150', '305', '499', '901', '902', '903', '904', '905', '999'].includes(code)) return false;
  return (
    ['SALARY', 'OVERTIME', 'DSR', 'NIGHT_SHIFT', 'VACATION', 'THIRTEENTH'].includes(cat) ||
    ['101', '102', '103', '106', '151', '301', '401', '402', '601', '602', '701', '702'].includes(code)
  );
}

export class RetroactiveDissidioCalculator {
  public static calculate(input: RetroactiveDissidioInput): RetroactiveDissidioResult {
    const installmentsCount = Math.max(1, Math.floor(Number(input.installmentsCount || 1)));
    const applyRra = input.applyRra !== false;
    const tpAcConv = input.esocialTpAcConv || 'A';
    const dtAcConv =
      input.agreementSignatureDate ||
      `${input.paymentYear}-${String(input.paymentMonth).padStart(2, '0')}-01`;

    const breakdown: RetroactiveItemBreakdown[] = [];
    const memoryLines: string[] = [];

    let totalDiffSalary110 = 0;
    let totalDiffReflexes111 = 0;
    let totalDiffVacation13th112 = 0;
    let totalInssDiff = 0;
    let totalFgtsDiff = 0;

    let currentYearGrossDiff = 0;
    let currentYearInssDiff = 0;
    let priorYearsGrossDiff = 0;
    let priorYearsInssDiff = 0;
    const priorYearCompetenceKeys = new Set<string>();

    for (const comp of input.competences) {
      if (comp.originalBaseSalary <= 0) continue;

      const factorRatio =
        input.adjustmentType === 'FIXED_TABLE' && input.newBaseSalaryFixed && input.newBaseSalaryFixed > 0
          ? input.newBaseSalaryFixed / comp.originalBaseSalary
          : 1 + Number(input.percentage || 0) / 100;

      if (factorRatio <= 1) continue;

      let compDiffGross = 0;
      let compDiffBaseInss = 0;
      let compDiffBaseFgts = 0;

      const itemDiffs: Array<{
        item: OriginalPayslipItemSnapshot;
        recalculated: number;
        diff: number;
        targetCode: '110' | '111' | '112';
      }> = [];

      for (const item of comp.items) {
        if (item.originalAmount <= 0 || !isItemSalaryDependent(item)) continue;
        const recalculated = round2(item.originalAmount * factorRatio);
        const diff = subtractMoney(recalculated, item.originalAmount);
        if (diff <= 0) continue;

        const targetCode = resolveTargetCode(item);
        compDiffGross = addMoney(compDiffGross, diff);
        if (item.inssIncidence !== false) compDiffBaseInss = addMoney(compDiffBaseInss, diff);
        if (item.fgtsIncidence !== false) compDiffBaseFgts = addMoney(compDiffBaseFgts, diff);

        if (targetCode === '110') totalDiffSalary110 = addMoney(totalDiffSalary110, diff);
        else if (targetCode === '111') totalDiffReflexes111 = addMoney(totalDiffReflexes111, diff);
        else totalDiffVacation13th112 = addMoney(totalDiffVacation13th112, diff);

        itemDiffs.push({ item, recalculated, diff, targetCode });
      }

      if (compDiffGross <= 0) continue;

      // INSS diferencial calculado sobre a base da competência de origem sem dupla subtração
      const originBrackets =
        comp.inssBracketsForOrigin && comp.inssBracketsForOrigin.length > 0
          ? comp.inssBracketsForOrigin
          : input.defaultInssBrackets;

      const origInss =
        comp.originalInssEmployee > 0
          ? comp.originalInssEmployee
          : INSSCalculator.calculate(comp.originalBaseInss, originBrackets).value;
      const newInss = INSSCalculator.calculate(
        addMoney(comp.originalBaseInss, compDiffBaseInss),
        originBrackets
      ).value;
      const compInssDiff = Math.max(0, subtractMoney(newInss, origInss));

      // FGTS diferencial da competência de origem
      const fgtsStd = input.generalLegalParameters.fgts_standard_aliquot;
      const fgtsApp = input.generalLegalParameters.fgts_apprentice_aliquot;
      const origFgts = FGTSCalculator.calculate(comp.originalBaseFgts, Boolean(input.isApprentice), fgtsStd, fgtsApp).value;
      const newFgts = FGTSCalculator.calculate(
        addMoney(comp.originalBaseFgts, compDiffBaseFgts),
        Boolean(input.isApprentice),
        fgtsStd,
        fgtsApp
      ).value;
      const compFgtsDiff = Math.max(0, subtractMoney(newFgts, origFgts));

      totalInssDiff = addMoney(totalInssDiff, compInssDiff);
      totalFgtsDiff = addMoney(totalFgtsDiff, compFgtsDiff);

      const isPriorYear = comp.year < input.paymentYear;
      if (isPriorYear && applyRra) {
        priorYearsGrossDiff = addMoney(priorYearsGrossDiff, compDiffGross);
        priorYearsInssDiff = addMoney(priorYearsInssDiff, compInssDiff);
        priorYearCompetenceKeys.add(`${comp.year}-${comp.month}`);
      } else {
        currentYearGrossDiff = addMoney(currentYearGrossDiff, compDiffGross);
        currentYearInssDiff = addMoney(currentYearInssDiff, compInssDiff);
      }

      const perRef = `${comp.year}-${String(comp.month).padStart(2, '0')}`;
      memoryLines.push(
        `Competência ${String(comp.month).padStart(2, '0')}/${comp.year}: Dif. Bruta R$ ${compDiffGross.toFixed(2)} | INSS Orig Dif R$ ${compInssDiff.toFixed(2)} | FGTS Dif R$ ${compFgtsDiff.toFixed(2)}${isPriorYear ? ' [RRA]' : ''}`
      );

      // Rateia INSS/FGTS da competência proporcionalmente para rastreabilidade no breakdown ideADC
      let allocatedInss = 0;
      let allocatedFgts = 0;
      itemDiffs.forEach((entry, idx) => {
        const isLast = idx === itemDiffs.length - 1;
        const share = entry.diff / compDiffGross;
        const itemInss = isLast
          ? Math.max(0, subtractMoney(compInssDiff, allocatedInss))
          : round2(compInssDiff * share);
        const itemFgts = isLast
          ? Math.max(0, subtractMoney(compFgtsDiff, allocatedFgts))
          : round2(compFgtsDiff * share);
        allocatedInss = addMoney(allocatedInss, itemInss);
        allocatedFgts = addMoney(allocatedFgts, itemFgts);

        breakdown.push({
          originYear: comp.year,
          originMonth: comp.month,
          originPeriodType: comp.periodType,
          rubricCode: entry.item.rubricCode,
          rubricName: entry.item.rubricName,
          targetComplementaryCode: entry.targetCode,
          originalAmount: entry.item.originalAmount,
          recalculatedAmount: entry.recalculated,
          diffAmount: entry.diff,
          inssOriginDiff: itemInss,
          fgtsOriginDiff: itemFgts,
          isPriorCalendarYear: isPriorYear,
          ideAdc: {
            dtAcConv,
            tpAcConv,
            perRef,
          },
        });
      });
    }

    const totalGrossDiff = sumMoney([totalDiffSalary110, totalDiffReflexes111, totalDiffVacation13th112]);

    // IRRF do ano corrente (Regime de Caixa no mês do pagamento — proporcional por parcela se parcelado)
    let currentYearIrrf = 0;
    if (currentYearGrossDiff > 0) {
      const installmentCurrentGross = divideMoney(currentYearGrossDiff, installmentsCount);
      const installmentCurrentInss = divideMoney(currentYearInssDiff, installmentsCount);
      const cashRes = IRRFCalculator.calculateCashConsolidated({
        current: {
          grossIncome: installmentCurrentGross,
          inss: installmentCurrentInss,
          dependents: input.dependentsCount || 0,
        },
        priorEntries: input.priorCashEntriesInPaymentMonth || [],
        bucket: 'MONTHLY_CASH',
        brackets: input.paymentIrrfBrackets,
        params: input.generalLegalParameters,
      });
      currentYearIrrf = round2(cashRes.value * installmentsCount);
    }

    // IRRF RRA Art. 12-A (para competências de anos-calendário anteriores)
    const priorYearsMonthsCount = priorYearCompetenceKeys.size;
    let priorYearsIrrfRra = 0;
    if (priorYearsGrossDiff > 0 && priorYearsMonthsCount > 0) {
      const rraRes = IRRFCalculator.calculateRRA({
        grossRra: priorYearsGrossDiff,
        inssRra: priorYearsInssDiff,
        dependents: input.dependentsCount || 0,
        monthsCount: priorYearsMonthsCount,
        brackets: input.paymentIrrfBrackets,
        params: input.generalLegalParameters,
      });
      priorYearsIrrfRra = rraRes.value;
      memoryLines.push(rraRes.formulaDescription);
    }

    const totalIrrf = addMoney(currentYearIrrf, priorYearsIrrfRra);
    const totalDeductions = addMoney(totalInssDiff, totalIrrf);
    const netPayableTotal = Math.max(0, subtractMoney(totalGrossDiff, totalDeductions));

    const installmentGross = divideMoney(totalGrossDiff, installmentsCount);
    const installmentNet = divideMoney(netPayableTotal, installmentsCount);

    return {
      totalDiffSalary110,
      totalDiffReflexes111,
      totalDiffVacation13th112,
      totalGrossDiff,
      totalInssDiff,
      totalFgtsDiff,
      currentYearGrossDiff,
      currentYearInssDiff,
      currentYearIrrf,
      priorYearsGrossDiff,
      priorYearsInssDiff,
      priorYearsMonthsCount,
      priorYearsIrrfRra,
      totalIrrf,
      totalDeductions,
      netPayableTotal,
      installmentGross,
      installmentNet,
      installmentsCount,
      breakdown,
      memoryLines,
    };
  }
}
