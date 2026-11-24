import React from 'react';
import { useAuth } from '../../contexts/AuthContext';

interface CanProps {
  permission: string | string[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * Componente declarativo para controle granular de visibilidade na UI.
 * Exemplo:
 * <Can permission="manage_employees">
 *   <button onClick={handleNew}>Novo Colaborador</button>
 * </Can>
 */
export default function Can({ permission, children, fallback = null }: CanProps) {
  const { hasPermission } = useAuth();

  if (hasPermission(permission)) {
    return <>{children}</>;
  }

  return <>{fallback}</>;
}
