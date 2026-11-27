import { addMoney, round2, subtractMoney, sumMoney } from '../utils/money.js';

export interface WhatIfScenarioParams {
  label?: string;
  salary_increase_pct?: number;
  salary_increase_fixed?: number;
  bonus_amount?: number;
  bonus_rubric_code?: string;
  overtime_hours_delta?: number;
  department_id?: string | null;
  position_id?: string | null;
  cost_center_id?: string | null;
  contract_ids?: string[];
}

export interface WhatIfContractFilterTarget {
  id: string;
  department_id?: string | null;
  position_id?: string | null;
  cost_center_id?: string | null;
}

export interface WhatIfContractSnapshot {
  contract_id: string;
  company_id: string;
  department_id?: string | null;
  worker_name?: string;
  affected: boolean;
  total_earnings: number;
  total_deductions: number;
  net_salary: number;
  base_inss: number;
  inss_employee: number;
  irrf_employee: number;
  fgts_month: number;
}

export interface WhatIfEmployerTotals {
  inss_patronal: number;
  rat_adjusted: number;
  terceiros: number;
  fgts_patronal: number;
  total_taxes: number;
}

export interface WhatIfFinancialBlock {
  total_earnings: number;
  total_deductions: number;
  total_net: number;
  total_inss_employee: number;
  total_irrf_employee: number;
  total_fgts_month: number;
  employer_taxes: WhatIfEmployerTotals;
  total_company_cost: number;
}

export interface WhatIfDepartmentImpact {
  department_id: string | null;
  total_contracts: number;
  affected_contracts: number;
  baseline_earnings: number;
  simulated_earnings: number;
  delta_earnings: number;
  baseline_net: number;
  simulated_net: number;
  delta_net: number;
}

export interface WhatIfContractImpact {
  contract_id: string;
  worker_name?: string;
  department_id?: string | null;
  baseline_earnings: number;
  simulated_earnings: number;
  delta_earnings: number;
  baseline_net: number;
  simulated_net: number;
  delta_net: number;
}

export interface WhatIfComparisonSummary {
  mode: 'SIMULATION';
  scenario: WhatIfScenarioParams;
  total_contracts: number;
  affected_contracts: number;
  chunks_processed: number;
  duration_ms: number;
  baseline: WhatIfFinancialBlock;
  simulated: WhatIfFinancialBlock;
  delta: WhatIfFinancialBlock;
  pct_company_cost_change: number;
  by_department: WhatIfDepartmentImpact[];
  top_impacts: WhatIfContractImpact[];
}

/**
 * Divide uma coleção em lotes (chunks) determinísticos de tamanho fixo (padrão 50).
 */
export function chunkArray<T>(items: readonly T[], chunkSize = 50): T[][] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const safeSize = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

/**
 * Avalia se um contrato é elegível aos filtros do cenário What-If.
 */
export function isContractEligibleForScenario(
  contract: WhatIfContractFilterTarget,
  scenario?: WhatIfScenarioParams | null
): boolean {
  if (!scenario) return false;

  if (scenario.contract_ids && scenario.contract_ids.length > 0) {
    if (!scenario.contract_ids.includes(contract.id)) return false;
  }
  if (scenario.department_id && contract.department_id !== scenario.department_id) {
    return false;
  }
  if (scenario.position_id && contract.position_id !== scenario.position_id) {
    return false;
  }
  if (scenario.cost_center_id && contract.cost_center_id !== scenario.cost_center_id) {
    return false;
  }

  return true;
}

/**
 * Calcula o salário-base simulado aplicando percentual e/ou valor fixo via centavos inteiros (HALF_UP).
 */
export function applyScenarioToBaseSalary(
  baseSalary: number,
  scenario?: WhatIfScenarioParams | null
): number {
  const safeBase = round2(Math.max(0, Number(baseSalary || 0)));
  if (!scenario) return safeBase;

  let result = safeBase;
  const pct = Number(scenario.salary_increase_pct || 0);
  if (pct !== 0) {
    const pctIncrease = round2(safeBase * (pct / 100));
    result = addMoney(result, pctIncrease);
  }

  const fixed = Number(scenario.salary_increase_fixed || 0);
  if (fixed !== 0) {
    result = addMoney(result, fixed);
  }

  return Math.max(0, result);
}

function aggregateBlock(
  snapshots: WhatIfContractSnapshot[],
  employerTaxes: WhatIfEmployerTotals
): WhatIfFinancialBlock {
  const total_earnings = sumMoney(snapshots.map((s) => s.total_earnings));
  const total_deductions = sumMoney(snapshots.map((s) => s.total_deductions));
  const total_net = sumMoney(snapshots.map((s) => s.net_salary));
  const total_inss_employee = sumMoney(snapshots.map((s) => s.inss_employee));
  const total_irrf_employee = sumMoney(snapshots.map((s) => s.irrf_employee));
  const total_fgts_month = sumMoney(snapshots.map((s) => s.fgts_month));

  // Custo empresa = Proventos brutos + Encargos patronais (INSS Patronal + RAT + Terceiros + FGTS)
  const total_company_cost = addMoney(total_earnings, employerTaxes.total_taxes);

  return {
    total_earnings,
    total_deductions,
    total_net,
    total_inss_employee,
    total_irrf_employee,
    total_fgts_month,
    employer_taxes: {
      inss_patronal: round2(employerTaxes.inss_patronal),
      rat_adjusted: round2(employerTaxes.rat_adjusted),
      terceiros: round2(employerTaxes.terceiros),
      fgts_patronal: round2(employerTaxes.fgts_patronal),
      total_taxes: round2(employerTaxes.total_taxes),
    },
    total_company_cost,
  };
}

