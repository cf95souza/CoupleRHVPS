/**
 * BenefitsCalculator.ts
 * ==============================================================================
 * Módulo de Cálculo Puro de Benefícios Enterprise (FOLHA-08)
 * 
 * Legislação e Normas Aplicadas:
 * - Vale-Transporte: Lei nº 7.418/1985 e Decreto nº 10.854/2021 (arts. 106 a 119)
 *   Teto legal de desconto: MIN(6% do salário básico proporcional, custo efetivo)
 *   Proporcionalidade por faltas, férias, afastamentos e dias de trabalho remoto (híbrido)
 * - Planos de Saúde e Odontológico: Lei nº 9.656/1998 e Resoluções da ANS
 *   Desconto de titular e rateio estruturado de dependentes com registro ANS
 * - Coparticipação em Consultas/Exames: apuração por procedimento e paciente
 * ==============================================================================
 */

import { addMoney, round2, subtractMoney } from '../utils/money.js';

export type WorkRegime = 'PRESENTIAL' | 'REMOTE' | 'HYBRID';

export interface TransportationVoucherCalculationParams {
  /** Salário básico contratual mensal */
  baseSalary: number;
  /** Dias úteis na competência (segunda a sexta/sábado excluindo feriados) */
  workingDaysInMonth: number;
  /** Dias de férias gozados na competência */
  vacationDays?: number;
  /** Dias de afastamentos legais ou faltas injustificadas na competência */
  absenceOrLeaveDays?: number;
  /** Regime de trabalho: PRESENTIAL, REMOTE ou HYBRID */
  workRegime?: WorkRegime;
  /** Dias remotos (home-office) por semana no regime híbrido (0 a 5) */
  weeklyRemoteDays?: number;
  /** Quantidade de viagens/passes por dia presencial (padrão 2: ida e volta) */
  dailyPasses?: number;
  /** Valor unitário da tarifa/passe de transporte */
  passUnitValue?: number;
  /** Custo total concedido fixo (override manual se informado) */
  manualConcededValue?: number;
  /** Se o colaborador optou por receber o VT (opt-in formal da CLT) */
  optIn?: boolean;
  /** Dias de direito trabalhados no mês (para admissão/rescisão fracionada no mês) */
  workedDaysInMonth?: number;
}

export interface TransportationVoucherResult {
  /** Desconto final aplicado em folha na rubrica 905 */
  vtDiscount: number;
  /** Custo efetivo total dos passes concedidos no mês */
  totalConcededCost: number;
  /** Subsídio suportado pelo empregador */
  companySubsidy: number;
  /** Teto legal de 6% sobre o salário básico proporcional */
  legalCap6Percent: number;
  /** Dias presenciais efetivos apurados */
  effectivePresentialDays: number;
  /** Se o teto legal de 6% limitou o desconto (custo real era maior) */
  isCapApplied: boolean;
  /** Descrição detalhada da memória de cálculo para auditoria */
  formulaDescription: string;
}

export interface BenefitDependentPlanInput {
  id?: string;
  dependentId?: string;
  dependentName: string;
  dependentCpf?: string;
  relationship: string;
  monthlyCost: number;
  employeeDiscount?: number;
  companySubsidy?: number;
}

export interface HealthOrDentalPlanCalculationParams {
  ansCode?: string;
  holderMonthlyCost: number;
  holderDiscountValue?: number;
  holderSubsidyAmount?: number;
  dependents?: BenefitDependentPlanInput[];
}

export interface HealthOrDentalPlanResult {
  ansCode?: string;
  holderDiscount: number;
  holderSubsidy: number;
  dependentsDiscount: number;
  dependentsSubsidy: number;
  totalEmployeeDiscount: number;
  totalCompanySubsidy: number;
  dependentsBreakdown: Array<{
    dependentName: string;
    dependentCpf?: string;
    relationship: string;
    cost: number;
    discount: number;
    subsidy: number;
  }>;
}

export interface CopaymentItemInput {
  id: string;
  benefitType: 'HEALTH_PLAN' | 'DENTAL_PLAN' | 'OTHER';
  patientType: 'HOLDER' | 'DEPENDENT';
  patientName: string;
  patientCpf?: string;
  procedureDate: string;
  procedureDescription: string;
  copayAmount: number;
}

export interface CopaymentSummaryResult {
  healthCopayTotal: number;
  dentalCopayTotal: number;
  otherCopayTotal: number;
  totalCopayDiscount: number;
  itemsCount: number;
}

