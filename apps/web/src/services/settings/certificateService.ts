/**
 * certificateService.ts
 *
 * Servico de gerenciamento do Cofre Criptografado de Certificados Digitais ICP-Brasil (A1 .pfx / .p12)
 * via API REST nativa (/api/v1/esocial/certificates). Zero Supabase.
 */

import { apiClient } from '../../lib/apiClient';

export type CertificateStatus = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'REVOKED' | 'NOT_CONFIGURED';

export interface TenantCertificate {
  id: string;
  tenant_id: string;
  company_id: string;
  environment: 'PRODUCTION' | 'HOMOLOGATION';
  filename: string;
  subject_name: string;
  subject_dn: string;
  cnpj: string;
  issuer_dn: string;
  serial_number: string;
  thumbprint_sha256: string;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
  revoked_at: string | null;
  revocation_reason: string | null;
  days_remaining: number;
  status: CertificateStatus;
  created_at: string;
}

export interface CertificateUploadPayload {
  companyId: string;
  file: File;
  password: string;
  environment: 'PRODUCTION' | 'HOMOLOGATION';
}

export const CertificateService = {
  formatCNPJ(cnpj: string): string {
    const clean = (cnpj || '').replace(/\D/g, '');
    if (clean.length === 14) {
      return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    }
    if (clean.length === 11) {
      return clean.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    }
    return cnpj;
  },

  async listCertificates(params?: {
    companyId?: string;
    environment?: 'PRODUCTION' | 'HOMOLOGATION';
  }): Promise<TenantCertificate[]> {
    const qs = new URLSearchParams();
    if (params?.companyId) qs.set('companyId', params.companyId);
    if (params?.environment) qs.set('environment', params.environment);
    const res = await apiClient.get<{ success: boolean; certificates: TenantCertificate[] }>(
      `/api/v1/esocial/certificates${qs.toString() ? `?${qs.toString()}` : ''}`
    );
    return res.certificates || [];
  },

  async getActiveCertificate(
    companyId: string,
    environment: 'PRODUCTION' | 'HOMOLOGATION' = 'HOMOLOGATION'
  ): Promise<TenantCertificate | null> {
    if (!companyId) return null;
    const list = await this.listCertificates({ companyId, environment });
    return list.find((c) => c.is_active) || null;
  },

  async uploadCertificate(
    payload: CertificateUploadPayload
  ): Promise<{ success: boolean; certificate?: TenantCertificate; error?: string }> {
    const ext = payload.file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pfx' && ext !== 'p12') {
      return { success: false, error: 'O arquivo deve possuir extensao .pfx ou .p12 (PKCS#12).' };
    }
    if (!payload.password) {
      return { success: false, error: 'Informe a senha da chave privada do certificado digital.' };
    }

    const formData = new FormData();
    formData.append('company_id', payload.companyId);
    formData.append('environment', payload.environment);
    formData.append('password', payload.password);
    formData.append('file', payload.file);

    try {
      const res = await apiClient.post<{ success: boolean; certificate: TenantCertificate }>(
        '/api/v1/esocial/certificates',
        formData
      );
      return { success: true, certificate: res.certificate };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Falha ao validar e instalar certificado digital A1.',
      };
    }
  },

  async revokeCertificate(
    certificateId: string,
    reason: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await apiClient.post(`/api/v1/esocial/certificates/${certificateId}/revoke`, { reason });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro ao revogar certificado.' };
    }
  },

  async checkExpiryAlerts(): Promise<{ triggeredCount: number }> {
    const res = await apiClient.post<{ success: boolean; triggered: any[] }>(
      '/api/v1/esocial/certificates/check-expiry',
      {}
    );
    return { triggeredCount: res.triggered?.length ?? 0 };
  },
};
