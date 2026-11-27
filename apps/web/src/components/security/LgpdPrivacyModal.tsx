import React, { useState, useEffect } from 'react';
import { ShieldCheck, FileText, Download, RefreshCw, Send, X, Camera } from 'lucide-react';
import { toast } from 'sonner';
import { LGPDService, LgpdRequestType } from '../../services/security/lgpdService';
import { pontoEnterpriseService } from '../../services/timeTracking/pontoEnterpriseService';

interface LgpdPrivacyModalProps {
  isOpen: boolean;
  onClose: () => void;
  workerId: string;
  tenantId: string;
  employeeName: string;
  employeeCpf: string;
}

export const LgpdPrivacyModal: React.FC<LgpdPrivacyModalProps> = ({
  isOpen,
  onClose,
  employeeName,
  employeeCpf,
}) => {
  const [activeTab, setActiveTab] = useState<'dossier' | 'consents' | 'requests'>('dossier');
  const [loading, setLoading] = useState(false);
  const [dossierData, setDossierData] = useState<any>(null);
  const [consentsList, setConsentsList] = useState<any[]>([]);
  const [subjectRequests, setSubjectRequests] = useState<any[]>([]);
  const [newReqType, setNewReqType] = useState<LgpdRequestType>(LgpdRequestType.ACCESS_DATA);
  const [newReqJustification, setNewReqJustification] = useState('');
  const [submittingReq, setSubmittingReq] = useState(false);

  useEffect(() => {
    if (isOpen) loadLgpdData();
  }, [isOpen]);

  const loadLgpdData = async () => {
    setLoading(true);
    try {
      const dossier = await pontoEnterpriseService.fetchLgpdDossier();
      setDossierData(dossier);
      setConsentsList(dossier?.consentimentos || []);
      setSubjectRequests(dossier?.solicitacoes_titular || []);
    } catch {
      const list = await pontoEnterpriseService.fetchLgpdConsents().catch(() => []);
      setConsentsList(list);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleSelfieConsent = async (grant: boolean) => {
    try {
      await pontoEnterpriseService.grantLgpdConsent('BIOMETRIC_SELFIE_PUNCH', grant);
      toast.success(grant ? 'Consentimento para selfie no ponto concedido.' : 'Consentimento para selfie revogado.');
      await loadLgpdData();
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao atualizar consentimento.');
    }
  };

  const handleRevokeConsent = async (consentId: string) => {
    try {
      await pontoEnterpriseService.revokeLgpdConsent(consentId);
      toast.success('Consentimento revogado com sucesso.');
      await loadLgpdData();
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao revogar consentimento.');
    }
  };

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newReqJustification.trim().length < 5) {
      toast.error('Descreva o motivo da solicitação.');
      return;
    }
    setSubmittingReq(true);
    try {
      await pontoEnterpriseService.submitLgpdRequest(newReqType, newReqJustification.trim());
      toast.success('Solicitação LGPD registrada com sucesso.');
      setNewReqJustification('');
      await loadLgpdData();
      setActiveTab('requests');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao enviar solicitação.');
    } finally {
      setSubmittingReq(false);
    }
  };

  const handleDownloadDossier = () => {
    const payload = dossierData || {
      generatedAt: new Date().toISOString(),
      titular: { nomeCompleto: employeeName, cpfMascarado: LGPDService.maskCpf(employeeCpf) },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dossie_lgpd_${employeeName.toLowerCase().replace(/\s+/g, '_')}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  const hasActiveSelfie = consentsList.some(
    (c) => c.consent_category === 'BIOMETRIC_SELFIE_PUNCH' && c.granted && !c.revoked_at
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-100 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldCheck size={22} className="text-indigo-300" />
            <div>
              <h2 className="text-base font-bold">Privacidade & Dossiê LGPD (Art. 18)</h2>
              <p className="text-xs text-slate-300">Consentimentos e direitos do titular via API</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10">
            <X size={18} />
          </button>
        </div>

        <div className="flex gap-2 px-6 py-2.5 bg-slate-50 border-b text-xs font-bold">
          <button onClick={() => setActiveTab('dossier')} className={`px-3 py-1.5 rounded-lg ${activeTab === 'dossier' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-600'}`}>
            Dossiê
          </button>
          <button onClick={() => setActiveTab('consents')} className={`px-3 py-1.5 rounded-lg ${activeTab === 'consents' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-600'}`}>
            Consentimentos ({consentsList.length})
          </button>
          <button onClick={() => setActiveTab('requests')} className={`px-3 py-1.5 rounded-lg ${activeTab === 'requests' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-600'}`}>
            Solicitações ({subjectRequests.length})
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4 flex-1 text-xs">
          {loading ? (
            <div className="py-8 flex justify-center">
              <RefreshCw size={22} className="animate-spin text-indigo-600" />
            </div>
          ) : activeTab === 'dossier' ? (
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <p className="font-bold text-slate-800 flex items-center gap-1.5">
                  <FileText size={15} /> Dados Pessoais e Contratuais Auditados
                </p>
                <button onClick={handleDownloadDossier} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-bold flex items-center gap-1">
                  <Download size={14} /> Baixar JSON
                </button>
              </div>
              <pre className="p-3 rounded-xl bg-slate-900 text-emerald-300 overflow-x-auto max-h-72 text-[11px]">
                {JSON.stringify(dossierData || {}, null, 2)}
              </pre>
            </div>
          ) : activeTab === 'consents' ? (
            <div className="space-y-3">
              <div className="p-4 rounded-2xl border border-indigo-200 bg-indigo-50/70 flex items-center justify-between gap-3">
                <div>
                  <p className="font-bold text-indigo-950 flex items-center gap-1.5">
                    <Camera size={14} /> Selfie Opcional na Marcação de Ponto (BIOMETRIC_SELFIE_PUNCH)
                  </p>
                  <p className="text-indigo-800/80 mt-0.5">Armazenada exclusivamente em cofre privado com revogação imediata.</p>
                </div>
                <button
                  onClick={() => handleToggleSelfieConsent(!hasActiveSelfie)}
                  className={`px-3 py-1.5 rounded-xl font-bold ${hasActiveSelfie ? 'bg-rose-600 text-white' : 'bg-indigo-600 text-white'}`}
                >
                  {hasActiveSelfie ? 'Revogar Selfie' : 'Autorizar Selfie'}
                </button>
              </div>
              {consentsList.map((c) => (
                <div key={c.id} className="p-3 rounded-xl border flex items-center justify-between">
                  <div>
                    <p className="font-bold text-slate-800">{c.consent_category}</p>
                    <p className="text-slate-400">
                      {c.revoked_at ? `Revogado em ${String(c.revoked_at).slice(0, 10)}` : `Ativo desde ${String(c.granted_at).slice(0, 10)}`}
                    </p>
                  </div>
                  {!c.revoked_at && (
                    <button onClick={() => handleRevokeConsent(c.id)} className="px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 font-bold">
                      Revogar
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <form onSubmit={handleSubmitRequest} className="space-y-3">
              <select
                value={newReqType}
                onChange={(e) => setNewReqType(e.target.value as LgpdRequestType)}
                className="w-full p-2.5 rounded-xl border bg-white"
              >
                <option value={LgpdRequestType.ACCESS_DATA}>Acesso / Portabilidade de Dados</option>
                <option value={LgpdRequestType.CORRECTION}>Retificação de Dados Incorretos</option>
                <option value={LgpdRequestType.ANONYMIZATION}>Anonimização / Eliminação (Resguardado Prazo Legal)</option>
              </select>
              <textarea
                rows={3}
                value={newReqJustification}
                onChange={(e) => setNewReqJustification(e.target.value)}
                placeholder="Descreva sua solicitação ao DPO..."
                className="w-full p-2.5 rounded-xl border bg-white"
              />
              <button type="submit" disabled={submittingReq} className="px-4 py-2 rounded-xl bg-indigo-600 text-white font-bold flex items-center gap-1.5">
                <Send size={14} /> {submittingReq ? 'Enviando...' : 'Enviar Solicitação'}
              </button>
              <div className="space-y-2 pt-2">
                {subjectRequests.map((r) => (
                  <div key={r.id} className="p-2.5 rounded-xl bg-slate-50 border flex justify-between">
                    <span>{r.request_type} — {r.justification}</span>
                    <span className="font-bold text-indigo-700">{r.status}</span>
                  </div>
                ))}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default LgpdPrivacyModal;
