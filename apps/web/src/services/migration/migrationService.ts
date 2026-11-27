import { apiClient, getAccessToken } from '../../lib/apiClient';
import { env } from '../../config/env';

export interface MigrationTemplateInfo {
  key: string;
  filename: string;
  title: string;
  description: string;
  required: boolean;
  order: number;
  format: 'CSV' | 'MARKDOWN';
  mimeType: string;
}

export interface MigrationPreviewResult {
  valid: boolean;
  totalWorkers: number;
  totalContracts: number;
  totalPeriods: number;
  periodsDetected: string[];
  totalEarnings: number;
  totalDeductions: number;
  totalNet: number;
  reconciliationDiff: number;
  totalOvertimeHours: number;
  totalAbsenceDays: number;
  workersPreview: Array<{
    cpf: string;
    matricula: string;
    nome: string;
    cargo: string;
    salarioBase: number;
  }>;
  periodsSummary: Array<{
    competence: string;
    tipoFolha: string;
    slipsCount: number;
    totalEarnings: number;
    totalDeductions: number;
    totalNet: number;
    reconciliationDiff: number;
  }>;
  vacationsSummary?: {
    totalVacationPeriods: number;
    totalDaysRemaining: number;
    totalAbsencesImpact: number;
    records: Array<{
      cpf: string;
      matricula: string;
      nome: string;
      inicioAquisitivo: string;
      fimAquisitivo: string;
      diasSaldoRestante: number;
      faltas: number;
      status: string;
    }>;
  };
  leavesSummary?: {
    totalLeaves: number;
    activeLeavesCount: number;
    records: Array<{
      cpf: string;
      matricula: string;
      nome: string;
      tipo: string;
      dataInicio: string;
      dataFim?: string;
      cid?: string;
      estabilidadeAte?: string;
    }>;
  };
  timeBankSummary?: {
    totalAccounts: number;
    totalPositiveMinutes: number;
    totalNegativeMinutes: number;
    records: Array<{
      cpf: string;
      matricula: string;
      nome: string;
      saldoHorasHhmm: string;
      saldoMinutosLiquido: number;
    }>;
  };
  loansAndDebtsSummary?: {
    totalConsignados: number;
    totalConsignadoAmount: number;
    totalDebitos899: number;
    totalDebito899Amount: number;
    records: Array<{
      cpf: string;
      matricula: string;
      nome: string;
      tipo: string;
      valor: number;
      parcelasInfo?: string;
    }>;
  };
  warnings: string[];
  errors: string[];
}

export interface MigrationExecuteResult {
  success: boolean;
  message: string;
  workersImported: number;
  contractsImported: number;
  periodsImported: number;
  payslipsImported: number;
  itemsImported: number;
  irrfLedgerEntries: number;
  reconciliationDiff: number;
  vacationPeriodsImported?: number;
  leavesImported?: number;
  timeBankAccountsImported?: number;
  loansImported?: number;
  balanceDebtsImported?: number;
  provisionsImported?: number;
}

export interface MigrationPayload {
  rawWorkersCsv?: string;
  rawHistoryCsv?: string;
  rawVacationsCsv?: string;
  rawLeavesCsv?: string;
  rawTimeBankCsv?: string;
  rawLoansAndDebtsCsv?: string;
  esocialXmls?: string[];
}

export const migrationService = {
  /**
   * Obtém a lista de templates de importação oficiais
   */
  async getTemplates(): Promise<MigrationTemplateInfo[]> {
    const res = await apiClient.get<{ success: boolean; templates: MigrationTemplateInfo[] }>(
      '/api/v1/migration/templates'
    );
    return res.templates || [];
  },

  /**
   * Baixa diretamente um template com BOM UTF-8
   */
  async downloadTemplate(key: string, filename: string): Promise<void> {
    const token = getAccessToken();
    const url = `${env.API_URL}/api/v1/migration/templates/${key}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Falha ao baixar o modelo ${filename}: ${response.statusText}`);
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(downloadUrl);
  },

  /**
   * Executa a prévia (Dry-Run) com validação sintática e financeira
   */
  async previewMigration(params: MigrationPayload): Promise<MigrationPreviewResult> {
    const res = await apiClient.post<{ success: boolean; preview: MigrationPreviewResult }>(
      '/api/v1/migration/preview',
      params
    );
    return res.preview;
  },

  /**
   * Efetiva a gravação atômica da migração no banco de dados
   */
  async executeMigration(params: MigrationPayload): Promise<MigrationExecuteResult> {
    const res = await apiClient.post<{ success: boolean; result: MigrationExecuteResult }>(
      '/api/v1/migration/execute',
      params
    );
    return res.result;
  },
};
