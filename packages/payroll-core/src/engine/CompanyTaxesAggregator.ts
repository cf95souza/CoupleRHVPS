import { addMoney, round2, subtractMoney, sumMoney } from "../utils/money.js";
import {
  EmployerTaxesCalculator,
  LaborConfig,
} from "../legal/EmployerTaxesCalculator.js";
import { CompanyTaxItem } from "./AtomicPersistence.js";

export interface ExistingPayslipBase {
  contract_id: string;
  company_id: string;
  base_inss: number;
  base_fgts: number;
  fgts_month?: number;
  inss_employee?: number;
  maternity_deduction?: number;
  family_salary_deduction?: number;
  calculation_regime?: string;
  special_retirement_exposure_code?: string;
}

export interface CalculatedPayslipForTax {
  contract_id: string;
  base_inss: number;
  base_fgts: number;
  fgts_month?: number;
  inss_employee?: number;
  maternity_deduction?: number;
  family_salary_deduction?: number;
  calculation_regime?: string;
  special_retirement_exposure_code?: string;
}

export interface CompanyInfo {
  id: string;
  labor_config?: LaborConfig;
  tax_regime?: string;
  simples_anexo?: string;
  is_cprb_exempted?: boolean;
  cprb_gross_revenue_exempt?: number;
  cprb_gross_revenue_total?: number;
  cprb_reoneration_year?: number | null;
}

export interface AggregatedCompanyTotals {
  base_inss: number;
  base_inss_employees?: number;
  base_inss_individual_contributors?: number;
  base_fgts: number;
  fgts_month_sum?: number;
  inss_employee_sum?: number;
  maternity_deduction_sum?: number;
  family_salary_deduction_sum?: number;
  special_retirement_code02_base?: number;
  special_retirement_code03_base?: number;
  special_retirement_code04_base?: number;
}

function isIndividualContributorRegime(regime?: string): boolean {
  return regime === 'PRO_LABORE' || regime === 'AUTONOMOUS_RPA';
}

function isExemptEmployerRegime(regime?: string): boolean {
  return regime === 'INTERN';
}

/**
 * Agrega as bases de INSS (segregando Empregados vs Pró-Labore/RPA), FGTS real por contrato
 * (8% CLT / 2% aprendiz / 0% isento) e exposição à Aposentadoria Especial (FOLHA-16).
 */
export function aggregateCompanyBases(params: {
  calculatedPayslips: CalculatedPayslipForTax[];
  existingPayslips?: ExistingPayslipBase[];
  contractCompanyMap: Record<string, string>;
}): Record<string, AggregatedCompanyTotals> {
  const { calculatedPayslips, existingPayslips = [], contractCompanyMap } = params;
  const totals: Record<string, AggregatedCompanyTotals> = {};
  const calculatedContractIds = new Set<string>();

  const accumulate = (
    companyId: string,
    p: {
      base_inss: number;
      base_fgts: number;
      fgts_month?: number;
      inss_employee?: number;
      maternity_deduction?: number;
      family_salary_deduction?: number;
      calculation_regime?: string;
      special_retirement_exposure_code?: string;
    }
  ) => {
    if (!totals[companyId]) {
      totals[companyId] = {
        base_inss: 0,
        base_inss_employees: 0,
        base_inss_individual_contributors: 0,
        base_fgts: 0,
        special_retirement_code02_base: 0,
        special_retirement_code03_base: 0,
        special_retirement_code04_base: 0,
      };
    }
    const bucket = totals[companyId];
    const baseInss = Number(p.base_inss || 0);
    bucket.base_inss = addMoney(bucket.base_inss, baseInss);
    bucket.base_fgts = addMoney(bucket.base_fgts, Number(p.base_fgts || 0));

    if (!isExemptEmployerRegime(p.calculation_regime)) {
      if (isIndividualContributorRegime(p.calculation_regime)) {
        bucket.base_inss_individual_contributors = addMoney(
          bucket.base_inss_individual_contributors || 0,
          baseInss
        );
      } else {
        bucket.base_inss_employees = addMoney(bucket.base_inss_employees || 0, baseInss);
        if (p.special_retirement_exposure_code === '02') {
          bucket.special_retirement_code02_base = addMoney(
            bucket.special_retirement_code02_base || 0,
            baseInss
          );
        } else if (p.special_retirement_exposure_code === '03') {
          bucket.special_retirement_code03_base = addMoney(
            bucket.special_retirement_code03_base || 0,
            baseInss
          );
        } else if (p.special_retirement_exposure_code === '04') {
          bucket.special_retirement_code04_base = addMoney(
            bucket.special_retirement_code04_base || 0,
            baseInss
          );
        }
      }
    }

    if (p.fgts_month !== undefined && p.fgts_month !== null) {
      bucket.fgts_month_sum = addMoney(bucket.fgts_month_sum ?? 0, p.fgts_month);
    }
    if (p.inss_employee !== undefined && p.inss_employee !== null) {
      bucket.inss_employee_sum = addMoney(bucket.inss_employee_sum ?? 0, p.inss_employee);
    }
    if (p.maternity_deduction !== undefined && p.maternity_deduction !== null) {
      bucket.maternity_deduction_sum = addMoney(bucket.maternity_deduction_sum ?? 0, p.maternity_deduction);
    }
    if (p.family_salary_deduction !== undefined && p.family_salary_deduction !== null) {
      bucket.family_salary_deduction_sum = addMoney(
        bucket.family_salary_deduction_sum ?? 0,
        p.family_salary_deduction
      );
    }
  };

  for (const p of calculatedPayslips) {
    calculatedContractIds.add(p.contract_id);
    const companyId = contractCompanyMap[p.contract_id];
    if (!companyId) continue;
    accumulate(companyId, p);
  }

  for (const ep of existingPayslips) {
    if (calculatedContractIds.has(ep.contract_id)) continue;
    if (!ep.company_id) continue;
    accumulate(ep.company_id, ep);
  }

  return totals;
}

