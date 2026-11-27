import { useEffect, useState } from 'react';
import {
  BookOpen,
  Building2,
  CheckCircle2,
  CreditCard,
  Download,
  FileSpreadsheet,
  FileText,
  Landmark,
  Layers,
  Loader2,
  PieChart,
  RefreshCw,
  UploadCloud,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '../../lib/apiClient';
import { useCompany } from '../../contexts/CompanyContext';
import {
  payrollObligationsService,
  type AccountingErpFormat,
  type AccountingSummaryReport,
  type ChartAccountItem,
  type ProvisionLedgerResponse,
} from '../../services/payroll/payrollObligationsService';

type HubTab = 'ALLOCATIONS' | 'PROVISIONS' | 'CHART_AND_ERP' | 'CNAB' | 'INCOME_AND_RECON';

export default function AccountingHub() {
  const { selectedCompany } = useCompany();
  const [activeTab, setActiveTab] = useState<HubTab>('ALLOCATIONS');
  const [periods, setPeriods] = useState<any[]>([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Estado por aba
  const [allocData, setAllocData] = useState<{ items: any[]; summary: any[] } | null>(null);
  const [provLedger, setProvLedger] = useState<ProvisionLedgerResponse | null>(null);
  const [chartAccounts, setChartAccounts] = useState<ChartAccountItem[]>([]);
  const [entriesReport, setEntriesReport] = useState<AccountingSummaryReport | null>(null);
  const [erpFormat, setErpFormat] = useState<AccountingErpFormat>('DOMINIO');

  const [cnabInfo, setCnabInfo] = useState<any>(null);
  const [bankCode, setBankCode] = useState('341');
  const [paymentChannel, setPaymentChannel] = useState<'MIXED' | 'TED_CC' | 'PIX'>('MIXED');
  const [returnText, setReturnText] = useState('');

  const [incomeYear, setIncomeYear] = useState(2026);
  const [incomeWorkers, setIncomeWorkers] = useState<any[]>([]);
  const [selectedWorkerReport, setSelectedWorkerReport] = useState<{ report: any; html: string } | null>(null);
  const [reconciliationRows, setReconciliationRows] = useState<any[]>([]);
  const [reconSource, setReconSource] = useState<'DCTFWEB' | 'FGTS_DIGITAL' | 'IRRF_DARF'>('DCTFWEB');
  const [reconDeclaredTax, setReconDeclaredTax] = useState('');

  useEffect(() => {
    loadPeriods();
  }, [selectedCompany?.id]);

  useEffect(() => {
    if (selectedPeriodId) {
      loadCurrentTabData();
    }
  }, [selectedPeriodId, activeTab, incomeYear]);

  const loadPeriods = async () => {
    try {
      const qs = selectedCompany?.id ? `?company_id=${selectedCompany.id}` : '';
      const res = await apiClient.get<{ success: boolean; data: any[] }>(`/api/v1/payroll/periods${qs}`);
      const list = res?.data || [];
      setPeriods(list);
      if (list.length > 0 && !selectedPeriodId) {
        setSelectedPeriodId(list[0].id);
      }
    } catch {
      setPeriods([]);
    }
  };

  const loadCurrentTabData = async () => {
    if (!selectedPeriodId) return;
    setLoading(true);
    try {
      if (activeTab === 'ALLOCATIONS') {
        const res = await payrollObligationsService.fetchPeriodCostAllocations(selectedPeriodId);
        setAllocData(res);
      } else if (activeTab === 'PROVISIONS') {
        const res = await payrollObligationsService.fetchPeriodProvisionsLedger(selectedPeriodId);
        setProvLedger(res);
      } else if (activeTab === 'CHART_AND_ERP') {
        const [chart, entries] = await Promise.all([
          payrollObligationsService.fetchChartOfAccounts(selectedCompany?.id),
          payrollObligationsService.fetchAccountingEntries(selectedPeriodId),
        ]);
        setChartAccounts(chart);
        setEntriesReport(entries);
      } else if (activeTab === 'CNAB') {
        const res = await payrollObligationsService.fetchPeriodCnabRemittances(selectedPeriodId);
        setCnabInfo(res);
      } else if (activeTab === 'INCOME_AND_RECON') {
        const [workersList, recon] = await Promise.all([
          payrollObligationsService.fetchIncomeReportsList(incomeYear),
          payrollObligationsService.fetchTaxReconciliation(selectedPeriodId),
        ]);
        setIncomeWorkers(workersList);
        setReconciliationRows(recon);
      }
    } catch (err: any) {
      console.error('Erro ao carregar dados contábeis:', err);
    } finally {
      setLoading(false);
    }
  };

  const fmt = (v: number) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const handleGenerateAllocations = async () => {
    if (!selectedPeriodId) return;
    setLoading(true);
    try {
      await payrollObligationsService.generatePeriodCostAllocations(selectedPeriodId);
      const res = await payrollObligationsService.fetchPeriodCostAllocations(selectedPeriodId);
      setAllocData(res);
      toast.success('Rateio Multi-CC / Projetos / CNO gerado sem perda de centavos.');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao gerar rateios.');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateProvisionsLedger = async () => {
    if (!selectedPeriodId) return;
    setLoading(true);
    try {
      const res = await payrollObligationsService.generatePeriodProvisionsLedger(selectedPeriodId);
      setProvLedger(res);
      toast.success('Razão de provisões acumuladas apurado com baixas reais do período.');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao gerar provisões acumuladas.');
    } finally {
      setLoading(false);
    }
  };

  const handleExportErp = async () => {
    if (!selectedPeriodId) return;
    try {
      const out = await payrollObligationsService.exportAccountingBatch(selectedPeriodId, erpFormat);
      const blob = new Blob([out.content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = out.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Arquivo ${erpFormat} gerado (${out.fileName}).`);
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao exportar para ERP.');
    }
  };

  const handleGenerateCnab = async () => {
    if (!selectedPeriodId) return;
    setLoading(true);
    try {
      await payrollObligationsService.generateCnab240(selectedPeriodId, {
        bankCode,
        paymentChannel,
        includeAlimony: true,
      });
      const res = await payrollObligationsService.fetchPeriodCnabRemittances(selectedPeriodId);
      setCnabInfo(res);
      toast.success('Remessa CNAB 240 (Segmentos A+B + PIX + Pensão) gerada no servidor.');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao gerar CNAB 240.');
    } finally {
      setLoading(false);
    }
  };

  const handleImportReturn = async () => {
    if (!returnText.trim()) {
      toast.error('Cole o conteúdo do arquivo .ret bancário para conciliar.');
      return;
    }
    try {
      const res = await payrollObligationsService.importCnabReturn({
        companyId: selectedCompany?.id,
        remittanceId: cnabInfo?.latest?.id,
        fileName: 'retorno_bancario.ret',
        content: returnText,
      });
      toast.success(`Conciliação concluída: ${res.parsed.paidCount} pago(s), ${res.parsed.rejectedCount} rejeitado(s).`);
      const updated = await payrollObligationsService.fetchPeriodCnabRemittances(selectedPeriodId);
      setCnabInfo(updated);
      setReturnText('');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao processar retorno .ret.');
    }
  };

  const handleLoadWorkerIncome = async (workerId: string) => {
    try {
      const res = await payrollObligationsService.fetchWorkerIncomeReport(incomeYear, workerId);
      setSelectedWorkerReport(res);
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao gerar Informe de Rendimentos.');
    }
  };

  const handleSaveReconciliation = async () => {
    if (!selectedPeriodId || !reconDeclaredTax) return;
    try {
      await payrollObligationsService.saveTaxReconciliation(selectedPeriodId, {
        sourceType: reconSource,
        declaredTaxAmount: Number(reconDeclaredTax),
      });
      const rows = await payrollObligationsService.fetchTaxReconciliation(selectedPeriodId);
      setReconciliationRows(rows);
      setReconDeclaredTax('');
      toast.success('Conciliação fiscal registrada.');
    } catch (err: any) {
      toast.error(err?.message || 'Erro na conciliação.');
    }
  };

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Cabeçalho e Seletor de Competência */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 font-display flex items-center gap-2">
            <Landmark className="text-primary-600" size={26} />
            Contabilização Enterprise, Bancos & Obrigações
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Rateio Multi-CC/CNO, Provisões Reais Acumuladas, Exportadores ERP, CNAB 240/PIX/Retorno e Informe RFB.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={selectedPeriodId}
            onChange={(e) => setSelectedPeriodId(e.target.value)}
            className="input min-w-[240px]"
          >
            <option value="">Selecione a competência...</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {String(p.month).padStart(2, '0')}/{p.year} — {p.type} ({p.status})
              </option>
            ))}
          </select>
          <button onClick={loadCurrentTabData} className="btn-secondary flex items-center gap-2">
            <RefreshCw size={16} /> Atualizar
          </button>
        </div>
      </div>

      {/* Navegação de Abas */}
      <div className="panel p-0 overflow-hidden">
        <div className="flex border-b border-slate-200 bg-slate-50 overflow-x-auto">
          {[
            { id: 'ALLOCATIONS', label: 'Rateio Multi-CC / CNO', icon: PieChart },
            { id: 'PROVISIONS', label: 'Provisões Reais Acumuladas', icon: Layers },
            { id: 'CHART_AND_ERP', label: 'Plano de Contas & ERP', icon: BookOpen },
            { id: 'CNAB', label: 'CNAB 240 / PIX / Retorno', icon: CreditCard },
            { id: 'INCOME_AND_RECON', label: 'Informe RFB & Conciliação', icon: FileSpreadsheet },
          ].map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as HubTab)}
                className={`px-5 py-3.5 text-xs font-bold border-b-2 flex items-center gap-2 whitespace-nowrap transition-all ${
                  activeTab === tab.id
                    ? 'border-primary-600 text-primary-700 bg-white'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="p-6">
          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center text-slate-500">
              <Loader2 className="animate-spin text-primary-600 mb-3" size={28} />
              <span className="text-sm font-medium">Processando apuração no servidor...</span>
            </div>
          ) : (
            <>
              {/* ABA 1: RATEIOS MULTI-CC / TOMADORES / CNO */}
              {activeTab === 'ALLOCATIONS' && (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-bold text-slate-900">Apropriação por Centro de Custo, Tomador e Obra CNO</h2>
                      <p className="text-xs text-slate-500">Distribuição sem perda de centavos com ajuste determinístico no maior rateio.</p>
                    </div>
                    <button onClick={handleGenerateAllocations} className="btn-primary flex items-center gap-2">
                      <Building2 size={16} /> Apurar Rateios do Período
                    </button>
                  </div>

                  {allocData?.summary && allocData.summary.length > 0 ? (
                    <div className="overflow-x-auto border border-slate-200 rounded-xl">
                      <table className="w-full text-xs text-left">
                        <thead className="bg-slate-100 text-slate-700 uppercase font-bold">
                          <tr>
                            <th className="px-4 py-2.5">Centro de Custo</th>
                            <th className="px-4 py-2.5">Projeto / Tomador / CNO</th>
                            <th className="px-4 py-2.5 text-right">Proventos</th>
                            <th className="px-4 py-2.5 text-right">INSS Patronal / RAT</th>
                            <th className="px-4 py-2.5 text-right">FGTS</th>
                            <th className="px-4 py-2.5 text-right">Provisões</th>
                            <th className="px-4 py-2.5 text-right">Custo Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 font-mono">
                          {allocData.summary.map((row, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="px-4 py-2.5 font-sans font-semibold text-slate-900">
                                {row.cost_center_code} — {row.cost_center_name}
                              </td>
                              <td className="px-4 py-2.5 font-sans text-slate-600">
                                {row.cno_number ? `CNO ${row.cno_number}` : row.tomador_cnpj ? `CNPJ ${row.tomador_cnpj}` : row.project_code || 'Padrão'}
                              </td>
                              <td className="px-4 py-2.5 text-right">{fmt(row.total_gross)}</td>
                              <td className="px-4 py-2.5 text-right">{fmt(row.total_employer_inss)}</td>
                              <td className="px-4 py-2.5 text-right">{fmt(row.total_fgts)}</td>
                              <td className="px-4 py-2.5 text-right">{fmt(row.total_provisions)}</td>
                              <td className="px-4 py-2.5 text-right font-bold text-primary-700">{fmt(row.total_cost)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="p-8 text-center border border-dashed border-slate-300 rounded-xl text-sm text-slate-500">
                      Nenhum rateio gerado para esta competência. Clique em &ldquo;Apurar Rateios do Período&rdquo;.
                    </div>
                  )}
                </div>
              )}

              {/* ABA 2: PROVISÕES REAIS ACUMULADAS */}
              {activeTab === 'PROVISIONS' && (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-bold text-slate-900">Razão Contábil de Provisões Acumuladas</h2>
                      <p className="text-xs text-slate-500">Saldo Anterior + 1/12 + Reajuste Salarial − Baixas Reais de Férias/13º = Saldo Final.</p>
                    </div>
                    <button onClick={handleGenerateProvisionsLedger} className="btn-primary flex items-center gap-2">
                      <Layers size={16} /> Processar Provisões Acumuladas
                    </button>
                  </div>

                  {provLedger && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                        <span className="text-xs font-bold text-slate-500">Saldo Acumulado Principal</span>
                        <p className="text-xl font-black font-mono text-slate-900 mt-1">{fmt(provLedger.totalClosingPrincipal)}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                        <span className="text-xs font-bold text-slate-500">Encargos Acumulados Reais</span>
                        <p className="text-xl font-black font-mono text-slate-900 mt-1">{fmt(provLedger.totalClosingCharges)}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-200">
                        <span className="text-xs font-bold text-indigo-800">Lançamento Líquido no Mês</span>
                        <p className="text-xl font-black font-mono text-indigo-700 mt-1">{fmt(provLedger.totalNetEntry)}</p>
                      </div>
                    </div>
                  )}

                  {provLedger && provLedger.entries.length > 0 && (
                    <div className="overflow-x-auto border border-slate-200 rounded-xl">
                      <table className="w-full text-xs text-left">
                        <thead className="bg-slate-100 text-slate-700 uppercase font-bold">
                          <tr>
                            <th className="px-3 py-2.5">Colaborador</th>
                            <th className="px-3 py-2.5">Tipo</th>
                            <th className="px-3 py-2.5 text-right">Saldo Ant.</th>
                            <th className="px-3 py-2.5 text-right">Avo Mês</th>
                            <th className="px-3 py-2.5 text-right">Dif. Reajuste</th>
                            <th className="px-3 py-2.5 text-right">Baixas Pagas</th>
                            <th className="px-3 py-2.5 text-right">Saldo Final</th>
                            <th className="px-3 py-2.5 text-right">Líq. Mês</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 font-mono">
                          {provLedger.entries.map((e) => (
                            <tr key={e.id} className="hover:bg-slate-50">
                              <td className="px-3 py-2 font-sans font-medium text-slate-900">{e.employee_name}</td>
                              <td className="px-3 py-2 font-sans">{e.provision_type === 'VACATION' ? 'Férias + 1/3' : '13º Salário'}</td>
                              <td className="px-3 py-2 text-right">{fmt(e.opening_balance)}</td>
                              <td className="px-3 py-2 text-right">{fmt(e.monthly_accrual)}</td>
                              <td className="px-3 py-2 text-right">{fmt(e.salary_adjustment_diff)}</td>
                              <td className="px-3 py-2 text-right text-emerald-700">-{fmt(e.settlements_paid)}</td>
                              <td className="px-3 py-2 text-right font-bold">{fmt(e.closing_balance)}</td>
                              <td className="px-3 py-2 text-right font-bold text-indigo-700">{fmt(e.net_accounting_entry)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* ABA 3: PLANO DE CONTAS & EXPORTADORES ERP */}
              {activeTab === 'CHART_AND_ERP' && (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-bold text-slate-900">Partidas Dobradas & Exportação Contábil ERP</h2>
                      {entriesReport && (
                        <p className="text-xs text-slate-600 mt-0.5 flex items-center gap-1.5">
                          <CheckCircle2 size={14} className="text-emerald-600" />
                          Débitos: <strong className="font-mono">{fmt(entriesReport.totalDebit)}</strong> | Créditos:{' '}
                          <strong className="font-mono">{fmt(entriesReport.totalCredit)}</strong> (Equilibrado D === C)
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={erpFormat}
                        onChange={(e) => setErpFormat(e.target.value as AccountingErpFormat)}
                        className="input"
                      >
                        <option value="DOMINIO">Domínio Sistemas</option>
                        <option value="ALTERDATA">Alterdata WCont</option>
                        <option value="PROTHEUS">TOTVS Protheus CT2</option>
                        <option value="SENIOR">Senior Sapiens</option>
                        <option value="CSV_CONFIGURABLE">CSV Configurável</option>
                      </select>
                      <button onClick={handleExportErp} className="btn-primary flex items-center gap-2">
                        <Download size={16} /> Exportar Lote
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <div className="px-4 py-2.5 bg-slate-100 text-xs font-bold uppercase text-slate-700">
                        Plano de Contas Ativo ({chartAccounts.length})
                      </div>
                      <div className="max-h-72 overflow-y-auto">
                        <table className="w-full text-xs text-left">
                          <tbody className="divide-y divide-slate-200">
                            {chartAccounts.map((acc) => (
                              <tr key={acc.id}>
                                <td className="px-3 py-2 font-mono font-bold text-slate-800">{acc.account_code}</td>
                                <td className="px-3 py-2 text-slate-700">{acc.account_name}</td>
                                <td className="px-3 py-2 text-right font-mono text-[10px]">{acc.nature}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <div className="px-4 py-2.5 bg-slate-100 text-xs font-bold uppercase text-slate-700">
                        Lançamentos do Período ({entriesReport?.entries.length || 0})
                      </div>
                      <div className="max-h-72 overflow-y-auto">
                        <table className="w-full text-xs text-left">
                          <tbody className="divide-y divide-slate-200">
                            {(entriesReport?.entries || []).map((e, idx) => (
                              <tr key={idx}>
                                <td className="px-3 py-2 font-mono font-bold">{e.accountCode}</td>
                                <td className="px-3 py-2">{e.history}</td>
                                <td className="px-3 py-2 text-center font-mono text-[10px]">{e.type}</td>
                                <td className="px-3 py-2 text-right font-mono font-bold">{fmt(e.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ABA 4: CNAB 240 / PIX / PENSÃO / RETORNO .RET */}
              {activeTab === 'CNAB' && (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-bold text-slate-900">Remessa Bancária CNAB 240 Multi-Banco & Retorno .ret</h2>
                      <p className="text-xs text-slate-500">Segmentos A e B com pagamento automático de salários e pensionistas judiciais.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select value={bankCode} onChange={(e) => setBankCode(e.target.value)} className="input">
                        <option value="001">001 - Banco do Brasil</option>
                        <option value="033">033 - Santander</option>
                        <option value="104">104 - Caixa Econômica</option>
                        <option value="237">237 - Bradesco</option>
                        <option value="341">341 - Itaú</option>
                        <option value="748">748 - Sicredi</option>
                        <option value="077">077 - Banco Inter</option>
                      </select>
                      <select value={paymentChannel} onChange={(e) => setPaymentChannel(e.target.value as any)} className="input">
                        <option value="MIXED">Misto (CC/TED/PIX)</option>
                        <option value="TED_CC">CC / TED</option>
                        <option value="PIX">PIX</option>
                      </select>
                      <button onClick={handleGenerateCnab} className="btn-primary flex items-center gap-2">
                        <CreditCard size={16} /> Gerar Remessa
                      </button>
                    </div>
                  </div>

                  {cnabInfo?.latest && (
                    <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-4 text-xs">
                      <div>
                        <strong>Última Remessa:</strong> {cnabInfo.latest.file_name} ·{' '}
                        <span className="font-mono">Status: {cnabInfo.latest.status}</span> · Total:{' '}
                        <strong className="font-mono text-emerald-700">{fmt(cnabInfo.latest.total_amount)}</strong>
                      </div>
                      <span className="font-mono text-slate-600">
                        Empregados: {cnabInfo.latest.employees_count} | Pensionistas: {cnabInfo.latest.alimony_count}
                      </span>
                    </div>
                  )}

                  <div className="space-y-2">
                    <label className="input-label">Importar Retorno Bancário (.ret) para Conciliação Automática</label>
                    <textarea
                      rows={4}
                      value={returnText}
                      onChange={(e) => setReturnText(e.target.value)}
                      placeholder="Cole aqui o conteúdo do arquivo CNAB 240 .ret retornado pelo banco..."
                      className="input font-mono text-xs"
                    />
                    <button onClick={handleImportReturn} className="btn-secondary flex items-center gap-2">
                      <UploadCloud size={16} /> Processar Conciliação de Retorno
                    </button>
                  </div>
                </div>
              )}

              {/* ABA 5: INFORME DE RENDIMENTOS RFB & CONCILIAÇÃO DCTFWEB/FGTS */}
              {activeTab === 'INCOME_AND_RECON' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Bloco A: Informe de Rendimentos Quadros 1-7 */}
                    <div className="space-y-3 border border-slate-200 rounded-xl p-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                          <FileText size={16} className="text-primary-600" /> Informes de Rendimentos RFB
                        </h3>
                        <input
                          type="number"
                          value={incomeYear}
                          onChange={(e) => setIncomeYear(Number(e.target.value) || 2026)}
                          className="input w-24 text-center font-mono"
                        />
                      </div>
                      <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
                        {incomeWorkers.map((w) => (
                          <div key={w.worker_id} className="py-2 flex items-center justify-between text-xs">
                            <div>
                              <span className="font-semibold text-slate-800 block">{w.full_name}</span>
                              <span className="text-slate-500 font-mono">CPF: {w.cpf}</span>
                            </div>
                            <button
                              onClick={() => handleLoadWorkerIncome(w.worker_id)}
                              className="px-3 py-1 bg-primary-50 text-primary-700 hover:bg-primary-100 rounded-lg font-bold"
                            >
                              Abrir Quadros 1–7
                            </button>
                          </div>
                        ))}
                      </div>
                      {selectedWorkerReport && (
                        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
                          <div className="font-bold text-slate-800">
                            {selectedWorkerReport.report.quadro2Beneficiario.nomeCompleto} — {selectedWorkerReport.report.calendarYear}
                          </div>
                          <div>Tributáveis (Quadro 3): <strong className="font-mono">{fmt(selectedWorkerReport.report.quadro3Tributaveis.totalRendimentos)}</strong></div>
                          <div>13º Líquido (Quadro 5): <strong className="font-mono">{fmt(selectedWorkerReport.report.quadro5Exclusiva.decimoTerceiroLiquidoQuadro)}</strong></div>
                          <div>RRA (Quadro 6): <strong className="font-mono">{fmt(selectedWorkerReport.report.quadro6Rra.rendimentosTributaveis)}</strong></div>
                        </div>
                      )}
                    </div>

                    {/* Bloco B: Conciliação DCTFWeb / FGTS Digital / DARF */}
                    <div className="space-y-3 border border-slate-200 rounded-xl p-4">
                      <h3 className="text-sm font-bold text-slate-900">Conciliação DCTFWeb / FGTS Digital / DARF</h3>
                      <div className="flex gap-2">
                        <select
                          value={reconSource}
                          onChange={(e) => setReconSource(e.target.value as any)}
                          className="input flex-1"
                        >
                          <option value="DCTFWEB">DCTFWeb (Previdenciário)</option>
                          <option value="FGTS_DIGITAL">FGTS Digital</option>
                          <option value="IRRF_DARF">DARF IRRF 0561</option>
                        </select>
                        <input
                          type="number"
                          step="0.01"
                          placeholder="Valor Declarado (R$)"
                          value={reconDeclaredTax}
                          onChange={(e) => setReconDeclaredTax(e.target.value)}
                          className="input w-40 font-mono"
                        />
                        <button onClick={handleSaveReconciliation} className="btn-primary">
                          Confrontar
                        </button>
                      </div>
                      <div className="divide-y divide-slate-100 text-xs">
                        {reconciliationRows.map((r) => (
                          <div key={r.id} className="py-2 flex items-center justify-between">
                            <div>
                              <span className="font-bold text-slate-800">{r.source_type}</span>
                              <span className="block text-slate-500 font-mono">
                                Motor: {fmt(r.engine_tax_amount)} | Declarado: {fmt(r.declared_tax_amount)}
                              </span>
                            </div>
                            <span
                              className={`px-2 py-0.5 rounded font-bold font-mono text-[10px] ${
                                r.status === 'MATCHED' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                              }`}
                            >
                              {r.status} ({fmt(r.diff_amount)})
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