export class BenefitsCalculator {
  /**
   * Calcula o Vale-Transporte estritamente conforme a Lei 7.418/1985 e Decreto 10.854/2021:
   * 
   * 1. Colaborador em trabalho integralmente REMOTO ou com optIn = false tem desconto 0.
   * 2. Dias presenciais efetivos = (dias úteis - férias - faltas/licenças) * fator híbrido.
   * 3. Custo total do benefício = dias presenciais * viagens por dia * tarifa unitária.
   * 4. Teto legal = 6% do salário básico proporcional aos dias trabalhados.
   * 5. Desconto = MIN(6% do salário, Custo Efetivo do Benefício).
   * 6. Empresa arca com a diferença caso o custo exceda o teto de 6%.
   */
  public static calculateTransportationVoucher(
    params: TransportationVoucherCalculationParams
  ): TransportationVoucherResult {
    const {
      baseSalary,
      workingDaysInMonth,
      vacationDays = 0,
      absenceOrLeaveDays = 0,
      workRegime = 'PRESENTIAL',
      weeklyRemoteDays = 0,
      dailyPasses = 2,
      passUnitValue = 0,
      manualConcededValue,
      optIn = true,
      workedDaysInMonth = 30,
    } = params;

    // Se renunciou ao benefício expressamente (opt-out), não há concessão nem desconto
    if (!optIn) {
      return {
        vtDiscount: 0,
        totalConcededCost: 0,
        companySubsidy: 0,
        legalCap6Percent: 0,
        effectivePresentialDays: 0,
        isCapApplied: false,
        formulaDescription: 'VT_OPT_OUT: Colaborador optou por não receber Vale-Transporte',
      };
    }

    // Se regime for 100% REMOTO, sem deslocamento casa-trabalho
    if (workRegime === 'REMOTE') {
      return {
        vtDiscount: 0,
        totalConcededCost: 0,
        companySubsidy: 0,
        legalCap6Percent: 0,
        effectivePresentialDays: 0,
        isCapApplied: false,
        formulaDescription: 'VT_REMOTE: Trabalho integralmente remoto (sem deslocamento presencial)',
      };
    }

    // Apuração dos dias úteis disponíveis
    const nonWorkingDays = Math.max(0, vacationDays + absenceOrLeaveDays);
    const availableWorkingDays = Math.max(0, workingDaysInMonth - nonWorkingDays);

    // Fator de dias presenciais no regime híbrido (semana padrão de 5 dias úteis)
    let presenceRatio = 1.0;
    if (workRegime === 'HYBRID') {
      const clampedRemoteDays = Math.min(5, Math.max(0, weeklyRemoteDays));
      presenceRatio = Math.max(0, (5 - clampedRemoteDays) / 5);
    }

    const effectivePresentialDays = Math.round(availableWorkingDays * presenceRatio * 10) / 10;

    // Custo efetivo concedido do benefício
    let totalConcededCost = 0;
    if (manualConcededValue != null && manualConcededValue >= 0) {
      totalConcededCost = round2(manualConcededValue);
    } else {
      totalConcededCost = round2(effectivePresentialDays * dailyPasses * passUnitValue);
    }

    // Se nenhum passe foi necessário ou custo for zero, desconto é zero
    if (totalConcededCost <= 0) {
      return {
        vtDiscount: 0,
        totalConcededCost: 0,
        companySubsidy: 0,
        legalCap6Percent: 0,
        effectivePresentialDays,
        isCapApplied: false,
        formulaDescription: 'VT_CUSTO_ZERO: Nenhum passe concedido no período de apuração',
      };
    }

    // Proporcionalidade do salário base contratual para admissão/rescisão/afastamento no mês
    const clampedWorkedDays = Math.min(30, Math.max(0, workedDaysInMonth));
    const proportionalSalary =
      clampedWorkedDays >= 30
        ? baseSalary
        : round2((baseSalary / 30) * clampedWorkedDays);

    // Teto legal de 6% do salário básico (Lei 7.418/1985 art. 4º)
    const legalCap6Percent = round2(proportionalSalary * 0.06);

    // Desconto é o MENOR entre o teto de 6% e o custo efetivo concedido
    const vtDiscount = Math.min(legalCap6Percent, totalConcededCost);
    const companySubsidy = Math.max(0, round2(totalConcededCost - vtDiscount));
    const isCapApplied = vtDiscount === legalCap6Percent && legalCap6Percent < totalConcededCost;

    const formulaDescription = isCapApplied
      ? `MIN(6% Salário R$ ${legalCap6Percent.toFixed(2)}, Custo VT R$ ${totalConcededCost.toFixed(2)}) = R$ ${vtDiscount.toFixed(2)} [TETO 6% APLICADO - Custeio Empresa: R$ ${companySubsidy.toFixed(2)}]`
      : `MIN(6% Salário R$ ${legalCap6Percent.toFixed(2)}, Custo VT R$ ${totalConcededCost.toFixed(2)}) = R$ ${vtDiscount.toFixed(2)} [CUSTO EFETIVO CONCEDIDO MENOR QUE O TETO 6%]`;

    return {
      vtDiscount,
      totalConcededCost,
      companySubsidy,
      legalCap6Percent,
      effectivePresentialDays,
      isCapApplied,
      formulaDescription,
    };
  }

