import pg from 'pg';
import {
  PayrollContext,
  PayrollEngine,
  Rubric,
  RubricContext,
  validateAllLegalTables,
  formatPeriodStartDate,
  shouldSkipFutureAdmission,
  calculateWorkingDays,
  isVacationCrossingMonth,
  calculateVacationDaysInMonth,
  formatDate,
  getDaysInMonth,
  isDeductionEligibleForPeriod,
  calculateDeductionAmount,
  evaluateIRRFDependents,
  calculateThirteenthAvos,
  calculateThirteenthValues,
  calculateThirteenthMaternityDeduction,
  calculateThirteenthWorkAccidentComplement,
  resolveCanonicalLeaveCategory,
  aggregateCompanyBases,
  calculateConsolidatedEmployerTaxes,
  buildAtomicPayrollPayload,
  validatePeriodStatusForCalculation,
  isRubricEligibleForCalculation,
  resolveRubricIncidence,
  resolveIrrfTaxationBucket,
  calculateDefaultPaymentDate,
  isAlimonyBeneficiaryEligible,
  LeaveImpactCalculator,
  BenefitsCalculator,
  CollectiveAgreementCalculator,
  AveragesCalculator,
  VacationEnterpriseCalculator,
  MultiRegimeCalculator,
  type HistoricalRubricEntry,
  type AverageTarget,
  type AverageWindowMode,
  type CalculationRegimeType,
  type AutonomousServiceType,
  type OtherEmploymentInput,
  chunkArray,
  isContractEligibleForScenario,
  applyScenarioToBaseSalary,
  addMoney,
  divideMoney,
  round2,
  subtractMoney,
  sumMoney,
  type AlimonyBeneficiaryRule,
  type AlimonySplitResult,
  type LeaveRecordInput,
  type LeavePeriodImpactResult,
  type RawCalculatedPayslip,
  type NegativeNetPolicy,
  type ExistingPayslipBase,
  type WhatIfScenarioParams,
  type WhatIfContractSnapshot,
  type PriorIrrfCashEntry,
  type IrrfCashLedgerSnapshot,
  type IrrfTaxationBucket,
} from '@couplerh/payroll-core';

export const ENGINE_VERSION = '2.2.0';
const SYNTHETIC_BONUS_RUBRIC_ID = 'b0000000-0000-0000-0000-000000000998';

function normalizeCalcForm(value: string): string {
  const map: Record<string, string> = {
    FIXED: 'FIXO',
    HOURS: 'HORAS',
    DAYS: 'DIAS',
    PERCENTAGE_OF_BASE: 'PERCENTUAL',
    PERCENTAGE: 'PERCENTUAL',
    REFERENCE_TABLE: 'AUTOMATICA',
    FORMULA: 'FORMULA',
    MANUAL: 'MANUAL',
    SYSTEM: 'AUTOMATICA',
    FIXO: 'FIXO',
    HORAS: 'HORAS',
    DIAS: 'DIAS',
    PERCENTUAL: 'PERCENTUAL',
    AUTOMATICA: 'AUTOMATICA',
    BASE: 'BASE',
    REFERENCIA: 'REFERENCIA',
    QUANTIDADE_X_VALOR: 'QUANTIDADE_X_VALOR',
  };
  return map[value] || value;
}

function mapDbRubricToEngine(r: any, rubricContext: RubricContext): Rubric {
  const rawInc = r.incidencias || {};
  const resolved = resolveRubricIncidence(
    {
      ...r,
      generates_base_inss: rawInc.gera_base_inss ?? rawInc.inss ?? false,
      generates_base_irrf: rawInc.gera_base_irrf ?? rawInc.irrf ?? false,
      generates_base_fgts: rawInc.gera_base_fgts ?? rawInc.fgts ?? false,
      incidence_inss_patronal: rawInc.inss_patronal ?? false,
      incidence_rat: rawInc.rat ?? false,
      incidence_third_parties: rawInc.terceiros ?? false,
    },
    rubricContext,
    []
  );

  return {
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    category: r.category,
    rubric_kind: r.rubric_kind || undefined,
    status: r.status || 'ACTIVE',
    is_system: Boolean(r.is_system),
    esocial_nature: r.esocial_nature || undefined,
    legal_basis: r.legal_basis || undefined,
    version: Number(r.version || 1),
    calculation_form: normalizeCalcForm(r.calculation_form || 'FIXO'),
    calculation_base: r.calculation_base || undefined,
    percentage: r.percentage !== null && r.percentage !== undefined ? Number(r.percentage) : undefined,
    quantity: r.quantity !== null && r.quantity !== undefined ? Number(r.quantity) : undefined,
    divisor: r.divisor !== null && r.divisor !== undefined ? Number(r.divisor) : undefined,
    factor: r.factor !== null && r.factor !== undefined ? Number(r.factor) : undefined,
    formula: r.formula || undefined,
    calculation_order: Number(r.calculation_order ?? 100),
    discount_priority: r.discount_priority !== null && r.discount_priority !== undefined ? Number(r.discount_priority) : null,
    average_type: r.average_type || 'NONE',
    include_in_vacation_avg: Boolean(r.include_in_vacation_avg),
    include_in_13th_avg: Boolean(r.include_in_13th_avg),
    include_in_notice_avg: Boolean(r.include_in_notice_avg),
    incidencias: {
      inss: Boolean(rawInc.inss ?? resolved.inss),
      irrf: Boolean(rawInc.irrf ?? resolved.irrf),
      fgts: Boolean(rawInc.fgts ?? resolved.fgts),
      inss_patronal: Boolean(rawInc.inss_patronal ?? resolved.inss_patronal),
      rat: Boolean(rawInc.rat ?? resolved.rat),
      terceiros: Boolean(rawInc.terceiros ?? resolved.terceiros),
      gera_base_inss: Boolean(rawInc.gera_base_inss ?? rawInc.inss ?? resolved.inss),
      gera_base_irrf: Boolean(rawInc.gera_base_irrf ?? rawInc.irrf ?? resolved.irrf),
      gera_base_fgts: Boolean(rawInc.gera_base_fgts ?? rawInc.fgts ?? resolved.fgts),
      integra_dsr: Boolean(rawInc.integra_dsr ?? resolved.integra_dsr),
      irrf_mode: rawInc.irrf_mode ?? resolved.irrf_mode ?? 'NORMAL',
      media_ferias: Boolean(rawInc.media_ferias ?? resolved.media_ferias),
      media_13: Boolean(rawInc.media_13 ?? resolved.media_13),
    },
  };
}

function toDateStr(val: any): string {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  if (val instanceof Date) {
    return `${val.getUTCFullYear()}-${String(val.getUTCMonth() + 1).padStart(2, '0')}-${String(val.getUTCDate()).padStart(2, '0')}`;
  }
  return String(val).slice(0, 10);
}

function groupByKey<T>(rows: T[], keyFn: (row: T) => string | null | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(row);
  }
  return map;
}

export interface LoadedPeriodCalculationData {
  tenantId: string;
  periodId: string;
  period: any;
  companyId: string;
  periodStartDate: string;
  endDate: string;
  daysInMonth: number;
  contracts: any[];
  contractCompanyMap: Record<string, string>;
  companies: any[];
  activeVersion: any;
  inss_parameters: any[];
  irrf_parameters: any[];
  general_legal_parameters: any;
  rubricas: Rubric[];
  rubricsById: Map<string, Rubric>;
  rubricsByCode: Map<string, Rubric>;
  baseApplicableRubrics: Rubric[];
  dbHolidays: any[];
  calendarCache: Map<string, { diasUteis: number; diasInuteis: number }>;
  fixedEventsByContract: Map<string, any[]>;
  variableEventsByContract: Map<string, any[]>;
  benefitsByContract: Map<string, any[]>;
  benefitDependentsByBenefitId: Map<string, any[]>;
  copaymentsByContract: Map<string, any[]>;
  deductionsByContract: Map<string, any[]>;
  alimonyBeneficiariesByContract: Map<string, AlimonyBeneficiaryRule[]>;
  leavesByContract: Map<string, LeaveRecordInput[]>;
  loansByContract: Map<string, any[]>;
  debtsByContract: Map<string, any[]>;
  negativeNetPolicy: NegativeNetPolicy;
  collectiveAgreementsById: Map<string, any>;
  dependentsByWorker: Map<string, any[]>;
  vacSchedulesByContract: Map<string, any[]>;
  existingCompetencePayslipsByContract: Map<string, any[]>;
  groupInssByCpfAndContract: Map<string, Map<string, OtherEmploymentInput[]>>;
  otherEmploymentsByWorker: Map<string, OtherEmploymentInput[]>;
  advancePayslipByContract: Map<string, any>;
  thirteenthAdvancesByContract: Record<string, { amount: number; fgtsBase: number }>;
  thirteenthSecondByContract: Map<
    string,
    { gross: number; inss: number; irrf: number; fgtsBase: number; alimony: number; avos: number }
  >;
  absencesByContractAndMonth: Map<string, Record<number, number>>;
  paymentDate: string;
  irrfRegime: 'CASH' | 'COMPETENCE';
  withholdIrrfOnAdvance: boolean;
  irrfBucket: IrrfTaxationBucket;
  priorCashIrrfByWorker: Map<string, PriorIrrfCashEntry[]>;
  historicalAveragesByContract: Map<string, HistoricalRubricEntry[]>;
  intermittentCallsByContract: Map<string, any[]>;
}

/**
 * Carrega o histórico fechado/calculado de itens variáveis elegíveis a médias (FOLHA-10).
 * Executado em lote único para férias, 13º e rescisão, preservando o fast-path da folha mensal.
 */
export async function loadHistoricalAveragesItems(
  client: pg.PoolClient,
  params: {
    tenantId: string;
    contractIds: string[];
    fromYear: number;
    fromMonth: number;
    toYear: number;
    toMonth: number;
  }
): Promise<Map<string, HistoricalRubricEntry[]>> {
  const { tenantId, contractIds, fromYear, fromMonth, toYear, toMonth } = params;
  if (contractIds.length === 0) return new Map();

  const startKey = fromYear * 100 + fromMonth;
  const endKey = toYear * 100 + toMonth;

  const { rows } = await client.query(
    `SELECT
       ps.contract_id,
       pp.year,
       pp.month,
       pi.rubric_id,
       pi.rubric_code,
       pi.rubric_name,
       pi.reference,
       pi.amount,
       r.average_type,
       r.factor,
       r.incidencias,
       r.include_in_vacation_avg,
       r.include_in_13th_avg,
       r.include_in_notice_avg
     FROM public.payslip_items pi
     JOIN public.payslips ps ON ps.id = pi.payslip_id
     JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
     JOIN public.rubrics r ON r.id = pi.rubric_id
     WHERE ps.tenant_id = $1::uuid
       AND ps.contract_id = ANY($2::uuid[])
       AND pp.type IN ('MONTHLY', 'COMPLEMENTARY')
       AND pp.status IN ('CALCULATED', 'APPROVED', 'LOCKED', 'CLOSED')
       AND (pp.year * 100 + pp.month) >= $3
       AND (pp.year * 100 + pp.month) <= $4
       AND r.average_type <> 'NONE'
     ORDER BY pp.year ASC, pp.month ASC, pi.rubric_code ASC;`,
    [tenantId, contractIds, startKey, endKey]
  );

  const grouped = new Map<string, HistoricalRubricEntry[]>();
  for (const row of rows) {
    const rawInc = row.incidencias || {};
    const entry: HistoricalRubricEntry = {
      year: Number(row.year),
      month: Number(row.month),
      rubricId: row.rubric_id,
      rubricCode: row.rubric_code,
      rubricName: row.rubric_name,
      averageType: row.average_type || 'NONE',
      quantity: row.reference !== null && row.reference !== undefined ? Number(row.reference) : 0,
      amount: Number(row.amount || 0),
      factor: row.factor !== null && row.factor !== undefined ? Number(row.factor) : 1,
      integraDsr: Boolean(rawInc.integra_dsr),
      includeInVacationAvg: Boolean(row.include_in_vacation_avg),
      includeIn13thAvg: Boolean(row.include_in_13th_avg),
      includeInNoticeAvg: Boolean(row.include_in_notice_avg),
    };
    const list = grouped.get(row.contract_id) || [];
    list.push(entry);
    grouped.set(row.contract_id, list);
  }
  return grouped;
}

export interface PersistedIrrfCashEntry extends IrrfCashLedgerSnapshot {
  contract_id: string;
  worker_id: string;
  company_id: string;
}

export interface PersistedAlimonySplit extends AlimonySplitResult {
  contract_id: string;
}

export interface SingleContractCalculationOutcome {
  skipped?: boolean;
  payslip?: RawCalculatedPayslip;
  snapshot?: WhatIfContractSnapshot;
  irrfCashEntry?: PersistedIrrfCashEntry | null;
  alimonySplits?: PersistedAlimonySplit[];
  error?: { contract_id: string; worker_id: string; error: string };
}

/**
 * Carrega uma única vez todo o contexto legal, catálogo de rubricas, feriados,
 * contratos e eventos da competência, indexando coleções em Maps O(1) para
 * processamento escalável em lotes de 50 contratos.
 */
