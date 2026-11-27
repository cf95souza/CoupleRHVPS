import React, { useEffect, useState } from 'react';
import { Building2, Plus, Pencil, Trash2, Loader2, Layers, AlertCircle } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { toast } from 'sonner';
import { confirmDialog } from '../ConfirmDialogProvider';

interface MultipleEmploymentsPanelProps {
  workerId: string | null | undefined;
  contractId?: string | null;
}

const IND_MV_OPTIONS = [
  {
    value: 1,
    label: '1 — Progressivo pela soma das remunerações (até o teto INSS)',
    hint: 'Soma a remuneração externa com a folha atual aplicando alíquota progressiva até o teto.',
  },
  {
    value: 2,
    label: '2 — Complementar considerando INSS já retido no outro vínculo',
    hint: 'Desconta apenas a diferença entre o devido sobre a soma e o INSS comprovadamente retido.',
  },
  {
    value: 3,
    label: '3 — Sem desconto (teto INSS já atingido no outro empregador)',
    hint: 'Zera o INSS do segurado neste contrato; encargos patronais (20%/RAT/FGTS) permanecem integrais.',
  },
];

function formatCnpj(val?: string): string {
  const digits = String(val || '').replace(/\D/g, '');
  if (digits.length !== 14) return val || '';
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

export const MultipleEmploymentsPanel: React.FC<MultipleEmploymentsPanelProps> = ({
  workerId,
  contractId,
}) => {
  const [externals, setExternals] = useState<any[]>([]);
  const [groupContracts, setGroupContracts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const now = new Date();
  const [form, setForm] = useState({
    id: null as string | null,
    employer_cnpj: '',
    employer_name: '',
    esocial_category_code: '101',
    ind_mv: 1,
    competence_year: now.getFullYear(),
    competence_month: now.getMonth() + 1,
    remuneration_amount: '',
    inss_withheld: '',
    is_recurring: false,
    notes: '',
  });

  useEffect(() => {
    if (workerId) {
      fetchData();
    } else {
      setLoading(false);
    }
  }, [workerId]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await apiClient.get<{
        success: boolean;
        data: { externalEmployments: any[]; groupContracts: any[] };
      }>(`/api/v1/employees/${workerId}/other-employments`);
      setExternals(res.data?.externalEmployments || []);
      setGroupContracts(res.data?.groupContracts || []);
    } catch (err) {
      console.error('Erro ao carregar múltiplos vínculos:', err);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setForm({
      id: null,
      employer_cnpj: '',
      employer_name: '',
      esocial_category_code: '101',
      ind_mv: 1,
      competence_year: now.getFullYear(),
      competence_month: now.getMonth() + 1,
      remuneration_amount: '',
      inss_withheld: '',
      is_recurring: false,
      notes: '',
    });
  };

  const handleEdit = (item: any) => {
    setForm({
      id: item.id,
      employer_cnpj: formatCnpj(item.employer_cnpj),
      employer_name: item.employer_name || '',
      esocial_category_code: item.esocial_category_code || '101',
      ind_mv: Number(item.ind_mv || 1),
      competence_year: Number(item.competence_year || now.getFullYear()),
      competence_month: Number(item.competence_month || 1),
      remuneration_amount: String(item.remuneration_amount ?? ''),
      inss_withheld: String(item.inss_withheld ?? ''),
      is_recurring: Boolean(item.is_recurring),
      notes: item.notes || '',
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('Deseja remover este vínculo previdenciário externo?'))) return;
    try {
      await apiClient.delete(`/api/v1/employees/${workerId}/other-employments/${id}`);
      toast.success('Vínculo removido com sucesso.');
      fetchData();
    } catch (err: any) {
      toast.error(err.message || 'Erro ao remover vínculo.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workerId) return;
    setSaving(true);
    try {
      const payload = {
        contract_id: contractId || null,
        employer_cnpj: form.employer_cnpj,
        employer_name: form.employer_name,
        esocial_category_code: form.esocial_category_code,
        ind_mv: Number(form.ind_mv),
        competence_year: Number(form.competence_year),
        competence_month: Number(form.competence_month),
        remuneration_amount: Number(form.remuneration_amount || 0),
        inss_withheld: Number(form.inss_withheld || 0),
        is_recurring: Boolean(form.is_recurring),
        notes: form.notes || null,
      };

      if (form.id) {
        await apiClient.put(`/api/v1/employees/${workerId}/other-employments/${form.id}`, payload);
      } else {
        await apiClient.post(`/api/v1/employees/${workerId}/other-employments`, payload);
      }
      toast.success('Múltiplo vínculo salvo com sucesso.');
      setIsModalOpen(false);
      resetForm();
      fetchData();
    } catch (err: any) {
      toast.error(err.message || 'Erro ao salvar múltiplo vínculo.');
    } finally {
      setSaving(false);
    }
  };

  if (!workerId) {
    return (
      <div className="card p-8 text-center text-slate-500">
        Salve os <strong>Dados Pessoais</strong> primeiro antes de configurar múltiplos vínculos.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-indigo-50 rounded-xl flex items-center justify-center">
            <Layers className="text-indigo-600" size={24} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-800">Múltiplos Vínculos (INSS — eSocial indMV 1/2/3)</h2>
            <p className="text-sm text-slate-500">
              Consolidação automática do teto previdenciário com outros empregadores ou outras matrículas do mesmo CPF.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            resetForm();
            setIsModalOpen(true);
          }}
          className="btn-primary"
        >
          <Plus size={18} />
          Informar Outro Empregador
        </button>
      </div>

      {/* Outras matrículas detectadas automaticamente no Grupo Econômico */}
      {groupContracts.length > 1 && (
        <div className="p-4 rounded-xl bg-blue-50 border border-blue-200 space-y-2">
          <div className="flex items-center gap-2 text-blue-900 font-semibold text-sm">
            <AlertCircle size={16} className="text-blue-600" />
            Consolidação Automática no Grupo Econômico Detectada ({groupContracts.length} matrículas ativas neste CPF)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-blue-800">
            {groupContracts.map((gc) => (
              <div key={gc.contract_id} className="bg-white/80 rounded-lg px-3 py-2 border border-blue-100 flex justify-between">
                <span className="font-medium">{gc.company_name}</span>
                <span className="font-mono text-slate-600">Mat. {gc.registration_number}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
        </div>
      ) : externals.length === 0 ? (
        <div className="card p-10 text-center text-slate-500 border-dashed border-2">
          Nenhum vínculo externo informado. Caso este trabalhador possua outro emprego com desconto de INSS, cadastre acima para limitar o desconto ao teto.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {externals.map((item) => (
            <div key={item.id} className="card p-5 space-y-3 hover:border-indigo-200 transition-colors">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Building2 size={16} className="text-indigo-600" />
                    <h3 className="font-semibold text-slate-800">{item.employer_name}</h3>
                  </div>
                  <p className="text-xs font-mono text-slate-500 mt-0.5">CNPJ: {formatCnpj(item.employer_cnpj)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleEdit(item)}
                    className="p-1.5 text-slate-400 hover:text-primary-600 rounded-md hover:bg-primary-50"
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(item.id)}
                    className="p-1.5 text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                  indMV = {item.ind_mv}
                </span>
                <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-slate-100 text-slate-700">
                  Comp: {String(item.competence_month).padStart(2, '0')}/{item.competence_year}
                </span>
                {item.is_recurring && (
                  <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Recorrente Mensal
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs bg-slate-50 p-3 rounded-lg border border-slate-100">
                <div>
                  <span className="text-slate-500 block">Remuneração Declarada</span>
                  <span className="font-mono font-bold text-slate-800">
                    {Number(item.remuneration_amount || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">INSS Retido Comprovado</span>
                  <span className="font-mono font-bold text-slate-800">
                    {Number(item.inss_withheld || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
            <div className="p-5 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-lg font-bold text-slate-800">
                {form.id ? 'Editar Vínculo Externo' : 'Novo Vínculo em Outro Empregador'}
              </h3>
              <button type="button" onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl">
                &times;
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-700">CNPJ do Outro Empregador *</label>
                  <input
                    required
                    type="text"
                    className="input mt-1"
                    placeholder="00.000.000/0001-00"
                    value={form.employer_cnpj}
                    onChange={(e) => setForm({ ...form, employer_cnpj: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-700">Categoria eSocial *</label>
                  <input
                    required
                    type="text"
                    className="input mt-1"
                    placeholder="101"
                    value={form.esocial_category_code}
                    onChange={(e) => setForm({ ...form, esocial_category_code: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700">Razão Social / Nome do Empregador *</label>
                <input
                  required
                  type="text"
                  className="input mt-1"
                  value={form.employer_name}
                  onChange={(e) => setForm({ ...form, employer_name: e.target.value })}
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700">Indicador de Múltiplos Vínculos (indMV eSocial) *</label>
                <select
                  className="input mt-1"
                  value={form.ind_mv}
                  onChange={(e) => setForm({ ...form, ind_mv: Number(e.target.value) })}
                >
                  {IND_MV_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  {IND_MV_OPTIONS.find((o) => o.value === form.ind_mv)?.hint}
                </p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-700">Mês (1-13) *</label>
                  <input
                    required
                    type="number"
                    min={1}
                    max={13}
                    className="input mt-1"
                    value={form.competence_month}
                    onChange={(e) => setForm({ ...form, competence_month: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-700">Ano *</label>
                  <input
                    required
                    type="number"
                    min={2000}
                    max={2100}
                    className="input mt-1"
                    value={form.competence_year}
                    onChange={(e) => setForm({ ...form, competence_year: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-700">Remuneração INSS *</label>
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    className="input mt-1"
                    value={form.remuneration_amount}
                    onChange={(e) => setForm({ ...form, remuneration_amount: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-700">INSS Retido</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input mt-1"
                    value={form.inss_withheld}
                    onChange={(e) => setForm({ ...form, inss_withheld: e.target.value })}
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_recurring}
                  onChange={(e) => setForm({ ...form, is_recurring: e.target.checked })}
                />
                Aplicar automaticamente nas competências seguintes até atualização cadastral
              </label>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
                <button type="button" onClick={() => setIsModalOpen(false)} className="btn-secondary">
                  Cancelar
                </button>
                <button type="submit" disabled={saving} className="btn-primary">
                  {saving && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
                  Salvar Vínculo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
