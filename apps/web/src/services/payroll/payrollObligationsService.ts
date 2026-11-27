import { apiClient } from '../../lib/apiClient';

export interface DctfWebInssGuide {
  code: string;
  name: string;
  dueDate: string;
  totalInssSegurados: number;
  inssPatronal: number;
  inssPatronalProLabore?: number;
  ratAdjusted: number;
  ratSpecialRetirementAmount?: number;
  terceiros: number;
  maternityDeduction?: number;
  familySalaryDeduction?: number;
  cprbReductionRatio?: number;
  cprbEffectiveCppRate?: number;
  totalDctfWeb: number;
}

export interface FgtsDigitalGuide {
  code: string;
  name: string;
  dueDate: string;
  baseFgts: number;
  totalFgts: number;
}

export interface DarfIrrfGuide {
  code: string;
  name: string;
  dueDate: string;
  baseIrrf: number;
  totalIrrf: number;
}

export interface TaxGuidesReport {
  competence: string;
  dctfWebInss: DctfWebInssGuide;
  fgtsDigital: FgtsDigitalGuide;
  darfIrrf: DarfIrrfGuide;
  totalTaxesDue: number;
}

export interface EmployeeProvisionResult {
  contractId: string;
  employeeName: string;
  monthlyFerias: number;
  monthlyTercoFerias: number;
  monthlyThirteenth: number;
  chargesFerias: number;
  chargesThirteenth: number;
  totalMonthly: number;
}

export interface PayrollProvisionsReport {
  totalMonthlyFerias: number;
  totalMonthlyTercoFerias: number;
  totalMonthlyThirteenth: number;
  totalChargesFerias: number;
  totalChargesThirteenth: number;
  totalMonthlyLiability: number;
  items: EmployeeProvisionResult[];
}

export interface AccountingEntry {
  entryDate?: string;
  eventKey?: string;
  accountCode: string;
  accountName: string;
  type: 'DEBIT' | 'CREDIT';
  amount: number;
  costCenterCode?: string | null;
  cnoNumber?: string | null;
  history: string;
}

export interface AccountingSummaryReport {
  isBalanced: boolean;
  totalDebit: number;
  totalCredit: number;
  entries: AccountingEntry[];
}

export type AccountingErpFormat = 'DOMINIO' | 'ALTERDATA' | 'PROTHEUS' | 'SENIOR' | 'CSV_CONFIGURABLE';

export interface CostAllocationItem {
  id?: string;
  costCenterId?: string | null;
  costCenterCode?: string | null;
  costCenterName?: string | null;
  projectCode?: string | null;
  tomadorCnpj?: string | null;
  tomadorName?: string | null;
  cnoNumber?: string | null;
  esocialLotacaoCode?: string | null;
  percentage: number;
}

export interface ProvisionLedgerEntry {
  id: string;
  contract_id: string;
  worker_id: string;
  employee_name?: string;
  provision_type: 'VACATION' | 'THIRTEENTH';
  opening_balance: number;
  monthly_accrual: number;
  salary_adjustment_diff: number;
  averages_adjustment: number;
  settlements_paid: number;
  closing_balance: number;
  charges_closing_balance: number;
  net_accounting_entry: number;
  net_charges_entry: number;
  effective_employer_rate: number;
  avos_accumulated: number;
}

export interface ProvisionLedgerResponse {
  totalClosingPrincipal: number;
  totalClosingCharges: number;
  totalNetEntry: number;
  entries: ProvisionLedgerEntry[];
}

export interface ChartAccountItem {
  id: string;
  account_code: string;
  account_name: string;
  reduced_code?: string | null;
  account_type: string;
  nature: 'DEBIT' | 'CREDIT';
  requires_cost_center: boolean;
  is_system_default: boolean;
}

export interface CnabGenerationResponse {
  remittance: {
    id: string;
    bank_code: string;
    bank_name: string;
    payment_channel: string;
    file_name: string;
    file_content: string;
    total_records: number;
    employees_count: number;
    alimony_count: number;
    total_amount: number;
    status: string;
  };
  items: Array<{
    id: string;
    beneficiary_type: 'EMPLOYEE' | 'ALIMONY';
    beneficiary_name: string;
    beneficiary_cpf: string;
    payment_method: string;
    amount: number;
    your_number: string;
    status: string;
    bank_occurrence_message?: string | null;
  }>;
}

