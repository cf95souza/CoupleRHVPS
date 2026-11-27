import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  Clock,
  X,
  Loader2,
  CalendarDays,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatMinutesToHours } from '../../services/timeTracking/timeBankService';
import { pontoEnterpriseService } from '../../services/timeTracking/pontoEnterpriseService';

interface TimeBankModalProps {
  isOpen: boolean;
  onClose: () => void;
  contractId: string;
}

export const TimeBankModal: React.FC<TimeBankModalProps> = ({ isOpen, onClose, contractId }) => {
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<any | null>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [pendingDayOffs, setPendingDayOffs] = useState<any[]>([]);
  const [showRequestOffModal, setShowRequestOffModal] = useState(false);
  const [offDate, setOffDate] = useState('');
  const [offHours, setOffHours] = useState('8');
  const [offDescription, setOffDescription] = useState('');
  const [submittingOff, setSubmittingOff] = useState(false);

  useEffect(() => {
    if (!isOpen || !contractId) return;
    fetchTimeBankData();
  }, [isOpen, contractId]);

  const fetchTimeBankData = async () => {
    setLoading(true);
    try {
      const res = await pontoEnterpriseService.fetchPortalTimeBank();
      setAccount(res.account || null);
      setTransactions(res.transactions || []);
      setPendingDayOffs(res.pendingDayOffs || []);
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao carregar banco de horas.');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestCompDayOff = async (e: React.FormEvent) => {
    e.preventDefault();
    const minutes = Math.round(parseFloat(offHours) * 60);
    if (!minutes || minutes <= 0) {
      toast.error('Informe uma quantidade válida de horas.');
      return;
    }
    if (!offDate) {
      toast.error('Selecione a data da folga compensatória.');
      return;
    }

    setSubmittingOff(true);
    try {
      await pontoEnterpriseService.requestPortalDayOff({
        workDate: offDate,
        requestedMinutes: minutes,
        justification: offDescription.trim() || `Folga compensatória solicitada (${offHours}h)`,
      });
      toast.success('Solicitação enviada ao Gestor e DP! O saldo só é debitado após homologação.');
      setShowRequestOffModal(false);
      setOffDate('');
      setOffDescription('');
      await fetchTimeBankData();
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao solicitar folga.');
    } finally {
      setSubmittingOff(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-100 max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="bg-gradient-to-r from-emerald-600 to-teal-600 px-6 py-5 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center">
              <TrendingUp size={22} className="text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Banco de Horas</h2>
              <p className="text-xs text-white/80">Extrato Oficial e Solicitação de Folga</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {loading ? (
            <div className="py-12 flex flex-col items-center text-slate-400 gap-2">
              <Loader2 size={28} className="animate-spin text-emerald-500" />
              <p className="text-xs">Consultando banco de horas autenticado...</p>
            </div>
          ) : !account ? (
            <div className="text-center py-8 text-slate-500 text-sm">
              <Clock size={36} className="mx-auto text-slate-300 mb-2" />
              Nenhuma conta de banco de horas encontrada para o contrato.
            </div>
          ) : (
            <>
              <div
                className={`p-5 rounded-2xl border ${
                  Number(account.balance_minutes || 0) >= 0
                    ? 'bg-emerald-50 border-emerald-200'
                    : 'bg-rose-50 border-rose-200'
                }`}
              >
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Saldo Atual</span>
                <div className="flex items-center justify-between mt-1">
                  <span
                    className={`text-4xl font-black font-mono ${
                      Number(account.balance_minutes || 0) >= 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {formatMinutesToHours(Number(account.balance_minutes || 0))}
                  </span>
                  <button
                    onClick={() => setShowRequestOffModal(!showRequestOffModal)}
                    className="py-2 px-3 rounded-xl bg-white text-emerald-700 border border-emerald-300 font-bold text-xs flex items-center gap-1.5"
                  >
                    <CalendarDays size={14} /> Solicitar Folga
                  </button>
                </div>
              </div>

              {showRequestOffModal && (
                <form onSubmit={handleRequestCompDayOff} className="p-4 bg-slate-50 border border-emerald-200 rounded-2xl space-y-3">
                  <p className="text-xs font-bold text-slate-800">Solicitar Folga Compensatória (Aprovação Gestor &rarr; DP)</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="date"
                      value={offDate}
                      onChange={(e) => setOffDate(e.target.value)}
                      required
                      className="px-3 py-2 rounded-xl border text-xs bg-white"
                    />
                    <input
                      type="number"
                      step="0.5"
                      min="1"
                      max="12"
                      value={offHours}
                      onChange={(e) => setOffHours(e.target.value)}
                      className="px-3 py-2 rounded-xl border text-xs bg-white"
                      placeholder="Horas (ex: 8)"
                    />
                  </div>
                  <input
                    type="text"
                    value={offDescription}
                    onChange={(e) => setOffDescription(e.target.value)}
                    placeholder="Motivo / observação"
                    className="w-full px-3 py-2 rounded-xl border text-xs bg-white"
                  />
                  <button
                    type="submit"
                    disabled={submittingOff}
                    className="w-full py-2 rounded-xl bg-emerald-600 text-white font-bold text-xs"
                  >
                    {submittingOff ? 'Enviando...' : 'Enviar para Aprovação'}
                  </button>
                </form>
              )}

              {pendingDayOffs.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-slate-500 uppercase">Solicitações de Folga</h4>
                  {pendingDayOffs.map((req) => (
                    <div key={req.id} className="p-3 rounded-xl border border-slate-200 flex items-center justify-between text-xs">
                      <div>
                        <p className="font-semibold text-slate-800">
                          {new Date(String(req.work_date).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR')} ·{' '}
                          {req.requested_minutes} min
                        </p>
                        <p className="text-slate-500">{req.justification}</p>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold">{req.status}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-xs font-bold text-slate-500 uppercase">Histórico de Movimentações</h4>
                {transactions.length === 0 ? (
                  <p className="text-xs text-slate-400">Nenhuma movimentação registrada.</p>
                ) : (
                  transactions.map((tx) => (
                    <div key={tx.id} className="p-3 rounded-xl bg-slate-50 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        {tx.minutes >= 0 ? (
                          <ArrowUpRight size={15} className="text-emerald-600" />
                        ) : (
                          <ArrowDownRight size={15} className="text-rose-600" />
                        )}
                        <div>
                          <p className="font-semibold text-slate-800">{tx.description || tx.transaction_type}</p>
                          <p className="text-slate-400">{String(tx.reference_date).slice(0, 10)}</p>
                        </div>
                      </div>
                      <span className={`font-mono font-bold ${tx.minutes >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {formatMinutesToHours(tx.minutes)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default TimeBankModal;
