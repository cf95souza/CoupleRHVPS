import React from 'react';
import { ShieldAlert, ArrowLeft, Home, Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface AccessDenied403Props {
  missingPermission?: string | string[];
}

export default function AccessDenied403({ missingPermission }: AccessDenied403Props) {
  const navigate = useNavigate();

  const missingText = Array.isArray(missingPermission)
    ? missingPermission.join(' ou ')
    : missingPermission;

  return (
    <div className="min-h-[75vh] flex flex-col items-center justify-center p-6 text-center animate-fade-in">
      <div className="relative mb-6">
        <div className="w-24 h-24 bg-rose-50 text-rose-600 rounded-3xl flex items-center justify-center shadow-inner border border-rose-100">
          <ShieldAlert className="w-12 h-12" />
        </div>
        <div className="absolute -bottom-2 -right-2 bg-slate-900 text-white p-2 rounded-xl shadow-md">
          <Lock className="w-4 h-4" />
        </div>
      </div>

      <span className="text-xs font-bold uppercase tracking-widest text-rose-600 bg-rose-50 px-3 py-1 rounded-full border border-rose-200 mb-3">
        HTTP 403 Forbidden
      </span>

      <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight font-display mb-3">
        Acesso Restrito ao Recurso
      </h1>

      <p className="text-slate-600 max-w-md text-sm leading-relaxed mb-6">
        Seu perfil de usuário atual não possui os privilégios necessários para acessar este módulo.
        Esta restrição faz parte das políticas de segurança e conformidade da empresa.
      </p>

      {missingText && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 mb-8 max-w-sm flex items-center gap-2 text-xs text-slate-500 font-mono">
          <span className="font-semibold text-slate-700">Permissão Requerida:</span>
          <span className="bg-white px-2 py-0.5 rounded border border-slate-200 text-rose-700 font-medium">
            {missingText}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 font-medium text-sm transition-all shadow-sm active:scale-95"
        >
          <ArrowLeft className="w-4 h-4" />
          Página Anterior
        </button>

        <button
          onClick={() => navigate('/dashboard')}
          className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-primary-600 hover:bg-primary-700 text-white font-medium text-sm transition-all shadow-md shadow-primary-500/20 active:scale-95"
        >
          <Home className="w-4 h-4" />
          Ir para o Painel Geral
        </button>
      </div>
    </div>
  );
}
