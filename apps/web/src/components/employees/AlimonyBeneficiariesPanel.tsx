import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Scale,
  Plus,
  Edit,
  Trash2,
  X,
  Loader2,
  Landmark,
  QrCode,
  FileCheck2,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '../../lib/apiClient';
import { formatDate } from '../../lib/dateUtils';
import { confirmDialog } from '../ConfirmDialogProvider';
import Can from '../auth/Can';

interface AlimonyBeneficiary {
  id: string;
  contract_id: string;
  beneficiary_name: string;
  beneficiary_cpf: string | null;
  relationship: string | null;
  court_process_number: string | null;
  court_name: string | null;
  calculation_basis:
    | 'NET_SALARY'
    | 'GROSS_SALARY'
    | 'BASE_SALARY'
    | 'MINIMUM_WAGE'
    | 'FIXED_AMOUNT';
  percentage: number | null;
  fixed_amount: number | null;
  min_amount: number | null;
  max_amount: number | null;
  payment_method: 'BANK_TRANSFER' | 'PIX' | 'JUDICIAL_DEPOSIT';
  pix_key_type: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP' | null;
  pix_key: string | null;
  bank_code: string | null;
  bank_name: string | null;
  bank_agency: string | null;
  bank_account: string | null;
  bank_account_type: 'CORRENTE' | 'POUPANCA' | 'SALARIO' | 'JUDICIAL' | null;
  apply_on_monthly: boolean;
  apply_on_advance: boolean;
  apply_on_vacation: boolean;
  apply_on_thirteenth: boolean;
  apply_on_termination: boolean;
  apply_on_complementary: boolean;
  start_date: string;
  end_date: string | null;
  is_active: boolean;
  notes: string | null;
}

const BASIS_LABELS: Record<AlimonyBeneficiary['calculation_basis'], string> = {
  NET_SALARY: 'Sobre Líquido (Bruto - INSS - IRRF)',
  GROSS_SALARY: 'Sobre Remuneração Bruta',
  BASE_SALARY: 'Sobre Salário Base',
  MINIMUM_WAGE: 'Sobre Salário Mínimo',
  FIXED_AMOUNT: 'Valor Fixo Mensal (R$)',
};

const PAYMENT_LABELS: Record<AlimonyBeneficiary['payment_method'], string> = {
  BANK_TRANSFER: 'Transferência Bancária',
  PIX: 'PIX',
  JUDICIAL_DEPOSIT: 'Depósito Judicial',
};