export async function loadPeriodCalculationData(
  client: pg.PoolClient,
  params: {
    tenantId: string;
    periodId: string;
    contractIdFilter?: string | null;
    periodRow?: any;
  }
): Promise<LoadedPeriodCalculationData> {
  const { tenantId, periodId, contractIdFilter = null } = params;

  let period = params.periodRow;
  if (!period) {
    const { rows: periodRows } = await client.query(
      `SELECT * FROM public.payroll_periods WHERE id = $1::uuid AND tenant_id = $2::uuid;`,
      [periodId, tenantId]
    );
    if (periodRows.length === 0) {
      throw Object.assign(new Error('Período de folha não encontrado.'), { httpStatus: 404 });
    }
    period = periodRows[0];
  }

  const companyId = period.company_id;
  if (!companyId) {
    throw new Error('A competência não possui uma empresa associada.');
  }

  const periodStartDate = formatPeriodStartDate(period.year, period.month);
  const daysInMonth = getDaysInMonth(period.year, period.month);
  const endDate = formatDate(period.year, period.month, daysInMonth);

  // 1. Feriados filtrados por tenant e ativos (BUG-10)
  const { rows: dbHolidays } = await client.query(
    `SELECT date, type, state_code, city_code, company_id
     FROM public.holidays
     WHERE (tenant_id IS NULL OR tenant_id = $1::uuid)
       AND status = 'ACTIVE'
       AND date >= $2::date
       AND date <= $3::date;`,
    [tenantId, periodStartDate, endDate]
  );

  // 2. Contratos ativos da empresa (sem limite de 1000 linhas - BUG-10)
  let contractsSql = `
    SELECT
      c.id, c.worker_id, c.company_id, c.department_id, c.position_id, c.cost_center_id,
      c.workplace_id, c.base_salary, c.status,
      c.admission_date, c.termination_date, c.receives_advance, c.advance_percentage,
      c.monthly_hours, c.weekly_hours, c.regime, c.incidences AS contract_incidences,
      c.union_id, c.collective_agreement_id,
      COALESCE(c.calculation_regime, ct.calculation_regime, 'CLT') AS calculation_regime,
      COALESCE(c.esocial_category_code, ct.esocial_category_code, '101') AS esocial_category_code,
      COALESCE(c.autonomous_service_type, 'GENERAL') AS autonomous_service_type,
      COALESCE(c.iss_rate, 0) AS iss_rate,
      COALESCE(c.special_retirement_exposure_code, '01') AS special_retirement_exposure_code,
      c.hourly_rate, c.daily_rate,
      w.full_name AS worker_name,
      w.cpf AS worker_cpf,
      w.is_apprentice,
      wp.state_code AS workplace_state_code,
      wp.city_code AS workplace_city_code,
      ct.is_clt AS contract_type_is_clt,
      ct.name AS contract_type_name,
      pos.cbo AS position_cbo
    FROM public.contracts c
    JOIN public.workers w ON w.id = c.worker_id
    LEFT JOIN public.positions pos ON pos.id = c.position_id
    LEFT JOIN public.workplaces wp ON wp.id = c.workplace_id
    LEFT JOIN public.contract_types ct ON ct.id = c.contract_type_id
    WHERE c.tenant_id = $1::uuid
      AND c.company_id = $2::uuid
      AND c.deleted_at IS NULL
      AND c.status IN ('ACTIVE', 'LEAVE', 'VACATION')
  `;
  const contractParams: any[] = [tenantId, companyId];

  if (contractIdFilter) {
    contractsSql += ` AND c.id = $3::uuid`;
    contractParams.push(contractIdFilter);
  }

  contractsSql += ` ORDER BY c.id ASC;`;

  const { rows: allContracts } = await client.query(contractsSql, contractParams);
  allContracts.sort((a: any, b: any) => {
    const cpfCmp = String(a.worker_cpf || '\uffff').localeCompare(String(b.worker_cpf || '\uffff'));
    if (cpfCmp !== 0) return cpfCmp;
    const admA = a.admission_date ? String(a.admission_date) : '';
    const admB = b.admission_date ? String(b.admission_date) : '';
    if (admA !== admB) return admA < admB ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });

  // Férias que cruzam o mês (inclui concessive_end para detecção automática de dobra CLT Art. 137)
  const { rows: vacSchedules } = await client.query(
    `SELECT vs.*, vp.concessive_end, vp.acquisition_start, vp.acquisition_end
     FROM public.vacation_schedules vs
     LEFT JOIN public.vacation_periods vp ON vp.id = vs.vacation_period_id
     WHERE vs.tenant_id = $1::uuid
       AND vs.start_date <= $2::date
       AND vs.end_date >= $3::date
       AND vs.status IN ('APPROVED', 'CALCULATED', 'PAID');`,
    [tenantId, endDate, periodStartDate]
  );

  let contracts = allContracts;
  if (!contractIdFilter && period.type === 'VACATION') {
    const vacContractSet = new Set(vacSchedules.map((v: any) => v.contract_id));
    contracts = allContracts.filter((c: any) => vacContractSet.has(c.id));
  }

  const contractIds = contracts.map((c: any) => c.id);
  const workerIds = Array.from(new Set(contracts.map((c: any) => c.worker_id).filter(Boolean)));

  // 3. Tabelas Legais Vigentes (BUG-06)
  const { rows: activeVersions } = await client.query(
    `SELECT id, code, description, valid_from, valid_to
     FROM public.legal_versions
     WHERE is_active = TRUE
       AND valid_from <= $1::date
       AND (valid_to IS NULL OR valid_to >= $1::date)
     ORDER BY valid_from DESC
     LIMIT 1;`,
    [periodStartDate]
  );

  if (activeVersions.length === 0) {
    throw new Error(
      `Nenhuma versão de parâmetros legais (legal_versions) vigente encontrada para a competência ${period.month}/${period.year}.`
    );
  }

  const activeVersion = activeVersions[0];
  const inssRes = await client.query(
    `SELECT bracket_number, base_limit, aliquot
     FROM public.inss_parameters
     WHERE legal_version_id = $1::uuid
     ORDER BY bracket_number ASC;`,
    [activeVersion.id]
  );
  const irrfRes = await client.query(
    `SELECT bracket_number, base_limit, aliquot, deduction
     FROM public.irrf_parameters
     WHERE legal_version_id = $1::uuid
     ORDER BY bracket_number ASC;`,
    [activeVersion.id]
  );
  const genRes = await client.query(
    `SELECT *
     FROM public.general_legal_parameters
     WHERE legal_version_id = $1::uuid
     LIMIT 1;`,
    [activeVersion.id]
  );
  const rubricsRes = await client.query(
    `SELECT *
     FROM public.rubrics
     WHERE (tenant_id = $1::uuid OR is_system = TRUE)
       AND deleted_at IS NULL;`,
    [tenantId]
  );
  const companiesRes = await client.query(
    `SELECT id, corporate_name, cnpj, labor_config, tax_regime, negative_net_policy,
            cprb_gross_revenue_exempt, cprb_gross_revenue_total, cprb_reoneration_year
     FROM public.companies
     WHERE tenant_id = $1::uuid AND deleted_at IS NULL;`,
    [tenantId]
  );

  const { rows: cctRows } = await client.query(
    `SELECT ca.*, u.code AS union_code, u.name AS union_name, u.cnpj AS union_cnpj, u.base_month
     FROM public.collective_agreements ca
     JOIN public.unions u ON u.id = ca.union_id
     WHERE ca.tenant_id = $1::uuid
       AND ca.deleted_at IS NULL;`,
    [tenantId]
  );
  const collectiveAgreementsById = new Map<string, any>();
  for (const ca of cctRows) {
    collectiveAgreementsById.set(ca.id, ca);
  }

  const inss_parameters = inssRes.rows.map((r: any) => ({
    bracket_number: Number(r.bracket_number),
    base_limit: Number(r.base_limit),
    aliquot: Number(r.aliquot),
    deduction: 0,
  }));
  const irrf_parameters = irrfRes.rows.map((r: any) => ({
    bracket_number: Number(r.bracket_number),
    base_limit: r.base_limit !== null ? Number(r.base_limit) : null,
    aliquot: Number(r.aliquot),
    deduction: Number(r.deduction),
  }));
  const rawGen = genRes.rows[0] || null;
  const general_legal_parameters = rawGen
    ? {
        minimum_wage: Number(rawGen.minimum_wage),
        inss_ceiling: Number(rawGen.inss_ceiling),
        dependent_deduction: Number(rawGen.dependent_deduction),
        simplified_discount: Number(rawGen.simplified_discount),
        family_salary_ceiling: Number(rawGen.family_salary_ceiling),
        family_salary_value: Number(rawGen.family_salary_value),
        fgts_standard_aliquot: Number(rawGen.fgts_standard_aliquot),
        fgts_apprentice_aliquot: Number(rawGen.fgts_apprentice_aliquot),
        irrf_exemption_limit:
          rawGen.irrf_exemption_limit !== null && rawGen.irrf_exemption_limit !== undefined
            ? Number(rawGen.irrf_exemption_limit)
            : undefined,
        irrf_reduction_formula_limit:
          rawGen.irrf_reduction_formula_limit !== null && rawGen.irrf_reduction_formula_limit !== undefined
            ? Number(rawGen.irrf_reduction_formula_limit)
            : undefined,
        irrf_reduction_a:
          rawGen.irrf_reduction_a !== null && rawGen.irrf_reduction_a !== undefined
            ? Number(rawGen.irrf_reduction_a)
            : undefined,
        irrf_reduction_b:
          rawGen.irrf_reduction_b !== null && rawGen.irrf_reduction_b !== undefined
            ? Number(rawGen.irrf_reduction_b)
            : undefined,
      }
    : null;

  validateAllLegalTables({
    version: { ...activeVersion, version_name: activeVersion.code },
    inssBrackets: inss_parameters,
    irrfBrackets: irrf_parameters,
    generalParams: general_legal_parameters,
    periodMonth: period.month,
    periodYear: period.year,
  });

  // 4. Rubricas ativas e vigentes
  const rubricContext: RubricContext =
    period.type === 'VACATION'
      ? 'VACATION'
      : ['13TH', 'THIRTEENTH_1', 'THIRTEENTH_2', 'THIRTEENTH_SINGLE', 'THIRTEENTH_COMPLEMENTARY'].includes(period.type)
        ? 'THIRTEENTH'
        : period.type === 'TERMINATION'
          ? 'TERMINATION'
          : 'MONTHLY';

  const rubricas: Rubric[] = rubricsRes.rows
    .filter((r: any) =>
      isRubricEligibleForCalculation(
        r.status || 'ACTIVE',
        endDate,
        toDateStr(r.valid_from) || null,
        toDateStr(r.valid_to) || null,
        periodStartDate
      )
    )
    .map((r: any) => mapDbRubricToEngine(r, rubricContext));

  const rubricsById = new Map<string, Rubric>();
  const rubricsByCode = new Map<string, Rubric>();
  for (const r of rubricas) {
    rubricsById.set(r.id, r);
    if (r.code) rubricsByCode.set(r.code, r);
  }

  const targetCompany = companiesRes.rows.find((c: any) => c.id === companyId);
  const companyLaborConfig = targetCompany?.labor_config || {};
  const negativeNetPolicy: NegativeNetPolicy =
    targetCompany?.negative_net_policy ||
    companyLaborConfig.negative_net_policy ||
    'INSUFFICIENCY_CARRYOVER';
  const withholdIrrfOnAdvance = Boolean(companyLaborConfig.withhold_irrf_on_advance);
  const irrfRegime: 'CASH' | 'COMPETENCE' = period.irrf_regime === 'COMPETENCE' ? 'COMPETENCE' : 'CASH';
  const irrfBucket = resolveIrrfTaxationBucket(period.type);
  const paymentDate =
    toDateStr(period.payment_date) ||
    calculateDefaultPaymentDate(
      period.year,
      period.month,
      period.type,
      companyLaborConfig,
      dbHolidays.map((h: any) => toDateStr(h.date))
    );

  let baseApplicableRubrics: Rubric[] = rubricas;
  if (period.type === 'ADVANCE') {
    const rAdv = rubricsByCode.get('250');
    if (!rAdv) {
      throw new Error('Rubrica de Adiantamento [250] ausente no catálogo.');
    }
    const rIrrf = rubricsByCode.get('902');
    const rAlimony = rubricsByCode.get('904') || rubricsByCode.get('804');
    baseApplicableRubrics = [
      rAdv,
      ...(withholdIrrfOnAdvance && irrfRegime === 'CASH' && rIrrf ? [rIrrf] : []),
      ...(rAlimony ? [rAlimony] : []),
    ];
  } else if (period.type === 'VACATION') {
    baseApplicableRubrics = rubricas.filter((r) => {
      if (r.rubric_kind === 'FAMILY_SALARY') return false;
      return ['501', '502', '503', '504', '701', '702', '703', '704', '705', '706', '707', '601', '901', '902', '903', '904', '804'].includes(r.code);
    });
  } else if (period.type === 'THIRTEENTH_1') {
    baseApplicableRubrics = rubricas.filter((r) => ['601', '604', '903'].includes(r.code));
  } else if (period.type === 'THIRTEENTH_2' || period.type === 'THIRTEENTH_SINGLE') {
    baseApplicableRubrics = rubricas.filter((r) => ['602', '603', '604', '607', '609', '901', '902', '903', '904', '804'].includes(r.code));
  } else if (period.type === 'THIRTEENTH_COMPLEMENTARY') {
    baseApplicableRubrics = rubricas.filter((r) => ['605', '606', '901', '902', '903', '904', '804'].includes(r.code));
  } else {
    baseApplicableRubrics = rubricas.filter((r) => {
      const c = r.code || '';
      const n = (r.name || '').toLowerCase();
      if (['601', '602', '603', '701', '702', '703', '704'].includes(c)) return false;
      if (n.includes('férias') || n.includes('13º') || n.includes('décimo terceiro')) return false;
      return true;
    });
  }

  // 5. Dados complementares por contrato e trabalhador
  let fixedEvents: any[] = [];
  let variableEvents: any[] = [];
  let employeeBenefits: any[] = [];
  let benefitDependentsRows: any[] = [];
  let copaymentsRows: any[] = [];
  let employeeDeductions: any[] = [];
  let alimonyBeneficiaries: any[] = [];
  let contractLeavesRaw: any[] = [];
  let employeeLoans: any[] = [];
  let employeeDebts: any[] = [];
  let allDependents: any[] = [];
  let existingCompetencePayslips: any[] = [];
  let otherEmploymentsRows: any[] = [];
  let groupCpfPayslipsRows: any[] = [];
  let advancePayslips: any[] = [];
  let intermittentCallsRows: any[] = [];
  const thirteenthAdvancesByContract: Record<string, { amount: number; fgtsBase: number }> = {};
  const thirteenthSecondByContract = new Map<
    string,
    { gross: number; inss: number; irrf: number; fgtsBase: number; alimony: number; avos: number }
  >();
  const absencesByContractAndMonth = new Map<string, Record<number, number>>();

  if (contractIds.length > 0) {
    const feRes = await client.query(
      `SELECT * FROM public.payroll_fixed_events
       WHERE tenant_id = $1::uuid
         AND contract_id = ANY($2::uuid[])
         AND is_active = TRUE
         AND valid_from <= $3::date
         AND (valid_to IS NULL OR valid_to >= $4::date);`,
      [tenantId, contractIds, endDate, periodStartDate]
    );
    const veRes = await client.query(
      `SELECT * FROM public.payroll_variable_events
       WHERE tenant_id = $1::uuid
         AND payroll_period_id = $2::uuid
         AND contract_id = ANY($3::uuid[]);`,
      [tenantId, periodId, contractIds]
    );
    const ebRes = await client.query(
      `SELECT eb.*, bc.rubric_id, bc.max_deduction_percentage, bc.benefit_type, bc.ans_code, bc.discount_rule
       FROM public.employee_benefits eb
       JOIN public.benefit_catalogs bc ON bc.id = eb.benefit_catalog_id
       WHERE eb.tenant_id = $1::uuid
         AND eb.contract_id = ANY($2::uuid[])
         AND eb.is_active = TRUE
         AND eb.start_date <= $3::date
         AND (eb.end_date IS NULL OR eb.end_date >= $4::date);`,
      [tenantId, contractIds, endDate, periodStartDate]
    );

    const ebIds = ebRes.rows.map((r: any) => r.id);
    if (ebIds.length > 0) {
      const ebdRes = await client.query(
        `SELECT * FROM public.employee_benefit_dependents
         WHERE tenant_id = $1::uuid
           AND employee_benefit_id = ANY($2::uuid[])
           AND is_active = TRUE
           AND deleted_at IS NULL;`,
        [tenantId, ebIds]
      );
      benefitDependentsRows = ebdRes.rows;
    }

    const copayRes = await client.query(
      `SELECT * FROM public.benefit_copayments
       WHERE tenant_id = $1::uuid
         AND payroll_period_id = $2::uuid
         AND contract_id = ANY($3::uuid[])
         AND status IN ('PENDING', 'DEDUCTED')
         AND deleted_at IS NULL;`,
      [tenantId, periodId, contractIds]
    );
    copaymentsRows = copayRes.rows;
    const dedRes = await client.query(
      `SELECT * FROM public.employee_deductions
       WHERE tenant_id = $1::uuid
         AND contract_id = ANY($2::uuid[])
         AND is_active = TRUE
         AND deleted_at IS NULL;`,
      [tenantId, contractIds]
    );
    const alimRes = await client.query(
      `SELECT * FROM public.alimony_beneficiaries
       WHERE tenant_id = $1::uuid
         AND contract_id = ANY($2::uuid[])
         AND is_active = TRUE
         AND deleted_at IS NULL
       ORDER BY created_at ASC;`,
      [tenantId, contractIds]
    );
    const loanRes = await client.query(
      `SELECT * FROM public.payroll_loans
       WHERE tenant_id = $1::uuid
         AND contract_id = ANY($2::uuid[])
         AND is_active = TRUE
         AND (status IS NULL OR status = 'ACTIVE')
         AND paid_installments < total_installments;`,
      [tenantId, contractIds]
    );
    const debtsRes = await client.query(
      `SELECT * FROM public.employee_balance_debts
       WHERE tenant_id = $1::uuid
         AND contract_id = ANY($2::uuid[])
         AND status IN ('PENDING', 'PARTIALLY_DEDUCTED')
         AND (
           target_year < $3
           OR (target_year = $3 AND target_month <= $4)
         )
       ORDER BY competence_year ASC, competence_month ASC;`,
      [tenantId, contractIds, period.year, period.month]
    );
    const leavesRes = await client.query(
      `SELECT id, contract_id, leave_type, esocial_reason_code, start_date, end_date,
              return_date, cid10_code, is_inss_responsible, is_same_cid_relapse,
              parent_leave_id, is_extended_maternity, status,
              COALESCE(inss_annual_bonus_amount, 0)::numeric AS inss_annual_bonus_amount
       FROM public.leaves
       WHERE tenant_id = $1::uuid
         AND contract_id = ANY($2::uuid[])
         AND status <> 'CANCELLED'
         AND start_date <= $3::date
       ORDER BY start_date ASC;`,
      [tenantId, contractIds, endDate]
    );

    fixedEvents = feRes.rows;
    variableEvents = veRes.rows;
    employeeBenefits = ebRes.rows;
    employeeDeductions = dedRes.rows;
    alimonyBeneficiaries = alimRes.rows;
    contractLeavesRaw = leavesRes.rows;
    employeeLoans = loanRes.rows;
    employeeDebts = debtsRes.rows;

    if (
      period.type !== 'THIRTEENTH_1' &&
      period.type !== 'THIRTEENTH_2' &&
      period.type !== 'THIRTEENTH_SINGLE' &&
      period.type !== 'THIRTEENTH_COMPLEMENTARY'
    ) {
      const { rows: otherRows } = await client.query(
        `SELECT ps.contract_id, ps.base_inss
         FROM public.payslips ps
         JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
         WHERE ps.tenant_id = $1::uuid
           AND ps.contract_id = ANY($2::uuid[])
           AND pp.year = $3
           AND pp.month = $4
           AND pp.id <> $5::uuid
           AND pp.type IN ('MONTHLY', 'VACATION', 'COMPLEMENTARY')
           AND pp.status IN ('CLOSED', 'APPROVED', 'CALCULATED');`,
        [tenantId, contractIds, period.year, period.month, periodId]
      );
      existingCompetencePayslips = otherRows;
    }

    // FOLHA-06: Consolida outras matrículas do mesmo CPF em outras empresas/períodos do grupo econômico
    const cleanCpfSet = new Set(
      contracts
        .map((c: any) => String(c.worker_cpf || '').replace(/\D/g, ''))
        .filter((cpf: string) => cpf.length > 0)
    );
    if (cleanCpfSet.size > 0 && period.type !== 'ADVANCE' && period.type !== 'THIRTEENTH_1') {
      const is13thPeriod = ['THIRTEENTH_2', 'THIRTEENTH_SINGLE', 'THIRTEENTH_COMPLEMENTARY'].includes(period.type);
      const targetPeriodTypes = is13thPeriod
        ? ['THIRTEENTH_2', 'THIRTEENTH_SINGLE', 'THIRTEENTH_COMPLEMENTARY']
        : ['MONTHLY', 'VACATION', 'COMPLEMENTARY'];
      const { rows: groupRows } = await client.query(
        `SELECT ps.contract_id, ps.payroll_period_id, ps.base_inss,
                w.cpf AS worker_cpf, c.registration_number, co.cnpj AS company_cnpj, co.corporate_name AS company_name,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '901'), 0) AS inss_withheld
         FROM public.payroll_periods pp
         JOIN public.payslips ps ON ps.payroll_period_id = pp.id
         JOIN public.contracts c ON c.id = ps.contract_id
         JOIN public.workers w ON w.id = c.worker_id
         LEFT JOIN public.companies co ON co.id = c.company_id
         WHERE pp.tenant_id = $1::uuid
           AND pp.year = $2
           AND ($3::boolean OR pp.month = $4)
           AND pp.type = ANY($5::text[])
           AND pp.status IN ('CLOSED', 'APPROVED', 'CALCULATED')
           AND (
             pp.id <> $6::uuid
             OR ($7::uuid IS NOT NULL AND ps.contract_id <> $7::uuid)
           );`,
        [
          tenantId,
          period.year,
          is13thPeriod,
          period.month,
          targetPeriodTypes,
          periodId,
          contractIdFilter,
        ]
      );
      groupCpfPayslipsRows = groupRows.filter((r: any) =>
        cleanCpfSet.has(String(r.worker_cpf || '').replace(/\D/g, ''))
      );
    }

    if (period.type === 'MONTHLY') {
      const { rows: advRows } = await client.query(
        `SELECT ps.contract_id, ps.total_earnings
         FROM public.payslips ps
         JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
         WHERE ps.tenant_id = $1::uuid
           AND ps.contract_id = ANY($2::uuid[])
           AND pp.type = 'ADVANCE'
           AND pp.month = $3
           AND pp.year = $4
           AND pp.status IN ('CLOSED', 'APPROVED', 'CALCULATED');`,
        [tenantId, contractIds, period.month, period.year]
      );
      advancePayslips = advRows;
    }

    if (['THIRTEENTH_1', 'THIRTEENTH_2', 'THIRTEENTH_SINGLE'].includes(period.type)) {
      const { rows: thAdvRows } = await client.query(
        `SELECT ps.contract_id, pi.amount, ps.base_fgts, pp.type AS period_type
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
         WHERE ps.tenant_id = $1::uuid
           AND ps.contract_id = ANY($2::uuid[])
           AND pp.year = $3
           AND pp.id <> $4::uuid
           AND pp.type IN ('THIRTEENTH_1', 'VACATION')
           AND pp.status IN ('CLOSED', 'APPROVED', 'CALCULATED')
           AND pi.rubric_code IN ('601', '602', '405', '604');`,
        [tenantId, contractIds, period.year, periodId]
      );
      for (const row of thAdvRows) {
        if (!thirteenthAdvancesByContract[row.contract_id]) {
          thirteenthAdvancesByContract[row.contract_id] = { amount: 0, fgtsBase: 0 };
        }
        const advAmount = Number(row.amount || 0);
        thirteenthAdvancesByContract[row.contract_id].amount = addMoney(
          thirteenthAdvancesByContract[row.contract_id].amount,
          advAmount
        );
        thirteenthAdvancesByContract[row.contract_id].fgtsBase = addMoney(
          thirteenthAdvancesByContract[row.contract_id].fgtsBase,
          advAmount
        );
      }
    }

    if (period.type === 'MONTHLY') {
      const { rows: intRows } = await client.query(
        `SELECT * FROM public.intermittent_calls
         WHERE tenant_id = $1::uuid
           AND contract_id = ANY($2::uuid[])
           AND status IN ('ACCEPTED', 'COMPLETED')
           AND work_start_date <= $3::date
           AND work_end_date >= $4::date;`,
        [tenantId, contractIds, endDate, periodStartDate]
      );
      intermittentCallsRows = intRows;
    }

    if (['THIRTEENTH_1', 'THIRTEENTH_2', 'THIRTEENTH_SINGLE', 'THIRTEENTH_COMPLEMENTARY'].includes(period.type)) {
      const target13Year = period.type === 'THIRTEENTH_COMPLEMENTARY' ? period.year - 1 : period.year;
      const { rows: absRows } = await client.query(
        `SELECT ps.contract_id, pp.month, COALESCE(SUM(pi.reference), 0) AS faltas
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
         WHERE ps.tenant_id = $1::uuid
           AND ps.contract_id = ANY($2::uuid[])
           AND pp.year = $3
           AND pp.type IN ('MONTHLY', 'COMPLEMENTARY')
           AND pp.status IN ('CLOSED', 'APPROVED', 'CALCULATED')
           AND pi.rubric_code = '801'
         GROUP BY ps.contract_id, pp.month;`,
        [tenantId, contractIds, target13Year]
      );
      for (const r of absRows) {
        const cur = absencesByContractAndMonth.get(r.contract_id) || {};
        cur[Number(r.month)] = Number(cur[Number(r.month)] || 0) + Number(r.faltas || 0);
        absencesByContractAndMonth.set(r.contract_id, cur);
      }

      if (period.type === 'THIRTEENTH_COMPLEMENTARY') {
        const { rows: prev13Rows } = await client.query(
          `SELECT ps.contract_id, ps.base_fgts,
                  COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code IN ('602', '604')), 0) AS gross_13_2,
                  COALESCE((SELECT MAX(pi.reference) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code IN ('602', '601')), 12) AS avos_13_2,
                  COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '901'), 0) AS inss_13,
                  COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '902'), 0) AS irrf_13,
                  COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code IN ('904', '804')), 0) AS alimony_13
           FROM public.payslips ps
           JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
           WHERE ps.tenant_id = $1::uuid
             AND ps.contract_id = ANY($2::uuid[])
             AND pp.year = $3
             AND pp.type IN ('THIRTEENTH_2', 'THIRTEENTH_SINGLE')
             AND pp.status IN ('CLOSED', 'APPROVED', 'CALCULATED');`,
          [tenantId, contractIds, target13Year]
        );
        for (const r of prev13Rows) {
          thirteenthSecondByContract.set(r.contract_id, {
            gross: Number(r.gross_13_2 || 0),
            inss: Number(r.inss_13 || 0),
            irrf: Number(r.irrf_13 || 0),
            fgtsBase: Number(r.base_fgts || r.gross_13_2 || 0),
            alimony: Number(r.alimony_13 || 0),
            avos: Number(r.avos_13_2 || 12),
          });
        }
      }
    }
  }

  if (workerIds.length > 0) {
    const { rows: depRows } = await client.query(
      `SELECT * FROM public.dependents
       WHERE tenant_id = $1::uuid
         AND worker_id = ANY($2::uuid[])
         AND deleted_at IS NULL;`,
      [tenantId, workerIds]
    );
    allDependents = depRows;

    const targetMvMonth = ['THIRTEENTH_2', 'THIRTEENTH_SINGLE'].includes(period.type) ? 13 : period.month;
    const { rows: mvRows } = await client.query(
      `SELECT * FROM public.employee_other_employments
       WHERE tenant_id = $1::uuid
         AND worker_id = ANY($2::uuid[])
         AND deleted_at IS NULL
         AND is_active = TRUE
         AND (
           (competence_year = $3 AND competence_month = $4)
           OR (
             $4 BETWEEN 1 AND 12
             AND is_recurring = TRUE
             AND (competence_year < $3 OR (competence_year = $3 AND competence_month <= $4))
           )
         )
       ORDER BY competence_year DESC, competence_month DESC, created_at ASC;`,
      [tenantId, workerIds, period.year, targetMvMonth]
    );
    otherEmploymentsRows = mvRows;
  }

  // FOLHA-02: Carrega histórico do mesmo mês de caixa (payment_date) para o bucket MONTHLY_CASH
  let priorCashIrrfRows: any[] = [];
  let historicalAveragesByContract = new Map<string, HistoricalRubricEntry[]>();

  if (
    contractIds.length > 0 &&
    ['VACATION', 'THIRTEENTH_1', 'THIRTEENTH_2', 'THIRTEENTH_SINGLE', 'THIRTEENTH_COMPLEMENTARY', 'TERMINATION'].includes(period.type)
  ) {
    const is13thComp = period.type === 'THIRTEENTH_COMPLEMENTARY';
    const refYear = is13thComp ? period.year - 1 : period.year;
    const refMonth = is13thComp ? 12 : period.month;
    const fromIdx = refYear * 12 + (refMonth - 1) - 23;
    const fromYear = Math.floor(fromIdx / 12);
    const fromMonth = (fromIdx % 12) + 1;
    historicalAveragesByContract = await loadHistoricalAveragesItems(client, {
      tenantId,
      contractIds,
      fromYear,
      fromMonth,
      toYear: refYear,
      toMonth: refMonth,
    });
  }
  if (irrfRegime === 'CASH' && irrfBucket === 'MONTHLY_CASH' && workerIds.length > 0) {
    const cashYear = Number(paymentDate.slice(0, 4));
    const cashMonth = Number(paymentDate.slice(5, 7));
    const { rows: ledgerRows } = await client.query(
      `SELECT l.worker_id, l.gross_taxable, l.inss_deducted, l.alimony_deducted, l.irrf_withheld
       FROM public.irrf_cash_ledger l
       JOIN public.payroll_periods pp ON pp.id = l.period_id
       WHERE l.tenant_id = $1::uuid
         AND l.worker_id = ANY($2::uuid[])
         AND l.cash_year = $3
         AND l.cash_month = $4
         AND l.taxation_bucket = 'MONTHLY_CASH'
         AND l.period_id <> $5::uuid
         AND pp.status IN ('CLOSED', 'APPROVED', 'CALCULATED');`,
      [tenantId, workerIds, cashYear, cashMonth, periodId]
    );
    priorCashIrrfRows = ledgerRows;
  }

  const contractCompanyMap: Record<string, string> = {};
  const companiesById = new Map<string, any>();
  for (const co of companiesRes.rows) {
    companiesById.set(co.id, co);
  }
  for (const c of contracts) {
    if (c.id && c.company_id) {
      contractCompanyMap[c.id] = c.company_id;
      const co = companiesById.get(c.company_id);
      if (co) {
        c.company_cnpj = co.cnpj;
        c.company_name = co.corporate_name;
      }
    }
  }

  const advancePayslipByContract = new Map<string, any>();
  for (const adv of advancePayslips) {
    advancePayslipByContract.set(adv.contract_id, adv);
  }

  // Deduplica vínculos externos por worker + employer_cnpj (dando preferência ao registro da competência exata sobre is_recurring)
  const otherEmploymentsByWorker = new Map<string, OtherEmploymentInput[]>();
  const seenExternalByWorkerCnpj = new Set<string>();
  for (const row of otherEmploymentsRows) {
    const cnpjClean = String(row.employer_cnpj || '').replace(/\D/g, '');
    const dedupKey = `${row.worker_id}|${cnpjClean}`;
    if (seenExternalByWorkerCnpj.has(dedupKey)) continue;
    seenExternalByWorkerCnpj.add(dedupKey);
    const list = otherEmploymentsByWorker.get(row.worker_id) || [];
    list.push({
      id: row.id,
      employer_cnpj: row.employer_cnpj,
      employer_name: row.employer_name,
      esocial_category_code: row.esocial_category_code || '101',
      ind_mv: Number(row.ind_mv) as 1 | 2 | 3,
      remuneration_amount: Number(row.remuneration_amount || 0),
      inss_withheld: Number(row.inss_withheld || 0),
      source: 'EXTERNAL_EMPLOYER',
    });
    otherEmploymentsByWorker.set(row.worker_id, list);
  }

  // Mapa de bases de outras matrículas do mesmo CPF em outros períodos do grupo econômico
  const groupInssByCpfAndContract = new Map<string, Map<string, OtherEmploymentInput[]>>();
  for (const g of groupCpfPayslipsRows) {
    const cpfClean = String(g.worker_cpf || '').replace(/\D/g, '');
    if (!cpfClean || Number(g.base_inss || 0) <= 0) continue;
    let byContract = groupInssByCpfAndContract.get(cpfClean);
    if (!byContract) {
      byContract = new Map();
      groupInssByCpfAndContract.set(cpfClean, byContract);
    }
    const list = byContract.get(g.contract_id) || [];
    list.push({
      id: g.contract_id,
      employer_cnpj: g.company_cnpj || undefined,
      employer_name: `${g.company_name || 'Grupo'} (Mat. ${g.registration_number || ''})`.trim(),
      esocial_category_code: '101',
      ind_mv: 1,
      remuneration_amount: Number(g.base_inss || 0),
      inss_withheld: Number(g.inss_withheld || 0),
      source: 'INTERNAL_GROUP_CONTRACT',
    });
    byContract.set(g.contract_id, list);
  }

  return {
    tenantId,
    periodId,
    period,
    companyId,
    periodStartDate,
    endDate,
    daysInMonth,
    contracts,
    contractCompanyMap,
    companies: companiesRes.rows,
    activeVersion,
    inss_parameters,
    irrf_parameters,
    general_legal_parameters,
    rubricas,
    rubricsById,
    rubricsByCode,
    baseApplicableRubrics,
    dbHolidays,
    calendarCache: new Map(),
    fixedEventsByContract: groupByKey(fixedEvents, (r) => r.contract_id),
    variableEventsByContract: groupByKey(variableEvents, (r) => r.contract_id),
    benefitsByContract: groupByKey(employeeBenefits, (r) => r.contract_id),
    benefitDependentsByBenefitId: groupByKey(benefitDependentsRows, (r) => r.employee_benefit_id),
    copaymentsByContract: groupByKey(copaymentsRows, (r) => r.contract_id),
    deductionsByContract: groupByKey(employeeDeductions, (r) => r.contract_id),
    alimonyBeneficiariesByContract: groupByKey(alimonyBeneficiaries, (r) => r.contract_id),
    leavesByContract: groupByKey(
      contractLeavesRaw.map((l: any) => ({
        ...l,
        start_date: toDateStr(l.start_date),
        end_date: toDateStr(l.end_date) || null,
        return_date: toDateStr(l.return_date) || null,
      })),
      (r) => r.contract_id
    ),
    loansByContract: groupByKey(employeeLoans, (r) => r.contract_id),
    debtsByContract: groupByKey(employeeDebts, (r) => r.contract_id),
    negativeNetPolicy,
    collectiveAgreementsById,
    dependentsByWorker: groupByKey(allDependents, (r) => r.worker_id),
    vacSchedulesByContract: groupByKey(vacSchedules, (r) => r.contract_id),
    existingCompetencePayslipsByContract: groupByKey(existingCompetencePayslips, (r) => r.contract_id),
    groupInssByCpfAndContract,
    otherEmploymentsByWorker,
    advancePayslipByContract,
    thirteenthAdvancesByContract,
    thirteenthSecondByContract,
    absencesByContractAndMonth,
    paymentDate,
    irrfRegime,
    withholdIrrfOnAdvance,
    irrfBucket,
    priorCashIrrfByWorker: groupByKey(priorCashIrrfRows, (r) => r.worker_id).size > 0
      ? new Map(
          Array.from(groupByKey(priorCashIrrfRows, (r) => r.worker_id).entries()).map(([wid, rows]) => [
            wid,
            rows.map((r: any) => ({
              gross_taxable: Number(r.gross_taxable || 0),
              inss_deducted: Number(r.inss_deducted || 0),
              alimony_deducted: Number(r.alimony_deducted || 0),
              irrf_withheld: Number(r.irrf_withheld || 0),
            })),
          ])
        )
      : new Map(),
    historicalAveragesByContract,
    intermittentCallsByContract: groupByKey(intermittentCallsRows, (r) => r.contract_id),
  };
}

