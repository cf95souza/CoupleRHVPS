import { useState, useEffect } from "react";
import {
  Search,
  Send,
  CheckCircle,
  AlertOctagon,
  Clock,
  Loader2,
  FileCode2,
  ShieldCheck,
  RefreshCw,
  FilePlus2,
  Scale,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";
import { useCompany } from "../../contexts/CompanyContext";
import { Pagination } from "../../components/Pagination";
import {
  EsocialService,
  type EsocialBatchRecord,
  type EsocialEnvironment,
  type EsocialEventRecord,
  type EsocialHomologationStatus,
  type EsocialLayoutVersion,
  type EsocialTotalizerRecord,
} from "../../services/esocial/esocialService";

type Tab = 'EVENTS' | 'BATCHES' | 'TOTALIZERS' | 'HOMOLOGATION';

const EVENT_TYPES = [
  'S-1000',
  'S-1005',
  'S-1010',
  'S-1020',
  'S-2190',
  'S-2200',
  'S-2205',
  'S-2206',
  'S-2230',
  'S-2240',
  'S-2299',
  'S-2300',
  'S-2399',
  'S-1200',
  'S-1210',
  'S-1298',
  'S-1299',
];

export default function ESocialDashboard() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const [activeTab, setActiveTab] = useState<Tab>('EVENTS');
  const [environment, setEnvironment] = useState<EsocialEnvironment>('HOMOLOGATION');
  const [layoutVersion, setLayoutVersion] = useState<EsocialLayoutVersion>('S-1.3');
  const [selectedEventType, setSelectedEventType] = useState<string>('S-1000');
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('');
  const [periods, setPeriods] = useState<Array<{ id: string; year: number; month: number; type: string; status: string }>>([]);

  const [events, setEvents] = useState<EsocialEventRecord[]>([]);
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [batches, setBatches] = useState<EsocialBatchRecord[]>([]);
  const [totalizers, setTotalizers] = useState<EsocialTotalizerRecord[]>([]);
  const [homologation, setHomologation] = useState<EsocialHomologationStatus>({ company: null, cycles: [] });

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const loadAll = async () => {
    if (!selectedCompanyId) {
      setEvents([]);
      setBatches([]);
      setTotalizers([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const [evList, bList, totList, homStatus, periodList] = await Promise.all([
        EsocialService.listEvents({ companyId: selectedCompanyId }),
        EsocialService.listBatches(selectedCompanyId),
        EsocialService.listTotalizers(selectedCompanyId),
        EsocialService.getHomologationStatus(selectedCompanyId),
        EsocialService.listPayrollPeriods(selectedCompanyId).catch(() => []),
      ]);
      setEvents(evList);
      setBatches(bList);
      setTotalizers(totList);
      setHomologation(homStatus);
      setPeriods(periodList);
      if (periodList.length > 0 && !selectedPeriodId) {
        setSelectedPeriodId(periodList[0].id);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao carregar dados do eSocial.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [selectedCompanyId]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, activeTab]);

  const handleGenerateEvent = async () => {
    if (!selectedCompanyId) return;
    try {
      setBusy(true);
      await EsocialService.generateEvent({
        company_id: selectedCompanyId,
        event_type: selectedEventType,
        environment,
        layout_version: layoutVersion,
        payroll_period_id: selectedPeriodId || undefined,
      });
      toast.success(`Evento ${selectedEventType} (${layoutVersion}) gerado e validado (XSD)!`);
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Falha ao gerar evento eSocial.');
    } finally {
      setBusy(false);
    }
  };

  const handleSignEvent = async (id: string) => {
    try {
      setBusy(true);
      await EsocialService.signEvent(id);
      toast.success('XML assinado com XML-DSig (RSA-SHA256)!');
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Falha na assinatura XML-DSig.');
    } finally {
      setBusy(false);
    }
  };

  const handleSendSelectedBatch = async () => {
    if (!selectedCompanyId || selectedEventIds.length === 0) {
      toast.error('Selecione ao menos um evento para montar o lote.');
      return;
    }
    try {
      setBusy(true);
      const res = await EsocialService.sendBatch({
        company_id: selectedCompanyId,
        event_ids: selectedEventIds,
        environment,
        async: true,
      });
      toast.success(`Lote ${res.batch.id.slice(0, 8)} enfileirado para transmissão mTLS!`);
      setSelectedEventIds([]);
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Falha ao enviar lote mTLS.');
    } finally {
      setBusy(false);
    }
  };

  const handlePollBatch = async (batchId: string) => {
    try {
      setBusy(true);
      await EsocialService.pollBatch(batchId);
      toast.success('Consulta de lote atualizada.');
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao consultar protocolo do lote.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyHomologation = async () => {
    if (!selectedCompanyId || !selectedPeriodId) {
      toast.error('Selecione uma competência de folha para verificar a homologação.');
      return;
    }
    try {
      setBusy(true);
      const res = await EsocialService.verifyHomologationCycle({
        company_id: selectedCompanyId,
        payroll_period_id: selectedPeriodId,
      });
      if (res.approved) {
        toast.success('Ciclo homologado em Produção Restrita! Produção Oficial liberada.');
      }
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || 'Homologação incompleta. Verifique eventos aceitos e totalizadores.');
      await loadAll();
    } finally {
      setBusy(false);
    }
  };

  const toggleSelectEvent = (id: string) => {
    setSelectedEventIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const getStatusBadge = (status: string) => {
    const map: Record<string, { cls: string; label: string }> = {
      DRAFT: { cls: 'bg-slate-100 text-slate-700', label: 'Rascunho' },
      VALIDATED: { cls: 'bg-sky-100 text-sky-800', label: 'XSD Válido' },
      SIGNED: { cls: 'bg-indigo-100 text-indigo-800', label: 'Assinado A1' },
      QUEUED: { cls: 'bg-amber-100 text-amber-800', label: 'Na Fila' },
      SENT: { cls: 'bg-blue-100 text-blue-800', label: 'Transmitido' },
      ACCEPTED: { cls: 'bg-emerald-100 text-emerald-800', label: 'Aceito' },
      PROCESSED: { cls: 'bg-emerald-100 text-emerald-800', label: 'Processado' },
      REJECTED: { cls: 'bg-rose-100 text-rose-800', label: 'Rejeitado' },
      MATCHED: { cls: 'bg-emerald-100 text-emerald-800', label: 'Batido R$ 0,00' },
      DIVERGENT: { cls: 'bg-rose-100 text-rose-800', label: 'Divergente' },
    };
    const item = map[status] || { cls: 'bg-slate-100 text-slate-700', label: status };
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold ${item.cls}`}>
        {item.label}
      </span>
    );
  };

  const filteredEvents = events.filter(
    (e) =>
      e.event_type.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.event_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (e.receipt_number || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.status.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalPages = Math.max(1, Math.ceil(filteredEvents.length / pageSize));
  const paginatedEvents = filteredEvents.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const stats = {
    accepted: events.filter((e) => e.status === 'ACCEPTED').length,
    pending: events.filter((e) => ['DRAFT', 'VALIDATED', 'SIGNED', 'QUEUED', 'SENT'].includes(e.status)).length,
    rejected: events.filter((e) => e.status === 'REJECTED').length,
  };

  const prodUnlocked = Boolean(homologation.company?.esocial_production_enabled);

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Cabeçalho */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900 font-display">
              Mensageria Oficial eSocial (S-1.2 / S-1.3)
            </h1>
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
                prodUnlocked
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : 'bg-amber-50 text-amber-800 border-amber-200'
              }`}
            >
              <ShieldCheck size={14} />
              {prodUnlocked ? 'Produção Oficial Homologada' : 'Produção Restrita (Homologação)'}
            </span>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            {selectedCompany?.corporate_name || 'Selecione uma empresa'} · Assinatura XML-DSig (RSA-SHA256), mTLS SERPRO e Totalizadores S-5001 a S-5013
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as EsocialEnvironment)}
            className="px-3 py-2 bg-white border border-slate-200 rounded-md text-xs font-semibold text-slate-700"
          >
            <option value="HOMOLOGATION">Produção Restrita</option>
            <option value="PRODUCTION" disabled={!prodUnlocked}>
              Produção Oficial {!prodUnlocked ? '(Bloqueada)' : ''}
            </option>
          </select>

          <select
            value={layoutVersion}
            onChange={(e) => setLayoutVersion(e.target.value as EsocialLayoutVersion)}
            className="px-3 py-2 bg-white border border-slate-200 rounded-md text-xs font-semibold text-slate-700"
          >
            <option value="S-1.3">Layout S-1.3</option>
            <option value="S-1.2">Layout S-1.2</option>
          </select>

          <button
            type="button"
            onClick={loadAll}
            disabled={loading || busy}
            className="px-3 py-2 bg-white hover:bg-slate-50 border border-slate-200 rounded-md text-xs font-semibold text-slate-700 flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Atualizar
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase">Aceitos com Recibo</span>
            <CheckCircle size={18} className="text-emerald-600" />
          </div>
          <p className="text-2xl font-bold text-slate-900 mt-2">{stats.accepted}</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase">Em Fluxo / Fila mTLS</span>
            <Clock size={18} className="text-amber-600" />
          </div>
          <p className="text-2xl font-bold text-slate-900 mt-2">{stats.pending}</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase">Rejeitados / Ajustar</span>
            <AlertOctagon size={18} className="text-rose-600" />
          </div>
          <p className="text-2xl font-bold text-rose-700 mt-2">{stats.rejected}</p>
        </div>
      </div>

      {/* Navegação por Abas */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        {[
          { id: 'EVENTS', label: 'Eventos XML (S-1.2/S-1.3)', icon: FileCode2 },
          { id: 'BATCHES', label: 'Lotes mTLS & Recibos', icon: Send },
          { id: 'TOTALIZERS', label: 'Confronto Totalizadores (S-5001..S-5013)', icon: Scale },
          { id: 'HOMOLOGATION', label: 'Homologação Produção Restrita', icon: KeyRound },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as Tab)}
              className={`px-4 py-2 rounded-md text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
                active
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Aba Eventos */}
      {activeTab === 'EVENTS' && (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-col lg:flex-row gap-3 items-stretch lg:items-center justify-between bg-slate-50">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedEventType}
                onChange={(e) => setSelectedEventType(e.target.value)}
                className="px-3 py-2 bg-white border border-slate-200 rounded-md text-xs font-semibold text-slate-700"
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>

              {periods.length > 0 && (
                <select
                  value={selectedPeriodId}
                  onChange={(e) => setSelectedPeriodId(e.target.value)}
                  className="px-3 py-2 bg-white border border-slate-200 rounded-md text-xs font-semibold text-slate-700"
                >
                  {periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {String(p.month).padStart(2, '0')}/{p.year} ({p.type})
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                onClick={handleGenerateEvent}
                disabled={busy || !selectedCompanyId}
                className="btn-primary px-4 py-2 text-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <FilePlus2 size={14} />}
                Gerar & Validar XSD
              </button>

              {selectedEventIds.length > 0 && (
                <button
                  type="button"
                  onClick={handleSendSelectedBatch}
                  disabled={busy}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <Send size={14} />
                  Transmitir Lote mTLS ({selectedEventIds.length})
                </button>
              )}
            </div>

            <div className="relative w-full lg:w-72">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Buscar evento, Id ou recibo..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-md text-xs"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                  <th className="px-4 py-3 w-10">Sel</th>
                  <th className="px-4 py-3">Evento</th>
                  <th className="px-4 py-3">Event ID</th>
                  <th className="px-4 py-3">Leiaute</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Recibo Oficial</th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                      Carregando eventos...
                    </td>
                  </tr>
                ) : paginatedEvents.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      Nenhum evento eSocial gerado para esta empresa.
                    </td>
                  </tr>
                ) : (
                  paginatedEvents.map((ev) => (
                    <tr key={ev.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedEventIds.includes(ev.id)}
                          onChange={() => toggleSelectEvent(ev.id)}
                        />
                      </td>
                      <td className="px-4 py-3 font-mono font-bold text-slate-900">{ev.event_type}</td>
                      <td className="px-4 py-3 font-mono text-slate-600">{ev.event_id}</td>
                      <td className="px-4 py-3">{ev.layout_version}</td>
                      <td className="px-4 py-3">{getStatusBadge(ev.status)}</td>
                      <td className="px-4 py-3 font-mono text-slate-600">{ev.receipt_number || '-'}</td>
                      <td className="px-4 py-3 text-right">
                        {['DRAFT', 'VALIDATED'].includes(ev.status) && (
                          <button
                            type="button"
                            onClick={() => handleSignEvent(ev.id)}
                            disabled={busy}
                            className="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-md font-semibold cursor-pointer"
                          >
                            Assinar A1
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {!loading && filteredEvents.length > 0 && (
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              pageSize={pageSize}
              totalItems={filteredEvents.length}
              onPageChange={setCurrentPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setCurrentPage(1);
              }}
            />
          )}
        </div>
      )}

      {/* Aba Lotes */}
      {activeTab === 'BATCHES' && (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                <th className="px-4 py-3">Protocolo</th>
                <th className="px-4 py-3">Grupo</th>
                <th className="px-4 py-3">Ambiente</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Retorno Gov</th>
                <th className="px-4 py-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {batches.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                    Nenhum lote transmitido ainda.
                  </td>
                </tr>
              ) : (
                batches.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono font-semibold text-slate-800">{b.protocol_number || b.id.slice(0, 8)}</td>
                    <td className="px-4 py-3">Grupo {b.group_type}</td>
                    <td className="px-4 py-3">{b.environment}</td>
                    <td className="px-4 py-3">{getStatusBadge(b.status)}</td>
                    <td className="px-4 py-3 text-slate-600">{b.cd_resposta ? `${b.cd_resposta} - ${b.desc_resposta}` : b.error_message || '-'}</td>
                    <td className="px-4 py-3 text-right">
                      {b.protocol_number && b.status !== 'PROCESSED' && (
                        <button
                          type="button"
                          onClick={() => handlePollBatch(b.id)}
                          disabled={busy}
                          className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md font-semibold cursor-pointer"
                        >
                          Consultar Recibos
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Aba Totalizadores */}
      {activeTab === 'TOTALIZERS' && (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                <th className="px-4 py-3">Totalizador</th>
                <th className="px-4 py-3">Competência</th>
                <th className="px-4 py-3">Status Confronto</th>
                <th className="px-4 py-3">Diff INSS Seg.</th>
                <th className="px-4 py-3">Diff Patronal</th>
                <th className="px-4 py-3">Diff IRRF</th>
                <th className="px-4 py-3">Diff FGTS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {totalizers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    Nenhum totalizador (S-5001 a S-5013) ingerido até o momento.
                  </td>
                </tr>
              ) : (
                totalizers.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono font-bold text-slate-900">{t.event_type}</td>
                    <td className="px-4 py-3">
                      {String(t.period_month).padStart(2, '0')}/{t.period_year}
                    </td>
                    <td className="px-4 py-3">{getStatusBadge(t.reconciliation_status)}</td>
                    <td className="px-4 py-3 font-mono">R$ {Number(t.diff_inss_segurados).toFixed(2)}</td>
                    <td className="px-4 py-3 font-mono">R$ {Number(t.diff_inss_patronal).toFixed(2)}</td>
                    <td className="px-4 py-3 font-mono">R$ {Number(t.diff_irrf_retido).toFixed(2)}</td>
                    <td className="px-4 py-3 font-mono">R$ {Number(t.diff_fgts_total).toFixed(2)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Aba Homologação */}
      {activeTab === 'HOMOLOGATION' && (
        <div className="bg-white border border-slate-200 rounded-lg p-6 shadow-sm space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Gate de Homologação em Produção Restrita (ESOC-05)
              </h2>
              <p className="text-xs text-slate-600 mt-1">
                A transmissão em Produção Oficial só é liberada após 1 ciclo completo (S-1000, S-1005, S-1010, S-1020, S-2200, S-1200, S-1210, S-1299) aceito com recibo e totalizadores batendo R$ 0,00.
              </p>
            </div>
            <button
              type="button"
              onClick={handleVerifyHomologation}
              disabled={busy || !selectedPeriodId}
              className="btn-primary px-4 py-2 text-xs flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Validar Ciclo & Liberar Produção
            </button>
          </div>

          <div className="space-y-2">
            {homologation.cycles.length === 0 ? (
              <p className="text-xs text-slate-500">Nenhuma tentativa de homologação registrada.</p>
            ) : (
              homologation.cycles.map((c) => (
                <div key={c.id} className="p-3 bg-slate-50 border border-slate-200 rounded-md flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-slate-800">{c.status}</span> ·{' '}
                    <span className="text-slate-600">{c.notes}</span>
                  </div>
                  <span className="font-mono text-slate-500">Max diff: R$ {Number(c.totalizer_max_diff).toFixed(2)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
