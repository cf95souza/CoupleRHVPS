import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import AccessDenied403 from '../../pages/AccessDenied403';

interface RequirePermissionProps {
  permission: string | string[];
  children?: React.ReactNode;
}

export default function RequirePermission({ permission, children }: RequirePermissionProps) {
  const { session, user, hasPermission, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center">
        <div className="w-12 h-12 border-4 border-primary-200 border-t-primary-600 rounded-full animate-spin mb-4"></div>
        <p className="text-slate-500 font-medium animate-pulse">Validando permissões de acesso...</p>
      </div>
    );
  }

  if (!session || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Verifica se possui a permissão requerida
  if (!hasPermission(permission)) {
    return <AccessDenied403 missingPermission={permission} />;
  }

  return children ? <>{children}</> : <Outlet />;
}
