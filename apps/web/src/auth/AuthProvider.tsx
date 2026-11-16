import { useQueryClient } from '@tanstack/react-query';
import type { ModuleKey, PermissionKey } from '@concilia/core/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, onUnauthorized, setCsrfToken } from '../api/client';
import { applyBranding } from '../theme/applyBranding';
import type { Me } from './types';

type Status = 'loading' | 'authenticated' | 'anonymous' | 'error';

interface AuthContextValue {
  status: Status;
  me: Me | null;
  error: string | null;
  can: (permission: PermissionKey) => boolean;
  hasModule: (key: ModuleKey) => boolean;
  /** Licença em somente leitura: escrita desabilitada. */
  readOnly: boolean;
  login: (email: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback((value: Me | null) => {
    setMe(value);
    setCsrfToken(value?.csrfToken ?? null);
    applyBranding(value?.branding?.primaryColor);
    setStatus(value ? 'authenticated' : 'anonymous');
  }, []);

  const refresh = useCallback(async () => {
    try {
      accept(await api.get<Me>('/auth/me', undefined, undefined, true));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        accept(null);
      } else {
        setError(e instanceof Error ? e.message : 'Falha ao carregar a sessão.');
        setStatus('error');
      }
    }
  }, [accept]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    onUnauthorized(() => {
      queryClient.clear();
      accept(null);
    });
    return () => onUnauthorized(null);
  }, [accept, queryClient]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<Me>('/auth/login', { email, password }, true);
      queryClient.clear();
      accept(result);
      return result;
    },
    [accept, queryClient],
  );

  const logout = useCallback(async () => {
    // Desativa as consultas periódicas e aborta as em andamento antes de encerrar a sessão no servidor.
    setStatus('anonymous');
    await queryClient.cancelQueries();
    try {
      await api.post('/auth/logout');
    } catch {
      /* a sessão local é descartada de qualquer forma */
    }
    queryClient.clear();
    accept(null);
  }, [accept, queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      error,
      can: (permission) => me?.permissions.includes(permission) ?? false,
      hasModule: (key) => me?.modules.includes(key) ?? false,
      readOnly: me?.license?.readOnly ?? false,
      login,
      logout,
      refresh,
    }),
    [status, me, error, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return ctx;
}