function getCalendarDaysForContract(
  data: LoadedPeriodCalculationData,
  contract: any
): { diasUteis: number; diasInuteis: number } {
  const cacheKey = `${contract.company_id || ''}|${contract.workplace_state_code || ''}|${contract.workplace_city_code || ''}`;
  const cached = data.calendarCache.get(cacheKey);
  if (cached) return cached;

  const applicableHolidaysSet = new Set<string>();
  for (const h of data.dbHolidays) {
    const hDate = toDateStr(h.date);
    if (h.company_id && h.company_id !== contract.company_id) continue;
    if (h.type === 'NATIONAL') {
      applicableHolidaysSet.add(hDate);
    } else if (h.type === 'STATE' && h.state_code && h.state_code === contract.workplace_state_code) {
      applicableHolidaysSet.add(hDate);
    } else if (h.type === 'MUNICIPAL' && h.city_code && h.city_code === contract.workplace_city_code) {
      applicableHolidaysSet.add(hDate);
    } else if (!h.state_code && !h.city_code && h.company_id === contract.company_id) {
      applicableHolidaysSet.add(hDate);
    }
  }

  let diasUteis = 0;
  let diasInuteis = 0;
  for (let day = 1; day <= data.daysInMonth; day++) {
    const dt = new Date(Date.UTC(data.period.year, data.period.month - 1, day));
    const dStr = formatDate(data.period.year, data.period.month, day);
    if (dt.getUTCDay() === 0 || applicableHolidaysSet.has(dStr)) {
      diasInuteis++;
    } else {
      diasUteis++;
    }
  }

  const res = { diasUteis, diasInuteis };
  data.calendarCache.set(cacheKey, res);
  return res;
}

