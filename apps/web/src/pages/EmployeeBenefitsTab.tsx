import React, { useState, useEffect } from 'react';
import {
  Loader2,
  Plus,
  Bus,
  Utensils,
  HeartPulse,
  Gift,
  Trash2,
  UserCheck,
  ShieldCheck,
  Home,
  Users,
} from 'lucide-react';
import { apiClient } from '../lib/apiClient';
import { toast } from 'sonner';
import { confirmDialog } from '../components/ConfirmDialogProvider';

interface BenefitCatalogItem {
  id: string;
  name: string;
  code: string;
  benefit_type: string;
  ans_code?: string | null;
  provider_cnpj?: string | null;
  default_provider?: string | null;
  discount_rule?: string;
  pat_coverage?: boolean;
}

interface BenefitDependent {
  id: string;
  dependent_name: string;
  dependent_cpf?: string | null;
  relationship: string;
  monthly_cost: number;
  employee_discount: number;
  company_subsidy: number;
}

interface EmployeeBenefitRecord {
  id: string;
  benefit_catalog_id: string;
  benefit_name: string;
  benefit_code: string;
  benefit_type: string;
  ans_code?: string | null;
  provider_cnpj?: string | null;
  default_provider?: string | null;
  work_regime: 'PRESENTIAL' | 'REMOTE' | 'HYBRID';
  weekly_remote_days: number;
  daily_passes: number;
  pass_unit_value: number;
  conceded_benefit_value: number;
  holder_monthly_cost: number;
  holder_discount_value: number;
  company_subsidy_amount: number;
  opt_in: boolean;
  start_date: string;
  end_date?: string | null;
  notes?: string | null;
  dependents?: BenefitDependent[];
}

