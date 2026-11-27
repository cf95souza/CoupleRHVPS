import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Upload,
  FileKey,
  Lock,
  Eye,
  EyeOff,
  ShieldCheck,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { CertificateService } from "../../../services/settings/certificateService";

interface UploadCertificateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  companyId: string;
  companyName?: string;
  environment?: 'PRODUCTION' | 'HOMOLOGATION';
}

export default function UploadCertificateModal({
  isOpen,
  onClose,
  onSuccess,
  companyId,
  companyName = "",
  environment = 'HOMOLOGATION',
}: UploadCertificateModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pfx' && ext !== 'p12') {
      toast.error('O arquivo deve possuir extensão .pfx ou .p12 (padrão PKCS#12).');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('O arquivo do certificado excede o limite máximo permitido de 5 MB.');
      return;
    }

    setSelectedFile(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!companyId) {
      toast.error('Selecione uma empresa antes de instalar o certificado.');
      return;
    }
    if (!selectedFile) {
      toast.error('Por favor, selecione o arquivo do certificado (.pfx ou .p12).');
      return;
    }
    if (!password) {
      toast.error('Informe a senha da chave privada do certificado digital.');
      return;
    }

    try {
      setSubmitting(true);
      const res = await CertificateService.uploadCertificate({
        companyId,
        file: selectedFile,
        password,
        environment,
      });

      if (res.success) {
        toast.success('Certificado Digital A1 validado (X.509) e armazenado no cofre AES-256-GCM!');
        setPassword("");
        setSelectedFile(null);
        onSuccess();
        onClose();
      } else {
        toast.error(res.error || 'Erro ao instalar certificado digital.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Falha inesperada ao processar o certificado.');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabeçalho */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center border border-rose-100 shadow-xs">
              <FileKey size={20} />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 font-display text-base">
                Instalar Certificado Digital A1
              </h3>
              <p className="text-xs text-slate-500">
                {companyName ? `${companyName} · ` : ''}
                {environment === 'PRODUCTION' ? 'Produção Oficial' : 'Produção Restrita'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          <div>
            <label className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-2">
              Arquivo do Certificado (.pfx ou .p12) *
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pfx,.p12,application/x-pkcs12"
              onChange={handleFileChange}
              className="hidden"
            />

            {!selectedFile ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-300 hover:border-primary-500 rounded-xl p-6 text-center bg-slate-50/50 hover:bg-primary-50/20 cursor-pointer transition-all group"
              >
                <Upload size={28} className="mx-auto text-slate-400 group-hover:text-primary-600 mb-2 transition-colors" />
                <p className="text-xs font-bold text-slate-700">Clique para selecionar o arquivo .pfx</p>
                <p className="text-[11px] text-slate-400 mt-1">
                  O servidor extrai automaticamente Titular, CNPJ, Emissor, Série e Validade X.509.
                </p>
              </div>
            ) : (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-2.5 overflow-hidden">
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                    <ShieldCheck size={18} />
                  </div>
                  <div className="truncate">
                    <p className="text-xs font-bold text-emerald-900 truncate">{selectedFile.name}</p>
                    <p className="text-[10px] text-emerald-700 font-medium">
                      {(selectedFile.size / 1024).toFixed(1)} KB · Pronto para validação X.509
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="text-xs text-rose-600 hover:text-rose-800 font-semibold px-2 py-1 rounded hover:bg-rose-50 transition-colors"
                >
                  Alterar
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-bold text-slate-700 uppercase tracking-wider block mb-1">
              Senha da Chave Privada *
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Informe a senha do arquivo .pfx"
                className="w-full pl-9 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
              />
              <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-slate-400">
                <Lock size={15} />
              </div>
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-3 flex items-center text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Criptografada em envelope AES-256-GCM com chave mestra fora do banco de dados.
            </p>
          </div>

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-start gap-2.5 text-xs text-slate-600">
            <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
            <p>
              O backend valida a senha PKCS#12, a validade temporal e o CNPJ raiz da empresa antes de armazenar o certificado no cofre.
            </p>
          </div>

          <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 border border-slate-200 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary py-2 px-5 text-xs flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {submitting ? <Loader2 size={15} className="animate-spin" /> : <FileKey size={15} />}
              <span>{submitting ? "Validando e Criptografando..." : "Instalar Certificado A1"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
