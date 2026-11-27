import { normalizeVariableName } from '../variablesCatalog.js';
import type { IrrfTaxationBucket, PriorIrrfCashEntry } from '../legal/IRRFCalculator.js';
import type {
  AlimonyBeneficiaryRule,
  AlimonySplitResult,
  AlimonySolverTraceStep,
} from '../legal/AlimonySolver.js';
import type {
  FamilyAllowanceCalculationResult,
  FamilyAllowanceDependentInput,
} from '../legal/FamilyAllowanceCalculator.js';
import type {
  IndMVCode,
  OtherEmploymentInput,
} from '../legal/MultipleEmploymentINSSCalculator.js';
import type { CollectiveAgreementData } from '../legal/CollectiveAgreementCalculator.js';
import type { AutonomousServiceType, CalculationRegimeType } from '../legal/MultiRegimeCalculator.js';

export type RubricKind =
  | 'SALARY_BASE'
  | 'OVERTIME'
  | 'DSR'
  | 'DSR_NOTURNO'
  | 'ADIC_NOTURNO'
  | 'INSALUBRIDADE'
  | 'PERICULOSIDADE'
  | 'ABSENCE'
  | 'LATE'
  | 'COMMISSION'
  | 'FAMILY_SALARY'
  | 'ALIMONY'
  | 'LOAN'
  | 'UNION'
  | 'ADVANCE'
  | 'BENEFIT'
  | 'VACATION'
  | 'THIRTEENTH'
  | 'TERMINATION'
  | 'MATERNITY_LEAVE'
  | 'SICK_LEAVE_COMPANY'
  | 'UNPAID_LEAVE'
  | 'FGTS_COMPULSORY_BASE'
  | 'INSS'
  | 'IRRF'
  | 'FGTS'
  | 'NIGHT_SHIFT'
  | 'UNHEALTHY'
  | 'HAZARD'
  | 'INSUFFICIENCY_CREDIT'
  | 'INSUFFICIENCY_DEBIT'
  | 'OTHER';

export interface Rubric {
  id: string;
  code: string;
  name: string;
  type: 'EARNING' | 'DEDUCTION' | 'NEUTRAL';
  category: string;
  rubric_kind?: RubricKind;
  manual_value?: number;
  status?: 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'RETIRED';
  is_system?: boolean;
  esocial_nature?: string;
  legal_basis?: string;
  version?: number;
  calculation_form: string;
  calculation_base?: string;
  percentage?: number;
  quantity?: number;
  divisor?: number;
  factor?: number;
  formula?: string;
  calculation_order: number;
  discount_priority?: number | null;
  average_type?: 'NONE' | 'HOURS_QUANTITY' | 'MONETARY_VALUE' | 'MONETARY_INDEXED';
  include_in_vacation_avg?: boolean;
  include_in_13th_avg?: boolean;
  include_in_notice_avg?: boolean;
  incidencias: {
    inss: boolean;
    irrf: boolean;
    fgts: boolean;
    inss_patronal: boolean;
    rat: boolean;
    terceiros: boolean;
    gera_base_inss: boolean;
    gera_base_irrf: boolean;
    gera_base_fgts: boolean;
    integra_dsr?: boolean;
    irrf_mode?: 'NORMAL' | 'EXCLUSIVO' | 'TABELA_PLR' | 'ISENTO';
    media_ferias?: boolean;
    media_13?: boolean;
  };
}

export interface PayrollEvent {
  id?: string;
  rubric_id: string;
  quantity?: number;
  reference?: string;
  manual_value?: number | null;
  force_zero_override?: boolean;
  percentage?: number;
  value_type?: 'AMOUNT' | 'PERCENT';
  origin?: string;
}

export interface CalculationMemory {
  rubric_id: string;
  step_name: string;
  base_value: number;
  quantity_used: number;
  percentage_used: number;
  parsed_formula: string;
  result_value: number;
  origin: string;
}

export interface IrrfCashLedgerSnapshot {
  cash_year: number;
  cash_month: number;
  payment_date: string;
  taxation_bucket: IrrfTaxationBucket;
  gross_taxable: number;
  inss_deducted: number;
  alimony_deducted: number;
  dependents_deducted: number;
  simplified_used: boolean;
  irrf_withheld: number;
}

export type NegativeNetPolicy = 'BLOCK' | 'INSUFFICIENCY_CARRYOVER' | 'CAP_OPTIONAL_DISCOUNTS';