export default function EmployeeBenefitsTab({ contractId }: { contractId?: string }) {
  const [benefits, setBenefits] = useState<EmployeeBenefitRecord[]>([]);
  const [catalog, setCatalog] = useState<BenefitCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form State
  const [selectedCatalogId, setSelectedCatalogId] = useState('');
  const [optIn, setOptIn] = useState(true);
  const [workRegime, setWorkRegime] = useState<'PRESENTIAL' | 'REMOTE' | 'HYBRID'>('PRESENTIAL');
  const [weeklyRemoteDays, setWeeklyRemoteDays] = useState(0);
  const [dailyPasses, setDailyPasses] = useState(2);
  const [passUnitValue, setPassUnitValue] = useState<number | ''>(4.5);
  const [concededValue, setConcededValue] = useState<number | ''>('');
  const [holderMonthlyCost, setHolderMonthlyCost] = useState<number | ''>('');
  const [holderDiscountValue, setHolderDiscountValue] = useState<number | ''>('');
  const [companySubsidy, setCompanySubsidy] = useState<number | ''>('');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    fetchData();
  }, [contractId]);

  const fetchData = async () => {
    if (!contractId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [catRes, empBenRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: BenefitCatalogItem[] }>('/api/v1/benefits/catalogs'),
        apiClient.get<{ success: boolean; data: EmployeeBenefitRecord[] }>(`/api/v1/benefits/employees/${contractId}/benefits`),
      ]);

      if (catRes.data) setCatalog(catRes.data);
      if (empBenRes.data) setBenefits(empBenRes.data);
    } catch (e: any) {
      console.error(e);
      toast.error('Erro ao carregar dados de benefícios');
    } finally {
      setLoading(false);
    }
  };

  const selectedCatalog = catalog.find((c) => c.id === selectedCatalogId);

  const openModal = () => {
    setSelectedCatalogId(catalog[0]?.id || '');
    setOptIn(true);
    setWorkRegime('PRESENTIAL');
    setWeeklyRemoteDays(0);
    setDailyPasses(2);
    setPassUnitValue(4.5);
    setConcededValue('');
    setHolderMonthlyCost('');
    setHolderDiscountValue('');
    setCompanySubsidy('');
    setStartDate(new Date().toISOString().slice(0, 10));
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCatalogId) {
      return toast.error('Selecione um benefício do catálogo');
    }
    if (!contractId) return;

    setSaving(true);
    try {
      const payload: any = {
        benefitCatalogId: selectedCatalogId,
        optIn,
        workRegime,
        weeklyRemoteDays: workRegime === 'HYBRID' ? Number(weeklyRemoteDays) : 0,
        dailyPasses: Number(dailyPasses || 2),
        passUnitValue: passUnitValue !== '' ? Number(passUnitValue) : 0,
        concededBenefitValue: concededValue !== '' ? Number(concededValue) : 0,
        holderMonthlyCost: holderMonthlyCost !== '' ? Number(holderMonthlyCost) : 0,
        holderDiscountValue: holderDiscountValue !== '' ? Number(holderDiscountValue) : 0,
        companySubsidyAmount: companySubsidy !== '' ? Number(companySubsidy) : 0,
        startDate,
      };

      await apiClient.post(`/api/v1/benefits/employees/${contractId}/benefits`, payload);
      toast.success('Benefício vinculado com sucesso!');
      setIsModalOpen(false);
      fetchData();
    } catch (e: any) {
      console.error(e);
      toast.error(`Erro ao vincular benefício: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (benefitId: string) => {
    if (!(await confirmDialog('Tem certeza que deseja cancelar este benefício do colaborador?'))) {
      return;
    }
    try {
      await apiClient.delete(`/api/v1/benefits/employees/${contractId}/benefits/${benefitId}`);
      toast.success('Benefício cancelado');
      fetchData();
    } catch (e: any) {
      console.error(e);
      toast.error(`Erro ao cancelar benefício: ${e.message}`);
    }
  };

  const getBenefitIcon = (type: string) => {
    switch (type) {
      case 'TRANSPORTATION_VOUCHER':
        return <Bus className="w-5 h-5 text-emerald-500" />;
      case 'MEAL_VOUCHER':
      case 'FOOD_VOUCHER':
        return <Utensils className="w-5 h-5 text-amber-500" />;
      case 'HEALTH_PLAN':
      case 'DENTAL_PLAN':
        return <HeartPulse className="w-5 h-5 text-rose-500" />;
      default:
        return <Gift className="w-5 h-5 text-primary-500" />;
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Benefícios Corporativos (FOLHA-08)</h2>
          <p className="text-sm text-slate-500">
            Gestão com teto legal de VT (Lei 7.418/85), planos com registro ANS e coparticipação.
          </p>
        </div>
        <button onClick={openModal} className="btn-primary flex items-center gap-2">
          <Plus size={18} />
          <span>Vincular Benefício</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {benefits.length === 0 ? (
          <div className="col-span-full panel bg-white p-12 rounded-xl border border-slate-200 text-center flex flex-col items-center">
            <Gift className="w-12 h-12 text-slate-300 mb-3" />
            <h3 className="text-slate-600 font-bold mb-1">Nenhum benefício vinculado</h3>
            <p className="text-sm text-slate-400 max-w-sm">
              Este colaborador ainda não possui benefícios ativos. Clique em "Vincular Benefício" para cadastrar.
            </p>
          </div>
        ) : (
          benefits.map((b) => (
            <div
              key={b.id}
              className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow relative flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                      {getBenefitIcon(b.benefit_type)}
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-800 text-sm">{b.benefit_name}</h3>
                      <span className="text-xs text-slate-400 font-mono">Cód: {b.benefit_code}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemove(b.id)}
                    className="text-slate-400 hover:text-rose-500 transition-colors p-1"
                    title="Cancelar benefício"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                {b.benefit_type === 'TRANSPORTATION_VOUCHER' && (
                  <div className="space-y-2 mt-4 text-xs bg-slate-50 p-3 rounded-lg border border-slate-100">
                    <div className="flex items-center justify-between text-slate-600">
                      <span>Regime:</span>
                      <span className="font-semibold text-slate-800 flex items-center gap-1">
                        {b.work_regime === 'HYBRID' ? (
                          <>
                            <Home size={12} className="text-primary-500" />
                            Híbrido ({b.weekly_remote_days}d remoto)
                          </>
                        ) : b.work_regime === 'REMOTE' ? (
                          '100% Remoto (Sem VT)'
                        ) : (
                          'Presencial'
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-600">
                      <span>Passes/dia:</span>
                      <span className="font-semibold text-slate-800">{b.daily_passes} viagens</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-600">
                      <span>Tarifa unitária:</span>
                      <span className="font-semibold text-slate-800">R$ {Number(b.pass_unit_value).toFixed(2)}</span>
                    </div>
                    <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-emerald-700 font-medium">
                      <span>Regra de Cálculo:</span>
                      <span>MIN(6% Salário, Custo VT)</span>
                    </div>
                  </div>
                )}

                {(b.benefit_type === 'HEALTH_PLAN' || b.benefit_type === 'DENTAL_PLAN') && (
                  <div className="space-y-2 mt-4 text-xs bg-slate-50 p-3 rounded-lg border border-slate-100">
                    {b.ans_code && (
                      <div className="flex items-center justify-between text-slate-600">
                        <span className="flex items-center gap-1">
                          <ShieldCheck size={13} className="text-blue-500" />
                          Reg. ANS:
                        </span>
                        <span className="font-mono font-semibold text-slate-800">{b.ans_code}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-slate-600">
                      <span>Mensalidade Titular:</span>
                      <span className="font-semibold text-slate-800">
                        R$ {Number(b.holder_monthly_cost || 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-600">
                      <span>Desconto Colaborador:</span>
                      <span className="font-semibold text-rose-600">
                        R$ {Number(b.holder_discount_value || 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-600">
                      <span>Subsídio Empresa:</span>
                      <span className="font-semibold text-emerald-600">
                        R$ {Number(b.company_subsidy_amount || 0).toFixed(2)}
                      </span>
                    </div>
                    {b.dependents && b.dependents.length > 0 && (
                      <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-primary-700 font-medium">
                        <span className="flex items-center gap-1">
                          <Users size={12} />
                          Dependentes:
                        </span>
                        <span>{b.dependents.length} incluído(s)</span>
                      </div>
                    )}
                  </div>
                )}

                {!['TRANSPORTATION_VOUCHER', 'HEALTH_PLAN', 'DENTAL_PLAN'].includes(b.benefit_type) && (
                  <div className="space-y-2 mt-4 text-xs bg-slate-50 p-3 rounded-lg border border-slate-100">
                    <div className="flex items-center justify-between text-slate-600">
                      <span>Desconto em Folha:</span>
                      <span className="font-semibold text-slate-800">
                        R$ {Number(b.holder_discount_value || 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                <span>Início: {b.start_date}</span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-medium border border-emerald-100">
                  Ativo
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal de Vinculação de Benefício */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 animate-in zoom-in-95">
            <h3 className="text-lg font-bold text-slate-900 mb-4">Vincular Benefício Corporativo</h3>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Selecione o Benefício do Catálogo
                </label>
                <select
                  value={selectedCatalogId}
                  onChange={(e) => setSelectedCatalogId(e.target.value)}
                  className="input-field w-full text-sm"
                  required
                >
                  {catalog.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code}) - {c.benefit_type}
                    </option>
                  ))}
                </select>
              </div>

              {selectedCatalog?.benefit_type === 'TRANSPORTATION_VOUCHER' && (
                <div className="p-3 bg-emerald-50/50 rounded-xl border border-emerald-100 space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="optInVT"
                      checked={optIn}
                      onChange={(e) => setOptIn(e.target.checked)}
                      className="rounded border-slate-300 text-primary-600"
                    />
                    <label htmlFor="optInVT" className="text-xs text-slate-700 font-medium">
                      Colaborador optou por receber Vale-Transporte (Opt-In CLT)
                    </label>
                  </div>

                  {optIn && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-slate-600 mb-1">Regime de Trabalho</label>
                          <select
                            value={workRegime}
                            onChange={(e) => setWorkRegime(e.target.value as any)}
                            className="input-field w-full text-xs"
                          >
                            <option value="PRESENTIAL">100% Presencial</option>
                            <option value="HYBRID">Híbrido (Home Office)</option>
                            <option value="REMOTE">100% Remoto</option>
                          </select>
                        </div>
                        {workRegime === 'HYBRID' && (
                          <div>
                            <label className="block text-xs text-slate-600 mb-1">Dias Remotos / Semana</label>
                            <input
                              type="number"
                              min="1"
                              max="4"
                              value={weeklyRemoteDays}
                              onChange={(e) => setWeeklyRemoteDays(Number(e.target.value))}
                              className="input-field w-full text-xs"
                            />
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-slate-600 mb-1">Passes por Dia</label>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={dailyPasses}
                            onChange={(e) => setDailyPasses(Number(e.target.value))}
                            className="input-field w-full text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-600 mb-1">Tarifa da Passagem (R$)</label>
                          <input
                            type="number"
                            step="0.01"
                            value={passUnitValue}
                            onChange={(e) => setPassUnitValue(e.target.value === '' ? '' : Number(e.target.value))}
                            className="input-field w-full text-xs"
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {(selectedCatalog?.benefit_type === 'HEALTH_PLAN' ||
                selectedCatalog?.benefit_type === 'DENTAL_PLAN') && (
                <div className="p-3 bg-rose-50/40 rounded-xl border border-rose-100 space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-1">Mensalidade Titular (R$)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={holderMonthlyCost}
                        onChange={(e) => setHolderMonthlyCost(e.target.value === '' ? '' : Number(e.target.value))}
                        className="input-field w-full text-xs"
                        placeholder="0.00"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-1">Desconto Titular (R$)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={holderDiscountValue}
                        onChange={(e) => setHolderDiscountValue(e.target.value === '' ? '' : Number(e.target.value))}
                        className="input-field w-full text-xs"
                        placeholder="0.00"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-1">Subsídio Empresa (R$)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={companySubsidy}
                        onChange={(e) => setCompanySubsidy(e.target.value === '' ? '' : Number(e.target.value))}
                        className="input-field w-full text-xs"
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Data de Início da Vigência</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="input-field w-full text-xs"
                  required
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="btn-secondary text-xs"
                  disabled={saving}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn-primary text-xs" disabled={saving}>
                  {saving ? 'Gravando...' : 'Salvar Benefício'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