  /**
   * Calcula Planos de Saúde e Odontológico Corporativos com Registro ANS:
   * Separação estrita de desconto do titular e dependentes vinculados.
   */
  public static calculateHealthOrDentalPlan(
    params: HealthOrDentalPlanCalculationParams
  ): HealthOrDentalPlanResult {
    const {
      ansCode,
      holderMonthlyCost,
      holderDiscountValue,
      holderSubsidyAmount,
      dependents = [],
    } = params;

    // Titular
    let holderDiscount = 0;
    let holderSubsidy = 0;

    if (holderDiscountValue != null) {
      holderDiscount = round2(Math.min(holderMonthlyCost, Math.max(0, holderDiscountValue)));
      holderSubsidy = round2(Math.max(0, holderMonthlyCost - holderDiscount));
    } else if (holderSubsidyAmount != null) {
      holderSubsidy = round2(Math.min(holderMonthlyCost, Math.max(0, holderSubsidyAmount)));
      holderDiscount = round2(Math.max(0, holderMonthlyCost - holderSubsidy));
    } else {
      // Padrão: colaborador paga 100% se não houver subsídio configurado
      holderDiscount = round2(holderMonthlyCost);
      holderSubsidy = 0;
    }

    // Dependentes
    let dependentsDiscount = 0;
    let dependentsSubsidy = 0;
    const dependentsBreakdown: HealthOrDentalPlanResult['dependentsBreakdown'] = [];

    for (const dep of dependents) {
      let depDiscount = 0;
      let depSub = 0;

      if (dep.employeeDiscount != null) {
        depDiscount = round2(Math.min(dep.monthlyCost, Math.max(0, dep.employeeDiscount)));
        depSub = round2(Math.max(0, dep.monthlyCost - depDiscount));
      } else if (dep.companySubsidy != null) {
        depSub = round2(Math.min(dep.monthlyCost, Math.max(0, dep.companySubsidy)));
        depDiscount = round2(Math.max(0, dep.monthlyCost - depSub));
      } else {
        depDiscount = round2(dep.monthlyCost);
        depSub = 0;
      }

      dependentsDiscount = addMoney(dependentsDiscount, depDiscount);
      dependentsSubsidy = addMoney(dependentsSubsidy, depSub);

      dependentsBreakdown.push({
        dependentName: dep.dependentName,
        dependentCpf: dep.dependentCpf,
        relationship: dep.relationship,
        cost: dep.monthlyCost,
        discount: depDiscount,
        subsidy: depSub,
      });
    }

    const totalEmployeeDiscount = addMoney(holderDiscount, dependentsDiscount);
    const totalCompanySubsidy = addMoney(holderSubsidy, dependentsSubsidy);

    return {
      ansCode,
      holderDiscount,
      holderSubsidy,
      dependentsDiscount,
      dependentsSubsidy,
      totalEmployeeDiscount,
      totalCompanySubsidy,
      dependentsBreakdown,
    };
  }

  /**
   * Consolida as faturas de coparticipação em consultas e exames por tipo de benefício.
   */
  public static aggregateCopayments(items: Array<Partial<CopaymentItemInput> & Record<string, any>>): CopaymentSummaryResult {
    let healthCopayTotal = 0;
    let dentalCopayTotal = 0;
    let otherCopayTotal = 0;

    for (const item of items) {
      const amount = round2(Math.max(0, Number(item.copay_amount ?? item.copayAmount ?? 0)));
      if (amount <= 0) continue;

      const type = String(item.benefit_type || item.benefitType || 'HEALTH_PLAN').toUpperCase();
      if (type === 'HEALTH_PLAN') {
        healthCopayTotal = addMoney(healthCopayTotal, amount);
      } else if (type === 'DENTAL_PLAN') {
        dentalCopayTotal = addMoney(dentalCopayTotal, amount);
      } else {
        otherCopayTotal = addMoney(otherCopayTotal, amount);
      }
    }

    const totalCopayDiscount = addMoney(
      addMoney(healthCopayTotal, dentalCopayTotal),
      otherCopayTotal
    );

    return {
      healthCopayTotal,
      dentalCopayTotal,
      otherCopayTotal,
      totalCopayDiscount,
      itemsCount: items.length,
    };
  }
}