/**
 * Consolida o comparativo financeiro completo (Baseline vs Simulado) de uma execução What-If.
 */
export function buildWhatIfComparisonSummary(params: {
  scenario: WhatIfScenarioParams;
  baselineContracts: WhatIfContractSnapshot[];
  simulatedContracts: WhatIfContractSnapshot[];
  baselineEmployerTaxes: WhatIfEmployerTotals;
  simulatedEmployerTaxes: WhatIfEmployerTotals;
  durationMs: number;
  chunksProcessed: number;
  topImpactsLimit?: number;
}): WhatIfComparisonSummary {
  const {
    scenario,
    baselineContracts,
    simulatedContracts,
    baselineEmployerTaxes,
    simulatedEmployerTaxes,
    durationMs,
    chunksProcessed,
    topImpactsLimit = 25,
  } = params;

  const baseline = aggregateBlock(baselineContracts, baselineEmployerTaxes);
  const simulated = aggregateBlock(simulatedContracts, simulatedEmployerTaxes);

  const delta: WhatIfFinancialBlock = {
    total_earnings: subtractMoney(simulated.total_earnings, baseline.total_earnings),
    total_deductions: subtractMoney(simulated.total_deductions, baseline.total_deductions),
    total_net: subtractMoney(simulated.total_net, baseline.total_net),
    total_inss_employee: subtractMoney(simulated.total_inss_employee, baseline.total_inss_employee),
    total_irrf_employee: subtractMoney(simulated.total_irrf_employee, baseline.total_irrf_employee),
    total_fgts_month: subtractMoney(simulated.total_fgts_month, baseline.total_fgts_month),
    employer_taxes: {
      inss_patronal: subtractMoney(simulated.employer_taxes.inss_patronal, baseline.employer_taxes.inss_patronal),
      rat_adjusted: subtractMoney(simulated.employer_taxes.rat_adjusted, baseline.employer_taxes.rat_adjusted),
      terceiros: subtractMoney(simulated.employer_taxes.terceiros, baseline.employer_taxes.terceiros),
      fgts_patronal: subtractMoney(simulated.employer_taxes.fgts_patronal, baseline.employer_taxes.fgts_patronal),
      total_taxes: subtractMoney(simulated.employer_taxes.total_taxes, baseline.employer_taxes.total_taxes),
    },
    total_company_cost: subtractMoney(simulated.total_company_cost, baseline.total_company_cost),
  };

  const pct_company_cost_change =
    baseline.total_company_cost > 0
      ? round2((delta.total_company_cost / baseline.total_company_cost) * 100)
      : 0;

  const simByContract = new Map<string, WhatIfContractSnapshot>();
  for (const s of simulatedContracts) {
    simByContract.set(s.contract_id, s);
  }

  const deptMap = new Map<string, WhatIfDepartmentImpact>();
  const impacts: WhatIfContractImpact[] = [];
  let affectedContracts = 0;

  for (const base of baselineContracts) {
    const sim = simByContract.get(base.contract_id) || base;
    if (sim.affected) affectedContracts++;

    const deptKey = base.department_id ?? '__NONE__';
    let deptAgg = deptMap.get(deptKey);
    if (!deptAgg) {
      deptAgg = {
        department_id: base.department_id ?? null,
        total_contracts: 0,
        affected_contracts: 0,
        baseline_earnings: 0,
        simulated_earnings: 0,
        delta_earnings: 0,
        baseline_net: 0,
        simulated_net: 0,
        delta_net: 0,
      };
      deptMap.set(deptKey, deptAgg);
    }

    deptAgg.total_contracts += 1;
    if (sim.affected) deptAgg.affected_contracts += 1;
    deptAgg.baseline_earnings = addMoney(deptAgg.baseline_earnings, base.total_earnings);
    deptAgg.simulated_earnings = addMoney(deptAgg.simulated_earnings, sim.total_earnings);
    deptAgg.delta_earnings = subtractMoney(deptAgg.simulated_earnings, deptAgg.baseline_earnings);
    deptAgg.baseline_net = addMoney(deptAgg.baseline_net, base.net_salary);
    deptAgg.simulated_net = addMoney(deptAgg.simulated_net, sim.net_salary);
    deptAgg.delta_net = subtractMoney(deptAgg.simulated_net, deptAgg.baseline_net);

    const deltaEarnings = subtractMoney(sim.total_earnings, base.total_earnings);
    const deltaNet = subtractMoney(sim.net_salary, base.net_salary);

    if (sim.affected && (deltaEarnings !== 0 || deltaNet !== 0)) {
      impacts.push({
        contract_id: base.contract_id,
        worker_name: base.worker_name,
        department_id: base.department_id ?? null,
        baseline_earnings: base.total_earnings,
        simulated_earnings: sim.total_earnings,
        delta_earnings: deltaEarnings,
        baseline_net: base.net_salary,
        simulated_net: sim.net_salary,
        delta_net: deltaNet,
      });
    }
  }

  impacts.sort((a, b) => Math.abs(b.delta_earnings) - Math.abs(a.delta_earnings));

  return {
    mode: 'SIMULATION',
    scenario,
    total_contracts: baselineContracts.length,
    affected_contracts: affectedContracts,
    chunks_processed: chunksProcessed,
    duration_ms: durationMs,
    baseline,
    simulated,
    delta,
    pct_company_cost_change,
    by_department: Array.from(deptMap.values()),
    top_impacts: impacts.slice(0, topImpactsLimit),
  };
}
