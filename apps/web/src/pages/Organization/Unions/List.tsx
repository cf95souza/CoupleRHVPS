import { useState, useEffect } from 'react';
import {
  Search,
  Plus,
  Loader2,
  Scale,
  Calendar,
  Building2,
  FileText,
  DollarSign,
  Clock,
  Shield,
  ChevronDown,
  ChevronUp,
  X,
  CheckCircle,
} from 'lucide-react';
import { apiClient } from '../../../lib/apiClient';
import { toast } from 'sonner';

interface Union {
  id: string;
  code: string | null;
  cnpj: string;
  name: string;
  trade_name: string | null;
  union_type: 'EMPLOYEE' | 'EMPLOYER';
  base_month: number;
  state: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  is_active: boolean;
  total_agreements: number;
}

interface CollectiveAgreement {
  id: string;
  union_id: string;
  title: string;
  agreement_type: 'CCT' | 'ACT';
  start_date: string;
  end_date: string;
  base_salary_floor: number;
  overtime_percentage_tier1: number;
  overtime_percentage_tier2: number;
  overtime_percentage_sunday_holiday: number;
  night_shift_percentage: number;
  night_shift_start_time: string;
  night_shift_end_time: string;
  night_hour_reduced: boolean;
  unhealthiness_base_type: 'MINIMUM_WAGE' | 'BASE_SALARY' | 'CATEGORY_FLOOR';
  ats_type: 'NONE' | 'ANUENIO' | 'BIENIO' | 'TRIENIO' | 'QUINQUENIO';
  ats_percentage_per_cycle: number;
  ats_max_percentage: number | null;
  average_calculation_months: number;
  post_vacation_stability_days: number;
  is_active: boolean;
}

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