export interface LoanRecordInput {
  id: string;
  contract_id: string;
  financial_institution: string;
  contract_number: string;
  total_amount: number;
  installment_amount: number;
  total_installments: number;
  paid_installments: number;
  start_date: string;
  is_active: boolean;
  status?: string;
}

export interface BalanceDebtRecordInput {
  id: string;
  contract_id: string;
  amount: number;
  balance_remaining: number;
  competence_year: number;
  competence_month: number;
  target_year: number;
  target_month: number;
  status: string;
}

export interface CalculationResult {
  total_proventos: number;
  total_descontos: number;
  total_inss: number;
  total_irrf: number;
  total_fgts: number;
  total_encargos_patronais: number;
  liquido: number;
  bases: {
    inss: number;
    irrf: number;
    fgts: number;
  };
  memoria_calculo: CalculationMemory[];
  irrf_cash_ledger_entry?: IrrfCashLedgerSnapshot | null;
  alimony_splits?: AlimonySplitResult[];
  alimony_solver_trace?: AlimonySolverTraceStep[];
  total_family_salary?: number;
  family_salary_evaluation?: FamilyAllowanceCalculationResult | null;
  ind_mv?: IndMVCode | null;
  other_employments_base?: number;
  other_employments_inss?: number;
  has_insufficiency?: boolean;
  insufficiency_credit?: number;
  consignable_margin?: number;
  consignable_loan_capped?: boolean;
  status: string;
}

export interface InssBracket {
  bracket_number: number;
  base_limit: number | null;
  aliquot: number;
  deduction: number;
}

export interface IrrfBracket {
  bracket_number: number;
  base_limit: number | null;
  aliquot: number;
  deduction: number;
}

export interface GeneralLegalParameters {
  minimum_wage?: number;
  dependent_deduction?: number;
  simplified_discount?: number;
  family_salary_quota?: number;
  family_salary_value?: number;
  family_salary_limit?: number;
  family_salary_ceiling?: number;
  fgts_standard_aliquot?: number;
  fgts_apprentice_aliquot?: number;
  irrf_exemption_limit?: number;
  irrf_reduction_formula_limit?: number;
  irrf_base_reduction?: number;
  irrf_reduction_a?: number;
  irrf_reduction_b?: number;
}

export interface PayrollContextData {
  competencia: string; 
  tipo_folha: string;
  empregado_id: string;
  contrato_id: string;
  salario_base: number;
  dias_trabalhados: number;
  dias_uteis: number;
  dias_inuteis: number;
  divisor: number;
  num_dependentes?: number;
  is_apprentice?: boolean;
  rubricas: Rubric[];
  eventos: PayrollEvent[];
  contract_incidences?: any;
  inss_parameters?: InssBracket[];
  irrf_parameters?: IrrfBracket[];
  general_legal_parameters?: GeneralLegalParameters;
  collective_agreement?: CollectiveAgreementData | null;
}

