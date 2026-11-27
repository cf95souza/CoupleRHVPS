import { apiClient } from '../../lib/apiClient';

export type EsocialEnvironment = 'PRODUCTION' | 'HOMOLOGATION';
export type EsocialLayoutVersion = 'S-1.2' | 'S-1.3';

export interface EsocialEventRecord {
  id: string;
  company_id: string;
  event_type: string;
  event_id: string;
  environment: EsocialEnvironment;
  layout_version: EsocialLayoutVersion;
  batch_id: string | null;
  payroll_period_id: string | null;
  period_year: number | null;
  period_month: number | null;
  xsd_valid: boolean;
  xsd_errors: Array<{ code: string; field: string; message: string }>;
  status: string;
  protocol_number: string | null;
  receipt_number: string | null;
  error_details: any;
  signed_at: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  created_at: string;
  xml_content?: string;
  signed_xml?: string | null;
}

export interface EsocialBatchRecord {
  id: string;
  company_id: string;
  environment: EsocialEnvironment;
  layout_version: EsocialLayoutVersion;
  group_type: number;
  protocol_number: string | null;
  status: string;
  attempt_count: number;
  http_status: number | null;
  cd_resposta: string | null;
  desc_resposta: string | null;
  error_message: string | null;
  sent_at: string | null;
  processed_at: string | null;
  created_at: string;
}

export interface EsocialTotalizerRecord {
  id: string;
  company_id: string;
  payroll_period_id: string | null;
  event_type: string;
  period_year: number;
  period_month: number;
  cpf: string | null;
  receipt_number: string | null;
  environment: EsocialEnvironment;
  inss_base: string | number;
  inss_segurados: string | number;
  inss_patronal: string | number;
  irrf_retido: string | number;
  fgts_base: string | number;
  fgts_total: string | number;
  couple_inss_segurados: string | number;
  couple_inss_patronal: string | number;
  couple_irrf_retido: string | number;
  couple_fgts_total: string | number;
  diff_inss_segurados: string | number;
  diff_inss_patronal: string | number;
  diff_irrf_retido: string | number;
  diff_fgts_total: string | number;
  reconciliation_status: 'PENDING' | 'MATCHED' | 'DIVERGENT';
  divergences_json: Array<{
    field: string;
    label: string;
    governmentAmount: number;
    motorAmount: number;
    diffAmount: number;
  }>;
  created_at: string;
}

export interface EsocialHomologationStatus {
  company: {
    id: string;
    corporate_name: string;
    cnpj: string;
    esocial_production_enabled: boolean;
    esocial_homologated_at: string | null;
  } | null;
  cycles: Array<{
    id: string;
    status: 'IN_PROGRESS' | 'APPROVED' | 'FAILED';
    environment: EsocialEnvironment;
    totalizer_max_diff: string | number;
    production_unlocked: boolean;
    unlocked_at: string | null;
    notes: string | null;
    created_at: string;
  }>;
}

export const EsocialService = {
  async listEvents(params?: { companyId?: string; status?: string; eventType?: string }): Promise<EsocialEventRecord[]> {
    const qs = new URLSearchParams();
    if (params?.companyId) qs.set('companyId', params.companyId);
    if (params?.status) qs.set('status', params.status);
    if (params?.eventType) qs.set('eventType', params.eventType);
    const res = await apiClient.get<{ success: boolean; events: EsocialEventRecord[] }>(
      `/api/v1/esocial/events${qs.toString() ? `?${qs.toString()}` : ''}`
    );
    return res.events || [];
  },

  async getEventDetail(id: string): Promise<EsocialEventRecord> {
    const res = await apiClient.get<{ success: boolean; event: EsocialEventRecord }>(`/api/v1/esocial/events/${id}`);
    return res.event;
  },

  async generateEvent(payload: {
    company_id: string;
    event_type: string;
    environment: EsocialEnvironment;
    layout_version: EsocialLayoutVersion;
    payroll_period_id?: string;
  }) {
    return apiClient.post<{ success: boolean; event: EsocialEventRecord; validation: any }>(
      '/api/v1/esocial/events/generate',
      payload
    );
  },

  async signEvent(id: string) {
    return apiClient.post<{ success: boolean; event: EsocialEventRecord }>(`/api/v1/esocial/events/${id}/sign`, {});
  },

  async listBatches(companyId?: string): Promise<EsocialBatchRecord[]> {
    const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : '';
    const res = await apiClient.get<{ success: boolean; batches: EsocialBatchRecord[] }>(
      `/api/v1/esocial/batches${qs}`
    );
    return res.batches || [];
  },

  async sendBatch(payload: {
    company_id: string;
    event_ids: string[];
    environment: EsocialEnvironment;
    async?: boolean;
  }) {
    return apiClient.post<{ success: boolean; batch: EsocialBatchRecord; execution?: any }>(
      '/api/v1/esocial/batches/send',
      payload
    );
  },

  async pollBatch(batchId: string) {
    return apiClient.post<{ success: boolean; execution: any }>(`/api/v1/esocial/batches/${batchId}/poll`, {});
  },

  async listTotalizers(companyId?: string): Promise<EsocialTotalizerRecord[]> {
    const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : '';
    const res = await apiClient.get<{ success: boolean; totalizers: EsocialTotalizerRecord[] }>(
      `/api/v1/esocial/totalizers/reconciliation${qs}`
    );
    return res.totalizers || [];
  },

  async ingestTotalizer(payload: {
    company_id: string;
    payroll_period_id?: string;
    environment: EsocialEnvironment;
    xml_content: string;
  }) {
    return apiClient.post<{ success: boolean; record: EsocialTotalizerRecord; reconciliation: any }>(
      '/api/v1/esocial/totalizers/ingest',
      payload
    );
  },

  async getHomologationStatus(companyId?: string): Promise<EsocialHomologationStatus> {
    const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : '';
    const res = await apiClient.get<{ success: boolean } & EsocialHomologationStatus>(
      `/api/v1/esocial/homologation/status${qs}`
    );
    return { company: res.company, cycles: res.cycles || [] };
  },

  async verifyHomologationCycle(payload: { company_id: string; payroll_period_id: string }) {
    return apiClient.post<{ success: boolean; approved: boolean; missingEvents: string[]; maxDiff: number }>(
      '/api/v1/esocial/homologation/verify-cycle',
      payload
    );
  },

  async listPayrollPeriods(companyId: string) {
    const res = await apiClient.get<{ success: boolean; data: Array<{ id: string; year: number; month: number; type: string; status: string }> }>(
      `/api/v1/payroll/periods?companyId=${encodeURIComponent(companyId)}`
    );
    return res.data || [];
  },
};