export default function UnionsList() {
  const [unions, setUnions] = useState<Union[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedUnionType, setSelectedUnionType] = useState<string>('ALL');
  const [expandedUnionId, setExpandedUnionId] = useState<string | null>(null);
  const [agreements, setAgreements] = useState<Record<string, CollectiveAgreement[]>>({});
  const [loadingAgreements, setLoadingAgreements] = useState<Record<string, boolean>>({});

  // Modais
  const [isUnionModalOpen, setIsUnionModalOpen] = useState(false);
  const [isAgreementModalOpen, setIsAgreementModalOpen] = useState(false);
  const [activeUnionForAgreement, setActiveUnionForAgreement] = useState<Union | null>(null);
  const [saving, setSaving] = useState(false);

  // Form Union
  const [unionForm, setUnionForm] = useState({
    code: '',
    cnpj: '',
    name: '',
    tradeName: '',
    unionType: 'EMPLOYEE' as 'EMPLOYEE' | 'EMPLOYER',
    baseMonth: 5,
    state: '',
    city: '',
    phone: '',
    email: '',
    notes: '',
  });

  // Form Agreement
  const [agreementForm, setAgreementForm] = useState({
    title: '',
    agreementType: 'CCT' as 'CCT' | 'ACT',
    startDate: '',
    endDate: '',
    baseSalaryFloor: 0,
    overtimePercentageTier1: 50,
    overtimePercentageTier2: 100,
    overtimePercentageSundayHoliday: 100,
    nightShiftPercentage: 20,
    nightShiftStartTime: '22:00:00',
    nightShiftEndTime: '05:00:00',
    nightHourReduced: true,
    unhealthinessBaseType: 'MINIMUM_WAGE' as 'MINIMUM_WAGE' | 'BASE_SALARY' | 'CATEGORY_FLOOR',
    atsType: 'NONE' as 'NONE' | 'ANUENIO' | 'BIENIO' | 'TRIENIO' | 'QUINQUENIO',
    atsPercentagePerCycle: 0,
    atsMaxPercentage: null as number | null,
    averageCalculationMonths: 12,
    postVacationStabilityDays: 0,
    notes: '',
  });

  useEffect(() => {
    fetchUnions();
  }, [searchTerm, selectedUnionType]);

  const fetchUnions = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.append('search', searchTerm);
      if (selectedUnionType !== 'ALL') params.append('union_type', selectedUnionType);

      const res = await apiClient.get<{ success: boolean; data: Union[] }>(
        `/api/v1/unions?${params.toString()}`
      );
      if (res.data?.success) {
        setUnions(res.data.data);
      }
    } catch (err: any) {
      toast.error('Erro ao carregar sindicatos.');
    } finally {
      setLoading(false);
    }
  };

  const fetchAgreementsForUnion = async (unionId: string) => {
    setLoadingAgreements((prev) => ({ ...prev, [unionId]: true }));
    try {
      const res = await apiClient.get<{ success: boolean; data: CollectiveAgreement[] }>(
        `/api/v1/unions/${unionId}/agreements`
      );
      if (res.data?.success) {
        setAgreements((prev) => ({ ...prev, [unionId]: res.data.data }));
      }
    } catch {
      toast.error('Erro ao carregar convenções do sindicato.');
    } finally {
      setLoadingAgreements((prev) => ({ ...prev, [unionId]: false }));
    }
  };

  const toggleExpand = (unionId: string) => {
    if (expandedUnionId === unionId) {
      setExpandedUnionId(null);
    } else {
      setExpandedUnionId(unionId);
      if (!agreements[unionId]) {
        fetchAgreementsForUnion(unionId);
      }
    }
  };

  const handleCreateUnion = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiClient.post<{ success: boolean; data: Union }>(
        '/api/v1/unions',
        unionForm
      );
      if (res.data?.success) {
        toast.success('Sindicato cadastrado com sucesso!');
        setIsUnionModalOpen(false);
        setUnionForm({
          code: '',
          cnpj: '',
          name: '',
          tradeName: '',
          unionType: 'EMPLOYEE',
          baseMonth: 5,
          state: '',
          city: '',
          phone: '',
          email: '',
          notes: '',
        });
        fetchUnions();
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Erro ao cadastrar sindicato.');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAgreement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeUnionForAgreement) return;
    setSaving(true);
    try {
      const res = await apiClient.post<{ success: boolean; data: CollectiveAgreement }>(
        `/api/v1/unions/${activeUnionForAgreement.id}/agreements`,
        agreementForm
      );
      if (res.data?.success) {
        toast.success('Convenção Coletiva (CCT) cadastrada com sucesso!');
        setIsAgreementModalOpen(false);
        fetchAgreementsForUnion(activeUnionForAgreement.id);
        fetchUnions();
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Erro ao cadastrar convenção coletiva.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <Scale className="text-primary h-7 w-7" />
            Sindicatos e Convenções Coletivas (CCT)
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Gestão de sindicatos profissionais/patronais, data-base, pisos da categoria, ATS e parâmetros normativos de folha.
          </p>
        </div>
        <button
          onClick={() => setIsUnionModalOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition shadow-sm"
        >
          <Plus size={16} />
          Novo Sindicato
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="relative w-full sm:w-96">
          <Search className="absolute left-3 top-2.5 text-slate-400" size={18} />
          <input
            type="text"
            placeholder="Buscar por nome, sigla, CNPJ ou código..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <span className="text-xs font-medium text-slate-500 whitespace-nowrap">Tipo:</span>
          <select
            value={selectedUnionType}
            onChange={(e) => setSelectedUnionType(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
          >
            <option value="ALL">Todos os Tipos</option>
            <option value="EMPLOYEE">Laboral (Empregados)</option>
            <option value="EMPLOYER">Patronal (Empregadores)</option>
          </select>
        </div>
      </div>

      {/* Unions List */}
      {loading ? (
        <div className="flex flex-col items-center justify-center p-12 bg-white rounded-xl border border-slate-200">
          <Loader2 className="h-8 w-8 text-primary animate-spin mb-2" />
          <p className="text-sm text-slate-500">Carregando sindicatos cadastrados...</p>
        </div>
      ) : unions.length === 0 ? (
        <div className="p-12 text-center bg-white rounded-xl border border-slate-200">
          <Scale className="h-12 w-12 text-slate-300 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-700">Nenhum sindicato encontrado</h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto mt-1">
            Cadastre os sindicatos representantes das categorias da empresa para vincular pisos, convenções coletivas e regras automáticas de folha.
          </p>
          <button
            onClick={() => setIsUnionModalOpen(true)}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition"
          >
            <Plus size={16} />
            Cadastrar Primeiro Sindicato
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {unions.map((u) => {
            const isExpanded = expandedUnionId === u.id;
            const unionAgreements = agreements[u.id] || [];
            const isLoadingAgr = loadingAgreements[u.id] || false;

            return (
              <div
                key={u.id}
                className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden transition"
              >
                {/* Header row */}
                <div
                  className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 cursor-pointer hover:bg-slate-50/50"
                  onClick={() => toggleExpand(u.id)}
                >
                  <div className="flex items-start gap-4">
                    <div className="h-11 w-11 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 mt-0.5">
                      <Building2 size={22} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-900 text-base">{u.name}</span>
                        {u.trade_name && (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                            {u.trade_name}
                          </span>
                        )}
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            u.union_type === 'EMPLOYEE'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-purple-50 text-purple-700 border border-purple-200'
                          }`}
                        >
                          {u.union_type === 'EMPLOYEE' ? 'Laboral (Empregados)' : 'Patronal'}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-slate-500 mt-1 flex-wrap">
                        <span>CNPJ: {u.cnpj}</span>
                        {u.code && <span>Cód. Sindical: {u.code}</span>}
                        {u.state && <span>Abrangência: {u.city ? `${u.city} - ` : ''}{u.state}</span>}
                        <span className="text-blue-700 font-medium">
                          Data-Base: {MONTH_NAMES[u.base_month - 1]} (Mês {u.base_month})
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 self-end md:self-auto">
                    <span className="text-xs font-medium px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg">
                      {u.total_agreements} {u.total_agreements === 1 ? 'CCT ativa' : 'CCTs ativas'}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveUnionForAgreement(u);
                        setIsAgreementModalOpen(true);
                      }}
                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-lg transition flex items-center gap-1.5"
                    >
                      <Plus size={14} />
                      Nova CCT
                    </button>
                    <div className="text-slate-400">
                      {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                    </div>
                  </div>
                </div>

                {/* Expanded Agreements Drawer */}
                {isExpanded && (
                  <div className="border-t border-slate-100 bg-slate-50/60 p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                        <FileText size={14} />
                        Convenções e Acordos Coletivos Vigentes
                      </h4>
                      <button
                        onClick={() => {
                          setActiveUnionForAgreement(u);
                          setIsAgreementModalOpen(true);
                        }}
                        className="text-xs text-primary font-medium hover:underline flex items-center gap-1"
                      >
                        <Plus size={12} />
                        Adicionar Acordo Coletivo
                      </button>
                    </div>

                    {isLoadingAgr ? (
                      <div className="flex items-center justify-center p-6 text-sm text-slate-500">
                        <Loader2 className="h-5 w-5 text-primary animate-spin mr-2" />
                        Carregando acordos...
                      </div>
                    ) : unionAgreements.length === 0 ? (
                      <p className="text-xs text-slate-400 italic p-3 bg-white rounded-lg border border-slate-200 text-center">
                        Nenhuma convenção coletiva cadastrada para este sindicato ainda.
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 gap-3">
                        {unionAgreements.map((ca) => (
                          <div
                            key={ca.id}
                            className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3"
                          >
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                              <div>
                                <span className="font-semibold text-sm text-slate-900">{ca.title}</span>
                                <span className="ml-2 text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                                  {ca.agreement_type}
                                </span>
                              </div>
                              <span className="text-xs text-slate-500 flex items-center gap-1">
                                <Calendar size={13} className="text-slate-400" />
                                Vigência: {ca.start_date} até {ca.end_date}
                              </span>
                            </div>

                            {/* Key parameters grid */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-100 text-xs">
                              <div className="p-2 rounded-lg bg-slate-50">
                                <span className="text-slate-400 block text-[10px] uppercase font-semibold">
                                  Piso Geral CCT
                                </span>
                                <span className="font-bold text-slate-800">
                                  {ca.base_salary_floor > 0
                                    ? `R$ ${ca.base_salary_floor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
                                    : 'CLT Padrão'}
                                </span>
                              </div>

                              <div className="p-2 rounded-lg bg-slate-50">
                                <span className="text-slate-400 block text-[10px] uppercase font-semibold">
                                  ATS ({ca.ats_type})
                                </span>
                                <span className="font-bold text-slate-800">
                                  {ca.ats_type !== 'NONE'
                                    ? `${ca.ats_percentage_per_cycle}% por ciclo ${
                                        ca.ats_max_percentage ? `(máx ${ca.ats_max_percentage}%)` : ''
                                      }`
                                    : 'Não aplicável'}
                                </span>
                              </div>

                              <div className="p-2 rounded-lg bg-slate-50">
                                <span className="text-slate-400 block text-[10px] uppercase font-semibold">
                                  Horas Extras
                                </span>
                                <span className="font-bold text-slate-800">
                                  {ca.overtime_percentage_tier1}% / {ca.overtime_percentage_tier2}% (Dom {ca.overtime_percentage_sunday_holiday}%)
                                </span>
                              </div>

                              <div className="p-2 rounded-lg bg-slate-50">
                                <span className="text-slate-400 block text-[10px] uppercase font-semibold">
                                  Noturno & Estabilidade
                                </span>
                                <span className="font-bold text-slate-800">
                                  {ca.night_shift_percentage}% noturno · {ca.post_vacation_stability_days}d pós-férias
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal: Novo Sindicato */}
      {isUnionModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-lg flex items-center gap-2">
                <Building2 className="text-primary" size={20} />
                Cadastrar Novo Sindicato
              </h3>
              <button
                onClick={() => setIsUnionModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleCreateUnion} className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    CNPJ do Sindicato *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="00.000.000/0000-00"
                    value={unionForm.cnpj}
                    onChange={(e) => setUnionForm({ ...unionForm, cnpj: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Código Sindical (eSocial)
                  </label>
                  <input
                    type="text"
                    placeholder="Ex: 000.123.456.78910-1"
                    value={unionForm.code}
                    onChange={(e) => setUnionForm({ ...unionForm, code: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Razão Social / Nome Oficial *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Sindicato dos Empregados no Comércio de São Paulo"
                  value={unionForm.name}
                  onChange={(e) => setUnionForm({ ...unionForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Sigla / Fantasia
                  </label>
                  <input
                    type="text"
                    placeholder="SECSP"
                    value={unionForm.tradeName}
                    onChange={(e) => setUnionForm({ ...unionForm, tradeName: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Tipo de Sindicato
                  </label>
                  <select
                    value={unionForm.unionType}
                    onChange={(e) => setUnionForm({ ...unionForm, unionType: e.target.value as any })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  >
                    <option value="EMPLOYEE">Laboral (Empregados)</option>
                    <option value="EMPLOYER">Patronal (Empregadores)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Mês da Data-Base *
                  </label>
                  <select
                    value={unionForm.baseMonth}
                    onChange={(e) => setUnionForm({ ...unionForm, baseMonth: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  >
                    {MONTH_NAMES.map((m, idx) => (
                      <option key={idx + 1} value={idx + 1}>
                        {m} (Mês {idx + 1})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    UF de Abrangência
                  </label>
                  <input
                    type="text"
                    maxLength={2}
                    placeholder="SP"
                    value={unionForm.state}
                    onChange={(e) => setUnionForm({ ...unionForm, state: e.target.value.toUpperCase() })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Município de Abrangência
                  </label>
                  <input
                    type="text"
                    placeholder="São Paulo"
                    value={unionForm.city}
                    onChange={(e) => setUnionForm({ ...unionForm, city: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsUnionModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 flex items-center gap-2"
                >
                  {saving && <Loader2 size={16} className="animate-spin" />}
                  Salvar Sindicato
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Nova Convenção Coletiva */}
      {isAgreementModalOpen && activeUnionForAgreement && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
              <div>
                <h3 className="font-bold text-slate-900 text-lg flex items-center gap-2">
                  <FileText className="text-primary" size={20} />
                  Cadastrar Convenção Coletiva (CCT)
                </h3>
                <p className="text-xs text-slate-500">
                  Sindicato: {activeUnionForAgreement.name} ({activeUnionForAgreement.trade_name || activeUnionForAgreement.cnpj})
                </p>
              </div>
              <button
                onClick={() => setIsAgreementModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleCreateAgreement} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Título da Convenção / Acordo *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: CCT Comércio Varejista SP 2026/2027"
                  value={agreementForm.title}
                  onChange={(e) => setAgreementForm({ ...agreementForm, title: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Tipo</label>
                  <select
                    value={agreementForm.agreementType}
                    onChange={(e) => setAgreementForm({ ...agreementForm, agreementType: e.target.value as any })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  >
                    <option value="CCT">CCT (Convenção Coletiva)</option>
                    <option value="ACT">ACT (Acordo Coletivo)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Início da Vigência *</label>
                  <input
                    type="date"
                    required
                    value={agreementForm.startDate}
                    onChange={(e) => setAgreementForm({ ...agreementForm, startDate: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Fim da Vigência *</label>
                  <input
                    type="date"
                    required
                    value={agreementForm.endDate}
                    onChange={(e) => setAgreementForm({ ...agreementForm, endDate: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  />
                </div>
              </div>

              {/* Piso e Base Insalubridade */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200/80 space-y-3">
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                  Piso Salarial e Insalubridade
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Piso Salarial Geral da Categoria (R$)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="2200.00"
                      value={agreementForm.baseSalaryFloor}
                      onChange={(e) => setAgreementForm({ ...agreementForm, baseSalaryFloor: Number(e.target.value) })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Base de Cálculo da Insalubridade
                    </label>
                    <select
                      value={agreementForm.unhealthinessBaseType}
                      onChange={(e) => setAgreementForm({ ...agreementForm, unhealthinessBaseType: e.target.value as any })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    >
                      <option value="MINIMUM_WAGE">Salário Mínimo Federal (CLT Padrão)</option>
                      <option value="CATEGORY_FLOOR">Piso Salarial da Categoria</option>
                      <option value="BASE_SALARY">Salário Base do Contrato</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Adicional por Tempo de Serviço (ATS) */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200/80 space-y-3">
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                  Adicional por Tempo de Serviço (ATS)
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Periodicidade do ATS</label>
                    <select
                      value={agreementForm.atsType}
                      onChange={(e) => setAgreementForm({ ...agreementForm, atsType: e.target.value as any })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    >
                      <option value="NONE">Sem ATS</option>
                      <option value="ANUENIO">Anuênio (1 ano)</option>
                      <option value="BIENIO">Biênio (2 anos)</option>
                      <option value="TRIENIO">Triênio (3 anos)</option>
                      <option value="QUINQUENIO">Quinquênio (5 anos)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Percentual por Ciclo (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="1.0"
                      value={agreementForm.atsPercentagePerCycle}
                      onChange={(e) => setAgreementForm({ ...agreementForm, atsPercentagePerCycle: Number(e.target.value) })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Teto Máximo ATS (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Opcional"
                      value={agreementForm.atsMaxPercentage || ''}
                      onChange={(e) =>
                        setAgreementForm({
                          ...agreementForm,
                          atsMaxPercentage: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                  </div>
                </div>
              </div>

              {/* Horas Extras e Noturno */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200/80 space-y-3">
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                  Horas Extras, Noturno e Estabilidade
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">HE 1ª Faixa (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={agreementForm.overtimePercentageTier1}
                      onChange={(e) => setAgreementForm({ ...agreementForm, overtimePercentageTier1: Number(e.target.value) })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">HE 2ª Faixa (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={agreementForm.overtimePercentageTier2}
                      onChange={(e) => setAgreementForm({ ...agreementForm, overtimePercentageTier2: Number(e.target.value) })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Noturno (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={agreementForm.nightShiftPercentage}
                      onChange={(e) => setAgreementForm({ ...agreementForm, nightShiftPercentage: Number(e.target.value) })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Estabilidade Pós-Férias (dias)</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={agreementForm.postVacationStabilityDays}
                      onChange={(e) => setAgreementForm({ ...agreementForm, postVacationStabilityDays: Number(e.target.value) })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsAgreementModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 flex items-center gap-2"
                >
                  {saving && <Loader2 size={16} className="animate-spin" />}
                  Salvar Convenção Coletiva
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
