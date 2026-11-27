/**
 * ProvisionsLedgerCalculator.ts
 * FASE V7 — CONT-02: Provisões Contábeis Reais Acumuladas com Baixa Mensal.
 *
 * Fórmula contábil mensal do razão (Férias + 1/3 e 13º Salário):
 * closingBalance = MAX(0, openingBalance + monthlyAccrual + salaryAdjustmentDiff + averagesAdjustment - settlementsPaid)
 * netAccountingEntry = closingBalance - openingBalance
 * Encargos reais calculados exclusivamente com base nas alíquotas do regime da empresa via EmployerTaxesCalculator.
 */

import { EmployerTaxesCalculator, type LaborConfig } from '../legal/EmployerTaxesCalculator.js';
import { addMoney, divideMoney, round2, subtractMoney, sumMoney } from '../utils/money.js';

export type ProvisionLedgerType = 'VACATION' | 'THIRTEENTH';

export interface ProvisionLedgerInput {
  contractId: string;
  provisionType: ProvisionLedgerType;
  year: number;
  month: number;
  currentSalary: number;
  previousSalary?: number;
  averageAdditionals?: number;
  previousAverageAdditionals?: number;
  avosPreviouslyAccumulated: number;
  earnedAvoInMonth: boolean;
  openingBalance: number;
  chargesOpeningBalance: number;
  settlementsPaid: number; // Baixas reais de férias gozadas/pagas, 13º ou rescisão no mês
  calculationRegime?: string | null;
  isApprentice?: boolean;
  specialRetirementExposureCode?: string | null;
  companyConfig?: LaborConfig;
}

export interface ProvisionLedgerOutput {
  contractId: string;
  provisionType: ProvisionLedgerType;
  openingBalance: number;
  monthlyAccrual: number;
  salaryAdjustmentDiff: number;
  averagesAdjustment: number;
  settlementsPaid: number;
  closingBalance: number;
  chargesOpeningBalance: number;
  chargesMonthlyAccrual: number;
  chargesAdjustmentDiff: number;
  chargesSettlementsPaid: number;
  chargesClosingBalance: number;
  netAccountingEntry: number;
  netChargesEntry: number;
  effectiveEmployerRate: number;
  avosAccumulated: number;
  referenceSalary: number;
  breakdown: {
    baseAvoValue: number;
    oneThirdFactorApplied: boolean;
    exemptByRegime: boolean;
    inssPatronalRate: number;
    ratRate: number;
    terceirosRate: number;
    fgtsRate: number;
  };
}

const EXEMPT_PROVISION_REGIMES = new Set(['PRO_LABORE', 'AUTONOMOUS_RPA', 'INTERN']);

/**
 * Resolve as alíquotas patronais efetivas sobre provisões usando o calculador oficial do regime.
 */
function resolveEffectiveEmployerChargeBreakdown(params: {
  isExempt: boolean;
  isApprentice: boolean;
  specialExposureCode?: string | null;
  config?: LaborConfig;
  competenceYear: number;
}): {
  effectiveRate: number;
  inssPatronalRate: number;
  ratRate: number;
  terceirosRate: number;
  fgtsRate: number;
} {
  if (params.isExempt) {
    return {
      effectiveRate: 0,
      inssPatronalRate: 0,
      ratRate: 0,
      terceirosRate: 0,
      fgtsRate: 0,
    };
  }

  const probeBase = 1000;
  const fgtsRate = params.isApprentice ? 0.02 : 0.08;
  const code = params.specialExposureCode || '01';

  const taxProbe = EmployerTaxesCalculator.calculateAdvanced({
    baseInssEmployees: probeBase,
    baseFgts: probeBase,
    fgtsMonthSum: round2(probeBase * fgtsRate),
    specialRetirementBases: {
      code02_15y: code === '02' ? probeBase : 0,
      code03_20y: code === '03' ? probeBase : 0,
      code04_25y: code === '04' ? probeBase : 0,
    },
    config: {
      ...(params.config || {}),
      competence_year: params.config?.competence_year ?? params.competenceYear,
    },
  });

  const inssPatronalRate = Number((taxProbe.inss_patronal / probeBase).toFixed(6));
  const ratRate = Number(
    ((taxProbe.rat_adjusted + taxProbe.rat_special_retirement_amount) / probeBase).toFixed(6)
  );
  const terceirosRate = Number((taxProbe.terceiros / probeBase).toFixed(6));
  const effectiveRate = Number(
    (inssPatronalRate + ratRate + terceirosRate + fgtsRate).toFixed(6)
  );

  return {
    effectiveRate,
    inssPatronalRate,
    ratRate,
    terceirosRate,
    fgtsRate,
  };
}

