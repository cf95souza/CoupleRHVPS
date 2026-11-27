import { apiClient } from '../lib/apiClient';

export interface LaborRiskItem {
  id: string;
  contract_id: string;
  worker_name: string;
  cpf: string;
  article: 'Art. 137 CLT' | 'Art. 66 CLT' | 'Art. 71 CLT' | 'Art. 59 CLT' | 'Banco Excedente';
  severity: 'DANGER' | 'WARNING';
  description: string;
  details: string;
  suggested_action: string;
}

export interface ExecutiveDashboardData {
  stats: {
    activeEmployees: number;
    vacationEmployees: number;
    suspendedEmployees: number;
    companiesCount: number;
    turnoverRateAnnual: number;
    absenteeismRateMonth: number;
  };
  costs: {
    grossPayrollCents: number;
    netPayrollCents: number;
    employerTaxesCents: number;
    provisionsCents: number;
    benefitsCents: number;
    totalCompanyCostCents: number;
  };
  overtimeVsTimeBank: {
    overtimeHoursMonth: number;
    timeBankCompensatedHours: number;
    totalActiveTimeBankBalanceHours: number;
  };
  payrollHistory12m: Array<{
    periodKey: string;
    grossAmount: number;
    netAmount: number;
    employerTaxes: number;
    totalCost: number;
    headcount: number;
  }>;
  laborRiskRadar: {
    totalRisksCount: number;
    dangerCount: number;
    warningCount: number;
    vacationRiskCount: number;
    interjornadaCount: number;
    intrajornadaCount: number;
    overtimeExcessCount: number;
    timeBankExcessCount: number;
    risks: LaborRiskItem[];
  };
}

export const biService = {
  async getExecutiveDashboard(companyId?: string): Promise<ExecutiveDashboardData> {
    const params = new URLSearchParams();
    if (companyId) params.append('company_id', companyId);

    const res = await apiClient.get<{ success: boolean; data: ExecutiveDashboardData }>(
      `/api/v1/bi/dashboard-executive?${params.toString()}`
    );
    return res.data;
  },

  async getLaborRiskRadar(companyId?: string, article?: string): Promise<{
    summary: ExecutiveDashboardData['laborRiskRadar'];
    risks: LaborRiskItem[];
  }> {
    const params = new URLSearchParams();
    if (companyId) params.append('company_id', companyId);
    if (article) params.append('article', article);

    const res = await apiClient.get<{
      success: boolean;
      data: {
        summary: ExecutiveDashboardData['laborRiskRadar'];
        risks: LaborRiskItem[];
      };
    }>(`/api/v1/bi/labor-risk-radar?${params.toString()}`);
    return res.data;
  },
};
