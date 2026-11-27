import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Users,
  DollarSign,
  Clock,
  TrendingUp,
  AlertTriangle,
  AlertCircle,
  ShieldAlert,
  ChevronRight,
  Loader2,
  CalendarDays,
  Activity,
  CheckCircle2,
  Building2,
  BarChart3,
  Scale,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { useCompany } from '../contexts/CompanyContext';
import { biService, ExecutiveDashboardData, LaborRiskItem } from '../services/biService';

export default function Dashboard() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<ExecutiveDashboardData | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<string>('ALL');

  const fetchDashboard = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await biService.getExecutiveDashboard(selectedCompanyId || undefined);
      setData(res);
    } catch (err) {
      console.error('Erro ao carregar dados do dashboard executivo:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, [selectedCompanyId]);

  const now = new Date();
  const greeting =
    now.getHours() < 12 ? 'Bom dia' : now.getHours() < 18 ? 'Boa tarde' : 'Boa noite';
  const monthName = now.toLocaleString('pt-BR', { month: 'long' });

  const formatCurrency = (cents: number) => {
    return (cents / 100).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  };

  const filteredRisks = data?.laborRiskRadar.risks.filter((risk) => {
    if (selectedFilter === 'ALL') return true;
    if (selectedFilter === 'DANGER') return risk.severity === 'DANGER';
    if (selectedFilter === 'WARNING') return risk.severity === 'WARNING';
    return risk.article === selectedFilter;
  }) || [];

  return (
    <div className="animate-fade-up space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 font-display flex items-center gap-2">
            {greeting} 👋
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Painel Executivo & Radar de Riscos · Competência {monthName} {now.getFullYear()}{' '}
            {selectedCompany && (
              <span className="font-semibold text-slate-700">· {selectedCompany.trade_name || selectedCompany.corporate_name}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchDashboard(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors shadow-sm cursor-pointer"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin text-primary-500' : ''} />
            Atualizar Indicadores
          </button>
          <Link
            to="/folha/processamento"
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors shadow-sm cursor-pointer"
          >
            <Activity size={14} />
            Motor de Folha
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
            <p className="text-sm text-slate-400 font-medium">Carregando inteligência de dados...</p>
          </div>
        </div>
      ) : data ? (
        <>
          {/* 4 Cards de KPI Executivo */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 1. Custo Real Empresa */}
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="p-2.5 rounded-lg bg-emerald-50 text-emerald-600">
                  <DollarSign size={20} />
                </div>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                  Custo Global
                </span>
              </div>
              <p className="text-2xl font-black text-slate-900 tracking-tight">
                {formatCurrency(data.costs.totalCompanyCostCents)}
              </p>
              <p className="text-xs text-slate-500 mt-1">Custo Real Empresa (Mês Atual)</p>
              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                <span>Bruto: {formatCurrency(data.costs.grossPayrollCents)}</span>
                <span>Encargos: {formatCurrency(data.costs.employerTaxesCents)}</span>
              </div>
            </div>

            {/* 2. Colaboradores Ativos & Ocupação */}
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="p-2.5 rounded-lg bg-primary-50 text-primary-600">
                  <Users size={20} />
                </div>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-primary-50 text-primary-700">
                  Headcount
                </span>
              </div>
              <p className="text-2xl font-black text-slate-900 tracking-tight">
                {data.stats.activeEmployees}
              </p>
              <p className="text-xs text-slate-500 mt-1">Contratos Ativos em Operação</p>
              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                <span>Férias: {data.stats.vacationEmployees}</span>
                <span>Afastados: {data.stats.suspendedEmployees}</span>
              </div>
            </div>

            {/* 3. Horas Extras vs Banco de Horas */}
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="p-2.5 rounded-lg bg-amber-50 text-amber-600">
                  <Clock size={20} />
                </div>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                  Jornada
                </span>
              </div>
              <p className="text-2xl font-black text-slate-900 tracking-tight">
                {data.overtimeVsTimeBank.overtimeHoursMonth}h
              </p>
              <p className="text-xs text-slate-500 mt-1">Horas Extras Realizadas (Mês)</p>
              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                <span>Compensadas: {data.overtimeVsTimeBank.timeBankCompensatedHours}h</span>
                <span>Saldo Banco: {data.overtimeVsTimeBank.totalActiveTimeBankBalanceHours}h</span>
              </div>
            </div>

            {/* 4. Turnover & Absenteísmo */}
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="p-2.5 rounded-lg bg-indigo-50 text-indigo-600">
                  <TrendingUp size={20} />
                </div>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                  Rotatividade
                </span>
              </div>
              <p className="text-2xl font-black text-slate-900 tracking-tight">
                {data.stats.turnoverRateAnnual}%
              </p>
              <p className="text-xs text-slate-500 mt-1">Taxa de Turnover Anualizada</p>
              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                <span>Absenteísmo Mês: {data.stats.absenteeismRateMonth}%</span>
                <span>Empresas: {data.stats.companiesCount}</span>
              </div>
            </div>
          </div>

          {/* RADAR DE RISCO TRABALHISTA (PASSIVOS CLT) */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-5 bg-gradient-to-r from-slate-900 to-slate-800 text-white flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <ShieldAlert size={20} className="text-rose-400" />
                  <h2 className="text-base font-extrabold tracking-tight font-display">
                    Radar de Risco Trabalhista (Passivos CLT)
                  </h2>
                </div>
                <p className="text-xs text-slate-300">
                  Auditoria contínua de prazos legais, intervalos e sobrejornada para prevenção de passivos.
                </p>
              </div>

              {/* Badges de Contagem */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300 text-xs font-bold">
                  <AlertCircle size={14} className="text-rose-400" />
                  <span>{data.laborRiskRadar.dangerCount} Risco Alto</span>
                </div>
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold">
                  <AlertTriangle size={14} className="text-amber-400" />
                  <span>{data.laborRiskRadar.warningCount} Atenção</span>
                </div>
              </div>
            </div>

            {/* Filtros por Categoria de Risco */}
            <div className="p-4 border-b border-slate-100 bg-slate-50 flex flex-wrap gap-2 text-xs font-semibold">
              <button
                onClick={() => setSelectedFilter('ALL')}
                className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                  selectedFilter === 'ALL'
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                }`}
              >
                Todos ({data.laborRiskRadar.totalRisksCount})
              </button>
              <button
                onClick={() => setSelectedFilter('Art. 137 CLT')}
                className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                  selectedFilter === 'Art. 137 CLT'
                    ? 'bg-rose-600 text-white'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                }`}
              >
                Férias em Dobro ({data.laborRiskRadar.vacationRiskCount})
              </button>
              <button
                onClick={() => setSelectedFilter('Art. 66 CLT')}
                className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                  selectedFilter === 'Art. 66 CLT'
                    ? 'bg-rose-600 text-white'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                }`}
              >
                Interjornada &lt; 11h ({data.laborRiskRadar.interjornadaCount})
              </button>
              <button
                onClick={() => setSelectedFilter('Art. 71 CLT')}
                className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                  selectedFilter === 'Art. 71 CLT'
                    ? 'bg-amber-600 text-white'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                }`}
              >
                Intrajornada &lt; 1h ({data.laborRiskRadar.intrajornadaCount})
              </button>
              <button
                onClick={() => setSelectedFilter('Art. 59 CLT')}
                className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                  selectedFilter === 'Art. 59 CLT'
                    ? 'bg-amber-600 text-white'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                }`}
              >
                Excesso de HE &gt; 2h ({data.laborRiskRadar.overtimeExcessCount})
              </button>
              <button
                onClick={() => setSelectedFilter('Banco Excedente')}
                className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                  selectedFilter === 'Banco Excedente'
                    ? 'bg-amber-600 text-white'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                }`}
              >
                Banco &gt; 30h ({data.laborRiskRadar.timeBankExcessCount})
              </button>
            </div>

            {/* Lista dos Riscos */}
            <div className="divide-y divide-slate-100">
              {filteredRisks.length === 0 ? (
                <div className="p-8 text-center">
                  <CheckCircle2 size={32} className="text-emerald-500 mx-auto mb-2" />
                  <p className="text-sm font-bold text-slate-700">Nenhum risco detectado nesta categoria</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Todos os contratos avaliados estão em estrita conformidade com as exigências da CLT.
                  </p>
                </div>
              ) : (
                filteredRisks.map((risk) => (
                  <div
                    key={risk.id}
                    className="p-4 hover:bg-slate-50/80 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-1">
                        {risk.severity === 'DANGER' ? (
                          <div className="p-1.5 rounded-lg bg-rose-50 text-rose-600 border border-rose-200">
                            <AlertCircle size={18} />
                          </div>
                        ) : (
                          <div className="p-1.5 rounded-lg bg-amber-50 text-amber-600 border border-amber-200">
                            <AlertTriangle size={18} />
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-slate-900">{risk.worker_name}</span>
                          <span className="text-[11px] font-mono text-slate-400">CPF: {risk.cpf}</span>
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              risk.severity === 'DANGER'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {risk.article}
                          </span>
                        </div>
                        <p className="text-xs font-semibold text-slate-700 mt-1">{risk.description}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5">{risk.details}</p>
                        <div className="mt-2 text-[11px] text-slate-600 bg-slate-50 p-2 rounded-lg border border-slate-200/60">
                          <span className="font-bold text-slate-700">Ação recomendada: </span>
                          {risk.suggested_action}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                      {risk.article === 'Art. 137 CLT' ? (
                        <Link
                          to="/ferias"
                          className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-1 cursor-pointer"
                        >
                          Programar Férias <ChevronRight size={13} />
                        </Link>
                      ) : (
                        <Link
                          to="/ponto/gestao"
                          className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-1 cursor-pointer"
                        >
                          Ver Ponto <ChevronRight size={13} />
                        </Link>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Gráficos e Histórico dos Últimos 12 Meses */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Histórico 12 Meses */}
            <div className="lg:col-span-2 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <BarChart3 size={18} className="text-primary-600" />
                  <h3 className="font-bold text-sm text-slate-800">
                    Evolução da Massa Salarial (Últimos 12 Meses)
                  </h3>
                </div>
                <span className="text-xs text-slate-400">Totalizadores Fechados</span>
              </div>

              <div className="space-y-3">
                {data.payrollHistory12m.length === 0 ? (
                  <p className="text-xs text-slate-400 py-6 text-center">
                    Nenhum período de folha histórico registrado para exibição.
                  </p>
                ) : (
                  data.payrollHistory12m.map((h) => {
                    const maxCost = Math.max(...data.payrollHistory12m.map((m) => m.totalCost), 1);
                    const percent = Math.min(100, Math.round((h.totalCost / maxCost) * 100));
                    return (
                      <div key={h.periodKey} className="text-xs">
                        <div className="flex justify-between items-center mb-1 text-slate-600">
                          <span className="font-bold">{h.periodKey}</span>
                          <div className="flex gap-4">
                            <span>Bruto: R$ {h.grossAmount.toLocaleString('pt-BR')}</span>
                            <span className="font-bold text-slate-900">
                              Custo Total: R$ {h.totalCost.toLocaleString('pt-BR')}
                            </span>
                          </div>
                        </div>
                        <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                          <div
                            className="bg-primary-500 h-2.5 rounded-full transition-all duration-500"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Composição do Custo Operacional */}
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <Scale size={18} className="text-emerald-600" />
                  <h3 className="font-bold text-sm text-slate-800">Composição do Custo RH</h3>
                </div>

                <div className="space-y-3 text-xs">
                  <div className="flex justify-between items-center p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-slate-600">Salários / Proventos:</span>
                    <span className="font-bold text-slate-900">
                      {formatCurrency(data.costs.grossPayrollCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-slate-600">Encargos Patronais (INSS+FGTS):</span>
                    <span className="font-bold text-slate-900">
                      {formatCurrency(data.costs.employerTaxesCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-slate-600">Provisões (Férias + 13º):</span>
                    <span className="font-bold text-slate-900">
                      {formatCurrency(data.costs.provisionsCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="text-slate-600">Benefícios (VT/VR/Saúde):</span>
                    <span className="font-bold text-slate-900">
                      {formatCurrency(data.costs.benefitsCents)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-200">
                <div className="flex justify-between items-center text-sm font-extrabold text-slate-900">
                  <span>Custo Total Empresa:</span>
                  <span className="text-emerald-700">
                    {formatCurrency(data.costs.totalCompanyCostCents)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