/**
 * Calcula os tributos patronais consolidados para cada empresa (FOLHA-16).
 */
export function calculateConsolidatedEmployerTaxes(params: {
  tenant_id: string;
  period_id: string;
  competence_year?: number;
  companyTotals: Record<string, AggregatedCompanyTotals>;
  companies: CompanyInfo[];
}): CompanyTaxItem[] {
  const { tenant_id, period_id, competence_year, companyTotals, companies } = params;
  const result: CompanyTaxItem[] = [];

  for (const companyId of Object.keys(companyTotals)) {
    const totals = companyTotals[companyId];
    const comp = companies.find((c) => c.id === companyId);

    const laborConfig: LaborConfig = {
      ...comp?.labor_config,
      tax_regime: comp?.tax_regime ?? comp?.labor_config?.tax_regime,
      simples_anexo: comp?.simples_anexo ?? comp?.labor_config?.simples_anexo,
      is_cprb_exempted: comp?.is_cprb_exempted ?? comp?.labor_config?.is_cprb_exempted,
      cprb_gross_revenue_exempt:
        comp?.cprb_gross_revenue_exempt ?? comp?.labor_config?.cprb_gross_revenue_exempt,
      cprb_gross_revenue_total:
        comp?.cprb_gross_revenue_total ?? comp?.labor_config?.cprb_gross_revenue_total,
      competence_year:
        comp?.cprb_reoneration_year ?? competence_year ?? comp?.labor_config?.competence_year,
    };

    const baseEmp =
      totals.base_inss_employees !== undefined ? totals.base_inss_employees : totals.base_inss;
    const baseInd = totals.base_inss_individual_contributors ?? 0;

    const taxes = EmployerTaxesCalculator.calculateAdvanced({
      baseInssEmployees: baseEmp,
      baseInssIndividualContributors: baseInd,
      baseFgts: totals.base_fgts,
      fgtsMonthSum: totals.fgts_month_sum,
      specialRetirementBases: {
        code02_15y: totals.special_retirement_code02_base,
        code03_20y: totals.special_retirement_code03_base,
        code04_25y: totals.special_retirement_code04_base,
      },
      config: laborConfig,
    });

    const maternityDeduction = round2(totals.maternity_deduction_sum ?? 0);
    const familySalaryDeduction = round2(totals.family_salary_deduction_sum ?? 0);
    const totalDctfWebDeductions = addMoney(maternityDeduction, familySalaryDeduction);
    const inssSegurados = round2(totals.inss_employee_sum ?? 0);

    const grossEmployerInss = sumMoney([
      taxes.inss_patronal,
      taxes.inss_patronal_pro_labore,
      taxes.rat_adjusted,
      taxes.rat_special_retirement_amount,
      taxes.terceiros,
    ]);

    const grossDctfWebInss = addMoney(inssSegurados, grossEmployerInss);
    const netInssDue = Math.max(0, subtractMoney(grossDctfWebInss, totalDctfWebDeductions));

    const effectiveTotal = addMoney(
      Math.max(0, subtractMoney(grossEmployerInss, totalDctfWebDeductions)),
      taxes.fgts_patronal
    );

    result.push({
      tenant_id,
      period_id,
      company_id: companyId,
      total_base_inss: totals.base_inss,
      total_base_fgts: totals.base_fgts,
      inss_patronal: taxes.inss_patronal,
      inss_patronal_pro_labore: taxes.inss_patronal_pro_labore,
      rat_adjusted: taxes.rat_adjusted,
      rat_special_retirement_amount: taxes.rat_special_retirement_amount,
      terceiros: taxes.terceiros,
      fgts_patronal: taxes.fgts_patronal,
      maternity_deduction: maternityDeduction,
      family_salary_deduction: familySalaryDeduction,
      net_inss_due: netInssDue,
      cprb_reduction_ratio: taxes.cprb_reduction_ratio,
      cprb_effective_cpp_rate: taxes.cprb_effective_cpp_rate,
      breakdown_json: {
        regimeApplied: taxes.regimeApplied,
        baseInssEmployees: baseEmp,
        baseInssIndividualContributors: baseInd,
        inssSegurados,
      },
      total_taxes: effectiveTotal,
    });
  }

  return result;
}
