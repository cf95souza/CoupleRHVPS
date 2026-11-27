import { round2, addMoney, subtractMoney } from '../utils/money.js';
import { Rubric, NegativeNetPolicy } from '../engine/PayrollContext.js';

export interface EvaluatedDiscountItem {
  rubricId: string;
  rubricCode: string;
  rubricName: string;
  discountPriority: number;
  originalAmount: number;
  appliedAmount: number;
  cappedByMargin?: boolean;
  cappedByPolicy?: boolean;
}

export interface ConsignableMarginEvaluation {
  grossEarnings: number;
  compulsoryDeductions: number;
  availableNetForMargin: number;
  legalMarginPercentage: number; // 35.00%
  maxConsignableLimit: number;
  requestedLoanAmount: number;
  effectiveLoanAmount: number;
  isCapped: boolean;
  cappedDifference: number;
}

export interface DiscountPriorityResult {
  policy: NegativeNetPolicy;
  grossEarningsBeforeInsufficiency: number;
  totalEarnings: number;
  totalDeductions: number;
  netSalary: number;
  marginEvaluation: ConsignableMarginEvaluation;
  hasInsufficiency: boolean;
  insufficiencyCreditAmount: number; // Rubrica 499
  hasPriorDebtDeduction: boolean;
  priorDebtDeductedAmount: number; // Rubrica 899
  evaluatedDiscounts: EvaluatedDiscountItem[];
  complianceAlerts: string[];
}

export class DiscountPriorityManager {
  public static readonly MARGIN_LEGAL_PERCENTAGE = 35.0; // Lei 10.820/2003

  /**
   * Resolve a prioridade numérica padrão baseada nas características da rubrica
   */
  public static resolvePriority(rubric: Rubric): number {
    if (rubric.discount_priority !== undefined && rubric.discount_priority !== null) {
      return Number(rubric.discount_priority);
    }
    const code = String(rubric.code || '').trim();
    const kind = String(rubric.rubric_kind || '').toUpperCase();

    if (code === '901' || code === '902' || kind === 'INSS' || kind === 'IRRF') return 10;
    if (code === '904' || code === '804' || kind === 'ALIMONY') return 20;
    if (code === '801' || code === '850' || kind === 'ABSENCE' || kind === 'ADVANCE') return 30;
    if (code === '899' || kind === 'INSUFFICIENCY_DEBIT') return 35;
    if (code === '805' || kind === 'LOAN') return 40;
    if (kind === 'BENEFIT' || code.startsWith('802') || code.startsWith('803')) return 50;
    return 60;
  }

  /**
   * Avalia a margem consignável (35% da remuneração disponível)
   * Base = Proventos - Descontos Compulsórios Legais (prioridade < 40)
   */
  public static evaluateConsignableMargin(params: {
    grossEarnings: number;
    compulsoryDeductions: number;
    requestedLoanAmount: number;
  }): ConsignableMarginEvaluation {
    const gross = Math.max(0, round2(params.grossEarnings));
    const compulsory = Math.max(0, round2(params.compulsoryDeductions));
    const availableNet = Math.max(0, subtractMoney(gross, compulsory));
    const maxLimit = round2((availableNet * this.MARGIN_LEGAL_PERCENTAGE) / 100);
    const requested = Math.max(0, round2(params.requestedLoanAmount));

    // O consignado não pode exceder o limite da margem e nem o líquido disponível total
    const allowedCeiling = Math.min(maxLimit, availableNet);
    const effective = Math.min(requested, allowedCeiling);
    const isCapped = effective < requested;
    const cappedDiff = round2(requested - effective);

    return {
      grossEarnings: gross,
      compulsoryDeductions: compulsory,
      availableNetForMargin: availableNet,
      legalMarginPercentage: this.MARGIN_LEGAL_PERCENTAGE,
      maxConsignableLimit: maxLimit,
      requestedLoanAmount: requested,
      effectiveLoanAmount: effective,
      isCapped,
      cappedDifference: cappedDiff,
    };
  }

