import { useState, useEffect } from "react";
import {
  FileKey,
  Upload,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  Trash2,
  RefreshCw,
  Loader2,
  Plus,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { confirmDialog } from "../../../components/ConfirmDialogProvider";
import { useCompany } from "../../../contexts/CompanyContext";
import {
  CertificateService,
  type TenantCertificate,
} from "../../../services/settings/certificateService";
import UploadCertificateModal from "./UploadCertificateModal";

export default function CertificatesTab() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const [loading, setLoading] = useState(true);
  const [activeCert, setActiveCert] = useState<TenantCertificate | null>(null);
  const [environment, setEnvironment] = useState<'PRODUCTION' | 'HOMOLOGATION'>('HOMOLOGATION');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    loadData();
  }, [environment, selectedCompanyId]);

  const loadData = async () => {
    if (!selectedCompanyId) {
      setActiveCert(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const cert = await CertificateService.getActiveCertificate(selectedCompanyId, environment);
      setActiveCert(cert);
    } catch (err) {
      console.error("Erro ao carregar dados do certificado:", err);
      toast.error("Não foi possível carregar as informações do certificado A1.");
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (!activeCert) return;

    const confirmed = await confirmDialog({
      title: "Revogar Certificado Digital",
      message:
        "Tem certeza de que deseja desativar este certificado digital? Assinaturas XML-DSig e transmissões mTLS ao eSocial ficarão inoperantes até a instalação de um novo A1.",
      confirmText: "Sim, Revogar",
      cancelText: "Cancelar",
      isDestructive: true,
    });

    if (!confirmed) return;

    try {
      setRevoking(true);
      const res = await CertificateService.revokeCertificate(
        activeCert.id,
        "Desativado manualmente pelo gestor na tela de configurações"
      );
      if (res.success) {
        toast.success("Certificado revogado com sucesso!");
        loadData();
      } else {
        toast.error(res.error || "Erro ao revogar certificado.");
      }
    } catch (err: any) {
      toast.error(err?.message || "Erro inesperado ao revogar.");
    } finally {
      setRevoking(false);
    }
  };

  const formatDate = (isoStr: string) => {
    try {
      return new Date(isoStr).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
    } catch {
      return isoStr;
    }
  };

  if (loading) {
    return (
      <div className="card p-12 flex flex-col items-center justify-center text-slate-500 space-y-3">
        <Loader2 className="animate-spin text-primary-500" size={32} />
        <p className="text-sm font-medium">Carregando cofre criptografado de certificados digitais...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="card overflow-hidden">
        <div className="p-6 bg-slate-50/50 border-b border-slate-200">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <FileKey size={20} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900 font-display">
                  Cofre de Certificados Digitais eSocial (A1 ICP-Brasil)
                </h2>
                <p className="text-sm text-slate-500">
                  Criptografia envelope AES-256-GCM no servidor VPS para assinatura XML-DSig (RSA-SHA256) e mTLS SERPRO.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl self-start md:self-auto">
              <button
                type="button"
                onClick={() => setEnvironment('HOMOLOGATION')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  environment === 'HOMOLOGATION'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Produção Restrita
              </button>
              <button
                type="button"
                onClick={() => setEnvironment('PRODUCTION')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  environment === 'PRODUCTION'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Produção Oficial
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {!selectedCompanyId ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Selecione uma empresa no cabeçalho para gerenciar o certificado A1.
            </div>
          ) : !activeCert ? (
            <div className="border-2 border-dashed border-slate-300 rounded-2xl p-10 text-center bg-slate-50/60 max-w-xl mx-auto space-y-4">
              <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 mx-auto flex items-center justify-center border border-slate-200">
                <Upload size={28} />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900 mb-1 font-display">
                  Nenhum Certificado A1 Ativo em{' '}
                  {environment === 'PRODUCTION' ? 'Produção Oficial' : 'Produção Restrita'}
                </h3>
                <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                  Envie o arquivo PKCS#12 (.pfx ou .p12) de <strong>{selectedCompany?.corporate_name}</strong> para validar o X.509 real e habilitar assinatura XML-DSig e transmissão mTLS.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(true)}
                className="btn-primary mx-auto py-2.5 px-6 shadow-md hover:shadow-lg transition-all flex items-center gap-2 cursor-pointer"
              >
                <Plus size={16} />
                <span>Instalar Certificado A1</span>
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <div
                className={`p-6 rounded-2xl border transition-all ${
                  activeCert.status === 'VALID'
                    ? 'bg-emerald-50/40 border-emerald-200'
                    : activeCert.status === 'EXPIRING_SOON'
                    ? 'bg-amber-50/50 border-amber-200'
                    : 'bg-rose-50/50 border-rose-200'
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-200/60">
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 shadow-xs ${
                        activeCert.status === 'VALID'
                          ? 'bg-emerald-100 text-emerald-700'
                          : activeCert.status === 'EXPIRING_SOON'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-rose-100 text-rose-700'
                      }`}
                    >
                      <FileKey size={24} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-base font-bold text-slate-900 font-display">
                          {activeCert.subject_name}
                        </h3>
                        {activeCert.status === 'VALID' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">
                            <CheckCircle2 size={12} /> Certificado Válido
                          </span>
                        )}
                        {activeCert.status === 'EXPIRING_SOON' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800">
                            <AlertTriangle size={12} /> Expira em {Math.max(0, activeCert.days_remaining)} dias
                          </span>
                        )}
                        {activeCert.status === 'EXPIRED' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800">
                            <ShieldAlert size={12} /> Certificado Expirado
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-600 mt-1">
                        Arquivo: <span className="font-semibold">{activeCert.filename}</span> · CNPJ:{' '}
                        <span className="font-semibold">{CertificateService.formatCNPJ(activeCert.cnpj)}</span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setIsModalOpen(true)}
                      className="px-3.5 py-2 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 shadow-2xs transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <RefreshCw size={14} className="text-slate-500" />
                      Substituir A1
                    </button>
                    <button
                      type="button"
                      onClick={handleRevoke}
                      disabled={revoking}
                      className="px-3.5 py-2 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg text-xs font-bold text-rose-700 transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      {revoking ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      Revogar
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-5">
                  <div className="space-y-1">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                      Autoridade Emissora
                    </span>
                    <p className="text-xs font-bold text-slate-800 truncate" title={activeCert.issuer_dn}>
                      {activeCert.issuer_dn}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                      Número de Série
                    </span>
                    <p className="text-xs font-bold text-slate-800 font-mono truncate" title={activeCert.serial_number}>
                      {activeCert.serial_number}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                      Vigência Inicial
                    </span>
                    <p className="text-xs font-bold text-slate-800">{formatDate(activeCert.valid_from)}</p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                      Data de Expiração
                    </span>
                    <p className={`text-xs font-bold ${activeCert.status === 'EXPIRED' ? 'text-rose-600' : 'text-slate-800'}`}>
                      {formatDate(activeCert.valid_to)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex items-start gap-3">
                <Info size={18} className="text-slate-400 shrink-0 mt-0.5" />
                <div className="text-xs text-slate-600 space-y-1">
                  <span className="font-semibold text-slate-800">Cofre Privado AES-256-GCM & Worker Node.js mTLS:</span>
                  <p>
                    Este certificado A1 é descriptografado exclusivamente em memória pelo Worker Node.js durante a assinatura XML-DSig (RSA-SHA256) e handshake HTTPS mTLS com o SERPRO/Gov.br. Alertas automáticos são emitidos com 60, 30, 15 e 7 dias antes do vencimento.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedCompanyId && (
        <UploadCertificateModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onSuccess={loadData}
          companyId={selectedCompanyId}
          companyName={selectedCompany?.corporate_name}
          environment={environment}
        />
      )}
    </div>
  );
}