export class PayrollObligationsService {
  /**
   * Guias Tributárias Server-Side (zero fórmulas patronais no frontend)
   */
  public async fetchPeriodTaxGuides(periodId: string): Promise<TaxGuidesReport> {
    const apiRes = await apiClient.get<{ success: boolean; data: any }>(
      `/api/v1/payroll/periods/${periodId}/tax-guides`
    );
    if (!apiRes?.success || !apiRes.data) {
      throw new Error('Falha ao obter apuração oficial de guias tributárias no servidor.');
    }

    const g = apiRes.data;
    const p = g.period || {};
    const month = Number(p.month || 1);
    const year = Number(p.year || 2026);
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const pad = (n: number) => String(n).padStart(2, '0');
    const competence = `${pad(month)}/${year}`;
    const dueDate = `20/${pad(nextMonth)}/${nextYear}`;

    const inssSegurados = Number(g.inssEmpregados || 0);
    const inssPatronal = Number(g.inssPatronal || 0);
    const inssPatronalProLabore = Number(g.inssPatronalProLabore || 0);
    const ratAdjusted = Number(g.ratAmount || 0);
    const ratSpecialRetirementAmount = Number(g.ratSpecialRetirementAmount || 0);
    const terceiros = Number(g.terceirosAmount || 0);
    const maternityDeduction = Number(g.maternityDeduction || 0);
    const familySalaryDeduction = Number(g.familySalaryDeduction || 0);
    const cprbReductionRatio = Number(g.cprbReductionRatio || 0);
    const cprbEffectiveCppRate =
      g.cprbEffectiveCppRate !== undefined && g.cprbEffectiveCppRate !== null
        ? Number(g.cprbEffectiveCppRate)
        : undefined;
    const totalDctfWeb = Number(g.totalDarfPrevidenciario || 0);
    const totalFgts = Number(g.totalFgtsDigital || g.fgtsTotal || 0);
    const totalIrrf = Number(g.totalDarfIrrf || g.irrfEmpregados || 0);

    return {
      competence,
      dctfWebInss: {
        code: '0561-INSS',
        name: 'DCTFWeb - Contribuição Previdenciária & Outras Entidades',
        dueDate,
        totalInssSegurados: inssSegurados,
        inssPatronal,
        inssPatronalProLabore,
        ratAdjusted,
        ratSpecialRetirementAmount,
        terceiros,
        maternityDeduction,
        familySalaryDeduction,
        cprbReductionRatio,
        cprbEffectiveCppRate,
        totalDctfWeb,
      },
      fgtsDigital: {
        code: 'FGTS-DIG',
        name: 'FGTS Digital (GRF Mensal)',
        dueDate,
        baseFgts: Number(g.totalBaseFgts || 0),
        totalFgts,
      },
      darfIrrf: {
        code: '0561-IRRF',
        name: 'DARF - Imposto de Renda Retido na Fonte',
        dueDate,
        baseIrrf: Number(g.totalBaseIrrf || 0),
        totalIrrf,
      },
      totalTaxesDue: Math.round((totalDctfWeb + totalFgts + totalIrrf) * 100) / 100,
    };
  }

  public async fetchPeriodProvisions(periodId: string): Promise<PayrollProvisionsReport> {
    const apiRes = await apiClient.get<{ success: boolean; data: PayrollProvisionsReport }>(
      `/api/v1/payroll/periods/${periodId}/provisions-summary`
    );
    if (!apiRes?.success || !apiRes.data) {
      throw new Error('Falha ao obter resumo de provisões no servidor.');
    }
    return apiRes.data;
  }

  public async fetchPeriodAccounting(periodId: string): Promise<AccountingSummaryReport> {
    const apiRes = await apiClient.get<{ success: boolean; data: AccountingSummaryReport }>(
      `/api/v1/payroll/periods/${periodId}/accounting-summary`
    );
    if (!apiRes?.success || !apiRes.data) {
      throw new Error('Falha ao obter resumo contábil no servidor.');
    }
    return apiRes.data;
  }

  // CONT-04: Remessa CNAB 240 gerada 100% no servidor (Segmentos A+B + PIX + Pensão)
  public async fetchPeriodCnab(
    periodId: string,
    opts?: { bankCode?: string; paymentChannel?: 'MIXED' | 'TED_CC' | 'PIX'; includeAlimony?: boolean }
  ): Promise<{
    cnabContent: string;
    totalEmployees: number;
    alimonyCount: number;
    totalAmount: number;
    fileName: string;
    remittanceId: string;
    items: CnabGenerationResponse['items'];
  }> {
    const res = await this.generateCnab240(periodId, opts);
    return {
      cnabContent: res.remittance.file_content,
      totalEmployees: Number(res.remittance.employees_count || 0),
      alimonyCount: Number(res.remittance.alimony_count || 0),
      totalAmount: Number(res.remittance.total_amount || 0),
      fileName: res.remittance.file_name,
      remittanceId: res.remittance.id,
      items: res.items,
    };
  }

  public async generateCnab240(
    periodId: string,
    opts?: { bankCode?: string; paymentChannel?: 'MIXED' | 'TED_CC' | 'PIX'; includeAlimony?: boolean; paymentDate?: string }
  ): Promise<CnabGenerationResponse> {
    const res = await apiClient.post<{ success: boolean; data: CnabGenerationResponse }>(
      `/api/v1/accounting/periods/${periodId}/cnab240/generate`,
      opts || { bankCode: '341', paymentChannel: 'MIXED', includeAlimony: true }
    );
    if (!res?.success || !res.data) throw new Error('Falha ao gerar remessa CNAB 240.');
    return res.data;
  }

  public async fetchPeriodCnabRemittances(periodId: string) {
    const res = await apiClient.get<{ success: boolean; data: any }>(
      `/api/v1/accounting/periods/${periodId}/cnab240`
    );
    return res.data;
  }

