import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Session, User } from '../lib/apiClient';
import { supabase, apiClient } from '../lib/apiClient';

interface AuthContextType {
  session: Session | null;
  user: User | null;
  permissions: string[];
  isSystemAdmin: boolean;
  hasPermission: (permission: string | string[]) => boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const hydrateUser = async () => {
    try {
      const me = await apiClient.auth.getMe();
      if (me) {
        setUser(me);
      }
    } catch {
      // Sessão ainda não autenticada
    }
  };

  useEffect(() => {
    // Buscar sessão atual ao carregar
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      if (session) {
        await hydrateUser();
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    // Escutar mudanças de autenticação
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
      if (session) {
        await hydrateUser();
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
  };

  const permissions = user?.permissions || [];
  const isSystemAdmin = user?.role === 'system_admin' || user?.isSystemAdmin === true;

  const hasPermission = useCallback((permission: string | string[]): boolean => {
    if (!user) return false;
    if (isSystemAdmin) return true;
    const userPerms = user.permissions || [];
    if (Array.isArray(permission)) {
      return permission.some(p => userPerms.includes(p));
    }
    return userPerms.includes(permission);
  }, [user, isSystemAdmin]);

  const value = {
    session,
    user,
    permissions,
    isSystemAdmin,
    hasPermission,
    signOut,
    refreshProfile: hydrateUser,
    loading,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