export class PayrollContext {
  competencia: string;
  tipo_folha: string;
  empregado_id: string;
  contrato_id: string;
  salario_base: number;
  dias_trabalhados: number;
  dias_uteis: number;
  dias_inuteis: number;
  divisor: number;
  salario_minimo: number;
  rubricas: Map<string, Rubric>;
  eventos: PayrollEvent[];
  contract_incidences?: any;
  inss_parameters?: InssBracket[];
  irrf_parameters?: IrrfBracket[];
  general_legal_parameters?: GeneralLegalParameters;
  allow_cumulative_hazard_allowances: boolean = false;
  is_apprentice: boolean = false;
  // T16: Base de INSS já tributada em outras folhas da mesma competência (férias, complementar, etc.)
  base_inss_already_taxed: number = 0;
  // BUG-03: Base de FGTS já tributada na 1ª parcela do 13º (para cálculo diferencial exato na 2ª parcela)
  fgts_base_already_taxed: number = 0;
  // T17: Total de pensão alimentícia judicial apurada (dedutível da base de IRRF)
  total_alimony: number = 0;
  // FOLHA-02: IRRF em Regime de Caixa (Lei 7.713/88 / IN RFB 1.500)
  irrf_regime: 'CASH' | 'COMPETENCE' = 'CASH';
  payment_date?: string | null;
  withhold_irrf_on_advance: boolean = false;
  prior_cash_irrf_entries: PriorIrrfCashEntry[] = [];
  // FOLHA-03: Beneficiários estruturados de pensão alimentícia para solver circular e splits
  alimony_beneficiaries: AlimonyBeneficiaryRule[] = [];
  // FOLHA-05: Salário-Família automático e elegibilidade de dependentes/vínculo
  family_salary_dependents: FamilyAllowanceDependentInput[] = [];
  admission_date?: string | null = null;
  termination_date?: string | null = null;
  employee_regime: string = 'CLT';
  has_unpaid_or_inss_only_month: boolean = false;
  // FOLHA-06: Múltiplos vínculos previdenciários (outro empregador / mesmo CPF no grupo)
  other_employments: OtherEmploymentInput[] = [];
  // FOLHA-07: Prioridade de descontos, política de saldo devedor e consignados
  negative_net_policy: NegativeNetPolicy = 'INSUFFICIENCY_CARRYOVER';
  loans: LoanRecordInput[] = [];
  prior_balance_debts: BalanceDebtRecordInput[] = [];
  // FOLHA-09: Sindicatos e Convenção Coletiva de Trabalho (CCT / ACT)
  collective_agreement?: CollectiveAgreementData | null = null;
  // FOLHA-11: Rateio de INSS/FGTS em férias partidas entre dois meses (mantendo IRRF integral no caixa)
  vacation_inss_base_override?: number | null = null;
  vacation_fgts_base_override?: number | null = null;
  // FOLHA-12: 13º Salário Complementar em Janeiro (Decreto 10.854/2021 art. 79)
  prior_thirteenth_irrf_entry?: PriorIrrfCashEntry | null = null;
  // FOLHA-15: Multi-Regime eSocial (Pró-Labore, Autônomo/RPA, Estagiário, Intermitente, Horista/Comissionista)
  calculation_regime: CalculationRegimeType = 'CLT';
  esocial_category_code: string = '101';
  autonomous_service_type: AutonomousServiceType = 'GENERAL';
  iss_rate: number = 0;
  
  // Variables tracking
  variables: Record<string, number>;
  
  // Variáveis Acumuladoras Globais (Estado da Máquina)
  base_inss: number = 0;
  base_irrf: number = 0;
  base_fgts: number = 0;

  total_proventos: number = 0;
  total_descontos: number = 0;

  memoria: CalculationMemory[] = [];

