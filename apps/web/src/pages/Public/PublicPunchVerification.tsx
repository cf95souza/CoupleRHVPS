import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Clock, Building2, Hash, Loader2, Search, ShieldCheck, AlertTriangle } from 'lucide-react';
import { pontoEnterpriseService } from '../../services/timeTracking/pontoEnterpriseService';

export default function PublicPunchVerification() {
  const { codigo } = useParams<{ codigo?: string }>();
  const [searchInput, setSearchInput] = useState(codigo || '');
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [punch, setPunch] = useState<any | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (codigo) {
      setSearchInput(codigo);
      handleSearch(codigo);
    }
  }, [codigo]);

  const handleSearch = async (raw?: string) => {
    const code = (raw ?? searchInput).trim();
    if (!code) return;
    setLoading(true);
    setSearched(true);
    setPunch(null);
    setErrorMsg(null);
    try {
      const res = await pontoEnterpriseService.verifyPublicPunch(code);
      setPunch(res);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Comprovante REP-P não localizado ou hash inválido.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/40 to-slate-100 py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">
            <ShieldCheck size={14} /> Portaria MTP nº 671/2021 — Verificação Pública REP-P
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Autenticidade do Comprovante de Ponto</h1>
          <p className="text-sm text-slate-500">
            Consulte o código do recibo (QR Code) ou hash SHA-256 sem expor dados pessoais (LGPD).
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSearch();
          }}
          className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex gap-2"
        >
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Ex.: RCP-20261127-A1B2C3D4 ou hash SHA-256"
            className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            Verificar
          </button>
        </form>

        {searched && !loading && punch && (
          <div className="bg-white rounded-3xl shadow-lg border border-emerald-200 overflow-hidden">
            <div className="bg-emerald-600 px-6 py-4 text-white flex items-center gap-3">
              <CheckCircle2 size={24} />
              <div>
                <h2 className="font-bold text-base">Comprovante REP-P Autêntico</h2>
                <p className="text-xs text-emerald-100">Chancela imutável validada no banco PostgreSQL</p>
              </div>
            </div>
            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div className="p-3 bg-slate-50 rounded-xl">
                <span className="text-xs text-slate-400 flex items-center gap-1">
                  <Building2 size={12} /> Empregador
                </span>
                <p className="font-semibold text-slate-800 mt-0.5">{punch.company_name}</p>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl">
                <span className="text-xs text-slate-400">Colaborador (Mascarado LGPD)</span>
                <p className="font-semibold text-slate-800 mt-0.5">
                  {punch.worker_name_masked} · CPF {punch.worker_cpf_masked}
                </p>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl">
                <span className="text-xs text-slate-400 flex items-center gap-1">
                  <Clock size={12} /> Data e Hora da Batida
                </span>
                <p className="font-semibold text-slate-800 mt-0.5">
                  {new Date(punch.punched_at).toLocaleString('pt-BR')} ({punch.punch_type})
                </p>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl">
                <span className="text-xs text-slate-400 flex items-center gap-1">
                  <Hash size={12} /> NSR / Recibo
                </span>
                <p className="font-semibold font-mono text-slate-800 mt-0.5">
                  NSR {punch.nsr} · {punch.receipt_code || punch.punch_id}
                </p>
              </div>
              <div className="sm:col-span-2 p-3 bg-slate-900 text-slate-200 rounded-xl font-mono text-xs break-all">
                SHA-256: {punch.sha256_hash}
              </div>
            </div>
          </div>
        )}

        {searched && !loading && errorMsg && (
          <div className="bg-white rounded-2xl p-6 border border-red-200 text-center space-y-2">
            <AlertTriangle size={28} className="text-red-500 mx-auto" />
            <p className="font-semibold text-red-700">{errorMsg}</p>
          </div>
        )}

        <div className="text-center text-xs text-slate-400">
          <Link to="/portal/login" className="text-blue-600 hover:underline">
            Voltar ao Portal do Colaborador
          </Link>
        </div>
      </div>
    </div>
  );
}
