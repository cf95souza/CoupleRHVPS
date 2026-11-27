import React, { useState, useEffect } from 'react';
import {
  FileText,
  Download,
  AlertCircle,
  CheckCircle2,
  X,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  TimesheetPdfService,
  type TimesheetReportData,
  type TimesheetDailyRow,
} from '../../services/timeTracking/timesheetPdfService';
import { pontoEnterpriseService } from '../../services/timeTracking/pontoEnterpriseService';

interface TimesheetViewModalProps {
  isOpen: boolean;
  onClose: () => void;
  contractId: string;
  workerId: string;
  workerName: string;
  workerCpf: string;
  companyName: string;
  companyCnpj: string;
}

export const TimesheetViewModal: React.FC<TimesheetViewModalProps> = ({
  isOpen,
  onClose,
  contractId,
  workerId,
  workerName,
  workerCpf,
  companyName,
  companyCnpj,
}) => {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [loading, setLoading] = useState(true);
  const [closure, setClosure] = useState<any | null>(null);
  const [dailyRows, setDailyRows] = useState<TimesheetDailyRow[]>([]);
  const [showContestForm, setShowContestForm] = useState(false);
  const [contestReason, setContestReason] = useState('');
  const [affectedDate, setAffectedDate] = useState('');
  const [submittingContest, setSubmittingContest] = useState(false);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    if (!isOpen || !contractId) return;
    fetchTimesheetData();
  }, [isOpen, contractId, year, month]);

  const fetchTimesheetData = async () => {
    setLoading(true);
    try {
      const res = await pontoEnterpriseService.fetchPortalTimesheet(year, month);
      setClosure(res.closure || { status: 'OPEN', year, month });
      const rows: TimesheetDailyRow[] = (res.summaries || []).map((d: any) => {
        const dtStr = String(d.work_date).slice(0, 10);
        const dayOfWeek = new Date(`${dtStr}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'short' });
        return {
          date: dtStr,
          dayOfWeek,
          punches: Array.isArray(d.punches) ? d.punches : [],
          worked_minutes: Math.round(Number(d.worked_hours || 0) * 60),
          overtime_50_minutes: Math.round(Number(d.overtime_50_hours || 0) * 60),
          overtime_100_minutes: Math.round(Number(d.overtime_100_hours || 0) * 60),
          night_shift_minutes: Math.round(Number(d.night_hours || 0) * 60),
          delay_minutes: Math.round(Number(d.delay_hours || 0) * 60),
          absence_minutes: Math.round(Number(d.absence_hours || 0) * 60),
          intrajornada_violation_minutes: 0,
          time_bank_minutes: Math.round(Number(d.time_bank_balance_hours || 0) * 60),
          status: d.status || 'REGULAR',
          notes: '',
        };
      });
      setDailyRows(rows);
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao carregar espelho de ponto.');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPdf = () => {
    try {
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const reportData: TimesheetReportData = {
        tenant_id: '',
        company: { corporate_name: companyName, cnpj: companyCnpj },
        employee: { worker_id: workerId, full_name: workerName, cpf: workerCpf },
        period: { month, year, start_date: startDate, end_date: endDate },
        daily_rows: dailyRows,
      };
      const doc = TimesheetPdfService.generateTimesheetPdf(reportData);
      doc.save(`Espelho_Ponto_${workerName.replace(/\s+/g, '_')}_${year}_${String(month).padStart(2, '0')}.pdf`);
      toast.success('Download do Espelho de Ponto em PDF concluído.');
    } catch (err: any) {
      toast.error('Erro ao gerar PDF: ' + err.message);
    }
  };

  const handleSignTimesheet = async () => {
    setSigning(true);
    try {
      const updated = await pontoEnterpriseService.signPortalTimesheet(year, month);
      setClosure(updated);
      toast.success('Espelho de ponto assinado digitalmente!');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao assinar espelho.');
    } finally {
      setSigning(false);
    }
  };

  const handleOpenContest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contestReason || contestReason.trim().length < 5) {
      toast.error('Descreva o motivo da contestação.');
      return;
    }
    setSubmittingContest(true);
    try {
      const updated = await pontoEnterpriseService.contestPortalTimesheet({
        year,
        month,
        affectedDate: affectedDate || undefined,
        reason: contestReason.trim(),
      });
      setClosure(updated);
      setShowContestForm(false);
      setContestReason('');
      setAffectedDate('');
      toast.success('Contestação enviada ao Gestor e DP.');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao contestar espelho.');
    } finally {
      setSubmittingContest(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl border border-slate-100 max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="bg-gradient-to-r from-slate-900 to-indigo-900 px-6 py-4 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center">
              <FileText size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold">Espelho de Ponto (Multi-Mês)</h2>
              <p className="text-xs text-white/80">Portaria MTP nº 671/2021 · Status: {closure?.status || 'OPEN'}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
            <div className="flex items-center gap-2">
              <select
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                className="px-2.5 py-1.5 rounded-lg border text-xs bg-white font-semibold"
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    Mês {String(m).padStart(2, '0')}
                  </option>
                ))}
              </select>
              <select
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="px-2.5 py-1.5 rounded-lg border text-xs bg-white font-semibold"
              >
                {[2025, 2026, 2027].map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleDownloadPdf}
                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-700 flex items-center gap-1"
              >
                <Download size={14} /> PDF
              </button>
              {closure?.status !== 'SIGNED_EMPLOYEE' && (
                <button
                  onClick={handleSignTimesheet}
                  disabled={signing}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold flex items-center gap-1"
                >
                  <ShieldCheck size={14} /> {signing ? 'Assinando...' : 'Aceitar Espelho'}
                </button>
              )}
              <button
                onClick={() => setShowContestForm(!showContestForm)}
                className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-bold flex items-center gap-1"
              >
                <AlertCircle size={14} /> Contestar
              </button>
            </div>
          </div>

          {showContestForm && (
            <form onSubmit={handleOpenContest} className="p-4 bg-rose-50/70 border border-rose-200 rounded-2xl space-y-3">
              <input
                type="date"
                value={affectedDate}
                onChange={(e) => setAffectedDate(e.target.value)}
                className="px-3 py-2 rounded-xl border text-xs bg-white"
              />
              <textarea
                rows={2}
                value={contestReason}
                onChange={(e) => setContestReason(e.target.value)}
                placeholder="Descreva a divergência encontrada..."
                className="w-full p-2.5 rounded-xl border text-xs bg-white"
              />
              <button type="submit" disabled={submittingContest} className="px-4 py-2 rounded-xl bg-rose-600 text-white text-xs font-bold">
                {submittingContest ? 'Enviando...' : 'Confirmar Contestação'}
              </button>
            </form>
          )}

          {loading ? (
            <div className="py-10 flex justify-center">
              <Loader2 size={24} className="animate-spin text-indigo-600" />
            </div>
          ) : dailyRows.length === 0 ? (
            <p className="text-center py-8 text-xs text-slate-400">Sem apontamentos fechados para {String(month).padStart(2, '0')}/{year}.</p>
          ) : (
            <div className="overflow-x-auto border rounded-2xl">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="p-2.5 text-left">Data</th>
                    <th className="p-2.5 text-right">Trab.</th>
                    <th className="p-2.5 text-right">HE 50%</th>
                    <th className="p-2.5 text-right">Noturno</th>
                    <th className="p-2.5 text-right">Atrasos</th>
                    <th className="p-2.5 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {dailyRows.map((row) => (
                    <tr key={row.date} className="hover:bg-slate-50">
                      <td className="p-2.5 font-mono">{row.date} ({row.dayOfWeek})</td>
                      <td className="p-2.5 text-right">{(row.worked_minutes / 60).toFixed(2)}h</td>
                      <td className="p-2.5 text-right text-emerald-700 font-semibold">{(row.overtime_50_minutes / 60).toFixed(2)}h</td>
                      <td className="p-2.5 text-right">{(row.night_shift_minutes / 60).toFixed(2)}h</td>
                      <td className="p-2.5 text-right text-rose-600">{(row.delay_minutes / 60).toFixed(2)}h</td>
                      <td className="p-2.5 text-center">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-[10px] font-bold">
                          <CheckCircle2 size={10} /> {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TimesheetViewModal;
