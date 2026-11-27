import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  Clock,
  FileText,
  CalendarDays,
  ShieldCheck,
  Loader2,
  Stethoscope,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../contexts/AuthContext';
import { pontoEnterpriseService } from '../../services/timeTracking/pontoEnterpriseService';

export default function ManagerApprovals() {
  const { hasPermission } = useAuth();
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<'pending' | 'all'>('pending');
  const [canViewCid, setCanViewCid] = useState(false);
  const [adjustments, setAdjustments] = useState<any[]>([]);
  const [vacations, setVacations] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canManagerApprove = hasPermission('approve_team_requests');
  const canDpTime = hasPermission('manage_time_tracking');
  const canDpVacation = hasPermission('manage_vacations');

  const loadQueue = async () => {
    setLoading(true);
    try {
      const res = await pontoEnterpriseService.fetchPendingApprovals(scope);
      setCanViewCid(Boolean(res.canViewMedicalCid));
      setAdjustments(res.timeAdjustments || []);
      setVacations(res.vacations || []);
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao carregar fila de aprovações.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue();
  }, [scope]);

  const handleDecision = async (
    stage: 'manager' | 'dp',
    kind: 'time-adjustment' | 'vacation',
    id: string,
    decision: 'APPROVE' | 'REJECT'
  ) => {
    setBusyId(id);
    try {
      if (stage === 'manager') {
        await pontoEnterpriseService.sendManagerDecision(kind, id, decision);
      } else {
        await pontoEnterpriseService.sendDpDecision(kind, id, decision);
      }
      toast.success(
        decision === 'APPROVE'
          ? stage === 'manager'
            ? 'Pré-aprovado pelo Gestor e encaminhado ao DP.'
            : 'Homologado pelo DP com sucesso.'
          : 'Solicitação indeferida.'
      );
      await loadQueue();
    } catch (err: any) {
      toast.error(err?.message || 'Falha ao processar decisão.');
    } finally {
      setBusyId(null);
    }
  };

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      PENDING_MANAGER: 'bg-amber-100 text-amber-800',
      PENDING: 'bg-amber-100 text-amber-800',
      REQUESTED: 'bg-amber-100 text-amber-800',
      APPROVED_MANAGER: 'bg-blue-100 text-blue-800',
      APPROVED_DP: 'bg-emerald-100 text-emerald-800',
      APPROVED: 'bg-emerald-100 text-emerald-800',
      REJECTED_MANAGER: 'bg-red-100 text-red-800',
      REJECTED_DP: 'bg-red-100 text-red-800',
      CANCELLED: 'bg-red-100 text-red-800',
    };
    return map[status] || 'bg-slate-100 text-slate-700';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Aprovações da Equipe (Multinível)</h1>
          <p className="text-sm text-slate-500">
            Fluxo auditável Gestor do Setor &rarr; DP com sigilo médico LGPD (CID oculto sem permissão clínica).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'pending' | 'all')}
            className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white"
          >
            <option value="pending">Pendentes de Ação</option>
            <option value="all">Histórico Completo</option>
          </select>
          <button
            onClick={loadQueue}
            className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm font-medium hover:bg-slate-50 flex items-center gap-1.5"
          >
            <RefreshCw size={15} /> Atualizar
          </button>
        </div>
      </div>

      {!canViewCid && (
        <div className="p-3 rounded-2xl bg-indigo-50 border border-indigo-200 text-xs text-indigo-800 flex items-center gap-2">
          <ShieldCheck size={16} />
          Proteção LGPD ativa: códigos CID-10 de atestados médicos permanecem ocultos para seu perfil de gestão.
        </div>
      )}

      {loading ? (
        <div className="p-12 flex justify-center">
          <Loader2 size={28} className="animate-spin text-blue-600" />
        </div>
      ) : (
        <div className="space-y-6">
          <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2 font-bold text-slate-800">
              <Clock size={18} className="text-blue-600" />
              Ajustes de Ponto, Folgas Banco de Horas e Atestados ({adjustments.length})
            </div>
            {adjustments.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">Nenhuma solicitação de ponto ou atestado nesta fila.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {adjustments.map((item) => {
                  const awaitingManager = ['PENDING', 'PENDING_MANAGER'].includes(item.status);
                  const awaitingDp = ['PENDING', 'PENDING_MANAGER', 'APPROVED_MANAGER'].includes(item.status);
                  return (
                    <div key={item.id} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-slate-900">{item.worker_name}</span>
                          <span className="text-xs text-slate-400">Mat. {item.registration_number}</span>
                          {item.department_name && (
                            <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-xs">
                              {item.department_name}
                            </span>
                          )}
                          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusBadge(item.status)}`}>
                            {item.status}
                          </span>
                        </div>
                        <p className="text-sm text-slate-700">
                          <strong>{item.adjustment_type}</strong> · Data:{' '}
                          {new Date(String(item.work_date).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR')}
                          {item.requested_minutes ? ` · ${item.requested_minutes} min` : ''}
                        </p>
                        <p className="text-xs text-slate-500">{item.justification}</p>
                        {item.adjustment_type === 'MEDICAL_CERTIFICATE' && (
                          <p className="text-xs flex items-center gap-1.5 text-rose-700 font-medium">
                            <Stethoscope size={13} />
                            {canViewCid && item.cid10_code
                              ? `CID-10: ${item.cid10_code}`
                              : item.cid_masked
                                ? 'CID-10 protegido por sigilo médico (LGPD)'
                                : 'Atestado sem CID informado'}
                          </p>
                        )}
                        {item.attachment_signed_url && (
                          <a
                            href={item.attachment_signed_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-600 font-semibold hover:underline"
                          >
                            <FileText size={13} /> Abrir Anexo Protegido
                          </a>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {canManagerApprove && awaitingManager && (
                          <>
                            <button
                              disabled={busyId === item.id}
                              onClick={() => handleDecision('manager', 'time-adjustment', item.id, 'APPROVE')}
                              className="px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 flex items-center gap-1"
                            >
                              <CheckCircle2 size={14} /> Aprovar (Gestor)
                            </button>
                            <button
                              disabled={busyId === item.id}
                              onClick={() => handleDecision('manager', 'time-adjustment', item.id, 'REJECT')}
                              className="px-3 py-1.5 rounded-xl bg-red-50 text-red-700 border border-red-200 text-xs font-semibold hover:bg-red-100 flex items-center gap-1"
                            >
                              <XCircle size={14} /> Recusar
                            </button>
                          </>
                        )}
                        {canDpTime && awaitingDp && (
                          <button
                            disabled={busyId === item.id}
                            onClick={() => handleDecision('dp', 'time-adjustment', item.id, 'APPROVE')}
                            className="px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 flex items-center gap-1"
                          >
                            <CheckCircle2 size={14} /> Homologar DP
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2 font-bold text-slate-800">
              <CalendarDays size={18} className="text-indigo-600" />
              Solicitações de Férias da Equipe ({vacations.length})
            </div>
            {vacations.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">Nenhuma solicitação de férias pendente.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {vacations.map((vac) => {
                  const awaitingManager = ['REQUESTED', 'PENDING_MANAGER'].includes(vac.status);
                  const awaitingDp = ['REQUESTED', 'PENDING_MANAGER', 'APPROVED_MANAGER'].includes(vac.status);
                  return (
                    <div key={vac.id} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900">{vac.worker_name}</span>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusBadge(vac.status)}`}>
                            {vac.status}
                          </span>
                        </div>
                        <p className="text-sm text-slate-600">
                          {new Date(String(vac.start_date).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR')} até{' '}
                          {new Date(String(vac.end_date).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR')} (
                          {vac.days_count} dias)
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {canManagerApprove && awaitingManager && (
                          <>
                            <button
                              disabled={busyId === vac.id}
                              onClick={() => handleDecision('manager', 'vacation', vac.id, 'APPROVE')}
                              className="px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
                            >
                              Aprovar (Gestor)
                            </button>
                            <button
                              disabled={busyId === vac.id}
                              onClick={() => handleDecision('manager', 'vacation', vac.id, 'REJECT')}
                              className="px-3 py-1.5 rounded-xl bg-red-50 text-red-700 border border-red-200 text-xs font-semibold"
                            >
                              Recusar
                            </button>
                          </>
                        )}
                        {canDpVacation && awaitingDp && (
                          <button
                            disabled={busyId === vac.id}
                            onClick={() => handleDecision('dp', 'vacation', vac.id, 'APPROVE')}
                            className="px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                          >
                            Homologar DP
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
