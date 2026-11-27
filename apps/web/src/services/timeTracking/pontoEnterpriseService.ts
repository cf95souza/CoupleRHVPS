import { apiClient } from '../../lib/apiClient';
import type { QueuedOfflinePunch } from '../../lib/offlinePunchQueue';

export interface EnterprisePunchPayload {
  workerId?: string;
  punchType: 'ENTRY' | 'INTERVAL_START' | 'INTERVAL_END' | 'EXIT' | 'IN' | 'BREAK_START' | 'BREAK_END' | 'OUT';
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  isMockLocation?: boolean;
  deviceFingerprint?: string | null;
  deviceTimestamp?: string | null;
  syncOrigin?: 'ONLINE_API' | 'OFFLINE_PWA';
  clientUuid?: string | null;
  selfieBase64?: string | null;
  selfieMimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface PunchAuditRecord {
  id: string;
  contract_id: string;
  worker_id: string;
  worker_name: string;
  registration_number: string;
  nsr: number;
  punched_at: string;
  device_timestamp: string | null;
  server_received_at: string | null;
  sync_origin: string;
  punch_type: string;
  entry_type_label: string;
  source: string;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  is_mock_location: boolean;
  geofence_status: string;
  distance_meters: number | null;
  speed_kmh: number | null;
  fraud_flags: string[];
  ip_address: string | null;
  receipt_code: string | null;
  selfie_signed_url: string | null;
  workplace_name: string | null;
  workplace_latitude: number | null;
  workplace_longitude: number | null;
  workplace_radius_meters: number | null;
}

class PontoEnterpriseService {
  // PONTO-01 / PONTO-04: Batida Única + QR Code Server-Side
  public async registerPunch(payload: EnterprisePunchPayload) {
    const res = await apiClient.post<{ success: boolean; duplicate?: boolean; data: any }>(
      '/api/v1/time-tracking/punch',
      payload
    );
    return res.data;
  }

  public async syncOfflinePunches(punches: QueuedOfflinePunch[]) {
    const res = await apiClient.post<{
      success: boolean;
      data: { syncedCount: number; duplicateCount: number; errorCount: number; results: any[] };
    }>('/api/v1/time-tracking/punch/sync-offline', { punches });
    return res.data;
  }

  // PONTO-02: Múltiplos Locais & Auditoria GPS RH
  public async fetchPunchesAudit(filters?: {
    companyId?: string;
    contractId?: string;
    startDate?: string;
    endDate?: string;
    onlyFlagged?: boolean;
  }): Promise<PunchAuditRecord[]> {
    const params = new URLSearchParams();
    if (filters?.companyId) params.set('companyId', filters.companyId);
    if (filters?.contractId) params.set('contractId', filters.contractId);
    if (filters?.startDate) params.set('startDate', filters.startDate);
    if (filters?.endDate) params.set('endDate', filters.endDate);
    if (filters?.onlyFlagged) params.set('onlyFlagged', 'true');
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await apiClient.get<{ success: boolean; data: PunchAuditRecord[] }>(
      `/api/v1/time-tracking/punches/audit${qs}`
    );
    return res.data || [];
  }

  public async fetchContractAllowedWorkplaces(contractId: string) {
    const res = await apiClient.get<{ success: boolean; data: any[] }>(
      `/api/v1/time-tracking/contracts/${contractId}/allowed-workplaces`
    );
    return res.data || [];
  }

  public async saveContractAllowedWorkplaces(
    contractId: string,
    workplaces: Array<{ workplaceId: string; isPrimary?: boolean; allowExternalAudit?: boolean }>
  ) {
    const res = await apiClient.put<{ success: boolean; data: any[] }>(
      `/api/v1/time-tracking/contracts/${contractId}/allowed-workplaces`,
      { workplaces }
    );
    return res.data || [];
  }

  // PONTO-04: Verificação Pública REP-P
  public async verifyPublicPunch(code: string) {
    const res = await apiClient.get<{ success: boolean; punch: any }>(
      `/api/v1/public/verify-punch/${encodeURIComponent(code)}`
    );
    return res.punch;
  }

  // PONTO-05: Portal do Colaborador 2.0
  public async fetchPortalWorkplaces() {
    const res = await apiClient.get<{ success: boolean; data: { isTelework: boolean; workplaces: any[] } }>(
      '/api/v1/portal/workplaces'
    );
    return res.data;
  }

  public async fetchPortalPunchReceipt(punchId: string) {
    const res = await apiClient.get<{ success: boolean; data: any }>(`/api/v1/portal/punches/${punchId}/receipt`);
    return res.data;
  }

