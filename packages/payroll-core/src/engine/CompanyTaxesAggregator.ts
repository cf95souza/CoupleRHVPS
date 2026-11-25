import { addMoney, sumMoney } from "../utils/money.js";
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
}

export interface CalculatedPayslipForTax {
  contract_id: string;
  base_inss: number;
  base_fgts: number;
  fgts_month?: number;
}

export interface CompanyInfo {
  id: string;
  labor_config?: LaborConfig;
  tax_regime?: string;
  simples_anexo?: string;
  is_cprb_exempted?: boolean;
}

export interface AggregatedCompanyTotals {
  base_inss: number;
  base_fgts: number;
  fgts_month_sum?: number;
}

/**
 * Agrega as bases de INSS, FGTS e FGTS individual real (2% aprendiz + 8% CLT - BUG-09)
 * por empresa a partir de todos os holerites do período (T10).
 */
export function aggregateCompanyBases(params: {
  calculatedPayslips: CalculatedPayslipForTax[];
  existingPayslips?: ExistingPayslipBase[];
  contractCompanyMap: Record<string, string>;
}): Record<string, AggregatedCompanyTotals> {
  const { calculatedPayslips, existingPayslips = [], contractCompanyMap } = params;
  const totals: Record<string, AggregatedCompanyTotals> = {};

  const calculatedContractIds = new Set<string>();

  for (const p of calculatedPayslips) {
    calculatedContractIds.add(p.contract_id);
    const companyId = contractCompanyMap[p.contract_id];
    if (!companyId) continue;

    if (!totals[companyId]) {
      totals[companyId] = { base_inss: 0, base_fgts: 0 };
    }

    totals[companyId].base_inss = addMoney(totals[companyId].base_inss, p.base_inss);
    totals[companyId].base_fgts = addMoney(totals[companyId].base_fgts, p.base_fgts);
    if (p.fgts_month !== undefined && p.fgts_month !== null) {
      totals[companyId].fgts_month_sum = addMoney(totals[companyId].fgts_month_sum ?? 0, p.fgts_month);
    }
  }

  for (const ep of existingPayslips) {
    if (calculatedContractIds.has(ep.contract_id)) {
      continue;
    }

    const companyId = ep.company_id;
    if (!companyId) continue;

    if (!totals[companyId]) {
      totals[companyId] = { base_inss: 0, base_fgts: 0 };
    }

    totals[companyId].base_inss = addMoney(totals[companyId].base_inss, ep.base_inss);
    totals[companyId].base_fgts = addMoney(totals[companyId].base_fgts, ep.base_fgts);
    if (ep.fgts_month !== undefined && ep.fgts_month !== null) {
      totals[companyId].fgts_month_sum = addMoney(totals[companyId].fgts_month_sum ?? 0, ep.fgts_month);
    }
  }

  return totals;
}

/**
 * Calcula os tributos patronais consolidados para cada empresa com base nos totais agregados (T10 + BUG-09).
 * Quando fgts_month_sum estiver disponível, utiliza a soma real dos FGTS individuais (2% aprendiz / 8% CLT).
 */
export function calculateConsolidatedEmployerTaxes(params: {
  tenant_id: string;
  period_id: string;
  companyTotals: Record<string, AggregatedCompanyTotals>;
  companies: CompanyInfo[];
}): CompanyTaxItem[] {
  const { tenant_id, period_id, companyTotals, companies } = params;
  const result: CompanyTaxItem[] = [];

  for (const companyId of Object.keys(companyTotals)) {
    const totals = companyTotals[companyId];
    const comp = companies.find((c) => c.id === companyId);

    const laborConfig: LaborConfig = {
      ...comp?.labor_config,
      tax_regime: comp?.tax_regime ?? comp?.labor_config?.tax_regime,
      simples_anexo: comp?.simples_anexo ?? comp?.labor_config?.simples_anexo,
      is_cprb_exempted: comp?.is_cprb_exempted ?? comp?.labor_config?.is_cprb_exempted,
    };

    const taxes = EmployerTaxesCalculator.calculate(
      totals.base_inss,
      totals.base_fgts,
      laborConfig
    );

    const effectiveFgtsPatronal =
      totals.fgts_month_sum !== undefined
        ? totals.fgts_month_sum
        : taxes.fgts_patronal;

    const effectiveTotal = sumMoney([
      taxes.inss_patronal,
      taxes.rat_adjusted,
      taxes.terceiros,
      effectiveFgtsPatronal,
    ]);

    result.push({
      tenant_id,
      period_id,
      company_id: companyId,
      total_base_inss: totals.base_inss,
      total_base_fgts: totals.base_fgts,
      inss_patronal: taxes.inss_patronal,
      rat_adjusted: taxes.rat_adjusted,
      terceiros: taxes.terceiros,
      fgts_patronal: effectiveFgtsPatronal,
      total_taxes: effectiveTotal,
    });
  }

  return result;
}
