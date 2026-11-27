import { useState, useEffect } from 'react';
import {
  Users,
  UserPlus,
  Search,
  Filter,
  CheckCircle2,
  Clock,
  AlertCircle,
  Copy,
  ExternalLink,
  Loader2,
  Building2,
  Briefcase,
  Calendar,
  DollarSign,
  FileText,
  Eye,
  Check,
  X,
  Send,
  Sparkles,
} from 'lucide-react';
import { useCompany } from '../../contexts/CompanyContext';
import { admissionService, AdmissionInvite } from '../../services/admissionService';

export default function AdmissionManagement() {
  const { selectedCompanyId, companies } = useCompany();
  const [invites, setInvites] = useState<AdmissionInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Modal Novo Convite
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [newInvite, setNewInvite] = useState({
    candidateName: '',
    candidateEmail: '',
    candidatePhone: '',
    candidateCpf: '',
    companyId: selectedCompanyId || (companies[0]?.id || ''),
    positionId: '',
    departmentId: '',
    proposedSalary: '',
    hireDate: new Date().toISOString().split('T')[0],
  });
  const [creating, setCreating] = useState(false);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);

  // Modal de Auditoria e Homologação
  const [selectedInvite, setSelectedInvite] = useState<AdmissionInvite | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const fetchInvites = async () => {
    setLoading(true);
    try {
      const data = await admissionService.listInvites(selectedCompanyId || undefined);
      setInvites(data);
    } catch (err) {
      console.error('Erro ao carregar convites de admissão:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInvites();
  }, [selectedCompanyId]);

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newInvite.candidateName || !newInvite.candidateEmail || !newInvite.companyId || !newInvite.proposedSalary) {
      alert('Preencha os campos obrigatórios.');
      return;
    }

    setCreating(true);
    try {
      const salaryCents = Math.round(parseFloat(newInvite.proposedSalary.replace(',', '.')) * 100);
      const res = await admissionService.createInvite({
        companyId: newInvite.companyId,
        candidateName: newInvite.candidateName,
        candidateEmail: newInvite.candidateEmail,
        candidatePhone: newInvite.candidatePhone || undefined,
        candidateCpf: newInvite.candidateCpf || undefined,
        positionId: newInvite.positionId || undefined,
        departmentId: newInvite.departmentId || undefined,
        proposedSalaryCents: salaryCents,
        hireDate: newInvite.hireDate,
      });

      const inviteUrl = `${window.location.origin}/admissao/${res.invite_token}`;
      setGeneratedLink(inviteUrl);
      fetchInvites();
    } catch (err: any) {
      alert(`Erro ao criar convite: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleOpenReview = async (invite: AdmissionInvite) => {
    try {
      const full = await admissionService.getInviteById(invite.id);
      setSelectedInvite(full);
      setReviewNotes('');
    } catch (err: any) {
      alert(`Erro ao abrir detalhes: ${err.message}`);
    }
  };

  const handleApprove = async () => {
    if (!selectedInvite) return;
    setApproving(true);
    try {
      await admissionService.approveAdmission(selectedInvite.id, reviewNotes);
      alert('Admissão homologada com sucesso! Colaborador e contrato criados no sistema.');
      setSelectedInvite(null);
      fetchInvites();
    } catch (err: any) {
      alert(`Erro ao homologar admissão: ${err.message}`);
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    if (!selectedInvite) return;
    if (!reviewNotes.trim()) {
      alert('Informe o motivo da recusa ou as correções necessárias nas notas.');
      return;
    }
    setRejecting(true);
    try {
      await admissionService.rejectAdmission(selectedInvite.id, reviewNotes);
      alert('Admissão rejeitada/retornada para o candidato.');
      setSelectedInvite(null);
      fetchInvites();
    } catch (err: any) {
      alert(`Erro ao rejeitar: ${err.message}`);
    } finally {
      setRejecting(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert('Link copiado para a área de transferência!');
  };

  const filteredInvites = invites.filter((inv) => {
    const matchesSearch =
      inv.candidate_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inv.candidate_email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (inv.candidate_cpf && inv.candidate_cpf.includes(searchTerm));

    const matchesStatus = statusFilter === 'ALL' || inv.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'APPROVED':
        return (
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 size={13} /> Homologado
          </span>
        );
      case 'SUBMITTED':
        return (
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 animate-pulse">
            <Eye size={13} /> Pronto para Revisão
          </span>
        );
      case 'REJECTED':
        return (
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">
            <X size={13} /> Pendente Correção
          </span>
        );
      case 'EXPIRED':
        return (
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-500">
            <Clock size={13} /> Expirado
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
            <Clock size={13} /> Aguardando Candidato
          </span>
        );
    }
  };

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 font-display flex items-center gap-2">
            <UserPlus className="text-primary-600" /> Admissão Digital Self-Service
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Envie links de pré-admissão para os candidatos preencherem dados, enviarem documentos e assinarem termos com validade jurídica.
          </p>
        </div>
        <button
          onClick={() => {
            setGeneratedLink(null);
            setIsNewModalOpen(true);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white font-bold text-xs rounded-lg transition-colors shadow-sm cursor-pointer"
        >
          <Sparkles size={15} /> Novo Convite de Admissão
        </button>
      </div>

      {/* Barra de Filtros */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
        <div className="relative flex-1 w-full sm:w-auto">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar por nome, e-mail ou CPF do candidato..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter size={14} className="text-slate-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="ALL">Todos os Status</option>
            <option value="PENDING">Aguardando Candidato</option>
            <option value="SUBMITTED">Pronto para Revisão</option>
            <option value="APPROVED">Homologados</option>
            <option value="REJECTED">Rejeitados</option>
            <option value="EXPIRED">Expirados</option>
          </select>
        </div>
      </div>

      {/* Tabela de Convites */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-xs text-slate-400">
            <Loader2 size={24} className="animate-spin mx-auto mb-2 text-primary-500" />
            Carregando convites de admissão...
          </div>
        ) : filteredInvites.length === 0 ? (
          <div className="p-12 text-center">
            <Users size={32} className="text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-700">Nenhum convite encontrado</p>
            <p className="text-xs text-slate-400 mt-1">
              Gere um novo convite de admissão digital para iniciar a contratação.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                  <th className="py-3 px-4">Candidato</th>
                  <th className="py-3 px-4">Empresa / Cargo</th>
                  <th className="py-3 px-4">Salário Proposto</th>
                  <th className="py-3 px-4">Data Início</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {filteredInvites.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3 px-4">
                      <p className="font-bold text-slate-900">{inv.candidate_name}</p>
                      <p className="text-[11px] text-slate-400">{inv.candidate_email}</p>
                    </td>
                    <td className="py-3 px-4">
                      <p className="font-semibold text-slate-800">{inv.company_trade_name || inv.company_corporate_name}</p>
                      <p className="text-[11px] text-slate-400">{inv.position_title || 'Cargo a definir'}</p>
                    </td>
                    <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                      {(inv.proposed_salary_cents / 100).toLocaleString('pt-BR', {
                        style: 'currency',
                        currency: 'BRL',
                      })}
                    </td>
                    <td className="py-3 px-4">{inv.hire_date}</td>
                    <td className="py-3 px-4">{getStatusBadge(inv.status)}</td>
                    <td className="py-3 px-4 text-right space-x-2">
                      {inv.status === 'SUBMITTED' ? (
                        <button
                          onClick={() => handleOpenReview(inv)}
                          className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-bold text-xs transition-colors shadow-sm cursor-pointer"
                        >
                          Revisar & Homologar
                        </button>
                      ) : inv.status === 'APPROVED' ? (
                        <button
                          onClick={() => handleOpenReview(inv)}
                          className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold text-xs transition-colors cursor-pointer"
                        >
                          Ver Ficha
                        </button>
                      ) : (
                        <button
                          onClick={() => copyToClipboard(`${window.location.origin}/admissao/${inv.invite_token}`)}
                          className="px-2.5 py-1 border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-lg font-semibold text-xs transition-colors inline-flex items-center gap-1 cursor-pointer"
                          title="Copiar Link"
                        >
                          <Copy size={12} /> Copiar Link
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* MODAL: NOVO CONVITE */}
      {isNewModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Sparkles size={18} className="text-primary-600" /> Gerar Convite de Admissão Digital
              </h3>
              <button
                onClick={() => setIsNewModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {generatedLink ? (
              <div className="space-y-4 py-2">
                <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto">
                  <CheckCircle2 size={28} />
                </div>
                <div className="text-center">
                  <h4 className="font-bold text-sm text-slate-900">Convite Criado com Sucesso!</h4>
                  <p className="text-xs text-slate-500 mt-1">
                    O e-mail foi enviado automaticamente. Você também pode copiar o link seguro abaixo para enviar por WhatsApp:
                  </p>
                </div>

                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-primary-700 truncate">{generatedLink}</span>
                  <button
                    onClick={() => copyToClipboard(generatedLink)}
                    className="p-1.5 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 text-slate-600 cursor-pointer shrink-0"
                    title="Copiar Link"
                  >
                    <Copy size={14} />
                  </button>
                </div>

                <button
                  onClick={() => setIsNewModalOpen(false)}
                  className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer"
                >
                  Concluir
                </button>
              </div>
            ) : (
              <form onSubmit={handleCreateInvite} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Empresa Contratante *</label>
                  <select
                    value={newInvite.companyId}
                    onChange={(e) => setNewInvite({ ...newInvite, companyId: e.target.value })}
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    required
                  >
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.trade_name || c.corporate_name} ({c.cnpj})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-bold text-slate-700 mb-1">Nome Completo do Candidato *</label>
                    <input
                      type="text"
                      value={newInvite.candidateName}
                      onChange={(e) => setNewInvite({ ...newInvite, candidateName: e.target.value })}
                      className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">E-mail do Candidato *</label>
                    <input
                      type="email"
                      value={newInvite.candidateEmail}
                      onChange={(e) => setNewInvite({ ...newInvite, candidateEmail: e.target.value })}
                      className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Celular / WhatsApp</label>
                    <input
                      type="text"
                      value={newInvite.candidatePhone}
                      onChange={(e) => setNewInvite({ ...newInvite, candidatePhone: e.target.value })}
                      className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="(00) 00000-0000"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Salário Proposto (R$) *</label>
                    <input
                      type="text"
                      value={newInvite.proposedSalary}
                      onChange={(e) => setNewInvite({ ...newInvite, proposedSalary: e.target.value })}
                      className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="Ex: 3500.00"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Data Prevista de Início *</label>
                    <input
                      type="date"
                      value={newInvite.hireDate}
                      onChange={(e) => setNewInvite({ ...newInvite, hireDate: e.target.value })}
                      className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      required
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setIsNewModalOpen(false)}
                    className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="px-5 py-2 text-xs font-bold text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {creating ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    Gerar e Enviar Convite
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* MODAL: AUDITORIA E HOMOLOGAÇÃO DO DP */}
      {selectedInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-2xl space-y-5">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Ficha Cadastral: {selectedInvite.candidate_name}
                </h3>
                <p className="text-xs text-slate-400">
                  Submetida em {selectedInvite.submitted_at ? new Date(selectedInvite.submitted_at).toLocaleString('pt-BR') : '-'}
                </p>
              </div>
              <button
                onClick={() => setSelectedInvite(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Dados Pessoais */}
            {selectedInvite.personal_data && (
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs space-y-2">
                <span className="font-bold text-slate-800 text-[13px] block border-b border-slate-200 pb-1 mb-2">
                  Dados Pessoais
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <div>
                    <span className="text-slate-400">CPF:</span>{' '}
                    <span className="font-semibold">{selectedInvite.personal_data.cpf}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">RG:</span>{' '}
                    <span className="font-semibold">{selectedInvite.personal_data.rg}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Nascimento:</span>{' '}
                    <span className="font-semibold">{selectedInvite.personal_data.birthDate}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Mãe:</span>{' '}
                    <span className="font-semibold">{selectedInvite.personal_data.motherName}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">PIS:</span>{' '}
                    <span className="font-semibold">{selectedInvite.personal_data.pisPasep || '-'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">CTPS:</span>{' '}
                    <span className="font-semibold">{selectedInvite.personal_data.ctpsNumber || '-'}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Endereço e Dados Bancários */}
            {selectedInvite.address_data && (
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs space-y-2">
                <span className="font-bold text-slate-800 text-[13px] block border-b border-slate-200 pb-1 mb-2">
                  Endereço & Pagamento
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <span className="text-slate-400">Endereço:</span>{' '}
                    <span className="font-semibold">
                      {selectedInvite.address_data.street}, {selectedInvite.address_data.number} - {selectedInvite.address_data.neighborhood}, {selectedInvite.address_data.city}/{selectedInvite.address_data.state} (CEP {selectedInvite.address_data.zipCode})
                    </span>
                  </div>
                  {selectedInvite.bank_data && (
                    <div>
                      <span className="text-slate-400">Banco:</span>{' '}
                      <span className="font-semibold">
                        {selectedInvite.bank_data.bankName} · Ag. {selectedInvite.bank_data.agency} · Conta {selectedInvite.bank_data.account} ({selectedInvite.bank_data.accountType})
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Vale Transporte e Termos */}
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs space-y-1">
              <span className="font-bold text-slate-800 text-[13px] block border-b border-slate-200 pb-1 mb-2">
                Opções e Termos Legais
              </span>
              <p>
                <strong>Vale-Transporte:</strong>{' '}
                {selectedInvite.transport_option?.optIn ? 'Solicitou VT com desconto de 6%' : 'Renunciou ao VT'}
              </p>
              <p>
                <strong>Acordo de Banco de Horas:</strong>{' '}
                {selectedInvite.time_bank_agreement ? 'Aceito' : 'Não aceito'}
              </p>
              <p>
                <strong>Assinatura Digital:</strong>{' '}
                <span className="font-serif italic text-primary-700">{selectedInvite.signature_svg || selectedInvite.candidate_name}</span>
              </p>
            </div>

            {/* Ações de Homologação */}
            {selectedInvite.status === 'SUBMITTED' && (
              <div className="space-y-3 pt-2 border-t border-slate-100">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Notas da Auditoria / Justificativa</label>
                  <textarea
                    rows={2}
                    value={reviewNotes}
                    onChange={(e) => setReviewNotes(e.target.value)}
                    placeholder="Observações do DP sobre a admissão ou motivo de eventuais correções solicitadas..."
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    onClick={handleReject}
                    disabled={rejecting}
                    className="px-4 py-2 text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 rounded-lg transition-colors cursor-pointer"
                  >
                    {rejecting ? 'Processando...' : 'Solicitar Correções'}
                  </button>
                  <button
                    onClick={handleApprove}
                    disabled={approving}
                    className="px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors shadow-sm cursor-pointer flex items-center gap-1.5"
                  >
                    {approving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                    Homologar Admissão (Criar Colaborador)
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
