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
  aggregateCompanyBases,
  calculateConsolidatedEmployerTaxes,
  buildAtomicPayrollPayload,
  validatePeriodStatusForCalculation,
  isRubricEligibleForCalculation,
  resolveRubricIncidence,
  addMoney,
  divideMoney,
  round2,
  subtractMoney,
  sumMoney,
  type RawCalculatedPayslip,
  type ExistingPayslipBase,
} from '@couplerh/payroll-core';

export const ENGINE_VERSION = '2.2.0';

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

export async function calculatePayrollPeriod(
  client: pg.PoolClient,
  params: CalculatePayrollParams
): Promise<CalculatePayrollResponse> {
  const { tenantId, periodId, contractIdFilter = null } = params;

  // 1. Buscar período de folha
  const { rows: periodRows } = await client.query(
    `SELECT * FROM public.payroll_periods WHERE id = $1::uuid AND tenant_id = $2::uuid;`,
    [periodId, tenantId]
  );

  if (periodRows.length === 0) {
    return { success: false, httpStatus: 404, error: 'Período de folha não encontrado.' };
  }

  const period = periodRows[0];

  // Permite 'OPEN' como alias operacional inicial de 'DRAFT'
  const effectiveStatus = period.status === 'OPEN' ? 'DRAFT' : period.status;
  const statusValidation = validatePeriodStatusForCalculation(effectiveStatus);
  if (!statusValidation.canCalculate) {
    return {
      success: false,
      httpStatus: statusValidation.httpStatus || 400,
      error: statusValidation.error,
    };
  }

  // Trava concorrente atômica
  const { rows: lockRows } = await client.query(
    `UPDATE public.payroll_periods
     SET status = 'CALCULATING', updated_at = NOW()
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
    const companyId = period.company_id;
    if (!companyId) {
      throw new Error('A competência não possui uma empresa associada.');
    }

    const periodStartDate = formatPeriodStartDate(period.year, period.month);
    const daysInMonth = getDaysInMonth(period.year, period.month);
    const endDate = formatDate(period.year, period.month, daysInMonth);

    // 2. Feriados filtrados por tenant e ativos (BUG-10: escopo Nacional/UF/Município aplicado por contrato abaixo)
    const { rows: dbHolidays } = await client.query(
      `SELECT date, type, state_code, city_code, company_id
       FROM public.holidays
       WHERE (tenant_id IS NULL OR tenant_id = $1::uuid)
         AND status = 'ACTIVE'
         AND date >= $2::date
         AND date <= $3::date;`,
      [tenantId, periodStartDate, endDate]
    );

    // 3. Buscar contratos ativos da empresa (sem limite de 1000 linhas - BUG-10)
    let contractsSql = `
      SELECT
        c.id, c.worker_id, c.company_id, c.workplace_id, c.base_salary, c.status,
        c.admission_date, c.receives_advance, c.advance_percentage,
        c.monthly_hours, c.weekly_hours, c.regime, c.incidences AS contract_incidences,
        w.is_apprentice,
        wp.state_code AS workplace_state_code,
        wp.city_code AS workplace_city_code,
        ct.is_clt AS contract_type_is_clt,
        ct.name AS contract_type_name
      FROM public.contracts c
      JOIN public.workers w ON w.id = c.worker_id
      LEFT JOIN public.workplaces wp ON wp.id = c.workplace_id
      LEFT JOIN public.contract_types ct ON ct.id = c.contract_type_id
      WHERE c.tenant_id = $1::uuid
        AND c.company_id = $2::uuid
        AND c.deleted_at IS NULL
        AND c.status = 'ACTIVE'
    `;
    const contractParams: any[] = [tenantId, companyId];

    if (contractIdFilter) {
      contractsSql += ` AND c.id = $3::uuid`;
      contractParams.push(contractIdFilter);
    }

    const { rows: allContracts } = await client.query(contractsSql, contractParams);

    // Se for VACATION sem filtro de contrato, restringe aos contratos com férias aprovadas/pagas que cruzam o mês
    const { rows: vacSchedules } = await client.query(
      `SELECT vs.*
       FROM public.vacation_schedules vs
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

    // 4. Tabelas Legais Vigentes (BUG-06)
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
    const { rows: inssRows } = await client.query(
      `SELECT bracket_number, base_limit, aliquot
       FROM public.inss_parameters
       WHERE legal_version_id = $1::uuid
       ORDER BY bracket_number ASC;`,
      [activeVersion.id]
    );
    const { rows: irrfRows } = await client.query(
      `SELECT bracket_number, base_limit, aliquot, deduction
       FROM public.irrf_parameters
       WHERE legal_version_id = $1::uuid
       ORDER BY bracket_number ASC;`,
      [activeVersion.id]
    );
    const { rows: genRows } = await client.query(
      `SELECT *
       FROM public.general_legal_parameters
       WHERE legal_version_id = $1::uuid
       LIMIT 1;`,
      [activeVersion.id]
    );

    const inss_parameters = inssRows.map((r: any) => ({
      bracket_number: Number(r.bracket_number),
      base_limit: Number(r.base_limit),
      aliquot: Number(r.aliquot),
      deduction: 0,
    }));
    const irrf_parameters = irrfRows.map((r: any) => ({
      bracket_number: Number(r.bracket_number),
      base_limit: r.base_limit !== null ? Number(r.base_limit) : null,
      aliquot: Number(r.aliquot),
      deduction: Number(r.deduction),
    }));
    const rawGen = genRows[0] || null;
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

    // 5. Rubricas ativas e vigentes
    const { rows: dbRubrics } = await client.query(
      `SELECT *
       FROM public.rubrics
       WHERE (tenant_id = $1::uuid OR is_system = TRUE)
         AND deleted_at IS NULL;`,
      [tenantId]
    );

    const rubricContext: RubricContext =
      period.type === 'VACATION'
        ? 'VACATION'
        : ['13TH', 'THIRTEENTH_1', 'THIRTEENTH_2'].includes(period.type)
          ? 'THIRTEENTH'
          : period.type === 'TERMINATION'
            ? 'TERMINATION'
            : 'MONTHLY';

    const rubricas: Rubric[] = dbRubrics
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

    // 6. Dados complementares (empresas, eventos fixos, variáveis, benefícios, deduções, dependentes, empréstimos)
    const { rows: companies } = await client.query(
      `SELECT id, labor_config, tax_regime FROM public.companies WHERE tenant_id = $1::uuid AND deleted_at IS NULL;`,
      [tenantId]
    );

    let fixedEvents: any[] = [];
    let variableEvents: any[] = [];
    let employeeBenefits: any[] = [];
    let employeeDeductions: any[] = [];
    let employeeLoans: any[] = [];
    let allDependents: any[] = [];
    let existingCompetencePayslips: any[] = [];

    if (contractIds.length > 0) {
      const { rows: feRows } = await client.query(
        `SELECT * FROM public.payroll_fixed_events
         WHERE tenant_id = $1::uuid
           AND contract_id = ANY($2::uuid[])
           AND is_active = TRUE
           AND valid_from <= $3::date
           AND (valid_to IS NULL OR valid_to >= $4::date);`,
        [tenantId, contractIds, endDate, periodStartDate]
      );
      fixedEvents = feRows;

      const { rows: veRows } = await client.query(
        `SELECT * FROM public.payroll_variable_events
         WHERE tenant_id = $1::uuid
           AND payroll_period_id = $2::uuid
           AND contract_id = ANY($3::uuid[]);`,
        [tenantId, periodId, contractIds]
      );
      variableEvents = veRows;

      const { rows: ebRows } = await client.query(
        `SELECT eb.*, bc.rubric_id, bc.max_deduction_percentage, bc.benefit_type
         FROM public.employee_benefits eb
         JOIN public.benefit_catalogs bc ON bc.id = eb.benefit_catalog_id
         WHERE eb.tenant_id = $1::uuid
           AND eb.contract_id = ANY($2::uuid[])
           AND eb.is_active = TRUE
           AND eb.start_date <= $3::date
           AND (eb.end_date IS NULL OR eb.end_date >= $4::date);`,
        [tenantId, contractIds, endDate, periodStartDate]
      );
      employeeBenefits = ebRows;

      const { rows: dedRows } = await client.query(
        `SELECT * FROM public.employee_deductions
         WHERE tenant_id = $1::uuid
           AND contract_id = ANY($2::uuid[])
           AND is_active = TRUE
           AND deleted_at IS NULL;`,
        [tenantId, contractIds]
      );
      employeeDeductions = dedRows;

      const { rows: loanRows } = await client.query(
        `SELECT * FROM public.payroll_loans
         WHERE tenant_id = $1::uuid
           AND contract_id = ANY($2::uuid[])
           AND is_active = TRUE;`,
        [tenantId, contractIds]
      );
      employeeLoans = loanRows;

      if (period.type !== 'THIRTEENTH_1' && period.type !== 'THIRTEENTH_2') {
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
    }

    if (workerIds.length > 0) {
      const { rows: depRows } = await client.query(
        `SELECT * FROM public.dependents
         WHERE tenant_id = $1::uuid
           AND worker_id = ANY($2::uuid[])
           AND deleted_at IS NULL
           AND is_irrf_dependent = TRUE;`,
        [tenantId, workerIds]
      );
      allDependents = depRows;
    }

    // Agrupa eventos fixos por contrato (BUG-01 fix: elimina ReferenceError fixedEventsByContract)
    const fixedEventsByContract: Record<string, any[]> = {};
    for (const fe of fixedEvents) {
      if (!fixedEventsByContract[fe.contract_id]) {
        fixedEventsByContract[fe.contract_id] = [];
      }
      fixedEventsByContract[fe.contract_id].push(fe);
    }

    // Adiantamentos do mês (se folha MENSAL)
    let advancePayslips: any[] = [];
    if (period.type === 'MONTHLY' && contractIds.length > 0) {
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

    // Adiantamentos de 13º no ano (se folha THIRTEENTH_2) — BUG-03
    let thirteenthAdvancesByContract: Record<string, { amount: number; fgtsBase: number }> = {};
    if (period.type === 'THIRTEENTH_2' && contractIds.length > 0) {
      const { rows: thAdvRows } = await client.query(
        `SELECT ps.contract_id, pi.amount, ps.base_fgts
         FROM public.payslip_items pi
         JOIN public.payslips ps ON ps.id = pi.payslip_id
         JOIN public.payroll_periods pp ON pp.id = ps.payroll_period_id
         WHERE ps.tenant_id = $1::uuid
           AND ps.contract_id = ANY($2::uuid[])
           AND pp.year = $3
           AND pp.type = 'THIRTEENTH_1'
           AND pp.status IN ('CLOSED', 'APPROVED', 'CALCULATED')
           AND pi.rubric_code IN ('601', '602', '405');`,
        [tenantId, contractIds, period.year]
      );
      for (const row of thAdvRows) {
        if (!thirteenthAdvancesByContract[row.contract_id]) {
          thirteenthAdvancesByContract[row.contract_id] = { amount: 0, fgtsBase: 0 };
        }
        thirteenthAdvancesByContract[row.contract_id].amount = addMoney(
          thirteenthAdvancesByContract[row.contract_id].amount,
          Number(row.amount || 0)
        );
        thirteenthAdvancesByContract[row.contract_id].fgtsBase = addMoney(
          thirteenthAdvancesByContract[row.contract_id].fgtsBase,
          Number(row.base_fgts || row.amount || 0)
        );
      }
    }

    const contractCompanyMap: Record<string, string> = {};
    for (const c of contracts) {
      if (c.id && c.company_id) contractCompanyMap[c.id] = c.company_id;
    }

    const calculatedPayslips: RawCalculatedPayslip[] = [];
    const results: Array<{ contract_id: string; net: number; status: string }> = [];
    const errors: Array<{ contract_id: string; worker_id: string; error: string }> = [];

    // 7. Processamento de cada contrato
    for (const contract of contracts) {
      const admissionStr = toDateStr(contract.admission_date);
      if (shouldSkipFutureAdmission(admissionStr, period.year, period.month)) {
        continue;
      }

      const baseSalary = Number(contract.base_salary || 0);
      const eventos: any[] = [];
      let applicableRubrics = rubricas.map((r) => structuredClone(r));
      let fgtsBaseAlreadyTaxed = 0;

      if (period.type === 'ADVANCE') {
        if (contract.receives_advance === false) continue;
        const rAdv = applicableRubrics.find((r) => r.code === '250');
        if (!rAdv) {
          throw new Error('Rubrica de Adiantamento [250] ausente no catálogo.');
        }
        applicableRubrics = [rAdv];
        const advPct = Number(contract.advance_percentage ?? rAdv.percentage ?? 40);
        eventos.push({
          rubric_id: rAdv.id,
          manual_value: round2(baseSalary * (advPct / 100)),
          quantity: 1,
        });
      } else if (period.type === 'VACATION') {
        const contractVacations = vacSchedules.filter((v: any) => v.contract_id === contract.id);
        if (contractVacations.length === 0) continue;

        applicableRubrics = applicableRubrics.filter((r) => {
          if (r.rubric_kind === 'FAMILY_SALARY') return false;
          return ['501', '502', '503', '504', '701', '702', '703', '704', '601', '901', '902', '903'].includes(r.code);
        });

        // BUG-01: Base de férias soma salário base + adicionais fixos do contrato (CLT art. 142 §5º)
        let baseRemuneracao = baseSalary;
        const contractFixedEvents = fixedEventsByContract[contract.id] || [];
        for (const fe of contractFixedEvents) {
          const rub = rubricas.find((r) => r.id === fe.rubric_id);
          if (rub && rub.type === 'EARNING') {
            if (fe.value_type === 'PERCENT') {
              const refBase =
                rub.calculation_base === 'SALARIO_MINIMO'
                  ? Number(general_legal_parameters!.minimum_wage)
                  : baseSalary;
              baseRemuneracao = addMoney(
                baseRemuneracao,
                round2(refBase * (Number(fe.percentage || 0) / 100))
              );
            } else {
              baseRemuneracao = addMoney(baseRemuneracao, Number(fe.amount || 0));
            }
          }
        }

        const totalDaysTaken = contractVacations.reduce((acc: number, v: any) => acc + Number(v.days_count || 0), 0);
        const totalCashAllowanceDays = contractVacations.reduce(
          (acc: number, v: any) => acc + Number(v.sell_days_count || 0),
          0
        );
        const hasAdvance13th = contractVacations.some((v: any) => Boolean(v.wants_thirteenth_advance));

        const rVac = applicableRubrics.find((r) => r.code === '701') || applicableRubrics.find((r) => r.code === '501');
        const rVacThird = applicableRubrics.find((r) => r.code === '702') || applicableRubrics.find((r) => r.code === '502');

        if (rVac && totalDaysTaken > 0) {
          const valVac = round2((baseRemuneracao / 30) * totalDaysTaken);
          eventos.push({ rubric_id: rVac.id, manual_value: valVac, quantity: totalDaysTaken });

          if (rVacThird) {
            const valThird = divideMoney(valVac, 3); // BUG-06: 1/3 exato
            eventos.push({ rubric_id: rVacThird.id, manual_value: valThird, quantity: 1 });
          }
        }

        if (totalCashAllowanceDays > 0) {
          const rAbono = applicableRubrics.find((r) => r.code === '703') || applicableRubrics.find((r) => r.code === '503');
          const rAbonoThird = applicableRubrics.find((r) => r.code === '704') || applicableRubrics.find((r) => r.code === '504');
          if (rAbono) {
            const valAbono = round2((baseRemuneracao / 30) * totalCashAllowanceDays);
            eventos.push({ rubric_id: rAbono.id, manual_value: valAbono, quantity: totalCashAllowanceDays });
            if (rAbonoThird) {
              eventos.push({ rubric_id: rAbonoThird.id, manual_value: divideMoney(valAbono, 3), quantity: 1 });
            }
          }
        }

        if (hasAdvance13th) {
          const r13Adv = applicableRubrics.find((r) => r.code === '601');
          if (r13Adv) {
            eventos.push({ rubric_id: r13Adv.id, manual_value: divideMoney(baseSalary, 2), quantity: 1 });
          }
        }
      } else if (period.type === 'THIRTEENTH_1' || period.type === 'THIRTEENTH_2') {
        const avosResult = calculateThirteenthAvos(admissionStr, period.year, period.month || 12);
        const avos = avosResult.totalAvos;
        const variableAverages = 0;

        if (period.type === 'THIRTEENTH_1') {
          // BUG-03: Incluir 903 (FGTS) junto com a rubrica da 1ª parcela (601)
          applicableRubrics = applicableRubrics.filter((r) => ['601', '903'].includes(r.code));
          const r601 = applicableRubrics.find((r) => r.code === '601');
          if (r601 && avos > 0) {
            const vals = calculateThirteenthValues(baseSalary, variableAverages, avos, 'THIRTEENTH_1');
            eventos.push({ rubric_id: r601.id, manual_value: vals.firstInstallmentGross, quantity: avos });
          }
        } else {
          // BUG-03: 2ª parcela desconta adiantamento e calcula FGTS diferencial exato
          applicableRubrics = applicableRubrics.filter((r) =>
            ['602', '603', '901', '902', '903'].includes(r.code)
          );
          const advInfo = thirteenthAdvancesByContract[contract.id] || { amount: 0, fgtsBase: 0 };
          fgtsBaseAlreadyTaxed = advInfo.fgtsBase;

          const vals = calculateThirteenthValues(
            baseSalary,
            variableAverages,
            avos,
            'THIRTEENTH_2',
            advInfo.amount
          );

          const r602 = applicableRubrics.find((r) => r.code === '602');
          if (r602 && avos > 0) {
            eventos.push({ rubric_id: r602.id, manual_value: vals.secondInstallmentGross, quantity: avos });
          }
          if (vals.advanceDeduction > 0) {
            const r603 = applicableRubrics.find((r) => r.code === '603');
            if (r603) {
              eventos.push({ rubric_id: r603.id, manual_value: vals.advanceDeduction, quantity: 1 });
            }
          }
        }
      } else {
        // Folha Mensal / Complementar
        applicableRubrics = applicableRubrics.filter((r) => {
          const c = r.code || '';
          const n = (r.name || '').toLowerCase();
          if (['601', '602', '603', '701', '702', '703', '704'].includes(c)) return false;
          if (n.includes('férias') || n.includes('13º') || n.includes('décimo terceiro')) return false;
          return true;
        });

        const salarioRubric = applicableRubrics.find(
          (r) =>
            r.rubric_kind === 'SALARY_BASE' ||
            r.code === '101' ||
            r.code === '1001'
        );
        if (salarioRubric) {
          eventos.push({ rubric_id: salarioRubric.id, quantity: 30, manual_value: null });
        }

        // Eventos fixos do contrato
        const contractFixed = fixedEventsByContract[contract.id] || [];
        for (const fe of contractFixed) {
          eventos.push({
            rubric_id: fe.rubric_id,
            manual_value: fe.value_type === 'PERCENT' ? null : Number(fe.amount || 0),
            percentage: fe.value_type === 'PERCENT' ? Number(fe.percentage || 0) : undefined,
            value_type: fe.value_type || 'AMOUNT',
            quantity: 1,
          });
        }

        // Benefícios ativos
        const contractBenefits = employeeBenefits.filter((b: any) => b.contract_id === contract.id);
        for (const eb of contractBenefits) {
          if (!eb.rubric_id) continue;
          const discountVal = Number(eb.employee_discount || 0);
          if (discountVal > 0) {
            eventos.push({ rubric_id: eb.rubric_id, manual_value: discountVal, quantity: 1 });
          }
        }

        // Desconto de adiantamento salarial (rubrica 850)
        if (period.type === 'MONTHLY') {
          const adv = advancePayslips.find((a) => a.contract_id === contract.id);
          if (adv && Number(adv.total_earnings) > 0) {
            const r850 = applicableRubrics.find((r) => r.code === '850');
            if (r850) {
              eventos.push({ rubric_id: r850.id, manual_value: Number(adv.total_earnings), quantity: 1 });
            }
          }

          // Empréstimos consignados (rubrica 805)
          const cLoans = employeeLoans.filter((l: any) => l.contract_id === contract.id);
          for (const loan of cLoans) {
            const instVal = round2(Number(loan.installment_amount || 0));
            const r805 = applicableRubrics.find((r) => r.code === '805');
            if (r805 && instVal > 0) {
              eventos.push({ rubric_id: r805.id, manual_value: instVal, quantity: 1 });
            }
          }
        }
      }

      // Eventos variáveis da competência (BUG-04: manual_value null/0 não trava quantidade sem force_zero_override)
      const contractVars = variableEvents.filter((v: any) => v.contract_id === contract.id);
      for (const v of contractVars) {
        eventos.push({
          rubric_id: v.rubric_id,
          manual_value: v.manual_value !== null && v.manual_value !== undefined ? Number(v.manual_value) : null,
          force_zero_override: Boolean(v.force_zero_override),
          quantity: v.quantity !== null && v.quantity !== undefined ? Number(v.quantity) : 1,
          origin: v.origin,
        });
      }

      // Deduções fixas elegíveis (BUG-10: respeitar total_limit inclusive em percentuais)
      const contractDeds = employeeDeductions.filter((d: any) =>
        isDeductionEligibleForPeriod(
          {
            ...d,
            start_date: toDateStr(d.start_date) || undefined,
            end_date: toDateStr(d.end_date) || null,
            value: d.amount_type === 'PERCENTAGE' ? Number(d.percentage || 0) : Number(d.fixed_amount || 0),
          },
          period.type,
          period.year,
          period.month
        )
      );

      for (const d of contractDeds) {
        if (!d.rubric_id) continue;
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
            const rub = rubricas.find((r) => r.id === d.rubric_id);
            if (rub) applicableRubrics.push(structuredClone(rub));
          }
        }
      }

      // Dias trabalhados + férias sobrepostas no mês
      let diasTrabalhados = calculateWorkingDays(admissionStr, period.year, period.month);
      if (period.type === 'MONTHLY') {
        const contractVacations = vacSchedules
          .filter((v: any) => v.contract_id === contract.id)
          .map((v: any) => ({
            id: v.id,
            contract_id: v.contract_id,
            start_date: toDateStr(v.start_date),
            end_date: toDateStr(v.end_date),
            days_taken: Number(v.days_count),
            status: 'APPROVED_DP',
          }));
        if (contractVacations.length > 0 && isVacationCrossingMonth(contractVacations[0].start_date, contractVacations[0].end_date, period.year, period.month)) {
          const vacRes = calculateVacationDaysInMonth(contractVacations, period.year, period.month, diasTrabalhados);
          diasTrabalhados = vacRes.remainingWorkedDays;
        }
      }

      // BUG-10: Feriados filtrados por âmbito da lotação (Nacional / UF / Município IBGE / Empresa)
      const applicableHolidaysSet = new Set<string>();
      for (const h of dbHolidays) {
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
      for (let day = 1; day <= daysInMonth; day++) {
        const dt = new Date(Date.UTC(period.year, period.month - 1, day));
        const dStr = formatDate(period.year, period.month, day);
        if (dt.getUTCDay() === 0 || applicableHolidaysSet.has(dStr)) {
          diasInuteis++;
        } else {
          diasUteis++;
        }
      }

      const divisor = Number(contract.monthly_hours || 220);

      // Dependentes elegíveis IRRF
      const workerDeps = allDependents
        .filter((d: any) => d.worker_id === contract.worker_id)
        .map((d: any) => ({
          id: d.id,
          cpf: d.cpf,
          birth_date: toDateStr(d.birth_date),
          relationship: d.relationship,
          is_irrf_dependent: d.is_irrf_dependent,
          is_incapacitated: d.is_incapacitated,
        }));
      const depEval = evaluateIRRFDependents(workerDeps, period.year, period.month);

      const isApprentice = Boolean(
        contract.is_apprentice ||
          String(contract.regime || '').toUpperCase() === 'APPRENTICE' ||
          String(contract.contract_type_name || '').toLowerCase().includes('aprendiz')
      );

      // BUG-02: Consolidação T16 INSS usando addMoney (eliminado sumMoney(sum, ...))
      const previousBaseInss = existingCompetencePayslips
        .filter((p: any) => p.contract_id === contract.id)
        .reduce((sum: number, p: any) => addMoney(sum, Number(p.base_inss) || 0), 0);

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
        base_inss_already_taxed: previousBaseInss,
        fgts_base_already_taxed: fgtsBaseAlreadyTaxed,
        contract_incidences: contract.contract_incidences,
        inss_parameters,
        irrf_parameters,
        general_legal_parameters,
      });

      const engine = new PayrollEngine(context);
      const result = await engine.run();

      if (result.status && result.status.startsWith('ERRO_CALCULO')) {
        errors.push({
          contract_id: contract.id,
          worker_id: contract.worker_id,
          error: result.status,
        });
        continue;
      }

      const validRubricIds = new Set(rubricas.map((r) => r.id));
      const rawItems = result.memoria_calculo
        .filter((m) => m.result_value > 0 && validRubricIds.has(m.rubric_id))
        .map((m) => {
          const rub = rubricas.find((r) => r.id === m.rubric_id);
          return {
            rubric_id: m.rubric_id,
            rubric_version_id: m.rubric_id,
            reference: m.quantity_used ? String(m.quantity_used) : null,
            amount: m.result_value,
            type: rub?.type || 'EARNING',
          };
        });

      const sumEarnings = sumMoney(rawItems.filter((i) => i.type === 'EARNING').map((i) => i.amount));
      const sumDeductions = sumMoney(rawItems.filter((i) => i.type === 'DEDUCTION').map((i) => i.amount));

      const diffE = Math.abs(subtractMoney(sumEarnings, result.total_proventos));
      const diffD = Math.abs(subtractMoney(sumDeductions, result.total_descontos));
      if (diffE > 0.01 || diffD > 0.01) {
        errors.push({
          contract_id: contract.id,
          worker_id: contract.worker_id,
          error: `Invariante contábil violada no contrato ${contract.id}: proventos (${sumEarnings} vs ${result.total_proventos}), descontos (${sumDeductions} vs ${result.total_descontos}).`,
        });
        continue;
      }

      calculatedPayslips.push({
        contract_id: contract.id,
        total_earnings: result.total_proventos,
        total_deductions: result.total_descontos,
        net_salary: result.liquido,
        base_inss: result.bases.inss,
        base_irrf: result.bases.irrf,
        base_fgts: result.bases.fgts,
        fgts_month: result.total_fgts,
        status: 'CALCULATED',
        legal_version_id: activeVersion.id,
        engine_version: ENGINE_VERSION,
        inss_table_version: activeVersion.code,
        irrf_table_version: activeVersion.code,
        fgts_table_version: activeVersion.code,
        items: rawItems,
        memory: result.memoria_calculo.map((m) => ({
          rubric_id: validRubricIds.has(m.rubric_id) ? m.rubric_id : null,
          step_name: m.step_name,
          base_value: m.base_value,
          quantity_used: m.quantity_used,
          percentage_used: m.percentage_used,
          parsed_formula: m.parsed_formula,
          result_value: m.result_value,
          origin: m.origin || 'ENGINE',
          engine_version: ENGINE_VERSION,
        })),
      });

      results.push({ contract_id: contract.id, net: result.liquido, status: result.status });
    }

    if (errors.length > 0) {
      await client.query(
        `UPDATE public.payroll_periods SET status = $1, updated_at = NOW() WHERE id = $2::uuid;`,
        [restoreStatus, periodId]
      );
      return {
        success: false,
        httpStatus: 422,
        error: 'Erros encontrados no cálculo da folha.',
        errors,
      };
    }

    // 8. Encargos patronais agregados com soma REAL do fgts_month (BUG-09)
    let existingPayslipsForTaxes: ExistingPayslipBase[] = [];
    if (contractIdFilter) {
      const { rows: otherSlips } = await client.query(
        `SELECT ps.contract_id, c.company_id, ps.base_inss, ps.base_fgts, ps.fgts_month
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
      }));
    }

    const consolidatedCompanyTotals = aggregateCompanyBases({
      calculatedPayslips: calculatedPayslips.map((p) => ({
        contract_id: p.contract_id,
        base_inss: p.base_inss,
        base_fgts: p.base_fgts,
        fgts_month: p.fgts_month,
      })),
      existingPayslips: existingPayslipsForTaxes,
      contractCompanyMap,
    });

    const companyTaxes = calculateConsolidatedEmployerTaxes({
      tenant_id: tenantId,
      period_id: periodId,
      companyTotals: consolidatedCompanyTotals,
      companies,
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

    return {
      success: true,
      httpStatus: 200,
      processed: results.length,
      results,
      saveResult: saveRows[0]?.res,
    };
  } catch (err: any) {
    await client.query(
      `UPDATE public.payroll_periods SET status = $1, updated_at = NOW() WHERE id = $2::uuid AND status = 'CALCULATING';`,
      [restoreStatus, periodId]
    );
    throw err;
  }
}
