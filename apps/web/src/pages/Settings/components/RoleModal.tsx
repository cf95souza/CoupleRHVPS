import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Shield, Check, Copy, CheckSquare, Square } from "lucide-react";
import { apiClient } from "../../../lib/apiClient";
import { toast } from "sonner";

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

interface RoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  roleToEdit: Role | null;
  isClone?: boolean;
  allPermissions: Permission[];
  currentRolePermissions: string[];
  onSuccess: () => void;
}

export default function RoleModal({ 
  isOpen, 
  onClose, 
  roleToEdit, 
  isClone = false,
  allPermissions, 
  currentRolePermissions, 
  onSuccess 
}: RoleModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (roleToEdit) {
        setName(isClone ? `[Cópia] ${roleToEdit.name}` : roleToEdit.name);
        setDescription(roleToEdit.description || "");
        setSelectedPerms([...currentRolePermissions]);
      } else {
        setName("");
        setDescription("");
        setSelectedPerms([]);
      }
      setError(null);
    }
  }, [isOpen, roleToEdit, isClone, currentRolePermissions]);

  if (!isOpen) return null;

  const togglePermission = (slug: string) => {
    if (selectedPerms.includes(slug)) {
      setSelectedPerms(selectedPerms.filter(p => p !== slug));
    } else {
      setSelectedPerms([...selectedPerms, slug]);
    }
  };

  const toggleModulePermissions = (module: string) => {
    const modulePerms = allPermissions.filter(p => p.module === module).map(p => p.slug);
    const allSelected = modulePerms.every(slug => selectedPerms.includes(slug));

    if (allSelected) {
      // Remove todas do módulo
      setSelectedPerms(selectedPerms.filter(slug => !modulePerms.includes(slug)));
    } else {
      // Adiciona todas do módulo que ainda não estão selecionadas
      const newSelected = new Set([...selectedPerms, ...modulePerms]);
      setSelectedPerms(Array.from(newSelected));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("O nome do perfil é obrigatório.");
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const payload = {
        name: name.trim(),
        description: description.trim(),
        permissionSlugs: selectedPerms,
      };

      if (roleToEdit && !isClone) {
        // Atualizar papel existente
        await apiClient.put(`/api/v1/auth/roles/${roleToEdit.id}`, payload);
        toast.success(`Perfil '${name}' atualizado com sucesso!`);
      } else {
        // Criar ou Clonar novo papel
        await apiClient.post('/api/v1/auth/roles', payload);
        toast.success(`Perfil '${name}' criado com sucesso!`);
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      console.error("Erro ao salvar perfil:", err);
      const msg = err.message || err.error || "Ocorreu um erro ao salvar o perfil.";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  // Agrupar permissões por módulo
  const modules = Array.from(new Set(allPermissions.map(p => p.module)));

  return createPortal(
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 shrink-0">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              isClone ? 'bg-amber-100 text-amber-600' : 'bg-primary-100 text-primary-600'
            }`}>
              {isClone ? <Copy size={20} /> : <Shield size={20} />}
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800 font-display">
                {isClone ? "Clonar Perfil de Acesso" : roleToEdit ? "Editar Perfil" : "Novo Perfil de Acesso"}
              </h2>
              <p className="text-xs text-slate-500">
                {isClone 
                  ? `Criando cópia personalizada a partir de '${roleToEdit?.name}'`
                  : "Defina o nome, a descrição e a matriz de permissões granulares"}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="p-6 overflow-y-auto flex-1 space-y-6">
            {error && (
              <div className="p-3 bg-rose-50 text-rose-700 text-sm rounded-lg border border-rose-100 shrink-0">
                {error}
              </div>
            )}

            <div className="space-y-4 shrink-0">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Nome do Perfil</label>
                <input 
                  type="text" 
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all text-sm font-medium"
                  placeholder="Ex: Gestor Operacional de Unidade"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Descrição</label>
                <textarea 
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all text-sm resize-none h-18"
                  placeholder="Descreva as atribuições e finalidade deste perfil..."
                />
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-bold text-slate-800">Matriz de Permissões Granulares (RBAC P8)</h3>
                  <p className="text-xs text-slate-500">
                    {selectedPerms.length} de {allPermissions.length} permissões concedidas a este perfil
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedPerms(allPermissions.map(p => p.slug))}
                    className="text-xs font-semibold text-primary-600 hover:text-primary-700 px-2 py-1 bg-primary-50 hover:bg-primary-100 rounded"
                  >
                    Marcar Todas
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedPerms([])}
                    className="text-xs font-semibold text-slate-500 hover:text-slate-700 px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded"
                  >
                    Limpar
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                {modules.map(module => {
                  const modulePerms = allPermissions.filter(p => p.module === module);
                  const isAllModuleSelected = modulePerms.every(p => selectedPerms.includes(p.slug));
                  const selectedCount = modulePerms.filter(p => selectedPerms.includes(p.slug)).length;

                  return (
                    <div key={module} className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col">
                      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-200">
                        <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                          {module}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleModulePermissions(module)}
                          className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-primary-600"
                        >
                          {isAllModuleSelected ? <CheckSquare size={13} className="text-primary-600" /> : <Square size={13} />}
                          <span>{selectedCount}/{modulePerms.length}</span>
                        </button>
                      </div>

                      <div className="space-y-2.5 flex-1">
                        {modulePerms.map(perm => {
                          const isSelected = selectedPerms.includes(perm.slug);
                          return (
                            <label key={perm.slug} className="flex items-start gap-2.5 cursor-pointer group">
                              <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                                isSelected ? 'bg-primary-600 border-primary-600' : 'bg-white border-slate-300 group-hover:border-primary-400'
                              }`}>
                                {isSelected && <Check size={12} className="text-white" strokeWidth={3} />}
                              </div>
                              <input 
                                type="checkbox"
                                className="hidden"
                                checked={isSelected}
                                onChange={() => togglePermission(perm.slug)}
                              />
                              <div className="min-w-0">
                                <div className="text-xs font-bold text-slate-700 group-hover:text-primary-700 transition-colors">
                                  {perm.name}
                                </div>
                                <div className="text-[10px] text-slate-400 leading-tight mt-0.5">
                                  {perm.description}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="p-5 border-t border-slate-100 bg-slate-50/50 shrink-0 flex justify-end gap-3">
            <button 
              type="button"
              onClick={onClose}
              disabled={loading}
              className="py-2 px-5 bg-white border border-slate-200 text-slate-700 rounded-lg font-bold text-sm hover:bg-slate-50 transition-colors"
            >
              Cancelar
            </button>
            <button 
              type="submit"
              disabled={loading}
              className="py-2 px-6 bg-primary-600 text-white rounded-lg font-bold text-sm hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-sm"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  <span>Salvando...</span>
                </>
              ) : (
                <>
                  <Check size={16} />
                  <span>{isClone ? "Criar Perfil Clonado" : roleToEdit ? "Salvar Alterações" : "Criar Perfil"}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