export class ProvisionsLedgerCalculator {
  /**
   * Apura o movimento completo do razão de provisões (saldo anterior + avo + reajuste/médias - baixas = fechamento).
   */
  public static calculate(input: ProvisionLedgerInput): ProvisionLedgerOutput {
    const regime = String(input.calculationRegime || 'CLT').toUpperCase();
    const isExempt = EXEMPT_PROVISION_REGIMES.has(regime);
    const isApprentice = Boolean(input.isApprentice || regime === 'APPRENTICE');

    const chargesInfo = resolveEffectiveEmployerChargeBreakdown({
      isExempt,
      isApprentice,
      specialExposureCode: input.specialRetirementExposureCode,
      config: input.companyConfig,
      competenceYear: input.year,
    });

    const opening = round2(input.openingBalance);
    const chargesOpening = round2(input.chargesOpeningBalance);
    const settlements = Math.max(0, round2(input.settlementsPaid));

    if (isExempt) {
      const closing = Math.max(0, subtractMoney(opening, settlements));
      const chargesClosing = round2(closing * chargesInfo.effectiveRate);
      return {
        contractId: input.contractId,
        provisionType: input.provisionType,
        openingBalance: opening,
        monthlyAccrual: 0,
        salaryAdjustmentDiff: 0,
        averagesAdjustment: 0,
        settlementsPaid: settlements,
        closingBalance: closing,
        chargesOpeningBalance: chargesOpening,
        chargesMonthlyAccrual: 0,
        chargesAdjustmentDiff: 0,
        chargesSettlementsPaid: round2(settlements * chargesInfo.effectiveRate),
        chargesClosingBalance: chargesClosing,
        netAccountingEntry: subtractMoney(closing, opening),
        netChargesEntry: subtractMoney(chargesClosing, chargesOpening),
        effectiveEmployerRate: 0,
        avosAccumulated: 0,
        referenceSalary: round2(input.currentSalary),
        breakdown: {
          baseAvoValue: 0,
          oneThirdFactorApplied: input.provisionType === 'VACATION',
          exemptByRegime: true,
          inssPatronalRate: 0,
          ratRate: 0,
          terceirosRate: 0,
          fgtsRate: 0,
        },
      };
    }

    const factor = input.provisionType === 'VACATION' ? 4 / 3 : 1; // Férias inclui 1/3 constitucional
    const prevAvg = Number(input.previousAverageAdditionals || 0);
    const currAvg = Number(input.averageAdditionals || 0);
    const prevBase = Number(input.previousSalary ?? input.currentSalary);
    const currBase = Number(input.currentSalary || 0);
    const avosPrev = Math.max(0, Math.min(12, Math.floor(input.avosPreviouslyAccumulated || 0)));

    // 1. Avo mensal pelo salário + médias vigentes (1/12, com 1/3 em férias)
    const earnedAvo = input.earnedAvoInMonth ? 1 : 0;
    const oneAvoBase = divideMoney(round2((currBase + currAvg) * factor), 12);
    const monthlyAccrual = earnedAvo > 0 ? oneAvoBase : 0;

    // 2. Ajuste por aumento salarial ou variação de médias sobre os avos já acumulados
    const salaryDelta = currBase - prevBase;
    const avgDelta = currAvg - prevAvg;
    const salaryAdjustmentDiff =
      avosPrev > 0 && Math.abs(salaryDelta) >= 0.01
        ? round2((salaryDelta * factor * avosPrev) / 12)
        : 0;
    const averagesAdjustment =
      avosPrev > 0 && Math.abs(avgDelta) >= 0.01
        ? round2((avgDelta * factor * avosPrev) / 12)
        : 0;

    // 3. Fechamento da obrigação principal e lançamento contábil líquido do mês
    const grossAccumulated = sumMoney([opening, monthlyAccrual, salaryAdjustmentDiff, averagesAdjustment]);
    const closingBalance = Math.max(0, subtractMoney(grossAccumulated, settlements));
    const netAccountingEntry = subtractMoney(closingBalance, opening);

    // 4. Encargos sobre provisões calculados exatamente pela taxa efetiva patronal da empresa
    const chargesMonthlyAccrual = round2(monthlyAccrual * chargesInfo.effectiveRate);
    const totalAdjustments = addMoney(salaryAdjustmentDiff, averagesAdjustment);
    const chargesAdjustmentDiff = round2(totalAdjustments * chargesInfo.effectiveRate);
    const chargesSettlementsPaid = round2(settlements * chargesInfo.effectiveRate);
    const chargesClosingBalance = round2(closingBalance * chargesInfo.effectiveRate);
    const netChargesEntry = subtractMoney(chargesClosingBalance, chargesOpening);

    const avosAccumulated = settlements > 0 && closingBalance === 0
      ? 0
      : Math.min(12, avosPrev + earnedAvo);

    return {
      contractId: input.contractId,
      provisionType: input.provisionType,
      openingBalance: opening,
      monthlyAccrual,
      salaryAdjustmentDiff,
      averagesAdjustment,
      settlementsPaid: settlements,
      closingBalance,
      chargesOpeningBalance: chargesOpening,
      chargesMonthlyAccrual,
      chargesAdjustmentDiff,
      chargesSettlementsPaid,
      chargesClosingBalance,
      netAccountingEntry,
      netChargesEntry,
      effectiveEmployerRate: chargesInfo.effectiveRate,
      avosAccumulated,
      referenceSalary: round2(currBase + currAvg),
      breakdown: {
        baseAvoValue: oneAvoBase,
        oneThirdFactorApplied: input.provisionType === 'VACATION',
        exemptByRegime: false,
        inssPatronalRate: chargesInfo.inssPatronalRate,
        ratRate: chargesInfo.ratRate,
        terceirosRate: chargesInfo.terceirosRate,
        fgtsRate: chargesInfo.fgtsRate,
      },
    };
  }
}