  public async importCnabReturn(payload: { companyId?: string; remittanceId?: string; fileName: string; content: string }) {
    const res = await apiClient.post<{ success: boolean; data: any }>(
      `/api/v1/accounting/cnab240/return-import`,
      payload
    );
    return res.data;
  }

  // CONT-01: Rateios Multi-CC / Projetos / Tomadores / Obras CNO
  public async getContractCostAllocations(contractId: string) {
    const res = await apiClient.get<{ success: boolean; data: any[] }>(
      `/api/v1/accounting/contracts/${contractId}/cost-allocations`
    );
    return res.data || [];
  }

  public async saveContractCostAllocations(contractId: string, allocations: CostAllocationItem[]) {
    const res = await apiClient.put<{ success: boolean; data: any[] }>(
      `/api/v1/accounting/contracts/${contractId}/cost-allocations`,
      { allocations }
    );
    return res.data || [];
  }

  public async generatePeriodCostAllocations(periodId: string) {
    const res = await apiClient.post<{ success: boolean; data: any }>(
      `/api/v1/accounting/periods/${periodId}/cost-allocations/generate`,
      {}
    );
    return res.data;
  }

  public async fetchPeriodCostAllocations(periodId: string) {
    const res = await apiClient.get<{ success: boolean; data: { items: any[]; summary: any[] } }>(
      `/api/v1/accounting/periods/${periodId}/cost-allocations`
    );
    return res.data;
  }

  // CONT-02: Razão de Provisões Reais Acumuladas
  public async generatePeriodProvisionsLedger(periodId: string): Promise<ProvisionLedgerResponse> {
    const res = await apiClient.post<{ success: boolean; data: ProvisionLedgerResponse }>(
      `/api/v1/accounting/periods/${periodId}/provisions/generate`,
      {}
    );
    return res.data;
  }

  public async fetchPeriodProvisionsLedger(periodId: string): Promise<ProvisionLedgerResponse> {
    const res = await apiClient.get<{ success: boolean; data: ProvisionLedgerResponse }>(
      `/api/v1/accounting/periods/${periodId}/provisions`
    );
    return res.data;
  }

  // CONT-03: Plano de Contas, Lançamentos D===C e Exportadores ERP
  public async fetchChartOfAccounts(companyId?: string): Promise<ChartAccountItem[]> {
    const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : '';
    const res = await apiClient.get<{ success: boolean; data: ChartAccountItem[] }>(
      `/api/v1/accounting/chart-of-accounts${qs}`
    );
    return res.data || [];
  }

  public async createChartAccount(payload: {
    companyId?: string | null;
    accountCode: string;
    accountName: string;
    reducedCode?: string;
    accountType: 'ASSET' | 'LIABILITY' | 'EXPENSE' | 'REVENUE' | 'TRANSITORY';
    nature: 'DEBIT' | 'CREDIT';
    requiresCostCenter: boolean;
  }) {
    const res = await apiClient.post<{ success: boolean; data: ChartAccountItem }>(
      `/api/v1/accounting/chart-of-accounts`,
      payload
    );
    return res.data;
  }

  public async fetchAccountingEntries(periodId: string): Promise<AccountingSummaryReport> {
    const res = await apiClient.get<{ success: boolean; data: AccountingSummaryReport }>(
      `/api/v1/accounting/periods/${periodId}/entries`
    );
    return res.data;
  }

  public async exportAccountingBatch(periodId: string, format: AccountingErpFormat, delimiter?: string) {
    const res = await apiClient.post<{
      success: boolean;
      data: { fileName: string; fileHash: string; content: string; journal: AccountingSummaryReport };
    }>(`/api/v1/accounting/periods/${periodId}/export`, { format, delimiter });
    return res.data;
  }

  // CONT-05: Informe de Rendimentos (Quadros 1-7) & Conciliação Fiscal
  public async fetchIncomeReportsList(year: number) {
    const res = await apiClient.get<{ success: boolean; data: any[] }>(
      `/api/v1/accounting/income-reports/${year}`
    );
    return res.data || [];
  }

  public async fetchWorkerIncomeReport(year: number, workerId: string) {
    const res = await apiClient.get<{ success: boolean; data: { report: any; html: string } }>(
      `/api/v1/accounting/income-reports/${year}/workers/${workerId}`
    );
    return res.data;
  }

  public async fetchTaxReconciliation(periodId: string) {
    const res = await apiClient.get<{ success: boolean; data: any[] }>(
      `/api/v1/accounting/periods/${periodId}/tax-reconciliation`
    );
    return res.data || [];
  }

  public async saveTaxReconciliation(
    periodId: string,
    payload: { sourceType: 'DCTFWEB' | 'FGTS_DIGITAL' | 'IRRF_DARF'; declaredTaxAmount: number; declaredBaseAmount?: number; notes?: string }
  ) {
    const res = await apiClient.post<{ success: boolean; data: any }>(
      `/api/v1/accounting/periods/${periodId}/tax-reconciliation`,
      payload
    );
    return res.data;
  }
}

export const payrollObligationsService = new PayrollObligationsService();