  public async fetchPortalTimeBank() {
    const res = await apiClient.get<{ success: boolean; data: any }>('/api/v1/portal/time-bank');
    return res.data;
  }

  public async requestPortalDayOff(payload: { workDate: string; requestedMinutes: number; justification: string }) {
    const res = await apiClient.post<{ success: boolean; data: any }>('/api/v1/portal/time-bank/request-day-off', payload);
    return res.data;
  }

  public async fetchPortalTimesheet(year: number, month: number) {
    const res = await apiClient.get<{ success: boolean; data: any }>(
      `/api/v1/portal/timesheet?year=${year}&month=${month}`
    );
    return res.data;
  }

  public async signPortalTimesheet(year: number, month: number) {
    const res = await apiClient.post<{ success: boolean; data: any }>('/api/v1/portal/timesheet/sign', { year, month });
    return res.data;
  }

  public async contestPortalTimesheet(payload: {
    year: number;
    month: number;
    affectedDate?: string;
    reason: string;
  }) {
    const res = await apiClient.post<{ success: boolean; data: any }>('/api/v1/portal/timesheet/contest', payload);
    return res.data;
  }

  public async fetchPortalSchedule(year: number, month: number) {
    const res = await apiClient.get<{ success: boolean; data: any }>(
      `/api/v1/portal/schedule?year=${year}&month=${month}`
    );
    return res.data;
  }

  public async fetchPortalBenefits() {
    const res = await apiClient.get<{ success: boolean; data: any[] }>('/api/v1/portal/benefits');
    return res.data || [];
  }

  public async submitPortalJustification(payload: {
    adjustmentType: 'INSERT_PUNCH' | 'JUSTIFY_ABSENCE' | 'FORGIVE_DELAY' | 'OVERTIME_AUTHORIZATION' | 'MEDICAL_CERTIFICATE';
    workDate: string;
    endDate?: string;
    justification: string;
    cid10Code?: string;
    doctorCrm?: string;
    fileName?: string;
    mimeType?: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';
    fileBase64?: string;
  }) {
    const res = await apiClient.post<{ success: boolean; data: any }>('/api/v1/portal/justifications', payload);
    return res.data;
  }

  public async fetchPortalJustifications() {
    const res = await apiClient.get<{ success: boolean; data: any[] }>('/api/v1/portal/justifications');
    return res.data || [];
  }

  public async fetchLgpdDossier() {
    const res = await apiClient.get<{ success: boolean; data: any }>('/api/v1/portal/lgpd/dossier');
    return res.data;
  }

  public async fetchLgpdConsents() {
    const res = await apiClient.get<{ success: boolean; data: any[] }>('/api/v1/portal/lgpd/consents');
    return res.data || [];
  }

  public async grantLgpdConsent(consentCategory: string, granted: boolean) {
    const res = await apiClient.post<{ success: boolean; data: any }>('/api/v1/portal/lgpd/consents', {
      consentCategory,
      granted,
    });
    return res.data;
  }

  public async revokeLgpdConsent(consentId: string) {
    const res = await apiClient.post<{ success: boolean; data: any }>(
      `/api/v1/portal/lgpd/consents/${consentId}/revoke`,
      {}
    );
    return res.data;
  }

  public async submitLgpdRequest(requestType: string, justification: string) {
    const res = await apiClient.post<{ success: boolean; data: any }>('/api/v1/portal/lgpd/requests', {
      requestType,
      justification,
    });
    return res.data;
  }

  // PONTO-06: Workflow Multinível de Aprovações
  public async fetchPendingApprovals(scope?: 'all' | 'pending') {
    const qs = scope === 'all' ? '?scope=all' : '';
    const res = await apiClient.get<{
      success: boolean;
      data: { canViewMedicalCid: boolean; timeAdjustments: any[]; vacations: any[] };
    }>(`/api/v1/approvals/pending${qs}`);
    return res.data;
  }

  public async sendManagerDecision(kind: 'time-adjustment' | 'vacation', id: string, decision: 'APPROVE' | 'REJECT', notes?: string) {
    const res = await apiClient.post<{ success: boolean; data: any }>(
      `/api/v1/approvals/${kind}/${id}/manager-decision`,
      { decision, notes }
    );
    return res.data;
  }

  public async sendDpDecision(kind: 'time-adjustment' | 'vacation', id: string, decision: 'APPROVE' | 'REJECT', notes?: string) {
    const res = await apiClient.post<{ success: boolean; data: any }>(
      `/api/v1/approvals/${kind}/${id}/dp-decision`,
      { decision, notes }
    );
    return res.data;
  }
}

export const pontoEnterpriseService = new PontoEnterpriseService();