/**
 * Executa o motor puro para 1 contrato com suporte opcional a override de cenário What-If.
 */
export async function calculateSingleContract(
  data: LoadedPeriodCalculationData,
  contract: any,
  scenarioOverride?: WhatIfScenarioParams | null,
  intraBatchOtherContractsByCpf?: Map<string, OtherEmploymentInput[]>
): Promise<SingleContractCalculationOutcome> {
  const { period, general_legal_parameters, rubricas, rubricsById, rubricsByCode, activeVersion } = data;

  const admissionStr = toDateStr(contract.admission_date);
  if (shouldSkipFutureAdmission(admissionStr, period.year, period.month)) {
    return { skipped: true };
  }

  const scenarioApplies = Boolean(scenarioOverride && isContractEligibleForScenario(contract, scenarioOverride));
  const rawBaseSalary = Number(contract.base_salary || 0);
  const baseSalary = scenarioApplies
    ? applyScenarioToBaseSalary(rawBaseSalary, scenarioOverride)
    : rawBaseSalary;

  const cct = contract.collective_agreement_id
    ? data.collectiveAgreementsById?.get(contract.collective_agreement_id)
    : null;

  const eventos: any[] = [];
  let applicableRubrics = data.baseApplicableRubrics;
  let fgtsBaseAlreadyTaxed = 0;
  let inssBaseAlreadyTaxedOverride: number | null = null;
  let vacationInssBaseOverride: number | null = null;
  let vacationFgtsBaseOverride: number | null = null;
  let priorThirteenthIrrfEntry: PriorIrrfCashEntry | null = null;
  const contractLeaves = data.leavesByContract.get(contract.id) || [];
  let leaveImpact: LeavePeriodImpactResult | null = null;
  let maternityDeduction = 0;
  let diasTrabalhados = calculateWorkingDays(admissionStr, period.year, period.month);

  if (period.type === 'MONTHLY') {
    const rawVacs = data.vacSchedulesByContract.get(contract.id) || [];
    if (rawVacs.length > 0) {
      const contractVacations = rawVacs.map((v: any) => ({
        id: v.id,
        contract_id: v.contract_id,
        start_date: toDateStr(v.start_date),
        end_date: toDateStr(v.end_date),
        days_taken: Number(v.days_count),
        status: 'APPROVED_DP',
      }));
      if (isVacationCrossingMonth(contractVacations[0].start_date, contractVacations[0].end_date, period.year, period.month)) {
        const vacRes = calculateVacationDaysInMonth(contractVacations, period.year, period.month, diasTrabalhados);
        diasTrabalhados = vacRes.remainingWorkedDays;
      }
    }
  }

  if (period.type === 'MONTHLY' || period.type === 'COMPLEMENTARY') {
    leaveImpact = LeaveImpactCalculator.calculatePeriodImpact({
      leaves: contractLeaves,
      periodYear: period.year,
      periodMonth: period.month,
      baseEligibleDays: diasTrabalhados,
      baseSalary,
    });
    diasTrabalhados = leaveImpact.workedSalaryDays;
  }

  const hasZeroCompanyPaidDaysInMonth = Boolean(
    leaveImpact &&
      leaveImpact.appliedLeaveIds.length > 0 &&
      diasTrabalhados === 0 &&
      leaveImpact.companyPaidSickDays === 0 &&
      leaveImpact.maternityDeductibleDays + leaveImpact.maternityExtendedDays === 0
  );

  if (period.type === 'ADVANCE') {
    if (contract.receives_advance === false) return { skipped: true };
    const rAdv = applicableRubrics[0];
    const advPct = Number(contract.advance_percentage ?? rAdv.percentage ?? 40);
    eventos.push({
      rubric_id: rAdv.id,
      manual_value: round2(baseSalary * (advPct / 100)),
      quantity: 1,
    });
  } else if (period.type === 'VACATION') {
    const contractVacations = data.vacSchedulesByContract.get(contract.id) || [];
    if (contractVacations.length === 0) return { skipped: true };

    // BUG-01 + FOLHA-11: Base de férias soma salário base + adicionais fixos do contrato (CLT art. 142 §5º)
    let fixedAdditionals = 0;
    const contractFixedEvents = data.fixedEventsByContract.get(contract.id) || [];
    for (const fe of contractFixedEvents) {
      const rub = rubricsById.get(fe.rubric_id);
      if (rub && rub.type === 'EARNING') {
        if (fe.value_type === 'PERCENT') {
          const refBase =
            rub.calculation_base === 'SALARIO_MINIMO'
              ? Number(general_legal_parameters!.minimum_wage)
              : baseSalary;
          fixedAdditionals = addMoney(
            fixedAdditionals,
            round2(refBase * (Number(fe.percentage || 0) / 100))
          );
        } else {
          fixedAdditionals = addMoney(fixedAdditionals, Number(fe.amount || 0));
        }
      }
    }

    // FOLHA-10: Médias configuráveis de variáveis sobre férias (período aquisitivo / CCT)
    const primaryVac = contractVacations[0];
    const histEntries = data.historicalAveragesByContract?.get(contract.id) || [];
    const { diasUteis, diasInuteis } = getCalendarDaysForContract(data, contract);
    const averagesRes =
      histEntries.length > 0
        ? AveragesCalculator.calculate({
            target: 'VACATION',
            referenceYear: period.year,
            referenceMonth: period.month,
            currentHourlyBase: addMoney(baseSalary, fixedAdditionals),
            divisor: Number(contract.monthly_hours || 220),
            windowMode: (cct?.average_window_mode as AverageWindowMode) || 'ACQUISITIVE_OR_12M',
            windowMonths: Number(cct?.average_calculation_months || 12),
            acquisitiveStart: toDateStr(primaryVac.acquisition_start) || null,
            acquisitiveEnd: toDateStr(primaryVac.acquisition_end) || null,
            monthlyIndexRate: Number(cct?.average_monetary_index_rate || 0),
            diasUteis,
            diasInuteis,
            entries: histEntries,
          })
        : null;
    const vacAveragesAmount = averagesRes?.totalAverage || 0;

    const totalDaysTaken = contractVacations.reduce((acc: number, v: any) => acc + Number(v.days_count || 0), 0);
    const totalCashAllowanceDays = contractVacations.reduce(
      (acc: number, v: any) => acc + Number(v.sell_days_count || 0),
      0
    );
    const hasAdvance13th = contractVacations.some((v: any) => Boolean(v.wants_thirteenth_advance));

    const entVac = VacationEnterpriseCalculator.calculateEnterpriseVacation({
      baseSalary,
      fixedAdditionals,
      averagesAmount: vacAveragesAmount,
      daysTaken: totalDaysTaken,
      sellDaysCount: totalCashAllowanceDays,
      wantsThirteenthAdvance: hasAdvance13th,
      startDate: toDateStr(primaryVac.start_date),
      endDate: toDateStr(primaryVac.end_date),
      concessiveEndDate: toDateStr(primaryVac.concessive_end) || null,
    });

    const rVac = rubricsByCode.get('701') || rubricsByCode.get('501');
    const rVacThird = rubricsByCode.get('702') || rubricsByCode.get('502');
    const rVacAvg = rubricsByCode.get('707');
    const rVacDouble = rubricsByCode.get('705');
    const rVacDoubleThird = rubricsByCode.get('706');

    if (rVac && entVac.vacationGross > 0) {
      eventos.push({ rubric_id: rVac.id, manual_value: entVac.vacationGross, quantity: totalDaysTaken });

      if (rVacThird && entVac.vacationOneThird > 0) {
        eventos.push({ rubric_id: rVacThird.id, manual_value: entVac.vacationOneThird, quantity: 1 });
      }
    }

    if (rVacAvg && entVac.averagesVacationGross > 0) {
      eventos.push({ rubric_id: rVacAvg.id, manual_value: entVac.averagesVacationGross, quantity: totalDaysTaken });
    }

    if (rVacDouble && entVac.doubleVacationIndemnity > 0) {
      eventos.push({
        rubric_id: rVacDouble.id,
        manual_value: entVac.doubleVacationIndemnity,
        quantity: entVac.doubleInfo.doubleDays,
      });
      if (rVacDoubleThird && entVac.doubleVacationOneThirdIndemnity > 0) {
        eventos.push({
          rubric_id: rVacDoubleThird.id,
          manual_value: entVac.doubleVacationOneThirdIndemnity,
          quantity: 1,
        });
      }
    }

    if (totalCashAllowanceDays > 0) {
      const rAbono = rubricsByCode.get('703') || rubricsByCode.get('503');
      const rAbonoThird = rubricsByCode.get('704') || rubricsByCode.get('504');
      if (rAbono && entVac.abonoGross > 0) {
        eventos.push({ rubric_id: rAbono.id, manual_value: entVac.abonoGross, quantity: totalCashAllowanceDays });
        if (rAbonoThird && entVac.abonoOneThird > 0) {
          eventos.push({ rubric_id: rAbonoThird.id, manual_value: entVac.abonoOneThird, quantity: 1 });
        }
      }
    }

    if (hasAdvance13th && entVac.thirteenthAdvanceGross > 0) {
      const r13Adv = rubricsByCode.get('601');
      if (r13Adv) {
        eventos.push({ rubric_id: r13Adv.id, manual_value: entVac.thirteenthAdvanceGross, quantity: 1 });
      }
    }

    // Férias partidas entre dois meses: rateia INSS/FGTS para a competência atual mantendo IRRF integral no caixa
    if (entVac.monthSplits.length > 1) {
      const currentMonthSplit = entVac.monthSplits.find(
        (s) => s.year === period.year && s.month === period.month
      );
      if (currentMonthSplit) {
        vacationInssBaseOverride = currentMonthSplit.inssBaseShare;
        vacationFgtsBaseOverride = currentMonthSplit.fgtsBaseShare;
      }
    }
  } else if (
    period.type === 'THIRTEENTH_1' ||
    period.type === 'THIRTEENTH_2' ||
    period.type === 'THIRTEENTH_SINGLE' ||
    period.type === 'THIRTEENTH_COMPLEMENTARY'
  ) {
    const is13Comp = period.type === 'THIRTEENTH_COMPLEMENTARY';
    const is13Single = period.type === 'THIRTEENTH_SINGLE';
    const targetYear = is13Comp ? period.year - 1 : period.year;
    const upToMonth = is13Comp || is13Single ? 12 : period.month || 12;

    const monthlyNonCreditedLeaves = LeaveImpactCalculator.getMonthlyLeaveNonCreditedDaysForThirteenth(
      contractLeaves,
      targetYear,
      upToMonth
    );
    const monthlyAbsences = data.absencesByContractAndMonth?.get(contract.id) || {};
    const avosResult = calculateThirteenthAvos(
      admissionStr,
      targetYear,
      upToMonth,
      monthlyAbsences,
      monthlyNonCreditedLeaves
    );
    const avos = avosResult.totalAvos;

    // Súmula 347 TST: Base horária incorpora adicionais habituais fixos do contrato (insalubridade, periculosidade)
    let fixedAdditionals = 0;
    const contractFixedEvents = data.fixedEventsByContract.get(contract.id) || [];
    for (const fe of contractFixedEvents) {
      const rub = rubricsById.get(fe.rubric_id);
      if (rub && rub.type === 'EARNING') {
        if (fe.value_type === 'PERCENT') {
          const refBase =
            rub.calculation_base === 'SALARIO_MINIMO'
              ? Number(general_legal_parameters!.minimum_wage)
              : baseSalary;
          fixedAdditionals = addMoney(
            fixedAdditionals,
            round2(refBase * (Number(fe.percentage || 0) / 100))
          );
        } else {
          fixedAdditionals = addMoney(fixedAdditionals, Number(fe.amount || 0));
        }
      }
    }

    // FOLHA-10 + FOLHA-12: Médias automáticas de variáveis do ano-base para 13º
    const histEntries = data.historicalAveragesByContract?.get(contract.id) || [];
    const { diasUteis, diasInuteis } = getCalendarDaysForContract(data, contract);
    const avg13Res =
      histEntries.length > 0
        ? AveragesCalculator.calculate({
            target: 'THIRTEENTH',
            referenceYear: targetYear,
            referenceMonth: upToMonth,
            currentHourlyBase: addMoney(baseSalary, fixedAdditionals),
            divisor: Number(contract.monthly_hours || 220),
            windowMode: 'CALENDAR_YEAR',
            monthsWorkedInWindow: avos > 0 ? avos : 12,
            monthlyIndexRate: Number(cct?.average_monetary_index_rate || 0),
            diasUteis,
            diasInuteis,
            entries: histEntries,
          })
        : null;
    const variableAverages = avg13Res?.totalAverage || 0;

    if (period.type === 'THIRTEENTH_1') {
      const r601 = rubricsByCode.get('601');
      const r604 = rubricsByCode.get('604');
      const includeAvgIn13th1 = cct?.include_averages_in_13th_first_installment ?? true;
      const effectiveAverages = includeAvgIn13th1 ? variableAverages : 0;

      const vals = calculateThirteenthValues(baseSalary, effectiveAverages, avos, 'THIRTEENTH_1');
      const priorAdvance = data.thirteenthAdvancesByContract[contract.id]?.amount || 0;

      if (r601 && avos > 0) {
        // Se já recebeu adiantamento anteriormente (ex: em férias), abate do valor da 1ª parcela
        const remainingToPay = Math.max(0, subtractMoney(vals.firstInstallmentGross, priorAdvance));
        if (remainingToPay > 0) {
          const basePortion = vals.firstInstallmentBase ?? round2((round2((baseSalary / 12) * avos)) / 2);
          const avgPortion = vals.firstInstallmentAverages ?? round2((round2((effectiveAverages / 12) * avos)) / 2);

          const payBase = Math.min(basePortion, remainingToPay);
          const payAvg = subtractMoney(remainingToPay, payBase);

          if (payBase > 0) {
            eventos.push({ rubric_id: r601.id, manual_value: payBase, quantity: avos });
          }
          if (payAvg > 0 && r604) {
            eventos.push({ rubric_id: r604.id, manual_value: payAvg, quantity: avos });
          } else if (payAvg > 0) {
            eventos.push({ rubric_id: r601.id, manual_value: remainingToPay, quantity: avos });
          }
        }
      }
    } else if (period.type === 'THIRTEENTH_2' || period.type === 'THIRTEENTH_SINGLE') {
      const advInfo = data.thirteenthAdvancesByContract[contract.id] || { amount: 0, fgtsBase: 0 };
      fgtsBaseAlreadyTaxed = advInfo.fgtsBase;

      const vals = calculateThirteenthValues(
        baseSalary,
        variableAverages,
        avos,
        period.type === 'THIRTEENTH_SINGLE' ? 'THIRTEENTH_SINGLE' : 'THIRTEENTH_2',
        advInfo.amount
      );

      // Proporcional 13º Salário-Maternidade dedutível na DCTFWeb (Decreto 3.048/99 art. 96)
      if (avos > 0 && contractLeaves.length > 0) {
        let maternity120DaysInYear = 0;
        for (let m = 1; m <= upToMonth; m++) {
          const mImpact = LeaveImpactCalculator.calculatePeriodImpact({
            leaves: contractLeaves,
            periodYear: targetYear,
            periodMonth: m,
            baseEligibleDays: 30,
            baseSalary,
          });
          maternity120DaysInYear += mImpact.maternityDeductibleDays;
        }
        if (maternity120DaysInYear > 0) {
          const maxMaternityRatio = Math.min(1, maternity120DaysInYear / 360);
          const calculatedMaternity = round2(vals.secondInstallmentGross * maxMaternityRatio);
          maternityDeduction = Math.min(vals.secondInstallmentGross, calculatedMaternity);
        }
      }

      // Súmula 46 TST: Complemento 13º Salário por Acidente de Trabalho (código eSocial 01 / WORK_ACCIDENT)
      const r607 = rubricsByCode.get('607');
      const r609 = rubricsByCode.get('609');
      const inssAbonoEvent = (data.variableEventsByContract.get(contract.id) || []).find(
        (e: any) => r609 && e.rubric_id === r609.id
      );
      const leaveBonusAmount = contractLeaves
        .filter((l: any) => resolveCanonicalLeaveCategory(l.leave_type, l.esocial_reason_code) === 'WORK_ACCIDENT')
        .reduce((sum: number, l: any) => sumMoney(sum, Number(l.inss_annual_bonus_amount || 0)), 0);
      const inssAnnualBonus = inssAbonoEvent
        ? Number(inssAbonoEvent.manual_value || inssAbonoEvent.amount || 0)
        : leaveBonusAmount;

      if (inssAnnualBonus > 0 && r607) {
        const compResult = calculateThirteenthWorkAccidentComplement({
          baseSalary,
          variableAverages,
          companyAvos: avos,
          inssAnnualBonusAmount: inssAnnualBonus,
        });
        if (compResult.complementAmount > 0) {
          eventos.push({ rubric_id: r607.id, manual_value: compResult.complementAmount, quantity: Math.max(0, 12 - avos) });
        }
      }

      const r602 = rubricsByCode.get('602');
      const r604 = rubricsByCode.get('604');
      const baseThirteenthOnly = round2((baseSalary / 12) * avos);
      const averagesThirteenthPortion = subtractMoney(vals.secondInstallmentGross, baseThirteenthOnly);

      if (r602 && avos > 0) {
        if (r604 && averagesThirteenthPortion > 0) {
          eventos.push({ rubric_id: r602.id, manual_value: baseThirteenthOnly, quantity: avos });
          eventos.push({ rubric_id: r604.id, manual_value: averagesThirteenthPortion, quantity: avos });
        } else {
          eventos.push({ rubric_id: r602.id, manual_value: vals.secondInstallmentGross, quantity: avos });
        }
      }
      if (vals.advanceDeduction > 0) {
        const r603 = rubricsByCode.get('603');
        if (r603) {
          eventos.push({ rubric_id: r603.id, manual_value: vals.advanceDeduction, quantity: 1 });
        }
      }
    } else {
      // THIRTEENTH_COMPLEMENTARY (Janeiro — Decreto 10.854/2021 art. 79)
      const prev2 = data.thirteenthSecondByContract?.get(contract.id);
      if (!prev2) {
        return { skipped: true };
      }
      const effectiveAvos = avos > 0 ? avos : prev2.avos;
      const recalculatedGross = round2(((baseSalary + variableAverages) / 12) * effectiveAvos);
      const diffGross = subtractMoney(recalculatedGross, prev2.gross);

      if (Math.abs(diffGross) < 0.01) {
        return { skipped: true };
      }

      inssBaseAlreadyTaxedOverride = prev2.gross;
      fgtsBaseAlreadyTaxed = prev2.fgtsBase;
      priorThirteenthIrrfEntry = {
        gross_taxable: prev2.gross,
        inss_deducted: prev2.inss,
        alimony_deducted: prev2.alimony,
        irrf_withheld: prev2.irrf,
      };

      if (diffGross > 0) {
        const r605 = rubricsByCode.get('605');
        if (r605) {
          eventos.push({ rubric_id: r605.id, manual_value: diffGross, quantity: effectiveAvos });
        }
      } else {
        const r606 = rubricsByCode.get('606');
        if (r606) {
          eventos.push({ rubric_id: r606.id, manual_value: Math.abs(diffGross), quantity: effectiveAvos });
        }
      }
    }
  } else {
    // Folha Mensal / Complementar (com suporte Multi-Regime FOLHA-15)
    const calcRegime = String(contract.calculation_regime || 'CLT').toUpperCase() as CalculationRegimeType;

    if (calcRegime === 'PRO_LABORE') {
      const r115 = rubricsByCode.get('115');
      if (r115) {
        eventos.push({ rubric_id: r115.id, quantity: 1, manual_value: baseSalary });
      }
    } else if (calcRegime === 'AUTONOMOUS_RPA') {
      const r116 = rubricsByCode.get('116');
      if (r116) {
        eventos.push({ rubric_id: r116.id, quantity: 1, manual_value: baseSalary });
      }
    } else if (calcRegime === 'INTERN') {
      const r117 = rubricsByCode.get('117');
      if (r117) {
        const propBolsa = diasTrabalhados < 30 ? round2((baseSalary / 30) * diasTrabalhados) : baseSalary;
        eventos.push({ rubric_id: r117.id, quantity: diasTrabalhados, manual_value: propBolsa });
      }
    } else if (calcRegime === 'INTERMITTENT') {
      const calls = data.intermittentCallsByContract?.get(contract.id) || [];
      let sumWorked = 0;
      let sumVacProp = 0;
      let sumVacThird = 0;
      let sum13Prop = 0;
      let sumDsr = 0;
      for (const cCall of calls) {
        sumWorked = addMoney(sumWorked, Number(cCall.gross_salary || 0));
        sumVacProp = addMoney(sumVacProp, Number(cCall.vacation_proportional || 0));
        sumVacThird = addMoney(sumVacThird, Number(cCall.vacation_third || 0));
        sum13Prop = addMoney(sum13Prop, Number(cCall.thirteenth_proportional || 0));
        sumDsr = addMoney(sumDsr, Number(cCall.dsr_amount || 0));
      }
      const r119 = rubricsByCode.get('119');
      const r120 = rubricsByCode.get('120');
      const r121 = rubricsByCode.get('121');
      const r122 = rubricsByCode.get('122');
      if (r119 && sumWorked > 0) eventos.push({ rubric_id: r119.id, quantity: 1, manual_value: sumWorked });
      if (r120 && addMoney(sumVacProp, sumVacThird) > 0) {
        eventos.push({ rubric_id: r120.id, quantity: 1, manual_value: addMoney(sumVacProp, sumVacThird) });
      }
      if (r121 && sum13Prop > 0) eventos.push({ rubric_id: r121.id, quantity: 1, manual_value: sum13Prop });
      if (r122 && sumDsr > 0) eventos.push({ rubric_id: r122.id, quantity: 1, manual_value: sumDsr });
    } else if (calcRegime === 'HOURLY' || calcRegime === 'DAILY') {
      const { diasUteis, diasInuteis } = getCalendarDaysForContract(data, contract);
      const varEvents = data.variableEventsByContract.get(contract.id) || [];
      const r101 = rubricsByCode.get('101');
      const r122 = rubricsByCode.get('122');
      const r101Var = r101 ? varEvents.find((v: any) => v.rubric_id === r101.id) : null;
      const units = r101Var && Number(r101Var.quantity || 0) > 0
        ? Number(r101Var.quantity)
        : calcRegime === 'HOURLY'
          ? Number(contract.monthly_hours || 220)
          : diasUteis;
      const unitRate =
        calcRegime === 'HOURLY'
          ? Number(contract.hourly_rate || baseSalary / (Number(contract.monthly_hours || 220)))
          : Number(contract.daily_rate || baseSalary / 30);

      const varCalc = MultiRegimeCalculator.calculateVariableBaseRemuneration({
        regime: calcRegime,
        unitsWorked: units,
        unitRate,
        diasUteis,
        diasInuteis,
      });
      if (r101 && varCalc.baseProduced > 0 && !r101Var) {
        eventos.push({ rubric_id: r101.id, quantity: units, manual_value: varCalc.baseProduced });
      }
      if (r122 && varCalc.dsrAmount > 0) {
        eventos.push({ rubric_id: r122.id, quantity: diasInuteis, manual_value: varCalc.dsrAmount });
      }
    } else if (calcRegime === 'COMMISSION_ONLY') {
      const { diasUteis, diasInuteis } = getCalendarDaysForContract(data, contract);
      const varEvents = data.variableEventsByContract.get(contract.id) || [];
      const commSum = varEvents
        .filter((v: any) => rubricsById.get(v.rubric_id)?.rubric_kind === 'COMMISSION' || rubricsById.get(v.rubric_id)?.category === 'COMMISSION')
        .reduce((acc: number, v: any) => addMoney(acc, Number(v.manual_value || 0)), 0);
      const floorGuarantee = Math.max(
        Number(cct?.base_salary_floor || 0),
        Number(general_legal_parameters?.minimum_wage || 0),
        baseSalary
      );
      const commCalc = MultiRegimeCalculator.calculateVariableBaseRemuneration({
        regime: 'COMMISSION_ONLY',
        unitsWorked: 0,
        unitRate: 0,
        commissionsTotal: commSum,
        diasUteis,
        diasInuteis,
        minimumGuaranteeAmount: floorGuarantee,
      });
      const r122 = rubricsByCode.get('122');
      const r123 = rubricsByCode.get('123');
      if (r122 && commCalc.dsrAmount > 0) {
        eventos.push({ rubric_id: r122.id, quantity: diasInuteis, manual_value: commCalc.dsrAmount });
      }
      if (r123 && commCalc.minimumGuaranteeSupplement > 0) {
        eventos.push({ rubric_id: r123.id, quantity: 1, manual_value: commCalc.minimumGuaranteeSupplement });
      }
    } else {
      const salarioRubric =
        applicableRubrics.find((r) => r.rubric_kind === 'SALARY_BASE' && r.code === '101') ||
        applicableRubrics.find((r) => r.rubric_kind === 'SALARY_BASE') ||
        rubricsByCode.get('101') ||
        rubricsByCode.get('1001');

      if (salarioRubric) {
        eventos.push({ rubric_id: salarioRubric.id, quantity: 30, manual_value: null });
      }
    }

    // FOLHA-04: Proventos e Base FGTS decorrentes de Afastamentos (104 Maternidade, 105 Doença 15d, 906 FGTS Legal)
    if (leaveImpact) {
      const totalMaternityDays = leaveImpact.maternityDeductibleDays + leaveImpact.maternityExtendedDays;
      if (totalMaternityDays > 0) {
        const r104 = rubricsByCode.get('104');
        if (r104) {
          if (!applicableRubrics.some((r) => r.id === r104.id)) {
            applicableRubrics = [...applicableRubrics, r104];
          }
          eventos.push({ rubric_id: r104.id, quantity: totalMaternityDays, manual_value: null });
          maternityDeduction = leaveImpact.maternityDctfWebDeductibleAmount;
        }
      }
      if (leaveImpact.companyPaidSickDays > 0) {
        const r105 = rubricsByCode.get('105');
        if (r105) {
          if (!applicableRubrics.some((r) => r.id === r105.id)) {
            applicableRubrics = [...applicableRubrics, r105];
          }
          eventos.push({ rubric_id: r105.id, quantity: leaveImpact.companyPaidSickDays, manual_value: null });
        }
      }
      if (leaveImpact.fgtsCompulsoryLeaveDays > 0) {
        const r906 = rubricsByCode.get('906');
        if (r906) {
          if (!applicableRubrics.some((r) => r.id === r906.id)) {
            applicableRubrics = [...applicableRubrics, r906];
          }
          eventos.push({ rubric_id: r906.id, quantity: leaveImpact.fgtsCompulsoryLeaveDays, manual_value: null });
        }
      }
    }

    if (!hasZeroCompanyPaidDaysInMonth) {
      const contractFixed = data.fixedEventsByContract.get(contract.id) || [];
      for (const fe of contractFixed) {
        eventos.push({
          rubric_id: fe.rubric_id,
          manual_value: fe.value_type === 'PERCENT' ? null : Number(fe.amount || 0),
          percentage: fe.value_type === 'PERCENT' ? Number(fe.percentage || 0) : undefined,
          value_type: fe.value_type || 'AMOUNT',
          quantity: 1,
        });
      }

      // FOLHA-08: Benefícios Enterprise (VT Lei 7.418/85, Saúde/Odonto ANS e Coparticipação)
      const contractBenefits = data.benefitsByContract.get(contract.id) || [];
      const r905 = data.rubricsByCode.get('905');
      const r907 = data.rubricsByCode.get('907');
      const r908 = data.rubricsByCode.get('908');
      const r909 = data.rubricsByCode.get('909');
      const r910 = data.rubricsByCode.get('910');
      const r911 = data.rubricsByCode.get('911');
      const r912 = data.rubricsByCode.get('912');

      if (period.type === 'MONTHLY' || period.type === 'COMPLEMENTARY') {
        const { diasUteis } = getCalendarDaysForContract(data, contract);
        const rawVacs = data.vacSchedulesByContract.get(contract.id) || [];
        const vacDays = rawVacs.reduce((acc: number, v: any) => acc + Number(v.days_count || 0), 0);
        const leaveDays = leaveImpact ? Math.max(0, 30 - diasTrabalhados) : 0;

        for (const eb of contractBenefits) {
          if (eb.benefit_type === 'TRANSPORTATION_VOUCHER') {
            const vtResult = BenefitsCalculator.calculateTransportationVoucher({
              baseSalary,
              workingDaysInMonth: diasUteis,
              vacationDays: vacDays,
              absenceOrLeaveDays: leaveDays,
              workRegime: eb.work_regime || 'PRESENTIAL',
              weeklyRemoteDays: Number(eb.weekly_remote_days || 0),
              dailyPasses: Number(eb.daily_passes || 2),
              passUnitValue: Number(eb.pass_unit_value || 0),
              manualConcededValue:
                Number(eb.conceded_benefit_value) > 0 ? Number(eb.conceded_benefit_value) : undefined,
              optIn: eb.opt_in !== false,
              workedDaysInMonth: diasTrabalhados,
            });

            const targetRubricId = eb.rubric_id || r905?.id;
            if (targetRubricId && vtResult.vtDiscount > 0) {
              eventos.push({
                rubric_id: targetRubricId,
                manual_value: vtResult.vtDiscount,
                quantity: vtResult.effectivePresentialDays,
              });
            }
          } else if (eb.benefit_type === 'HEALTH_PLAN' || eb.benefit_type === 'DENTAL_PLAN') {
            const benefitDeps = data.benefitDependentsByBenefitId?.get(eb.id) || [];
            const planResult = BenefitsCalculator.calculateHealthOrDentalPlan({
              ansCode: eb.ans_code,
              holderMonthlyCost: Number(eb.holder_monthly_cost || eb.contract_value || 0),
              holderDiscountValue:
                eb.holder_discount_value != null && Number(eb.holder_discount_value) > 0
                  ? Number(eb.holder_discount_value)
                  : eb.employee_discount != null && Number(eb.employee_discount) > 0
                    ? Number(eb.employee_discount)
                    : undefined,
              holderSubsidyAmount:
                eb.company_subsidy_amount != null && Number(eb.company_subsidy_amount) > 0
                  ? Number(eb.company_subsidy_amount)
                  : eb.company_cost != null && Number(eb.company_cost) > 0
                    ? Number(eb.company_cost)
                    : undefined,
              dependents: benefitDeps.map((d: any) => ({
                id: d.id,
                dependentName: d.dependent_name,
                dependentCpf: d.dependent_cpf,
                relationship: d.relationship,
                monthlyCost: Number(d.monthly_cost || 0),
                employeeDiscount: d.employee_discount != null ? Number(d.employee_discount) : undefined,
                companySubsidy: d.company_subsidy != null ? Number(d.company_subsidy) : undefined,
              })),
            });

            // Desconto do Titular
            const holderRubricId =
              eb.rubric_id ||
              (eb.benefit_type === 'HEALTH_PLAN' ? r907?.id : r910?.id);
            if (holderRubricId && planResult.holderDiscount > 0) {
              eventos.push({
                rubric_id: holderRubricId,
                manual_value: planResult.holderDiscount,
                quantity: 1,
              });
            }

            // Desconto dos Dependentes
            const depRubricId =
              eb.benefit_type === 'HEALTH_PLAN'
                ? r908?.id || holderRubricId
                : r910?.id || holderRubricId;
            if (depRubricId && planResult.dependentsDiscount > 0) {
              eventos.push({
                rubric_id: depRubricId,
                manual_value: planResult.dependentsDiscount,
                quantity: benefitDeps.length || 1,
              });
            }
          } else {
            // Outros benefícios (VR/VA/PAT, Seguro de Vida, etc.)
            const discountVal = Number(eb.employee_discount || 0);
            const targetRubricId =
              eb.rubric_id ||
              (['MEAL_VOUCHER', 'FOOD_VOUCHER'].includes(eb.benefit_type) ? r912?.id : null);
            if (targetRubricId && discountVal > 0) {
              eventos.push({ rubric_id: targetRubricId, manual_value: discountVal, quantity: 1 });
            }
          }
        }

        // Coparticipação em Consultas/Exames (Faturas Importadas da Operadora)
        const contractCopays = data.copaymentsByContract?.get(contract.id) || [];
        if (contractCopays.length > 0) {
          const copaySummary = BenefitsCalculator.aggregateCopayments(contractCopays);
          if (copaySummary.healthCopayTotal > 0 && r909) {
            eventos.push({
              rubric_id: r909.id,
              manual_value: copaySummary.healthCopayTotal,
              quantity: contractCopays.filter((c: any) => c.benefit_type === 'HEALTH_PLAN').length || 1,
            });
          }
          if (copaySummary.dentalCopayTotal > 0 && r911) {
            eventos.push({
              rubric_id: r911.id,
              manual_value: copaySummary.dentalCopayTotal,
              quantity: contractCopays.filter((c: any) => c.benefit_type === 'DENTAL_PLAN').length || 1,
            });
          }
        }

        // FOLHA-09: Sindicatos e Convenções Coletivas (CCT) — Piso Salarial e ATS
        if (cct) {
          // 1. Piso Salarial da Categoria (Geral ou por CBO/Função)
          const positionInfo = {
            cbo: contract.position_cbo || (contract as any).cbo,
            positionId: contract.position_id,
          };
          const floorCheck = CollectiveAgreementCalculator.validateCategoryFloor(
            baseSalary,
            cct,
            positionInfo
          );
          if (floorCheck.isBelowFloor && floorCheck.difference > 0) {
            const r107 = data.rubricsByCode.get('107');
            if (r107) {
              if (!applicableRubrics.some((r) => r.id === r107.id)) {
                applicableRubrics = [...applicableRubrics, r107];
              }
              eventos.push({
                rubric_id: r107.id,
                manual_value: floorCheck.difference,
                quantity: 1,
              });
            }
          }

          // 2. Adicional por Tempo de Serviço (ATS — Anuênio, Biênio, Triênio, Quinquênio)
          if (cct.ats_type && cct.ats_type !== 'NONE') {
            const atsRes = CollectiveAgreementCalculator.calculateServiceTimeAllowance(
              admissionStr,
              period.year,
              period.month || 1,
              baseSalary,
              cct
            );
            if (atsRes.amount > 0) {
              const r106 = data.rubricsByCode.get('106');
              if (r106) {
                if (!applicableRubrics.some((r) => r.id === r106.id)) {
                  applicableRubrics = [...applicableRubrics, r106];
                }
                eventos.push({
                  rubric_id: r106.id,
                  manual_value: atsRes.amount,
                  percentage: atsRes.percentage,
                  quantity: atsRes.cycles,
                });
              }
            }
          }
        }
      } else {
        for (const eb of contractBenefits) {
          if (!eb.rubric_id) continue;
          const discountVal = Number(eb.employee_discount || 0);
          if (discountVal > 0) {
            eventos.push({ rubric_id: eb.rubric_id, manual_value: discountVal, quantity: 1 });
          }
        }
      }

      if (period.type === 'MONTHLY') {
        const adv = data.advancePayslipByContract.get(contract.id);
        if (adv && Number(adv.total_earnings) > 0) {
          const r850 = rubricsByCode.get('850');
          if (r850) {
            eventos.push({ rubric_id: r850.id, manual_value: Number(adv.total_earnings), quantity: 1 });
          }
        }

        const cLoans = data.loansByContract.get(contract.id) || [];
        for (const loan of cLoans) {
          const instVal = round2(Number(loan.installment_amount || 0));
          const r805 = rubricsByCode.get('805');
          if (r805 && instVal > 0) {
            eventos.push({ rubric_id: r805.id, manual_value: instVal, quantity: 1 });
          }
        }

        // FOLHA-07: Desconto de Saldo Devedor Anterior (Rubrica 899)
        const cDebts = data.debtsByContract.get(contract.id) || [];
        const pendingDebts = cDebts.filter((d) => d.status === 'PENDING' || d.status === 'PARTIALLY_DEDUCTED');
        const pendingDebtSum = sumMoney(pendingDebts.map((d) => Number(d.balance_remaining ?? d.amount ?? 0)));
        if (pendingDebtSum > 0) {
          const r899 = rubricsByCode.get('899');
          const hasManual899 = (data.variableEventsByContract.get(contract.id) || []).some(
            (v) => rubricsById.get(v.rubric_id)?.code === '899'
          );
          if (r899 && !hasManual899) {
            eventos.push({ rubric_id: r899.id, manual_value: pendingDebtSum, quantity: 1 });
          }
        }
      }
    }
  }

  // Eventos variáveis da competência (BUG-04)
  const contractVars = data.variableEventsByContract.get(contract.id) || [];
  for (const v of contractVars) {
    eventos.push({
      rubric_id: v.rubric_id,
      manual_value: v.manual_value !== null && v.manual_value !== undefined ? Number(v.manual_value) : null,
      force_zero_override: Boolean(v.force_zero_override),
      quantity: v.quantity !== null && v.quantity !== undefined ? Number(v.quantity) : 1,
      origin: v.origin,
    });
  }

  // Injeções de cenário What-If (bônus e delta de horas extras)
  if (scenarioApplies && scenarioOverride) {
    const bonusAmount = round2(Number(scenarioOverride.bonus_amount || 0));
    if (bonusAmount > 0) {
      let bonusRubric: Rubric | undefined =
        (scenarioOverride.bonus_rubric_code
          ? applicableRubrics.find((r) => r.code === scenarioOverride.bonus_rubric_code) ||
            rubricsByCode.get(scenarioOverride.bonus_rubric_code)
          : undefined) ||
        applicableRubrics.find(
          (r) =>
            r.type === 'EARNING' &&
            (r.category === 'BONUS' ||
              (r.name || '').toLowerCase().includes('bônus') ||
              (r.name || '').toLowerCase().includes('bonus') ||
              (r.name || '').toLowerCase().includes('prêmio') ||
              (r.name || '').toLowerCase().includes('premio'))
        );

      const resolvedBonusRubric: Rubric = bonusRubric || {
        id: SYNTHETIC_BONUS_RUBRIC_ID,
        code: '998',
        name: 'Simulação What-If — Bônus / Prêmio',
        type: 'EARNING',
        category: 'BONUS',
        rubric_kind: 'OTHER',
        status: 'ACTIVE',
        is_system: false,
        calculation_form: 'FIXO',
        calculation_order: 39,
        incidencias: {
          inss: true,
          irrf: true,
          fgts: true,
          inss_patronal: true,
          rat: true,
          terceiros: true,
          gera_base_inss: true,
          gera_base_irrf: true,
          gera_base_fgts: true,
          integra_dsr: false,
          irrf_mode: 'NORMAL',
          media_ferias: false,
          media_13: false,
        },
      };

      if (!applicableRubrics.some((r) => r.id === resolvedBonusRubric.id)) {
        applicableRubrics = [...applicableRubrics, resolvedBonusRubric];
      }

      eventos.push({
        rubric_id: resolvedBonusRubric.id,
        manual_value: bonusAmount,
        value_type: 'AMOUNT',
        quantity: 1,
        origin: 'SIMULATION',
      });
    }

    const overtimeDelta = Number(scenarioOverride.overtime_hours_delta || 0);
    if (overtimeDelta > 0) {
      const heRubric =
        applicableRubrics.find((r) => r.code === '102' || r.code === '150') ||
        applicableRubrics.find((r) => r.rubric_kind === 'OVERTIME' && r.type === 'EARNING');

      if (heRubric) {
        eventos.push({
          rubric_id: heRubric.id,
          manual_value: null,
          quantity: overtimeDelta,
          origin: 'SIMULATION',
        });
      }
    }
  }

  // Beneficiários estruturados de pensão alimentícia (FOLHA-03)
  const rawAlimonyBeneficiaries = data.alimonyBeneficiariesByContract.get(contract.id) || [];
  const eligibleAlimonyBeneficiaries = rawAlimonyBeneficiaries
    .map((b: any) => ({
      ...b,
      start_date: toDateStr(b.start_date) || null,
      end_date: toDateStr(b.end_date) || null,
      percentage: b.percentage !== null && b.percentage !== undefined ? Number(b.percentage) : null,
      fixed_amount: b.fixed_amount !== null && b.fixed_amount !== undefined ? Number(b.fixed_amount) : null,
      min_amount: b.min_amount !== null && b.min_amount !== undefined ? Number(b.min_amount) : null,
      max_amount: b.max_amount !== null && b.max_amount !== undefined ? Number(b.max_amount) : null,
    }))
    .filter((b: AlimonyBeneficiaryRule) =>
      isAlimonyBeneficiaryEligible(b, period.type, period.year, period.month)
    );

  if (eligibleAlimonyBeneficiaries.length > 0) {
    const hasAlimonyRubric = applicableRubrics.some((r) => r.code === '904' || r.code === '804' || r.rubric_kind === 'ALIMONY');
    if (!hasAlimonyRubric) {
      const r904 = rubricsByCode.get('904') || rubricsByCode.get('804');
      if (r904) {
        applicableRubrics = [...applicableRubrics, r904];
      }
    }
  }

  // FOLHA-07: Assegura disponibilidade das rubricas de sistema 499 e 899 no catálogo do cálculo
  const r499 = rubricsByCode.get('499');
  if (r499 && !applicableRubrics.some((r) => r.id === r499.id)) {
    applicableRubrics = [...applicableRubrics, r499];
  } else if (!r499 && !applicableRubrics.some((r) => r.code === '499')) {
    const synthetic499: Rubric = {
      id: 'a0000000-0000-0000-0000-000000000499',
      code: '499',
      name: 'Insuficiência de Saldo',
      type: 'EARNING',
      category: 'OTHER',
      rubric_kind: 'INSUFFICIENCY_CREDIT',
      status: 'ACTIVE',
      is_system: true,
      calculation_form: 'VALOR_FIXO',
      calculation_order: 99,
      discount_priority: 99,
      incidencias: {
        inss: false,
        irrf: false,
        fgts: false,
        inss_patronal: false,
        rat: false,
        terceiros: false,
        gera_base_inss: false,
        gera_base_irrf: false,
        gera_base_fgts: false,
        integra_dsr: false,
        irrf_mode: 'NORMAL',
        media_ferias: false,
        media_13: false,
      },
    };
    rubricsById.set(synthetic499.id, synthetic499);
    rubricsByCode.set(synthetic499.code, synthetic499);
    applicableRubrics = [...applicableRubrics, synthetic499];
  }

  const r899 = rubricsByCode.get('899');
  if (r899 && !applicableRubrics.some((r) => r.id === r899.id)) {
    applicableRubrics = [...applicableRubrics, r899];
  }

  // Deduções fixas elegíveis (BUG-10)
  const rawContractDeds = hasZeroCompanyPaidDaysInMonth
    ? []
    : (data.deductionsByContract.get(contract.id) || []);
  for (const d of rawContractDeds) {
    if (d.deduction_type === 'ALIMONY' && rawAlimonyBeneficiaries.length > 0) continue;
    if (!d.rubric_id) continue;
    const eligible = isDeductionEligibleForPeriod(
      {
        ...d,
        start_date: toDateStr(d.start_date) || undefined,
        end_date: toDateStr(d.end_date) || null,
        value: d.amount_type === 'PERCENTAGE' ? Number(d.percentage || 0) : Number(d.fixed_amount || 0),
      },
      period.type,
      period.year,
      period.month
    );
    if (!eligible) continue;

    const val = calculateDeductionAmount(
      {
        ...d,
        amount_type: d.percentage ? 'PERCENTAGE' : 'FIXED',
        value: d.percentage ? Number(d.percentage) : Number(d.fixed_amount || 0),
        total_limit: d.total_limit !== null ? Number(d.total_limit) : null,
      },
      baseSalary
    );
    if (val > 0) {
      eventos.push({ rubric_id: d.rubric_id, manual_value: val, quantity: 1 });
      if (!applicableRubrics.some((r) => r.id === d.rubric_id)) {
        const rub = rubricsById.get(d.rubric_id);
        if (rub) applicableRubrics = [...applicableRubrics, rub];
      }
    }
  }

  const { diasUteis, diasInuteis } = getCalendarDaysForContract(data, contract);
  const divisor = Number(contract.monthly_hours || 220);

  const workerDepsRaw = data.dependentsByWorker.get(contract.worker_id) || [];
  const workerDeps = workerDepsRaw.map((d: any) => ({
    id: d.id,
    name: d.name,
    cpf: d.cpf,
    birth_date: toDateStr(d.birth_date),
    relationship: d.relationship,
    is_irrf_dependent: d.is_irrf_dependent,
    is_family_salary: d.is_family_salary,
    is_incapacitated: d.is_incapacitated,
    start_date: toDateStr(d.start_date) || null,
    end_date: toDateStr(d.end_date) || null,
    vaccination_card_date: toDateStr(d.vaccination_card_date) || null,
    school_frequency_date: toDateStr(d.school_frequency_date) || null,
  }));
  const depEval = evaluateIRRFDependents(workerDeps, period.year, period.month);
  const terminationStr = toDateStr(contract.termination_date) || null;

  const isApprentice = Boolean(
    contract.is_apprentice ||
      String(contract.regime || '').toUpperCase() === 'APPRENTICE' ||
      String(contract.contract_type_name || '').toLowerCase().includes('aprendiz')
  );

  // BUG-02: Consolidação T16 INSS usando addMoney
  const otherSlips = data.existingCompetencePayslipsByContract.get(contract.id) || [];
  const previousBaseInss = otherSlips.reduce(
    (sum: number, p: any) => addMoney(sum, Number(p.base_inss) || 0),
    0
  );

  // FOLHA-06: Combina vínculos externos declarados + outras matrículas do mesmo CPF no grupo econômico (outros períodos + lote atual)
  const cleanCpf = String(contract.worker_cpf || '').replace(/\D/g, '');
  const externalOthers = data.otherEmploymentsByWorker.get(contract.worker_id) || [];
  const groupFromOtherPeriods: OtherEmploymentInput[] = [];
  if (cleanCpf) {
    const byContractMap = data.groupInssByCpfAndContract.get(cleanCpf);
    if (byContractMap) {
      for (const [otherContractId, entries] of byContractMap.entries()) {
        if (otherContractId !== contract.id) {
          groupFromOtherPeriods.push(...entries);
        }
      }
    }
  }
  const intraBatchOthers =
    cleanCpf && intraBatchOtherContractsByCpf
      ? (intraBatchOtherContractsByCpf.get(cleanCpf) || [])
      : [];
  const combinedOtherEmployments: OtherEmploymentInput[] = [
    ...externalOthers,
    ...groupFromOtherPeriods,
    ...intraBatchOthers,
  ];

  const context = new PayrollContext({
    competencia: `${period.month}/${period.year}`,
    tipo_folha: period.type,
    empregado_id: contract.worker_id,
    contrato_id: contract.id,
    salario_base: baseSalary,
    salario_minimo: Number(general_legal_parameters!.minimum_wage),
    dias_trabalhados: diasTrabalhados,
    dias_uteis: diasUteis,
    dias_inuteis: diasInuteis,
    divisor,
    num_dependentes: depEval.eligibleCount,
    is_apprentice: isApprentice,
    rubricas: applicableRubrics,
    eventos,
    base_inss_already_taxed:
      inssBaseAlreadyTaxedOverride !== null ? inssBaseAlreadyTaxedOverride : previousBaseInss,
    fgts_base_already_taxed: fgtsBaseAlreadyTaxed,
    vacation_inss_base_override: vacationInssBaseOverride,
    vacation_fgts_base_override: vacationFgtsBaseOverride,
    prior_thirteenth_irrf_entry: priorThirteenthIrrfEntry,
    irrf_regime: data.irrfRegime,
    payment_date: data.paymentDate,
    withhold_irrf_on_advance: data.withholdIrrfOnAdvance,
    prior_cash_irrf_entries: data.priorCashIrrfByWorker.get(contract.worker_id) || [],
    alimony_beneficiaries: eligibleAlimonyBeneficiaries,
    family_salary_dependents: workerDeps,
    other_employments: combinedOtherEmployments,
    admission_date: admissionStr || null,
    termination_date: terminationStr,
    employee_regime: contract.regime || (isApprentice ? 'APPRENTICE' : 'CLT'),
    has_unpaid_or_inss_only_month: hasZeroCompanyPaidDaysInMonth,
    contract_incidences: contract.contract_incidences,
    inss_parameters: data.inss_parameters,
    irrf_parameters: data.irrf_parameters,
    general_legal_parameters,
    negative_net_policy: data.negativeNetPolicy,
    loans: data.loansByContract.get(contract.id) || [],
    prior_balance_debts: data.debtsByContract.get(contract.id) || [],
    collective_agreement: cct,
    calculation_regime: (contract.calculation_regime || (isApprentice ? 'APPRENTICE' : 'CLT')) as CalculationRegimeType,
    esocial_category_code: contract.esocial_category_code || (isApprentice ? '103' : '101'),
    autonomous_service_type: (contract.autonomous_service_type || 'GENERAL') as AutonomousServiceType,
    iss_rate: Number(contract.iss_rate || 0),
  });

  const engine = new PayrollEngine(context);
  const result = await engine.run();

  if (result.status && result.status.startsWith('ERRO_CALCULO')) {
    return {
      error: {
        contract_id: contract.id,
        worker_id: contract.worker_id,
        error: result.status,
      },
    };
  }

  const rawItems = result.memoria_calculo
    .filter((m) => m.result_value > 0 && rubricsById.has(m.rubric_id))
    .map((m) => {
      const rub = rubricsById.get(m.rubric_id);
      return {
        rubric_id: m.rubric_id,
        rubric_version_id: m.rubric_id,
        reference: m.quantity_used ? String(m.quantity_used) : null,
        amount: m.result_value,
        type: rub?.type || 'EARNING',
      };
    });

  // Validação contábil em modo REAL (em simulação pode haver rubrica sintética de bônus fora do catálogo)
  if (!scenarioApplies) {
    const sumEarnings = sumMoney(rawItems.filter((i) => i.type === 'EARNING').map((i) => i.amount));
    const sumDeductions = sumMoney(rawItems.filter((i) => i.type === 'DEDUCTION').map((i) => i.amount));

    const diffE = Math.abs(subtractMoney(sumEarnings, result.total_proventos));
    const diffD = Math.abs(subtractMoney(sumDeductions, result.total_descontos));
    if (diffE > 0.01 || diffD > 0.01) {
      return {
        error: {
          contract_id: contract.id,
          worker_id: contract.worker_id,
          error: `Invariante contábil violada no contrato ${contract.id}: proventos (${sumEarnings} vs ${result.total_proventos}), descontos (${sumDeductions} vs ${result.total_descontos}).`,
        },
      };
    }
  }

  const leaveImpactMemory =
    leaveImpact && leaveImpact.appliedLeaveIds.length > 0
      ? [
          {
            rubric_id: null,
            step_name: 'Impacto de Afastamentos (Tabela 18 eSocial)',
            base_value: baseSalary,
            quantity_used:
              leaveImpact.companyPaidSickDays +
              leaveImpact.inssPaidDays +
              leaveImpact.maternityDeductibleDays +
              leaveImpact.maternityExtendedDays +
              leaveImpact.unpaidLeaveDays,
            percentage_used: 0,
            parsed_formula: leaveImpact.notes.join(' | ') || 'Afastamento aplicado',
            result_value: maternityDeduction,
            origin: 'LEAVE_IMPACT',
            engine_version: ENGINE_VERSION,
          },
        ]
      : [];

  const payslip: RawCalculatedPayslip = {
    contract_id: contract.id,
    total_earnings: result.total_proventos,
    total_deductions: result.total_descontos,
    net_salary: result.liquido,
    base_inss: result.bases.inss,
    base_irrf: result.bases.irrf,
    base_fgts: result.bases.fgts,
    fgts_month: result.total_fgts,
    inss_employee: result.total_inss,
    maternity_deduction: maternityDeduction,
    family_salary_deduction: result.total_family_salary ?? 0,
    ind_mv: result.ind_mv ?? null,
    other_employments_base: result.other_employments_base ?? 0,
    other_employments_inss: result.other_employments_inss ?? 0,
    has_insufficiency: result.has_insufficiency,
    insufficiency_credit: result.insufficiency_credit,
    consignable_margin: result.consignable_margin,
    consignable_loan_capped: result.consignable_loan_capped,
    calculation_regime: contract.calculation_regime || (isApprentice ? 'APPRENTICE' : 'CLT'),
    special_retirement_exposure_code: contract.special_retirement_exposure_code || '01',
    status: 'CALCULATED',
    legal_version_id: activeVersion.id,
    engine_version: ENGINE_VERSION,
    inss_table_version: activeVersion.code,
    irrf_table_version: activeVersion.code,
    fgts_table_version: activeVersion.code,
    items: rawItems,
    memory: [
      ...result.memoria_calculo.map((m) => ({
        rubric_id: rubricsById.has(m.rubric_id) ? m.rubric_id : null,
        step_name: m.step_name,
        base_value: m.base_value,
        quantity_used: m.quantity_used,
        percentage_used: m.percentage_used,
        parsed_formula: m.parsed_formula,
        result_value: m.result_value,
        origin: m.origin || 'ENGINE',
        engine_version: ENGINE_VERSION,
      })),
      ...leaveImpactMemory,
    ],
  };

  const snapshot: WhatIfContractSnapshot = {
    contract_id: contract.id,
    company_id: contract.company_id,
    department_id: contract.department_id ?? null,
    worker_name: contract.worker_name,
    affected: scenarioApplies,
    total_earnings: result.total_proventos,
    total_deductions: result.total_descontos,
    net_salary: result.liquido,
    base_inss: result.bases.inss,
    inss_employee: result.total_inss,
    irrf_employee: result.total_irrf,
    fgts_month: result.total_fgts,
  };

  const irrfCashEntry: PersistedIrrfCashEntry | null = result.irrf_cash_ledger_entry
    ? {
        ...result.irrf_cash_ledger_entry,
        contract_id: contract.id,
        worker_id: contract.worker_id,
        company_id: contract.company_id,
      }
    : null;

  const alimonySplits: PersistedAlimonySplit[] = (result.alimony_splits || []).map((s) => ({
    ...s,
    contract_id: contract.id,
  }));

  return { payslip, snapshot, irrfCashEntry, alimonySplits };
}