  constructor(data: any) {
    this.competencia = data.competencia;
    this.tipo_folha = data.tipo_folha;
    this.empregado_id = data.empregado_id;
    this.contrato_id = data.contrato_id;
    this.salario_base = data.salario_base || 0;
    this.dias_trabalhados = data.dias_trabalhados !== undefined ? data.dias_trabalhados : 30;
    this.dias_uteis = data.dias_uteis !== undefined ? data.dias_uteis : 26;
    this.dias_inuteis = data.dias_inuteis !== undefined ? data.dias_inuteis : 4;
    this.divisor = data.divisor || 220;
    const sm = data.salario_minimo ?? data.general_legal_parameters?.minimum_wage;
    if (!sm || Number(sm) <= 0) {
      throw new Error('Parâmetro legal obrigatório ausente: salario_minimo');
    }
    this.salario_minimo = Number(sm);
    this.rubricas = data.rubricas instanceof Map
      ? new Map(Array.from(data.rubricas.entries() as Iterable<[string, Rubric]>).map(([k, v]) => [k, structuredClone(v)]))
      : new Map((data.rubricas || []).map((r: Rubric) => [r.id, structuredClone(r)]));
    this.eventos = data.eventos || [];
    this.allow_cumulative_hazard_allowances = Boolean(data.allow_cumulative_hazard_allowances);
    this.is_apprentice = Boolean(data.is_apprentice);
    this.base_inss_already_taxed = Number(data.base_inss_already_taxed || 0);
    this.fgts_base_already_taxed = Number(data.fgts_base_already_taxed || 0);
    this.total_alimony = Number(data.total_alimony || 0);
    this.irrf_regime = data.irrf_regime === 'COMPETENCE' ? 'COMPETENCE' : 'CASH';
    this.payment_date = data.payment_date || null;
    this.withhold_irrf_on_advance = Boolean(data.withhold_irrf_on_advance);
    this.prior_cash_irrf_entries = Array.isArray(data.prior_cash_irrf_entries)
      ? data.prior_cash_irrf_entries
      : [];
    this.alimony_beneficiaries = Array.isArray(data.alimony_beneficiaries)
      ? data.alimony_beneficiaries
      : [];
    this.family_salary_dependents = Array.isArray(data.family_salary_dependents)
      ? data.family_salary_dependents
      : [];
    this.admission_date = data.admission_date || null;
    this.termination_date = data.termination_date || null;
    this.employee_regime = data.employee_regime || 'CLT';
    this.has_unpaid_or_inss_only_month = Boolean(data.has_unpaid_or_inss_only_month);
    this.other_employments = Array.isArray(data.other_employments)
      ? data.other_employments
      : [];
    this.negative_net_policy = data.negative_net_policy || 'INSUFFICIENCY_CARRYOVER';
    this.loans = Array.isArray(data.loans) ? data.loans : [];
    this.prior_balance_debts = Array.isArray(data.prior_balance_debts) ? data.prior_balance_debts : [];
    this.collective_agreement = data.collective_agreement || null;
    this.vacation_inss_base_override =
      data.vacation_inss_base_override !== undefined && data.vacation_inss_base_override !== null
        ? Number(data.vacation_inss_base_override)
        : null;
    this.vacation_fgts_base_override =
      data.vacation_fgts_base_override !== undefined && data.vacation_fgts_base_override !== null
        ? Number(data.vacation_fgts_base_override)
        : null;
    this.prior_thirteenth_irrf_entry = data.prior_thirteenth_irrf_entry || null;
    this.calculation_regime = data.calculation_regime || 'CLT';
    this.esocial_category_code = data.esocial_category_code || '101';
    this.autonomous_service_type = data.autonomous_service_type || 'GENERAL';
    this.iss_rate = Number(data.iss_rate || 0);
    this.contract_incidences = data.contract_incidences || null;
    this.inss_parameters = data.inss_parameters || [];
    this.irrf_parameters = data.irrf_parameters || [];
    this.general_legal_parameters = data.general_legal_parameters || {};

    this.memoria = [];  
    this.variables = {
      'SALARIO_BASE': this.salario_base,
      'SALARIO_MINIMO': this.salario_minimo,
      'SALARIO_CONTRATUAL': this.salario_base,
      'DIAS_TRABALHADOS': this.dias_trabalhados,
      'HORAS_TRABALHADAS': this.divisor,
      'DIAS_UTEIS': this.dias_uteis,
      'DIAS_INUTEIS': this.dias_inuteis,
      'DIAS_DSR': this.dias_inuteis,
      'DIVISOR': this.divisor,
      'FATOR': 1,
      'QUANTIDADE': 0,
      'PERCENTUAL': 0,
      'DEPENDENTES': data.num_dependentes ?? data.dependentes ?? 0,
      'BASE_DSR': 0,
      'BASE_DSR_NOTURNO': 0,
      'BASE_HORA_EXTRA': this.salario_base,
      'BASE_HORA_EXTRA_NOTURNA': this.salario_base,
      'BASE_FERIAS': this.salario_base,
      'BASE_13': this.salario_base,
      'PISO_SALARIAL_CCT': Number(this.collective_agreement?.base_salary_floor || 0),
      'ADICIONAL_TEMPO_SERVICO': 0,
      'ATS': 0,
      // Variáveis auxiliares do catálogo de seeds 2026 (valor 0 quando não há evento específico)
      'COTA_FAMILIA': Number(this.general_legal_parameters?.family_salary_value ?? this.general_legal_parameters?.family_salary_quota ?? 0),
      'NUM_DEPENDENTES_SF': 0,
      'PROPORCAO_SF': 1,
      'VALOR_VT': 0,
      'VALOR_FERIAS': 0,
      'VALOR_ADIANTAMENTO_13': 0,
      'DIAS_FERIAS': 0,
      'DIAS_FALTA': 0,
      'DIAS_DSR_PERDIDOS': 0,
      'HORAS_ATRASO': 0,
      'HORAS_EXTRAS_50': 0,
      'HORAS_EXTRAS_100': 0,
      'HORAS_NOTURNAS': 0,
    };

    // T24: Pré-carregar todas as rubricas do catálogo com valor 0 na variável R{code}
    for (const r of Array.from(this.rubricas.values())) {
      if (r.code) {
        this.variables[`R${r.code}`] = 0;
      }
    }
  }

  setVariable(name: string, value: number) {
    this.variables[name] = value;
  }

  getVariable(name: string): number {
    if (name in this.variables) {
      return this.variables[name];
    }
    const normalized = normalizeVariableName(name);
    if (normalized in this.variables) {
      return this.variables[normalized];
    }
    throw new Error(`Variável ou base de cálculo inexistente no contexto: '${name}'`);
  }

  hasVariable(name: string): boolean {
    if (name in this.variables) return true;
    return normalizeVariableName(name) in this.variables;
  }

  addMemory(mem: CalculationMemory) {
    this.memoria.push(mem);
  }
}
