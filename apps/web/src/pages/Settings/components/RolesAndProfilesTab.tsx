import { useState, useEffect } from "react";
import { 
  Users, Plus, Shield, Edit, Trash2, Mail, UserPlus, Key, Check, Briefcase, 
  CheckCircle2, XCircle, Copy, Laptop, Globe, Filter, Users as UsersIcon, 
  UserCheck, LogOut, Clock, Smartphone, AlertTriangle, ShieldCheck
} from "lucide-react";
import { apiClient, supabase } from "../../../lib/apiClient";
import InviteUserModal from "./InviteUserModal";
import RoleModal from "./RoleModal";
import EditUserModal from "./EditUserModal";
import { toast } from 'sonner';
import { confirmDialog } from '../../../components/ConfirmDialogProvider';
import { 
  UserManagementService, 
  type TenantUserDetails, 
  type WorkerOption 
} from "../../../services/settings/userManagementService";

interface Role {
  id: string;
  name: string;
  description: string;
  is_system_role?: boolean;
  is_system?: boolean;
}

interface Permission {
  slug: string;
  name: string;
  module: string;
  description: string;
}

interface SessionItem {
  id: string;
  user_id?: string;
  user_email?: string;
  user_name?: string;
  aal: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export default function RolesAndProfilesTab() {
  const [activeSubTab, setActiveSubTab] = useState<'usuarios' | 'perfis' | 'sessoes'>('usuarios');
  
  const [users, setUsers] = useState<TenantUserDetails[]>([]);
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [rolePermissions, setRolePermissions] = useState<string[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  // Sessões Ativas
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [isEditUserModalOpen, setIsEditUserModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<TenantUserDetails | null>(null);
  const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [isCloningRole, setIsCloningRole] = useState(false);
  
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      setLoading(true);

      // 1. Fetch Roles via REST ou DataBridge
      const { data: rolesData, error: rolesError } = await supabase
        .from('roles')
        .select('*')
        .order('name');
      if (rolesError) throw rolesError;
      
      const normalizedRoles = (rolesData || []).map((r: any) => ({
        ...r,
        is_system_role: r.is_system === true || r.is_system_role === true,
      }));
      setRoles(normalizedRoles);
      
      if (normalizedRoles.length > 0 && !selectedRoleId) {
        setSelectedRoleId(normalizedRoles[0].id);
      }

      // 2. Fetch Permissions
      const { data: permsData, error: permsError } = await supabase
        .from('permissions')
        .select('*')
        .order('module, name');
      if (permsError) throw permsError;
      setPermissions(permsData || []);

      // 3. Fetch Enriched Users and Workers
      const [enrichedUsers, availableWorkers] = await Promise.all([
        UserManagementService.fetchTenantUsers(),
        UserManagementService.fetchAvailableWorkers(),
      ]);

      setUsers(enrichedUsers);
      setWorkers(availableWorkers);

    } catch (err) {
      console.error("Erro ao buscar dados RBAC:", err);
      toast.error("Falha ao carregar usuários e perfis.");
    } finally {
      setLoading(false);
    }
  };

  const fetchRolePermissions = async (roleId: string) => {
    try {
      const res = await apiClient.get<{ success: boolean; permissions: string[] }>(`/api/v1/auth/roles/${roleId}/permissions`);
      if (res && res.data && Array.isArray(res.data.permissions)) {
        setRolePermissions(res.data.permissions);
      } else {
        // Fallback dataBridge
        const { data, error } = await supabase
          .from('role_permissions')
          .select('permission_id, permissions ( slug )')
          .eq('role_id', roleId);
        if (error) throw error;
        const slugs = (data || []).map((d: any) => d.permissions?.slug || d.permission_slug).filter(Boolean);
        setRolePermissions(slugs);
      }
    } catch (err) {
      console.error("Erro ao buscar permissões da role:", err);
    }
  };

  const fetchSessions = async () => {
    try {
      setLoadingSessions(true);
      const res = await apiClient.get<{ 
        success: boolean; 
        currentSessionId: string; 
        sessions: SessionItem[] 
      }>('/api/v1/auth/sessions?all=true');

      if (res && res.data) {
        setSessions(res.data.sessions || []);
        setCurrentSessionId(res.data.currentSessionId || null);
      }
    } catch (err) {
      console.error("Erro ao carregar sessões ativas:", err);
      toast.error("Falha ao listar sessões ativas.");
    } finally {
      setLoadingSessions(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (selectedRoleId) {
      fetchRolePermissions(selectedRoleId);
    }
  }, [selectedRoleId]);

  useEffect(() => {
    if (activeSubTab === 'sessoes') {
      fetchSessions();
    }
  }, [activeSubTab]);

  const handleDeleteRole = async (role: Role) => {
    if (role.is_system_role || role.is_system) {
      toast.error("Não é possível excluir um perfil de sistema (imutável).");
      return;
    }
    if (await confirmDialog(`Tem certeza que deseja excluir o perfil '${role.name}'?`)) {
      try {
        await apiClient.delete(`/api/v1/auth/roles/${role.id}`);
        toast.success(`Perfil '${role.name}' excluído com sucesso.`);
        if (selectedRoleId === role.id) setSelectedRoleId(null);
        fetchData();
      } catch (err: any) {
        toast.error(err.message || "Erro ao excluir perfil.");
      }
    }
  };

  const handleRevokeSession = async (sessionId: string, isCurrent: boolean) => {
    const msg = isCurrent 
      ? "Deseja realmente encerrar a sua sessão atual? Você precisará fazer login novamente."
      : "Tem certeza que deseja encerrar remotamente esta sessão de usuário?";

    if (await confirmDialog(msg)) {
      try {
        await apiClient.delete(`/api/v1/auth/sessions/${sessionId}`);
        toast.success("Sessão remota encerrada com sucesso.");
        if (isCurrent) {
          window.location.href = '/login';
        } else {
          fetchSessions();
        }
      } catch (err: any) {
        toast.error(err.message || "Falha ao revogar sessão.");
      }
    }
  };

  const handleOpenEditUser = (user: TenantUserDetails) => {
    setEditingUser(user);
    setIsEditUserModalOpen(true);
  };

  const handleOpenCloneRole = (role: Role) => {
    setEditingRole(role);
    setIsCloningRole(true);
    setIsRoleModalOpen(true);
  };

  const handleOpenNewRole = () => {
    setEditingRole(null);
    setIsCloningRole(false);
    setIsRoleModalOpen(true);
  };

  const handleOpenEditRole = (role: Role) => {
    setEditingRole(role);
    setIsCloningRole(false);
    setIsRoleModalOpen(true);
  };

  const selectedRole = roles.find(r => r.id === selectedRoleId);

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'system_admin':
      case 'tenant_admin':
        return 'bg-purple-100 text-purple-800 border-purple-200';
      case 'dp_analyst':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'sst_specialist':
        return 'bg-emerald-100 text-emerald-800 border-emerald-200';
      case 'manager':
        return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'accountant':
        return 'bg-teal-100 text-teal-800 border-teal-200';
      case 'auditor':
        return 'bg-indigo-100 text-indigo-800 border-indigo-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const getScopeBadge = (scopeMode?: string) => {
    switch (scopeMode) {
      case 'RESTRICTED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <Filter size={11} /> Restrito
          </span>
        );
      case 'OWN_TEAM':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200">
            <UsersIcon size={11} /> Equipe
          </span>
        );
      case 'SELF_ONLY':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200">
            <UserCheck size={11} /> Pessoal
          </span>
        );
      case 'ALL':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
            <Globe size={11} /> Global
          </span>
        );
    }
  };

  const parseUserAgent = (ua: string | null) => {
    if (!ua) return { os: 'Sistema Operacional', browser: 'Navegador Web' };
    let os = 'Dispositivo';
    let browser = 'Navegador';

    if (ua.includes('Windows')) os = 'Windows PC';
    else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

    if (ua.includes('Edg/')) browser = 'Microsoft Edge';
    else if (ua.includes('Chrome/')) browser = 'Google Chrome';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
    else if (ua.includes('Firefox/')) browser = 'Firefox';

    return { os, browser };
  };

  return (
    <div className="card overflow-hidden animate-in fade-in slide-in-from-bottom-2">
      <div className="p-6 bg-slate-50/50 border-b border-slate-200">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
              <Shield size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 font-display">
                Acessos, Perfis & Sessões (RBAC & Governança)
              </h2>
              <p className="text-sm text-slate-500">
                Gerencie matriz de permissões granulares, escopo multidimensional e sessões ativas do sistema.
              </p>
            </div>
          </div>
          
          <div className="flex items-center bg-slate-100 p-1 rounded-lg">
            <button 
              onClick={() => setActiveSubTab('usuarios')}
              className={`px-3.5 py-1.5 text-xs font-bold rounded-md transition-all ${
                activeSubTab === 'usuarios' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Usuários ({users.length})
            </button>
            <button 
              onClick={() => setActiveSubTab('perfis')}
              className={`px-3.5 py-1.5 text-xs font-bold rounded-md transition-all ${
                activeSubTab === 'perfis' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Perfis de Acesso ({roles.length})
            </button>
            <button 
              onClick={() => setActiveSubTab('sessoes')}
              className={`px-3.5 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-1.5 ${
                activeSubTab === 'sessoes' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Laptop size={13} />
              <span>Sessões Ativas</span>
            </button>
          </div>
        </div>
      </div>
      
      <div className="p-6">
        {loading ? (
          <div className="flex justify-center items-center py-16 text-slate-400 gap-3">
            <div className="w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
            <span>Carregando governança de acessos...</span>
          </div>
        ) : activeSubTab === 'usuarios' ? (
          <div className="space-y-4">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h3 className="font-bold text-slate-800">Usuários Vinculados à Organização</h3>
                <p className="text-xs text-slate-500">Controle de credenciais, papéis, escopo organizacional e colaboradores vinculados</p>
              </div>
              <button 
                onClick={() => setIsInviteModalOpen(true)}
                className="btn-primary py-2 px-4 shadow-sm text-sm flex items-center gap-2">
                <UserPlus size={16} />
                <span>Convidar Usuário</span>
              </button>
            </div>
            
            <div className="border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Usuário</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Perfil (Role)</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Escopo</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Colaborador Vinculado</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.map(u => (
                    <tr key={u.tenant_user_id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-4 py-3.5">
                        <div className="font-bold text-slate-900 text-sm">{u.full_name}</div>
                        <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                          <Mail size={12} className="text-slate-400" /> {u.email}
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${getRoleBadgeColor(u.role)}`}>
                          {u.role_name}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        {getScopeBadge(u.scope_mode)}
                      </td>
                      <td className="px-4 py-3.5">
                        {u.worker_name ? (
                          <div className="flex items-center gap-1.5 text-xs text-slate-700 font-medium">
                            <Briefcase size={13} className="text-amber-500" />
                            <span>{u.worker_name}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400 italic">Não vinculado</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        {u.is_active ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100">
                            <CheckCircle2 size={12} />
                            Ativo
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full border border-slate-200">
                            <XCircle size={12} />
                            Inativo
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <button 
                          onClick={() => handleOpenEditUser(u)}
                          className="text-slate-400 hover:text-blue-600 p-1.5 rounded-lg hover:bg-blue-50 transition-colors"
                          title="Editar Permissões e Escopo do Usuário"
                        >
                          <Edit size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-slate-500 text-sm">
                        Nenhum usuário cadastrado nesta organização.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : activeSubTab === 'perfis' ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Lista de Perfis */}
            <div className="col-span-1 border border-slate-200 rounded-xl overflow-hidden flex flex-col h-[540px]">
              <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex justify-between items-center">
                <span className="font-bold text-sm text-slate-700">Perfis Cadastrados</span>
                <button 
                  onClick={handleOpenNewRole}
                  className="btn-primary py-1 px-2.5 text-xs flex items-center gap-1 shadow-xs"
                  title="Criar Novo Perfil"
                >
                  <Plus size={14} />
                  <span>Novo</span>
                </button>
              </div>
              <div className="divide-y divide-slate-100 overflow-y-auto flex-1 bg-white">
                {roles.map(r => (
                  <div 
                    key={r.id} 
                    onClick={() => setSelectedRoleId(r.id)}
                    className={`px-4 py-3 cursor-pointer transition-colors border-l-4 ${
                      selectedRoleId === r.id ? 'bg-blue-50/70 border-blue-500' : 'hover:bg-slate-50 border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className={`font-bold text-sm ${selectedRoleId === r.id ? 'text-blue-900' : 'text-slate-700'}`}>
                        {r.name}
                      </div>
                      {r.is_system_role && (
                        <span className="text-[10px] uppercase bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-extrabold">
                          Sistema
                        </span>
                      )}
                    </div>
                    <div className={`text-xs mt-0.5 line-clamp-1 ${selectedRoleId === r.id ? 'text-blue-700' : 'text-slate-500'}`}>
                      {r.description}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Permissões do Perfil Selecionado */}
            <div className="col-span-1 md:col-span-2 border border-slate-200 rounded-xl overflow-hidden flex flex-col h-[540px]">
              <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex justify-between items-center">
                <span className="font-bold text-sm text-slate-700 truncate mr-2">
                  Permissões: {selectedRole?.name || 'Selecione um perfil'}
                </span>
                
                {selectedRole ? (
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Botão de Clonar Perfil */}
                    <button
                      onClick={() => handleOpenCloneRole(selectedRole)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-md transition-colors"
                      title="Clonar este perfil para gerar um perfil customizado"
                    >
                      <Copy size={13} />
                      <span>Clonar</span>
                    </button>

                    {selectedRole.is_system_role ? (
                      <span className="text-[10px] uppercase bg-slate-200 text-slate-700 px-2 py-1 rounded font-extrabold flex items-center gap-1">
                        <Shield size={11} /> Sistema (Imutável)
                      </span>
                    ) : (
                      <>
                        <button 
                          onClick={() => handleOpenEditRole(selectedRole)}
                          className="text-slate-600 hover:text-blue-600 bg-white border border-slate-200 p-1 rounded-md transition-colors" 
                          title="Editar Perfil"
                        >
                          <Edit size={14} />
                        </button>
                        <button 
                          onClick={() => handleDeleteRole(selectedRole)}
                          className="text-slate-600 hover:text-rose-600 bg-white border border-slate-200 p-1 rounded-md transition-colors" 
                          title="Excluir Perfil"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              
              <div className="p-4 flex-1 overflow-y-auto space-y-6 bg-white">
                {selectedRole ? (
                  <>
                    <p className="text-sm text-slate-600 mb-4">{selectedRole.description}</p>
                    
                    {Array.from(new Set(permissions.map(p => p.module))).map(module => {
                      const modulePerms = permissions.filter(p => p.module === module);
                      const authorizedCount = modulePerms.filter(p => rolePermissions.includes(p.slug)).length;

                      return (
                        <div key={module} className="mb-6">
                          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 border-b border-slate-100 pb-1 flex items-center justify-between">
                            <span>Módulo: {module}</span>
                            <span className="text-[10px] font-normal text-slate-400">
                              {authorizedCount} de {modulePerms.length} autorizadas
                            </span>
                          </h4>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            {modulePerms.map(perm => {
                              const hasPerm = rolePermissions.includes(perm.slug);
                              return (
                                <div key={perm.slug} className={`p-2.5 rounded-lg border flex items-start gap-2.5 transition-all ${
                                  hasPerm ? 'bg-blue-50/40 border-blue-200' : 'bg-slate-50/50 border-slate-100 opacity-55'
                                }`}>
                                  <div className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center shrink-0 ${
                                    hasPerm ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-400'
                                  }`}>
                                    {hasPerm && <Check size={12} strokeWidth={3} />}
                                  </div>
                                  <div>
                                    <div className="text-xs font-bold text-slate-800">{perm.name}</div>
                                    <div className="text-[11px] text-slate-500 leading-tight mt-0.5">{perm.description}</div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    {selectedRole.is_system_role && (
                      <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg flex items-start gap-3 mt-6">
                        <Shield className="text-blue-500 mt-0.5 shrink-0" size={16} />
                        <p className="text-xs text-blue-800 leading-relaxed">
                          <strong>Perfil Canônico do Sistema:</strong> Este perfil segue a matriz canônica da CLT e RBAC P8. Para personalizá-lo para sua empresa, clique no botão <strong>"Clonar"</strong> acima.
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400">
                    <Key size={48} className="mb-4 opacity-20" />
                    <p>Selecione um perfil para visualizar as permissões</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Sub-aba 3: Sessões Ativas e Revogação Remota (RBAC-07) */
          <div className="space-y-4">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h3 className="font-bold text-slate-800">Sessões Conectadas em Tempo Real</h3>
                <p className="text-xs text-slate-500">
                  Monitore dispositivos autenticados, endereços IP e encerre acessos remotamente.
                </p>
              </div>
              <button 
                onClick={fetchSessions}
                disabled={loadingSessions}
                className="px-3 py-1.5 text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors flex items-center gap-1.5"
              >
                <Clock size={13} className={loadingSessions ? 'animate-spin' : ''} />
                <span>Atualizar</span>
              </button>
            </div>

            {loadingSessions ? (
              <div className="flex justify-center items-center py-12 text-slate-400 gap-3">
                <div className="w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
                <span>Carregando sessões ativas...</span>
              </div>
            ) : sessions.length === 0 ? (
              <div className="border border-slate-200 rounded-xl p-8 text-center text-slate-500 text-sm">
                Nenhuma sessão ativa encontrada.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {sessions.map(s => {
                  const isCurrent = s.id === currentSessionId;
                  const { os, browser } = parseUserAgent(s.user_agent);

                  return (
                    <div 
                      key={s.id} 
                      className={`border rounded-xl p-4.5 flex flex-col justify-between transition-all ${
                        isCurrent 
                          ? 'border-emerald-300 bg-emerald-50/30 shadow-xs' 
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      <div>
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                              isCurrent ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
                            }`}>
                              <Laptop size={18} />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h4 className="text-sm font-bold text-slate-800">{browser}</h4>
                                {isCurrent && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-200">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                    Sessão Atual
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-slate-500">{os}</p>
                            </div>
                          </div>

                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                            s.aal === 'aal2' ? 'bg-purple-100 text-purple-800' : 'bg-slate-100 text-slate-600'
                          }`}>
                            {s.aal === 'aal2' ? 'MFA (AAL2)' : 'Senha (AAL1)'}
                          </span>
                        </div>

                        <div className="space-y-1.5 mt-3 pt-3 border-t border-slate-100 text-xs text-slate-600">
                          {s.user_email && (
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400">Usuário:</span>
                              <span className="font-semibold text-slate-800">{s.user_name || s.user_email}</span>
                            </div>
                          )}
                          <div className="flex items-center justify-between">
                            <span className="text-slate-400">Endereço IP:</span>
                            <span className="font-mono text-slate-700">{s.ip_address || '127.0.0.1'}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-slate-400">Última Atividade:</span>
                            <span>{new Date(s.last_seen_at).toLocaleTimeString('pt-BR')} ({new Date(s.last_seen_at).toLocaleDateString('pt-BR')})</span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-slate-100 flex justify-end">
                        <button
                          onClick={() => handleRevokeSession(s.id, isCurrent)}
                          className="px-3 py-1.5 text-xs font-bold text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors border border-rose-200 flex items-center gap-1.5"
                        >
                          <LogOut size={13} />
                          <span>{isCurrent ? "Encerrar Minha Sessão" : "Revogar Sessão Remota"}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <InviteUserModal 
        isOpen={isInviteModalOpen} 
        onClose={() => setIsInviteModalOpen(false)}
        roles={roles}
        workers={workers}
        onSuccess={fetchData}
      />

      <EditUserModal
        isOpen={isEditUserModalOpen}
        onClose={() => { setIsEditUserModalOpen(false); setEditingUser(null); }}
        user={editingUser}
        roles={roles}
        workers={workers}
        onSuccess={fetchData}
      />
      
      <RoleModal 
        isOpen={isRoleModalOpen}
        onClose={() => { setIsRoleModalOpen(false); setIsCloningRole(false); }}
        roleToEdit={editingRole}
        isClone={isCloningRole}
        allPermissions={permissions}
        currentRolePermissions={rolePermissions}
        onSuccess={() => { setIsRoleModalOpen(false); setIsCloningRole(false); fetchData(); }}
      />
    </div>
  );
}