  /**
   * Processa a fila de prioridades, aplica a trava de consignado e resolve
   * insuficiência de saldo conforme negative_net_policy (CLT Art. 462).
   */
  public static processDiscountsAndInsufficiency(params: {
    grossEarnings: number;
    discounts: Array<{
      rubric: Rubric;
      amount: number;
    }>;
    policy?: NegativeNetPolicy;
  }): DiscountPriorityResult {
    const policy = params.policy || 'INSUFFICIENCY_CARRYOVER';
    let currentGross = Math.max(0, round2(params.grossEarnings));
    const complianceAlerts: string[] = [];

    // Mapeia e classifica os descontos com suas prioridades
    const mapped = params.discounts
      .filter((d) => d.amount > 0)
      .map((d) => ({
        rubric: d.rubric,
        priority: this.resolvePriority(d.rubric),
        requestedAmount: round2(d.amount),
        appliedAmount: round2(d.amount),
        cappedByMargin: false,
        cappedByPolicy: false,
      }));

    // 1. Calcula descontos compulsórios (prioridade < 40: INSS, IRRF, Pensão, Faltas, Adiantamento, Débito Anterior)
    const compulsoryTotal = mapped
      .filter((d) => d.priority < 40)
      .reduce((acc, d) => addMoney(acc, d.requestedAmount), 0);

    // 2. Avalia consignados (prioridade 40) com trava legal de 35%
    const loanItems = mapped.filter((d) => d.priority === 40 || d.rubric.rubric_kind === 'LOAN' || d.rubric.code === '805');
    const totalLoanRequested = loanItems.reduce((acc, d) => addMoney(acc, d.requestedAmount), 0);

    const marginEval = this.evaluateConsignableMargin({
      grossEarnings: currentGross,
      compulsoryDeductions: compulsoryTotal,
      requestedLoanAmount: totalLoanRequested,
    });

    if (totalLoanRequested > 0 && marginEval.isCapped) {
      let remainingAllowed = marginEval.effectiveLoanAmount;
      for (const loan of loanItems) {
        if (loan.requestedAmount <= remainingAllowed) {
          loan.appliedAmount = loan.requestedAmount;
          remainingAllowed = subtractMoney(remainingAllowed, loan.appliedAmount);
        } else {
          loan.appliedAmount = Math.max(0, remainingAllowed);
          loan.cappedByMargin = true;
          remainingAllowed = 0;
        }
      }
      complianceAlerts.push(
        `Consignado limitado pela Margem Legal de 35% (Lei 10.820/2003): Solicitado R$ ${totalLoanRequested.toFixed(2)}, Aplicado R$ ${marginEval.effectiveLoanAmount.toFixed(2)}`
      );
    }

    // 3. Soma total dos descontos aplicados após a trava de consignado
    let appliedDeductionsSum = mapped.reduce((acc, d) => addMoney(acc, d.appliedAmount), 0);
    let netSalary = subtractMoney(currentGross, appliedDeductionsSum);
    let insufficiencyCredit = 0;

    // 4. Resolução da Política de Saldo Negativo (CLT Art. 462)
    if (netSalary < 0) {
      const deficit = round2(Math.abs(netSalary));

      if (policy === 'INSUFFICIENCY_CARRYOVER') {
        // Padrão Enterprise: gera Rubrica 499 (Insuficiência de Saldo) e zera o líquido
        insufficiencyCredit = deficit;
        currentGross = addMoney(currentGross, insufficiencyCredit);
        netSalary = 0.0;
        complianceAlerts.push(
          `Insuficiência de Saldo gerada (Rubrica 499): R$ ${insufficiencyCredit.toFixed(2)} para manter Líquido CLT em R$ 0,00`
        );
      } else if (policy === 'CAP_OPTIONAL_DISCOUNTS') {
        // Reduz descontos na ordem inversa de prioridade (maior prioridade numérica = menos prioritário)
        let neededReduction = deficit;
        const sortedDesc = [...mapped].sort((a, b) => b.priority - a.priority);

        for (const item of sortedDesc) {
          // Apenas descontos facultativos (prioridade >= 40) podem ser cortados
          if (item.priority >= 40 && neededReduction > 0 && item.appliedAmount > 0) {
            const cut = Math.min(item.appliedAmount, neededReduction);
            item.appliedAmount = subtractMoney(item.appliedAmount, cut);
            item.cappedByPolicy = true;
            neededReduction = subtractMoney(neededReduction, cut);
          }
        }

        appliedDeductionsSum = mapped.reduce((acc, d) => addMoney(acc, d.appliedAmount), 0);
        netSalary = Math.max(0, subtractMoney(currentGross, appliedDeductionsSum));
        complianceAlerts.push(
          `Descontos facultativos limitados por política de saldo zero (Redução de R$ ${deficit.toFixed(2)})`
        );
      } else if (policy === 'BLOCK') {
        complianceAlerts.push(
          `BLOQUEIO CLT: Saldo devedor negativo de R$ ${deficit.toFixed(2)} detectado.`
        );
      }
    }

    const priorDebtItem = mapped.find(
      (d) => d.rubric.code === '899' || d.rubric.rubric_kind === 'INSUFFICIENCY_DEBIT'
    );

    return {
      policy,
      grossEarningsBeforeInsufficiency: round2(params.grossEarnings),
      totalEarnings: round2(currentGross),
      totalDeductions: round2(appliedDeductionsSum),
      netSalary: round2(netSalary),
      marginEvaluation: marginEval,
      hasInsufficiency: insufficiencyCredit > 0,
      insufficiencyCreditAmount: insufficiencyCredit,
      hasPriorDebtDeduction: Boolean(priorDebtItem && priorDebtItem.appliedAmount > 0),
      priorDebtDeductedAmount: priorDebtItem ? priorDebtItem.appliedAmount : 0,
      evaluatedDiscounts: mapped.map((m) => ({
        rubricId: m.rubric.id,
        rubricCode: m.rubric.code,
        rubricName: m.rubric.name,
        discountPriority: m.priority,
        originalAmount: m.requestedAmount,
        appliedAmount: m.appliedAmount,
        cappedByMargin: m.cappedByMargin,
        cappedByPolicy: m.cappedByPolicy,
      })),
      complianceAlerts,
    };
  }
}