export function AlimonyBeneficiariesPanel({ contractId }: { contractId: string }) {
  const [beneficiaries, setBeneficiaries] = useState<AlimonyBeneficiary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [beneficiaryCpf, setBeneficiaryCpf] = useState('');
  const [relationship, setRelationship] = useState('FILHO');
  const [courtProcessNumber, setCourtProcessNumber] = useState('');
  const [courtName, setCourtName] = useState('');
  const [calculationBasis, setCalculationBasis] =
    useState<AlimonyBeneficiary['calculation_basis']>('NET_SALARY');
  const [percentage, setPercentage] = useState('');
  const [fixedAmount, setFixedAmount] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [paymentMethod, setPaymentMethod] =
    useState<AlimonyBeneficiary['payment_method']>('PIX');
  const [pixKeyType, setPixKeyType] = useState<'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP'>('CPF');
  const [pixKey, setPixKey] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAgency, setBankAgency] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [bankAccountType, setBankAccountType] =
    useState<'CORRENTE' | 'POUPANCA' | 'SALARIO' | 'JUDICIAL'>('CORRENTE');

  const [applyMonthly, setApplyMonthly] = useState(true);
  const [applyAdvance, setApplyAdvance] = useState(false);
  const [applyVacation, setApplyVacation] = useState(true);
  const [applyThirteenth, setApplyThirteenth] = useState(true);
  const [applyTermination, setApplyTermination] = useState(true);
  const [applyComplementary, setApplyComplementary] = useState(true);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState('');
  const [notes, setNotes] = useState('');

  const fetchBeneficiaries = async () => {
    if (!contractId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await apiClient.get<{ success: boolean; data: AlimonyBeneficiary[] }>(
        `/api/v1/employees/${contractId}/alimony-beneficiaries`
      );
      setBeneficiaries(res.data || []);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro ao carregar beneficiários de pensão.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBeneficiaries();
  }, [contractId]);

  const openCreateModal = () => {
    setEditingId(null);
    setBeneficiaryName('');
    setBeneficiaryCpf('');
    setRelationship('FILHO');
    setCourtProcessNumber('');
    setCourtName('');
    setCalculationBasis('NET_SALARY');
    setPercentage('30');
    setFixedAmount('');
    setMinAmount('');
    setMaxAmount('');
    setPaymentMethod('PIX');
    setPixKeyType('CPF');
    setPixKey('');
    setBankCode('');
    setBankName('');
    setBankAgency('');
    setBankAccount('');
    setBankAccountType('CORRENTE');
    setApplyMonthly(true);
    setApplyAdvance(false);
    setApplyVacation(true);
    setApplyThirteenth(true);
    setApplyTermination(true);
    setApplyComplementary(true);
    setStartDate(new Date().toISOString().slice(0, 10));
    setEndDate('');
    setNotes('');
    setIsModalOpen(true);
  };

  const openEditModal = (b: AlimonyBeneficiary) => {
    setEditingId(b.id);
    setBeneficiaryName(b.beneficiary_name || '');
    setBeneficiaryCpf(b.beneficiary_cpf && !b.beneficiary_cpf.includes('*') ? b.beneficiary_cpf : '');
    setRelationship(b.relationship || 'FILHO');
    setCourtProcessNumber(b.court_process_number || '');
    setCourtName(b.court_name || '');
    setCalculationBasis(b.calculation_basis || 'NET_SALARY');
    setPercentage(b.percentage !== null && b.percentage !== undefined ? String(b.percentage) : '');
    setFixedAmount(b.fixed_amount !== null && b.fixed_amount !== undefined ? String(b.fixed_amount) : '');
    setMinAmount(b.min_amount !== null && b.min_amount !== undefined ? String(b.min_amount) : '');
    setMaxAmount(b.max_amount !== null && b.max_amount !== undefined ? String(b.max_amount) : '');
    setPaymentMethod(b.payment_method || 'BANK_TRANSFER');
    setPixKeyType(b.pix_key_type || 'CPF');
    setPixKey(b.pix_key && !b.pix_key.includes('*') ? b.pix_key : '');
    setBankCode(b.bank_code || '');
    setBankName(b.bank_name || '');
    setBankAgency(b.bank_agency && !b.bank_agency.includes('*') ? b.bank_agency : '');
    setBankAccount(b.bank_account && !b.bank_account.includes('*') ? b.bank_account : '');
    setBankAccountType(b.bank_account_type || 'CORRENTE');
    setApplyMonthly(b.apply_on_monthly);
    setApplyAdvance(b.apply_on_advance);
    setApplyVacation(b.apply_on_vacation);
    setApplyThirteenth(b.apply_on_thirteenth);
    setApplyTermination(b.apply_on_termination);
    setApplyComplementary(b.apply_on_complementary);
    setStartDate(b.start_date ? String(b.start_date).slice(0, 10) : new Date().toISOString().slice(0, 10));
    setEndDate(b.end_date ? String(b.end_date).slice(0, 10) : '');
    setNotes(b.notes || '');
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload: Record<string, any> = {
        beneficiary_name: beneficiaryName.trim(),
        beneficiary_cpf: beneficiaryCpf.trim() ? beneficiaryCpf.replace(/\D/g, '') : undefined,
        relationship: relationship || null,
        court_process_number: courtProcessNumber.trim() || null,
        court_name: courtName.trim() || null,
        calculation_basis: calculationBasis,
        percentage: calculationBasis === 'FIXED_AMOUNT' ? null : Number(percentage || 0),
        fixed_amount: calculationBasis === 'FIXED_AMOUNT' ? Number(fixedAmount || 0) : null,
        min_amount: minAmount ? Number(minAmount) : null,
        max_amount: maxAmount ? Number(maxAmount) : null,
        payment_method: paymentMethod,
        pix_key_type: paymentMethod === 'PIX' ? pixKeyType : null,
        pix_key: paymentMethod === 'PIX' && pixKey.trim() ? pixKey.trim() : undefined,
        bank_code: bankCode.trim() || null,
        bank_name: bankName.trim() || null,
        bank_agency: bankAgency.trim() || undefined,
        bank_account: bankAccount.trim() || undefined,
        bank_account_type: paymentMethod !== 'PIX' ? bankAccountType : null,
        apply_on_monthly: applyMonthly,
        apply_on_advance: applyAdvance,
        apply_on_vacation: applyVacation,
        apply_on_thirteenth: applyThirteenth,
        apply_on_termination: applyTermination,
        apply_on_complementary: applyComplementary,
        start_date: startDate,
        end_date: endDate || null,
        notes: notes.trim() || null,
      };

      if (editingId) {
        await apiClient.put(`/api/v1/employees/${contractId}/alimony-beneficiaries/${editingId}`, payload);
        toast.success('Beneficiário de pensão atualizado.');
      } else {
        await apiClient.post(`/api/v1/employees/${contractId}/alimony-beneficiaries`, payload);
        toast.success('Beneficiário de pensão cadastrado.');
      }

      setIsModalOpen(false);
      await fetchBeneficiaries();
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao salvar beneficiário.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmDialog('Deseja desativar e remover este beneficiário de pensão alimentícia?');
    if (!ok) return;
    try {
      await apiClient.delete(`/api/v1/employees/${contractId}/alimony-beneficiaries/${id}`);
      toast.success('Beneficiário removido.');
      await fetchBeneficiaries();
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao remover beneficiário.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Scale size={18} className="text-indigo-600" />
            Beneficiários de Pensão Alimentícia (Rateio &amp; Solver Pensão ↔ IRRF)
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Para regras sobre salário líquido, o motor resolve automaticamente a circularidade com o IRRF (tolerância R$ 0,01).
          </p>
        </div>
        <Can permission="manage_employees">
          <button
            type="button"
            onClick={openCreateModal}
            className="btn-primary inline-flex items-center gap-2 shrink-0"
          >
            <Plus size={16} />
            <span>Novo Beneficiário</span>
          </button>
        </Can>
      </div>

      {loading ? (
        <div className="bg-white rounded-lg border border-slate-200 p-8 flex justify-center shadow-sm">
          <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
        </div>
      ) : errorMsg ? (
        <div className="bg-rose-50 rounded-lg border border-rose-200 p-4 text-sm text-rose-700">
          {errorMsg}
        </div>
      ) : beneficiaries.length === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 p-8 text-center shadow-sm">
          <Scale className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-semibold text-slate-700">
            Nenhum beneficiário judicial cadastrado
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Cadastre um ou mais beneficiários com dados bancários ou chave PIX para rateio automático na folha.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {beneficiaries.map((b) => (
            <div
              key={b.id}
              className="bg-white rounded-lg border border-slate-200 shadow-sm p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-slate-900 text-base">
                      {b.beneficiary_name}
                    </h3>
                    {b.calculation_basis === 'NET_SALARY' && (
                      <span className="text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded">
                        Solver Circular
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    CPF: {b.beneficiary_cpf || 'Não informado'}
                    {b.relationship ? ` • ${b.relationship}` : ''}
                    {b.court_process_number ? ` • Proc.: ${b.court_process_number}` : ''}
                  </p>
                </div>
                <Can permission="manage_employees">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEditModal(b)}
                      className="p-1.5 text-slate-400 hover:text-indigo-600 transition-colors"
                      title="Editar beneficiário"
                    >
                      <Edit size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(b.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-600 transition-colors"
                      title="Remover beneficiário"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </Can>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100 text-xs">
                <div>
                  <span className="text-slate-500 block">Base de Cálculo</span>
                  <span className="font-medium text-slate-800">
                    {BASIS_LABELS[b.calculation_basis]}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-slate-500 block">Alíquota / Valor</span>
                  <span className="font-semibold text-slate-900">
                    {b.calculation_basis === 'FIXED_AMOUNT'
                      ? `R$ ${Number(b.fixed_amount || 0).toFixed(2)}`
                      : `${Number(b.percentage || 0).toFixed(2)}%`}
                  </span>
                </div>
              </div>

              <div className="bg-slate-50 rounded-md p-2.5 border border-slate-200 text-xs flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-slate-700">
                  {b.payment_method === 'PIX' ? (
                    <QrCode size={14} className="text-indigo-600 shrink-0" />
                  ) : (
                    <Landmark size={14} className="text-slate-600 shrink-0" />
                  )}
                  <span className="font-medium">{PAYMENT_LABELS[b.payment_method]}:</span>
                  {b.payment_method === 'PIX' ? (
                    <span>
                      {b.pix_key_type || 'Chave'} {b.pix_key || 'não informada'}
                    </span>
                  ) : (
                    <span>
                      {b.bank_code || '-'} Ag {b.bank_agency || '-'} Cc {b.bank_account || '-'}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-500">
                  {formatDate(b.start_date)}
                  {b.end_date ? ` - ${formatDate(b.end_date)}` : ''}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 text-[10px]">
                {b.apply_on_monthly && (
                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">Mensal</span>
                )}
                {b.apply_on_vacation && (
                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">Férias</span>
                )}
                {b.apply_on_thirteenth && (
                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">13º</span>
                )}
                {b.apply_on_advance && (
                  <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                    Adiantamento
                  </span>
                )}
                {b.apply_on_termination && (
                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">Rescisão</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {isModalOpen &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
            <div className="bg-white rounded-lg shadow-md w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-slate-200">
              <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50 sticky top-0 z-10">
                <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                  <FileCheck2 size={18} className="text-indigo-600" />
                  {editingId ? 'Editar Beneficiário de Pensão' : 'Novo Beneficiário de Pensão Alimentícia'}
                </h3>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="text-slate-400 hover:text-slate-700"
                >
                  <X size={20} />
                </button>
              </div>

              <form onSubmit={handleSave} className="p-6 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Nome do Beneficiário *
                    </label>
                    <input
                      type="text"
                      required
                      value={beneficiaryName}
                      onChange={(e) => setBeneficiaryName(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      CPF do Beneficiário
                    </label>
                    <input
                      type="text"
                      value={beneficiaryCpf}
                      onChange={(e) => setBeneficiaryCpf(e.target.value)}
                      placeholder="Somente dígitos (opcional)"
                      className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Vínculo / Parentesco
                    </label>
                    <select
                      value={relationship}
                      onChange={(e) => setRelationship(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm bg-white"
                    >
                      <option value="FILHO">Filho(a)</option>
                      <option value="EX_CONJUGE">Ex-Cônjuge</option>
                      <option value="OUTRO">Outro Dependente Judicial</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Nº Processo Judicial
                    </label>
                    <input
                      type="text"
                      value={courtProcessNumber}
                      onChange={(e) => setCourtProcessNumber(e.target.value)}
                      placeholder="0000000-00.2026.8.26.0100"
                      className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Vara / Comarca
                    </label>
                    <input
                      type="text"
                      value={courtName}
                      onChange={(e) => setCourtName(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 border-t border-slate-100 pt-4">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Base de Cálculo *
                    </label>
                    <select
                      value={calculationBasis}
                      onChange={(e) =>
                        setCalculationBasis(e.target.value as AlimonyBeneficiary['calculation_basis'])
                      }
                      className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm bg-white"
                    >
                      <option value="NET_SALARY">Sobre Líquido (Bruto - INSS - IRRF)</option>
                      <option value="GROSS_SALARY">Percentual sobre Remuneração Bruta</option>
                      <option value="BASE_SALARY">Percentual sobre Salário Base</option>
                      <option value="MINIMUM_WAGE">Percentual sobre Salário Mínimo</option>
                      <option value="FIXED_AMOUNT">Valor Fixo Mensal (R$)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      {calculationBasis === 'FIXED_AMOUNT' ? 'Valor Fixo (R$) *' : 'Percentual (%) *'}
                    </label>
                    {calculationBasis === 'FIXED_AMOUNT' ? (
                      <input
                        type="number"
                        step="0.01"
                        required
                        value={fixedAmount}
                        onChange={(e) => setFixedAmount(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                      />
                    ) : (
                      <input
                        type="number"
                        step="0.01"
                        required
                        value={percentage}
                        onChange={(e) => setPercentage(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                      />
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Piso (R$)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={minAmount}
                        onChange={(e) => setMinAmount(e.target.value)}
                        className="w-full px-2 py-2 border border-slate-200 rounded-md text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Teto (R$)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={maxAmount}
                        onChange={(e) => setMaxAmount(e.target.value)}
                        className="w-full px-2 py-2 border border-slate-200 rounded-md text-sm"
                      />
                    </div>
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-4 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Forma de Pagamento
                      </label>
                      <select
                        value={paymentMethod}
                        onChange={(e) =>
                          setPaymentMethod(e.target.value as AlimonyBeneficiary['payment_method'])
                        }
                        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm bg-white"
                      >
                        <option value="PIX">PIX</option>
                        <option value="BANK_TRANSFER">Transferência / TED</option>
                        <option value="JUDICIAL_DEPOSIT">Depósito Judicial</option>
                      </select>
                    </div>
                    {paymentMethod === 'PIX' ? (
                      <>
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">
                            Tipo de Chave PIX
                          </label>
                          <select
                            value={pixKeyType}
                            onChange={(e) => setPixKeyType(e.target.value as any)}
                            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm bg-white"
                          >
                            <option value="CPF">CPF</option>
                            <option value="EMAIL">E-mail</option>
                            <option value="PHONE">Telefone</option>
                            <option value="EVP">Chave Aleatória</option>
                            <option value="CNPJ">CNPJ</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">
                            Chave PIX
                          </label>
                          <input
                            type="text"
                            value={pixKey}
                            onChange={(e) => setPixKey(e.target.value)}
                            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">
                            Banco (Código / Nome)
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="341"
                              value={bankCode}
                              onChange={(e) => setBankCode(e.target.value)}
                              className="w-20 px-2 py-2 border border-slate-200 rounded-md text-sm"
                            />
                            <input
                              type="text"
                              placeholder="Itaú"
                              value={bankName}
                              onChange={(e) => setBankName(e.target.value)}
                              className="flex-1 px-2 py-2 border border-slate-200 rounded-md text-sm"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">
                            Agência / Conta
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="Agência"
                              value={bankAgency}
                              onChange={(e) => setBankAgency(e.target.value)}
                              className="w-24 px-2 py-2 border border-slate-200 rounded-md text-sm"
                            />
                            <input
                              type="text"
                              placeholder="Conta"
                              value={bankAccount}
                              onChange={(e) => setBankAccount(e.target.value)}
                              className="flex-1 px-2 py-2 border border-slate-200 rounded-md text-sm"
                            />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-4 space-y-2">
                  <span className="block text-xs font-semibold text-slate-700">
                    Folhas de Incidência
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                    {[
                      ['Mensal', applyMonthly, setApplyMonthly],
                      ['Férias', applyVacation, setApplyVacation],
                      ['13º Salário', applyThirteenth, setApplyThirteenth],
                      ['Adiantamento', applyAdvance, setApplyAdvance],
                      ['Rescisão', applyTermination, setApplyTermination],
                      ['Complementar', applyComplementary, setApplyComplementary],
                    ].map(([label, checked, setter]: any) => (
                      <label
                        key={label}
                        className="flex items-center gap-2 p-2 rounded-md border border-slate-200 bg-slate-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setter(e.target.checked)}
                          className="rounded border-slate-300"
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Início Vigência *
                    </label>
                    <input
                      type="date"
                      required
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Fim Vigência (Opcional)
                    </label>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="btn-secondary"
                  >
                    Cancelar
                  </button>
                  <button type="submit" disabled={saving} className="btn-primary">
                    {saving ? <Loader2 className="animate-spin" size={16} /> : 'Salvar Beneficiário'}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