/**
 * Persiste atomicamente o ledger de IRRF em Regime de Caixa após `save_payroll_period`.
 * Executado apenas no modo REAL (nunca em simulações What-If).
 */
export async function persistIrrfCashLedger(
  client: pg.PoolClient,
  params: {
    tenantId: string;
    periodId: string;
    contractIdFilter?: string | null;
    entries: PersistedIrrfCashEntry[];
  }
): Promise<void> {
  const { tenantId, periodId, contractIdFilter = null, entries } = params;

  if (contractIdFilter) {
    await client.query(
      `DELETE FROM public.irrf_cash_ledger
       WHERE tenant_id = $1::uuid AND period_id = $2::uuid AND contract_id = $3::uuid;`,
      [tenantId, periodId, contractIdFilter]
    );
  } else {
    await client.query(
      `DELETE FROM public.irrf_cash_ledger
       WHERE tenant_id = $1::uuid AND period_id = $2::uuid;`,
      [tenantId, periodId]
    );
  }

  if (entries.length === 0) return;

  const { rows: slipRows } = await client.query(
    `SELECT id, contract_id
     FROM public.payslips
     WHERE tenant_id = $1::uuid AND payroll_period_id = $2::uuid;`,
    [tenantId, periodId]
  );

  const payslipIdByContract = new Map<string, string>();
  for (const s of slipRows) {
    payslipIdByContract.set(s.contract_id, s.id);
  }

  const validEntries = entries.filter((e) => payslipIdByContract.has(e.contract_id));
  if (validEntries.length === 0) return;

  await client.query(
    `INSERT INTO public.irrf_cash_ledger (
       tenant_id, company_id, worker_id, contract_id, period_id, payslip_id,
       cash_year, cash_month, payment_date, taxation_bucket,
       gross_taxable, inss_deducted, alimony_deducted, dependents_deducted,
       simplified_used, irrf_withheld
     )
     SELECT
       $1::uuid,
       u.company_id,
       u.worker_id,
       u.contract_id,
       $2::uuid,
       u.payslip_id,
       u.cash_year,
       u.cash_month,
       u.payment_date,
       u.taxation_bucket,
       u.gross_taxable,
       u.inss_deducted,
       u.alimony_deducted,
       u.dependents_deducted,
       u.simplified_used,
       u.irrf_withheld
     FROM UNNEST(
       $3::uuid[],
       $4::uuid[],
       $5::uuid[],
       $6::uuid[],
       $7::int[],
       $8::int[],
       $9::date[],
       $10::text[],
       $11::numeric[],
       $12::numeric[],
       $13::numeric[],
       $14::numeric[],
       $15::boolean[],
       $16::numeric[]
     ) AS u(
       company_id, worker_id, contract_id, payslip_id,
       cash_year, cash_month, payment_date, taxation_bucket,
       gross_taxable, inss_deducted, alimony_deducted, dependents_deducted,
       simplified_used, irrf_withheld
     )
     ON CONFLICT (payslip_id, taxation_bucket) DO UPDATE SET
       cash_year = EXCLUDED.cash_year,
       cash_month = EXCLUDED.cash_month,
       payment_date = EXCLUDED.payment_date,
       gross_taxable = EXCLUDED.gross_taxable,
       inss_deducted = EXCLUDED.inss_deducted,
       alimony_deducted = EXCLUDED.alimony_deducted,
       dependents_deducted = EXCLUDED.dependents_deducted,
       simplified_used = EXCLUDED.simplified_used,
       irrf_withheld = EXCLUDED.irrf_withheld,
       updated_at = NOW();`,
    [
      tenantId,
      periodId,
      validEntries.map((e) => e.company_id),
      validEntries.map((e) => e.worker_id),
      validEntries.map((e) => e.contract_id),
      validEntries.map((e) => payslipIdByContract.get(e.contract_id)!),
      validEntries.map((e) => e.cash_year),
      validEntries.map((e) => e.cash_month),
      validEntries.map((e) => e.payment_date),
      validEntries.map((e) => e.taxation_bucket),
      validEntries.map((e) => e.gross_taxable),
      validEntries.map((e) => e.inss_deducted),
      validEntries.map((e) => e.alimony_deducted),
      validEntries.map((e) => e.dependents_deducted),
      validEntries.map((e) => e.simplified_used),
      validEntries.map((e) => e.irrf_withheld),
    ]
  );
}

