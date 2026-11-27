import { apiClient } from '../lib/apiClient';

export interface AdmissionInvite {
  id: string;
  tenant_id: string;
  company_id: string;
  company_trade_name?: string;
  company_corporate_name?: string;
  company_cnpj?: string;
  invite_token: string;
  candidate_name: string;
  candidate_email: string;
  candidate_phone?: string;
  candidate_cpf?: string;
  position_id?: string;
  position_title?: string;
  department_id?: string;
  department_name?: string;
  proposed_salary_cents: number;
  hire_date: string;
  status: 'PENDING' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  expires_at: string;
  submission_id?: string;
  personal_data?: any;
  address_data?: any;
  bank_data?: any;
  dependents_data?: any[];
  transport_option?: any;
  time_bank_agreement?: boolean;
  document_file_ids?: string[];
  signature_svg?: string;
  submitted_at?: string;
  reviewed_at?: string;
  review_notes?: string;
  created_at: string;
}

export const admissionService = {
  // Rotas Administrativas
  async createInvite(data: {
    companyId: string;
    candidateName: string;
    candidateEmail: string;
    candidatePhone?: string;
    candidateCpf?: string;
    positionId?: string;
    departmentId?: string;
    proposedSalaryCents: number;
    hireDate: string;
  }): Promise<AdmissionInvite> {
    const res = await apiClient.post<{ success: boolean; data: AdmissionInvite }>(
      '/api/v1/admissions/invites',
      data
    );
    return res.data;
  },

  async listInvites(companyId?: string): Promise<AdmissionInvite[]> {
    const params = new URLSearchParams();
    if (companyId) params.append('company_id', companyId);

    const res = await apiClient.get<{ success: boolean; data: AdmissionInvite[] }>(
      `/api/v1/admissions/invites?${params.toString()}`
    );
    return res.data || [];
  },

  async getInviteById(id: string): Promise<AdmissionInvite> {
    const res = await apiClient.get<{ success: boolean; data: AdmissionInvite }>(
      `/api/v1/admissions/invites/${id}`
    );
    return res.data;
  },

  async approveAdmission(id: string, notes?: string): Promise<any> {
    const res = await apiClient.post<{ success: boolean; data: any }>(
      `/api/v1/admissions/invites/${id}/approve`,
      { notes }
    );
    return res.data;
  },

  async rejectAdmission(id: string, notes: string): Promise<any> {
    const res = await apiClient.post<{ success: boolean; data: any }>(
      `/api/v1/admissions/invites/${id}/reject`,
      { notes }
    );
    return res.data;
  },

  // Rotas Públicas do Candidato
  async getPublicInvite(token: string): Promise<any> {
    const res = await apiClient.get<{ success: boolean; data: any }>(
      `/api/v1/admissions/public/invites/${token}`
    );
    return res.data;
  },

  async submitAdmission(token: string, payload: any): Promise<any> {
    const res = await apiClient.post<{ success: boolean; data: any; message: string }>(
      `/api/v1/admissions/public/invites/${token}/submit`,
      payload
    );
    return res.data;
  },

  async uploadPublicDocument(token: string, file: File): Promise<{ fileId: string; fileName: string }> {
    const formData = new FormData();
    formData.append('file', file);

    const baseUrl = import.meta.env.VITE_API_URL || '';
    const response = await fetch(`${baseUrl}/api/v1/admissions/public/invites/${token}/upload-doc`, {
      method: 'POST',
      body: formData,
    });

    const json = await response.json();
    if (!response.ok || !json.success) {
      throw new Error(json.error || 'Erro no envio do documento.');
    }
    return json.data;
  },
};
