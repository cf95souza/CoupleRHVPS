import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Building2,
  User,
  Home,
  CreditCard,
  Users,
  Bus,
  Upload,
  FileCheck,
  ShieldCheck,
  ChevronRight,
  ChevronLeft,
  Trash2,
  Plus,
  Sparkles,
} from 'lucide-react';
import { admissionService } from '../../services/admissionService';

export default function AdmissionWizard() {
  const { token } = useParams<{ token: string }>();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [invite, setInvite] = useState<any>(null);

  // Etapa atual (1 a 6)
  const [step, setStep] = useState(1);

  // Formulário
  const [personal, setPersonal] = useState({
    fullName: '',
    cpf: '',
    rg: '',
    rgIssuer: '',
    birthDate: '',
    gender: 'MALE',
    maritalStatus: 'SINGLE',
    raceOrColor: 'WHITE',
    motherName: '',
    fatherName: '',
    pisPasep: '',
    ctpsNumber: '',
    ctpsSeries: '',
    cnhNumber: '',
    cnhCategory: '',
  });

  const [address, setAddress] = useState({
    zipCode: '',
    street: '',
    number: '',
    complement: '',
    neighborhood: '',
    city: '',
    state: 'SP',
  });

  const [bank, setBank] = useState({
    bankCode: '001',
    bankName: 'Banco do Brasil',
    agency: '',
    account: '',
    accountType: 'CHECKING' as 'CHECKING' | 'SAVINGS',
    pixKey: '',
  });

  const [dependents, setDependents] = useState<any[]>([]);

  const [transport, setTransport] = useState({
    optIn: false,
    transportLines: '',
    waiverReason: '',
  });

  const [timeBankAgreement, setTimeBankAgreement] = useState(true);
  const [uploadedFiles, setUploadedFiles] = useState<Array<{ fileId: string; fileName: string; label: string }>>([]);
  const [signatureText, setSignatureText] = useState('');
  const [lgpdConsent, setLgpdConsent] = useState(true);

  // Carrega dados iniciais do convite
  useEffect(() => {
    async function load() {
      if (!token) return;
      try {
        const inv = await admissionService.getPublicInvite(token);
        setInvite(inv);
        setPersonal((prev) => ({
          ...prev,
          fullName: inv.candidate_name || '',
          cpf: inv.candidate_cpf || '',
        }));
      } catch (err: any) {
        setError(err.message || 'Convite inválido ou expirado.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [token]);

  // Consulta automática de CEP
  const handleCepBlur = async () => {
    const cleanCep = address.zipCode.replace(/\D/g, '');
    if (cleanCep.length === 8) {
      try {
        const res = await fetch(`https://viacep.com.br/ws/${cleanCep}/json/`);
        const json = await res.json();
        if (!json.erro) {
          setAddress((prev) => ({
            ...prev,
            street: json.logradouro || '',
            neighborhood: json.bairro || '',
            city: json.localidade || '',
            state: json.uf || 'SP',
          }));
        }
      } catch {
        // Ignora erro de CEP
      }
    }
  };

  const handleAddDependent = () => {
    setDependents((prev) => [
      ...prev,
      {
        name: '',
        cpf: '',
        birthDate: '',
        relationship: 'CHILD',
        isIrrfDependent: true,
        isFamilyAllowanceDependent: true,
      },
    ]);
  };

  const handleRemoveDependent = (idx: number) => {
    setDependents((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleFileUpload = async (label: string, file: File) => {
    if (!token) return;
    try {
      const res = await admissionService.uploadPublicDocument(token, file);
      setUploadedFiles((prev) => [...prev, { fileId: res.fileId, fileName: res.fileName, label }]);
    } catch (err: any) {
      alert(`Falha no upload do documento (${label}): ${err.message}`);
    }
  };

  const handleSubmit = async () => {
    if (!token) return;
    if (!signatureText.trim()) {
      alert('Por favor, digite seu nome completo no campo de assinatura digital.');
      return;
    }
    if (!lgpdConsent) {
      alert('É necessário concordar com os termos de tratamento de dados LGPD.');
      return;
    }

    setSubmitting(true);
    try {
      await admissionService.submitAdmission(token, {
        inviteToken: token,
        personalData: personal,
        addressData: address,
        bankData: bank,
        dependentsData: dependents,
        transportOption: transport,
        timeBankAgreement,
        documentFileIds: uploadedFiles.map((f) => f.fileId),
        signatureSvg: signatureText,
      });
      setSuccess(true);
    } catch (err: any) {
      alert(`Erro ao submeter admissão: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="text-center text-white">
          <Loader2 size={36} className="animate-spin text-primary-400 mx-auto mb-3" />
          <p className="text-sm font-semibold">Validando convite de admissão...</p>
        </div>
      </div>
    );
  }

  if (error || !invite) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
          <AlertCircle size={48} className="text-rose-500 mx-auto mb-3" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">Convite Indisponível</h2>
          <p className="text-sm text-slate-600 mb-6">{error}</p>
          <p className="text-xs text-slate-400">
            Entre em contato com o setor de Recursos Humanos da empresa para solicitar uma nova via.
          </p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
          <div className="w-16 h-16 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 size={36} />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Dados Enviados com Sucesso!</h2>
          <p className="text-sm text-slate-600 mb-6">
            Obrigado, <strong>{personal.fullName || invite.candidate_name}</strong>! Seus documentos e dados
            cadastrais foram recebidos em segurança pelo Departamento Pessoal de <strong>{invite.company_name}</strong>.
          </p>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-500">
            Você receberá um e-mail com a confirmação da homologação e orientações sobre seu primeiro dia de trabalho.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        {/* Header do Wizard */}
        <div className="bg-slate-900 rounded-2xl p-6 text-white mb-6 shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary-500 flex items-center justify-center text-white font-extrabold text-xs">
                cR
              </div>
              <span className="font-extrabold text-sm tracking-tight font-display">
                couple<span className="text-primary-400">RH</span> Admissão Digital
              </span>
            </div>
            <span className="text-xs bg-slate-800 text-slate-300 px-3 py-1 rounded-full font-semibold">
              Etapa {step} de 6
            </span>
          </div>

          <h1 className="text-xl font-extrabold font-display">
            Ficha de Admissão: {invite.candidate_name}
          </h1>
          <p className="text-xs text-slate-300 mt-1">
            Empresa: <strong>{invite.company_name}</strong> · Cargo:{' '}
            <strong>{invite.position_title || 'A definir'}</strong> · Início:{' '}
            <strong>{invite.hire_date}</strong>
          </p>

          {/* Barra de Progresso */}
          <div className="w-full bg-slate-800 rounded-full h-2 mt-5 overflow-hidden">
            <div
              className="bg-primary-500 h-2 transition-all duration-300"
              style={{ width: `${(step / 6) * 100}%` }}
            />
          </div>
        </div>

        {/* Card do Passo */}
        <div className="bg-white rounded-2xl p-6 sm:p-8 shadow-sm border border-slate-200 mb-6">
          {/* PASSO 1: DADOS PESSOAIS */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
                <User size={20} className="text-primary-600" />
                <h2 className="text-base font-bold text-slate-900">1. Dados Pessoais e Identificação</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">Nome Completo *</label>
                  <input
                    type="text"
                    value={personal.fullName}
                    onChange={(e) => setPersonal({ ...personal, fullName: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">CPF *</label>
                  <input
                    type="text"
                    value={personal.cpf}
                    onChange={(e) => setPersonal({ ...personal, cpf: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    placeholder="000.000.000-00"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Data de Nascimento *</label>
                  <input
                    type="date"
                    value={personal.birthDate}
                    onChange={(e) => setPersonal({ ...personal, birthDate: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">RG *</label>
                  <input
                    type="text"
                    value={personal.rg}
                    onChange={(e) => setPersonal({ ...personal, rg: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Órgão Emissor / UF *</label>
                  <input
                    type="text"
                    value={personal.rgIssuer}
                    onChange={(e) => setPersonal({ ...personal, rgIssuer: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    placeholder="Ex: SSP/SP"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Gênero</label>
                  <select
                    value={personal.gender}
                    onChange={(e) => setPersonal({ ...personal, gender: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="MALE">Masculino</option>
                    <option value="FEMALE">Feminino</option>
                    <option value="OTHER">Outro / Prefiro não informar</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Estado Civil</label>
                  <select
                    value={personal.maritalStatus}
                    onChange={(e) => setPersonal({ ...personal, maritalStatus: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="SINGLE">Solteiro(a)</option>
                    <option value="MARRIED">Casado(a)</option>
                    <option value="DIVORCED">Divorciado(a)</option>
                    <option value="WIDOWED">Viúvo(a)</option>
                    <option value="SEPARATED">Separado(a)</option>
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">Nome da Mãe *</label>
                  <input
                    type="text"
                    value={personal.motherName}
                    onChange={(e) => setPersonal({ ...personal, motherName: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">PIS/PASEP (se possuir)</label>
                  <input
                    type="text"
                    value={personal.pisPasep}
                    onChange={(e) => setPersonal({ ...personal, pisPasep: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">CTPS (Número e Série)</label>
                  <input
                    type="text"
                    value={personal.ctpsNumber}
                    onChange={(e) => setPersonal({ ...personal, ctpsNumber: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    placeholder="Ex: Digital / 00123"
                  />
                </div>
              </div>
            </div>
          )}

          {/* PASSO 2: ENDEREÇO & DADOS BANCÁRIOS */}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
                  <Home size={20} className="text-primary-600" />
                  <h2 className="text-base font-bold text-slate-900">2. Endereço Residencial</h2>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">CEP *</label>
                    <input
                      type="text"
                      value={address.zipCode}
                      onChange={(e) => setAddress({ ...address, zipCode: e.target.value })}
                      onBlur={handleCepBlur}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="00000-000"
                      required
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-bold text-slate-700 mb-1">Logradouro / Rua *</label>
                    <input
                      type="text"
                      value={address.street}
                      onChange={(e) => setAddress({ ...address, street: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Número *</label>
                    <input
                      type="text"
                      value={address.number}
                      onChange={(e) => setAddress({ ...address, number: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Complemento</label>
                    <input
                      type="text"
                      value={address.complement}
                      onChange={(e) => setAddress({ ...address, complement: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="Ex: Apto 42"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Bairro *</label>
                    <input
                      type="text"
                      value={address.neighborhood}
                      onChange={(e) => setAddress({ ...address, neighborhood: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      required
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-bold text-slate-700 mb-1">Cidade *</label>
                    <input
                      type="text"
                      value={address.city}
                      onChange={(e) => setAddress({ ...address, city: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Estado (UF) *</label>
                    <input
                      type="text"
                      value={address.state}
                      onChange={(e) => setAddress({ ...address, state: e.target.value.toUpperCase() })}
                      maxLength={2}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 uppercase"
                      required
                    />
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
                  <CreditCard size={20} className="text-emerald-600" />
                  <h2 className="text-base font-bold text-slate-900">3. Dados Bancários para Pagamento de Salário</h2>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-bold text-slate-700 mb-1">Instituição Bancária *</label>
                    <input
                      type="text"
                      value={bank.bankName}
                      onChange={(e) => setBank({ ...bank, bankName: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="Ex: Nubank, Itaú, Bradesco..."
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Tipo de Conta</label>
                    <select
                      value={bank.accountType}
                      onChange={(e) => setBank({ ...bank, accountType: e.target.value as any })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <option value="CHECKING">Conta Corrente</option>
                      <option value="SAVINGS">Conta Poupança</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Agência (com dígito) *</label>
                    <input
                      type="text"
                      value={bank.agency}
                      onChange={(e) => setBank({ ...bank, agency: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Conta (com dígito) *</label>
                    <input
                      type="text"
                      value={bank.account}
                      onChange={(e) => setBank({ ...bank, account: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Chave PIX (opcional)</label>
                    <input
                      type="text"
                      value={bank.pixKey}
                      onChange={(e) => setBank({ ...bank, pixKey: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="CPF, E-mail ou Celular"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* PASSO 3: DEPENDENTES */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
                <div className="flex items-center gap-2">
                  <Users size={20} className="text-primary-600" />
                  <h2 className="text-base font-bold text-slate-900">3. Dependentes (IRRF e Salário-Família)</h2>
                </div>
                <button
                  onClick={handleAddDependent}
                  className="flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-600 rounded-lg text-xs font-bold hover:bg-primary-100 transition-colors cursor-pointer"
                >
                  <Plus size={14} /> Adicionar Dependente
                </button>
              </div>

              {dependents.length === 0 ? (
                <div className="text-center py-8 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                  <p className="text-xs text-slate-500">Nenhum dependente informado.</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Caso não possua dependentes (filhos ou cônjuge), você pode avançar para a próxima etapa.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {dependents.map((dep, idx) => (
                    <div key={idx} className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-bold text-slate-700">Dependente #{idx + 1}</span>
                        <button
                          onClick={() => handleRemoveDependent(idx)}
                          className="text-rose-500 hover:text-rose-700 text-xs flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 size={13} /> Remover
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="sm:col-span-2">
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">Nome Completo</label>
                          <input
                            type="text"
                            value={dep.name}
                            onChange={(e) => {
                              const updated = [...dependents];
                              updated[idx].name = e.target.value;
                              setDependents(updated);
                            }}
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">CPF</label>
                          <input
                            type="text"
                            value={dep.cpf}
                            onChange={(e) => {
                              const updated = [...dependents];
                              updated[idx].cpf = e.target.value;
                              setDependents(updated);
                            }}
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">Data de Nascimento</label>
                          <input
                            type="date"
                            value={dep.birthDate}
                            onChange={(e) => {
                              const updated = [...dependents];
                              updated[idx].birthDate = e.target.value;
                              setDependents(updated);
                            }}
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">Parentesco</label>
                          <select
                            value={dep.relationship}
                            onChange={(e) => {
                              const updated = [...dependents];
                              updated[idx].relationship = e.target.value;
                              setDependents(updated);
                            }}
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                          >
                            <option value="CHILD">Filho(a)</option>
                            <option value="SPOUSE">Cônjuge / Companheiro(a)</option>
                            <option value="STEPCHILD">Enteado(a)</option>
                            <option value="PARENT">Pai / Mãe</option>
                            <option value="OTHER">Outro</option>
                          </select>
                        </div>

                        <div className="flex items-center gap-4 sm:col-span-3 pt-1">
                          <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={dep.isIrrfDependent}
                              onChange={(e) => {
                                const updated = [...dependents];
                                updated[idx].isIrrfDependent = e.target.checked;
                                setDependents(updated);
                              }}
                              className="rounded text-primary-600 focus:ring-primary-500"
                            />
                            Deduzir do Imposto de Renda (IRRF)
                          </label>

                          <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={dep.isFamilyAllowanceDependent}
                              onChange={(e) => {
                                const updated = [...dependents];
                                updated[idx].isFamilyAllowanceDependent = e.target.checked;
                                setDependents(updated);
                              }}
                              className="rounded text-primary-600 focus:ring-primary-500"
                            />
                            Direito a Salário-Família (filhos até 14 anos)
                          </label>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* PASSO 4: VALE-TRANSPORTE & BANCO DE HORAS */}
          {step === 4 && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
                  <Bus size={20} className="text-primary-600" />
                  <h2 className="text-base font-bold text-slate-900">4. Opção de Vale-Transporte (Lei 7.418/85)</h2>
                </div>

                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-4">
                  <p className="text-xs text-slate-600 leading-relaxed">
                    O Vale-Transporte é destinado ao deslocamento residência-trabalho e vice-versa, com desconto legal
                    de até 6% do salário-base.
                  </p>

                  <div className="space-y-2">
                    <label className="flex items-center gap-2 p-3 bg-white rounded-lg border border-slate-200 cursor-pointer">
                      <input
                        type="radio"
                        name="vt_option"
                        checked={transport.optIn}
                        onChange={() => setTransport({ ...transport, optIn: true })}
                        className="text-primary-600 focus:ring-primary-500"
                      />
                      <div>
                        <span className="text-xs font-bold text-slate-800">Sim, opto por receber o Vale-Transporte</span>
                        <p className="text-[11px] text-slate-400">Autorizo o desconto legal de até 6% em folha de pagamento.</p>
                      </div>
                    </label>

                    <label className="flex items-center gap-2 p-3 bg-white rounded-lg border border-slate-200 cursor-pointer">
                      <input
                        type="radio"
                        name="vt_option"
                        checked={!transport.optIn}
                        onChange={() => setTransport({ ...transport, optIn: false })}
                        className="text-primary-600 focus:ring-primary-500"
                      />
                      <div>
                        <span className="text-xs font-bold text-slate-800">Não, renuncio ao Vale-Transporte</span>
                        <p className="text-[11px] text-slate-400">Declaro utilizar condução própria para deslocamento.</p>
                      </div>
                    </label>
                  </div>

                  {transport.optIn && (
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">
                        Linhas de Ônibus / Metrô e Quantidade Diária *
                      </label>
                      <textarea
                        rows={2}
                        value={transport.transportLines}
                        onChange={(e) => setTransport({ ...transport, transportLines: e.target.value })}
                        className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                        placeholder="Ex: 2 passagens Linha 4312 (Ida e Volta) + Metrô Linha 3 Vermelha"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
                  <ShieldCheck size={20} className="text-emerald-600" />
                  <h2 className="text-base font-bold text-slate-900">Acordo Individual de Banco de Horas (Art. 59 §5º CLT)</h2>
                </div>

                <div className="p-4 bg-emerald-50/50 rounded-xl border border-emerald-200 space-y-3">
                  <p className="text-xs text-slate-700 leading-relaxed">
                    Fica pactuado o regime de compensação de jornada por Banco de Horas individual, de modo que as horas
                    extras trabalhadas poderão ser compensadas pela correspondente diminuição em outro dia, no prazo de até 6
                    meses, ou pagas com o adicional legal.
                  </p>

                  <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={timeBankAgreement}
                      onChange={(e) => setTimeBankAgreement(e.target.checked)}
                      className="rounded text-emerald-600 focus:ring-emerald-500"
                    />
                    Concordo com o termo de Acordo Individual de Banco de Horas
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* PASSO 5: UPLOAD DE DOCUMENTOS */}
          {step === 5 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
                <Upload size={20} className="text-primary-600" />
                <h2 className="text-base font-bold text-slate-900">5. Envio de Documentos (Fotos ou PDFs)</h2>
              </div>

              <p className="text-xs text-slate-500">
                Envie fotos nítidas ou arquivos em PDF dos documentos solicitados para conferência pelo DP.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { label: 'RG ou CNH (Frente e Verso)', key: 'RG_CNH' },
                  { label: 'Comprovante de Residência (recente)', key: 'RESIDENCE' },
                  { label: 'Título de Eleitor / Reservista', key: 'VOTER_MILITARY' },
                  { label: 'Certidão de Nascimento / Casamento', key: 'CIVIL_CERT' },
                ].map((doc) => {
                  const uploaded = uploadedFiles.find((f) => f.label === doc.label);
                  return (
                    <div key={doc.key} className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                      <div className="flex justify-between items-start mb-2">
                        <span className="font-bold text-slate-800">{doc.label}</span>
                        {uploaded && (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                            <FileCheck size={12} /> Enviado
                          </span>
                        )}
                      </div>
                      <input
                        type="file"
                        accept="image/*,.pdf"
                        onChange={(e) => {
                          if (e.target.files && e.target.files[0]) {
                            handleFileUpload(doc.label, e.target.files[0]);
                          }
                        }}
                        className="w-full text-slate-500 file:mr-2 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100 cursor-pointer"
                      />
                      {uploaded && <p className="text-[10px] text-slate-400 mt-1 truncate">{uploaded.fileName}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* PASSO 6: LGPD & ASSINATURA ELETRÔNICA */}
          {step === 6 && (
            <div className="space-y-6">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
                <ShieldCheck size={20} className="text-primary-600" />
                <h2 className="text-base font-bold text-slate-900">6. Consentimento LGPD & Assinatura Eletrônica</h2>
              </div>

              {/* Termo LGPD */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-600 space-y-2 max-h-48 overflow-y-auto leading-relaxed">
                <p className="font-bold text-slate-800">Termo de Tratamento de Dados Pessoais (Lei 13.709/2018):</p>
                <p>
                  Declaro sob as penas da lei que todas as informações prestadas e documentos anexados são autênticos e
                  verdadeiros. Autorizo expressamente a empresa <strong>{invite.company_name}</strong> a tratar e
                  armazenar meus dados pessoais e sensíveis para os fins exclusivos de contratação, formalização de vínculo
                  empregatício, cumprimento de obrigações legais perante o Ministério do Trabalho e Previdência Social
                  (eSocial) e execução do contrato de trabalho.
                </p>
              </div>

              <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={lgpdConsent}
                  onChange={(e) => setLgpdConsent(e.target.checked)}
                  className="rounded text-primary-600 focus:ring-primary-500"
                />
                Declaro que li e concordo integralmente com os termos de privacidade e LGPD
              </label>

              {/* Assinatura Eletrônica */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <label className="block text-xs font-bold text-slate-700">
                  Assinatura Eletrônica (Digite seu nome completo exatamente como no documento) *
                </label>
                <input
                  type="text"
                  value={signatureText}
                  onChange={(e) => setSignatureText(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-serif italic border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                  placeholder="Nome Completo para Assinatura Digital"
                  required
                />
                <p className="text-[11px] text-slate-400">
                  Ao assinar eletronicamente, seus dados de IP, data/hora e identificador do dispositivo serão vinculados
                  como comprovante de validade jurídica conforme Medida Provisória nº 2.200-2/2001.
                </p>
              </div>
            </div>
          )}

          {/* Botões de Navegação */}
          <div className="flex justify-between items-center mt-8 pt-4 border-t border-slate-100">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="flex items-center gap-1 px-4 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
              >
                <ChevronLeft size={16} /> Voltar
              </button>
            ) : (
              <div />
            )}

            {step < 6 ? (
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                className="flex items-center gap-1 px-5 py-2 text-xs font-bold text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors shadow-sm cursor-pointer"
              >
                Próximo <ChevronRight size={16} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="flex items-center gap-2 px-6 py-2.5 text-xs font-extrabold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors shadow-md cursor-pointer disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Enviando Admissão...
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={16} />
                    Finalizar e Assinar Admissão
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