/**
 * Persiste atomicamente os rateios de pensão alimentícia (`payslip_alimony_splits`)
 * por beneficiário no modo REAL (nunca em simulações What-If).
 */
export async function persistAlimonySplits(
  client: pg.PoolClient,
  params: {
    tenantId: string;
    periodId: string;
    contractIdFilter?: string | null;
    splits: PersistedAlimonySplit[];
  }
): Promise<void> {
  const { tenantId, periodId, contractIdFilter = null, splits } = params;

  if (contractIdFilter) {
    await client.query(
      `DELETE FROM public.payslip_alimony_splits
       WHERE tenant_id = $1::uuid AND payroll_period_id = $2::uuid AND contract_id = $3::uuid;`,
      [tenantId, periodId, contractIdFilter]
    );
  } else {
    await client.query(
      `DELETE FROM public.payslip_alimony_splits
       WHERE tenant_id = $1::uuid AND payroll_period_id = $2::uuid;`,
      [tenantId, periodId]
    );
  }

  if (splits.length === 0) return;

  const { rows: slipRows } = await client.query(
    `SELECT id, contract_id
     FROM public.payslips
     WHERE tenant_id = $1::uuid AND payroll_period_id = $2::uuid;`,
    [tenantId, periodId]
  );

  const payslipIdByContract = new Map<string, string>();
  for (const s of slipRows) {
    payslipIdByContract.set(s.contract_id, s.id);
  }

  const validSplits = splits.filter((s) => payslipIdByContract.has(s.contract_id));
  if (validSplits.length === 0) return;

  await client.query(
    `INSERT INTO public.payslip_alimony_splits (
       tenant_id, payroll_period_id, payslip_id, contract_id, beneficiary_id,
       beneficiary_name, beneficiary_cpf, court_process_number,
       calculation_basis, percentage_applied, base_amount, amount,
       irrf_converged, solver_iterations, payment_method, payment_details
     )
     SELECT
       $1::uuid,
       $2::uuid,
       u.payslip_id,
       u.contract_id,
       u.beneficiary_id,
       u.beneficiary_name,
       u.beneficiary_cpf,
       u.court_process_number,
       u.calculation_basis,
       u.percentage_applied,
       u.base_amount,
       u.amount,
       u.irrf_converged,
       u.solver_iterations,
       u.payment_method,
       u.payment_details
     FROM UNNEST(
       $3::uuid[],
       $4::uuid[],
       $5::uuid[],
       $6::text[],
       $7::varchar[],
       $8::text[],
       $9::text[],
       $10::numeric[],
       $11::numeric[],
       $12::numeric[],
       $13::numeric[],
       $14::int[],
       $15::text[],
       $16::jsonb[]
     ) AS u(
       payslip_id, contract_id, beneficiary_id, beneficiary_name, beneficiary_cpf,
       court_process_number, calculation_basis, percentage_applied, base_amount,
       amount, irrf_converged, solver_iterations, payment_method, payment_details
     );`,
    [
      tenantId,
      periodId,
      validSplits.map((s) => payslipIdByContract.get(s.contract_id)!),
      validSplits.map((s) => s.contract_id),
      validSplits.map((s) => s.beneficiary_id || null),
      validSplits.map((s) => s.beneficiary_name),
      validSplits.map((s) => s.beneficiary_cpf || null),
      validSplits.map((s) => s.court_process_number || null),
      validSplits.map((s) => s.calculation_basis),
      validSplits.map((s) => s.percentage_applied ?? 0),
      validSplits.map((s) => s.base_amount),
      validSplits.map((s) => s.amount),
      validSplits.map((s) => s.irrf_converged),
      validSplits.map((s) => s.solver_iterations),
      validSplits.map((s) => s.payment_method || 'BANK_TRANSFER'),
      validSplits.map((s) => JSON.stringify(s.payment_details || {})),
    ]
  );
}

export interface CalculatePayrollParams {
  tenantId: string;
  periodId: string;
  contractIdFilter?: string | null;
}

export interface CalculatePayrollResponse {
  success: boolean;
  httpStatus?: number;
  error?: string;
  errors?: Array<{ contract_id: string; worker_id: string; error: string }>;
  processed?: number;
  results?: Array<{ contract_id: string; net: number; status: string }>;
  saveResult?: any;
}

/**
 * Execução síncrona transacional em chunks de 50 contratos (compatível com /calculate).
 */
export async function calculatePayrollPeriod(
  client: pg.PoolClient,
  params: CalculatePayrollParams
): Promise<CalculatePayrollResponse> {
  const { tenantId, periodId, contractIdFilter = null } = params;

  const { rows: periodRows } = await client.query(
    `SELECT * FROM public.payroll_periods WHERE id = $1::uuid AND tenant_id = $2::uuid;`,
    [periodId, tenantId]
  );

  if (periodRows.length === 0) {
    return { success: false, httpStatus: 404, error: 'Período de folha não encontrado.' };
  }

  const period = periodRows[0];
  const effectiveStatus = period.status === 'OPEN' ? 'DRAFT' : period.status;
  const statusValidation = validatePeriodStatusForCalculation(effectiveStatus);
  if (!statusValidation.canCalculate) {
    return {
      success: false,
      httpStatus: statusValidation.httpStatus || 400,
      error: statusValidation.error,
    };
  }

  // Trava concorrente atômica com timestamp de heartbeat
  const { rows: lockRows } = await client.query(
    `UPDATE public.payroll_periods
     SET status = 'CALCULATING',
         locked_at = NOW(),
         heartbeat_at = NOW(),
         updated_at = NOW()
     WHERE id = $1::uuid AND tenant_id = $2::uuid
       AND status NOT IN ('CALCULATING', 'CLOSED')
     RETURNING id, status;`,
    [periodId, tenantId]
  );

  if (lockRows.length === 0) {
    return {
      success: false,
      httpStatus: 409,
      error: 'Cálculo concorrente detectado: o período de folha já está sendo processado.',
    };
  }

  const restoreStatus = period.status;

  try {
    const loadedData = await loadPeriodCalculationData(client, {
      tenantId,
      periodId,
      contractIdFilter,
      periodRow: period,
    });

    const calculatedPayslips: RawCalculatedPayslip[] = [];
    const irrfCashEntries: PersistedIrrfCashEntry[] = [];
    const alimonySplits: PersistedAlimonySplit[] = [];
    const results: Array<{ contract_id: string; net: number; status: string }> = [];
    const errors: Array<{ contract_id: string; worker_id: string; error: string }> = [];
    const intraBatchOtherContractsByCpf = new Map<string, OtherEmploymentInput[]>();

    const chunks = chunkArray(loadedData.contracts, 50);
    for (const chunk of chunks) {
      for (const contract of chunk) {
        const outcome = await calculateSingleContract(
          loadedData,
          contract,
          null,
          intraBatchOtherContractsByCpf
        );
        if (outcome.skipped) continue;
        if (outcome.error) {
          errors.push(outcome.error);
          continue;
        }
        if (outcome.payslip) {
          calculatedPayslips.push(outcome.payslip);
          const cleanCpf = String(contract.worker_cpf || '').replace(/\D/g, '');
          if (cleanCpf && outcome.payslip.base_inss > 0) {
            const list = intraBatchOtherContractsByCpf.get(cleanCpf) || [];
            list.push({
              id: contract.id,
              employer_cnpj: contract.company_cnpj || undefined,
              employer_name: `${contract.company_name || 'Grupo'} (Mat. ${contract.registration_number || ''})`.trim(),
              esocial_category_code: '101',
              ind_mv: 1,
              remuneration_amount: outcome.payslip.base_inss,
              inss_withheld: outcome.payslip.inss_employee || 0,
              source: 'INTERNAL_GROUP_CONTRACT',
            });
            intraBatchOtherContractsByCpf.set(cleanCpf, list);
          }
          if (outcome.irrfCashEntry) {
            irrfCashEntries.push(outcome.irrfCashEntry);
          }
          if (outcome.alimonySplits && outcome.alimonySplits.length > 0) {
            alimonySplits.push(...outcome.alimonySplits);
          }
          results.push({
            contract_id: contract.id,
            net: outcome.payslip.net_salary,
            status: outcome.payslip.status || 'CALCULATED',
          });
        }
      }
    }

    if (errors.length > 0) {
      await client.query(
        `UPDATE public.payroll_periods
         SET status = $1, locked_at = NULL, heartbeat_at = NULL, updated_at = NOW()
         WHERE id = $2::uuid;`,
        [restoreStatus, periodId]
      );
      return {
        success: false,
        httpStatus: 422,
        error: 'Erros encontrados no cálculo da folha.',
        errors,
      };
    }

    let existingPayslipsForTaxes: ExistingPayslipBase[] = [];
    if (contractIdFilter) {
      const { rows: otherSlips } = await client.query(
        `SELECT ps.contract_id, c.company_id, ps.base_inss, ps.base_fgts, ps.fgts_month,
                COALESCE(c.calculation_regime, 'CLT') AS calculation_regime,
                COALESCE(c.special_retirement_exposure_code, '01') AS special_retirement_exposure_code,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '901'), 0) AS inss_employee,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '104'), 0) AS maternity_deduction,
                COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '305'), 0) AS family_salary_deduction
         FROM public.payslips ps
         JOIN public.contracts c ON c.id = ps.contract_id
         WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id <> $2::uuid;`,
        [periodId, contractIdFilter]
      );
      existingPayslipsForTaxes = otherSlips.map((p: any) => ({
        contract_id: p.contract_id,
        company_id: p.company_id,
        base_inss: Number(p.base_inss || 0),
        base_fgts: Number(p.base_fgts || 0),
        fgts_month: Number(p.fgts_month || 0),
        inss_employee: Number(p.inss_employee || 0),
        maternity_deduction: Number(p.maternity_deduction || 0),
        family_salary_deduction: Number(p.family_salary_deduction || 0),
        calculation_regime: p.calculation_regime,
        special_retirement_exposure_code: p.special_retirement_exposure_code,
      }));
    }

    const consolidatedCompanyTotals = aggregateCompanyBases({
      calculatedPayslips: calculatedPayslips.map((p) => ({
        contract_id: p.contract_id,
        base_inss: p.base_inss,
        base_fgts: p.base_fgts,
        fgts_month: p.fgts_month,
        inss_employee: p.inss_employee,
        maternity_deduction: p.maternity_deduction,
        family_salary_deduction: p.family_salary_deduction,
        calculation_regime: p.calculation_regime,
        special_retirement_exposure_code: p.special_retirement_exposure_code,
      })),
      existingPayslips: existingPayslipsForTaxes,
      contractCompanyMap: loadedData.contractCompanyMap,
    });

    const companyTaxes = calculateConsolidatedEmployerTaxes({
      tenant_id: tenantId,
      period_id: periodId,
      competence_year: loadedData.period.year,
      companyTotals: consolidatedCompanyTotals,
      companies: loadedData.companies,
    });

    const atomicPayload = buildAtomicPayrollPayload({
      tenant_id: tenantId,
      period_id: periodId,
      contract_id_filter: contractIdFilter,
      payslips: calculatedPayslips,
      company_taxes: companyTaxes,
    });

    const { rows: saveRows } = await client.query(
      `SELECT public.save_payroll_period($1::uuid, $2::jsonb) AS res;`,
      [periodId, JSON.stringify(atomicPayload)]
    );

    await persistIrrfCashLedger(client, {
      tenantId,
      periodId,
      contractIdFilter,
      entries: irrfCashEntries,
    });

    await persistAlimonySplits(client, {
      tenantId,
      periodId,
      contractIdFilter,
      splits: alimonySplits,
    });

    await client.query(
      `UPDATE public.payroll_periods
       SET locked_at = NULL, heartbeat_at = NULL, updated_at = NOW()
       WHERE id = $1::uuid;`,
      [periodId]
    );

    return {
      success: true,
      httpStatus: 200,
      processed: results.length,
      results,
      saveResult: saveRows[0]?.res,
    };
  } catch (err: any) {
    await client.query(
      `UPDATE public.payroll_periods
       SET status = $1, locked_at = NULL, heartbeat_at = NULL, updated_at = NOW()
       WHERE id = $2::uuid AND status = 'CALCULATING';`,
      [restoreStatus, periodId]
    );
    throw err;
  }
}
