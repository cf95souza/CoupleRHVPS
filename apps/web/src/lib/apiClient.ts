/**
 * coupleRH Enterprise v2.0 — Cliente HTTP Tipado Oficial
 * 
 * - Token Bearer estritamente em memória (sem localStorage, imune a ataques XSS).
 * - Refresh Token rotativo via Cookie HttpOnly (SameSite=Lax, Secure).
 * - Fila de renovação automática em 401 sem Race Condition (Mutex de concorrência).
 * - Comunicação REST nativa com Fastify API do coupleRH VPS.
 */

import { env } from '../config/env';

export interface User {
  id: string;
  email?: string;
  full_name?: string;
  cpf?: string;
  role?: string;
  roles?: string[];
  tenant_id?: string;
  company_id?: string;
  worker_id?: string;
  user_metadata?: Record<string, any>;
  app_metadata?: Record<string, any>;
}

export interface Session {
  access_token: string;
  user: User;
  expires_in?: number;
  expires_at?: number;
}

export class ApiError extends Error {
  public status: number;
  public code?: string;
  public details?: any;

  constructor(message: string, status: number, details?: any, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code || details?.code;
  }
}

// -----------------------------------------------------------------------------
// Gerenciamento de Access Token em Memória (Zero localStorage)
// -----------------------------------------------------------------------------
let inMemoryAccessToken: string | null = null;
let inMemoryUser: User | null = null;
const authFailureListeners: Array<() => void> = [];

export function setAccessToken(token: string | null, user: User | null = null): void {
  inMemoryAccessToken = token;
  if (user) inMemoryUser = user;
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export function getCurrentUser(): User | null {
  return inMemoryUser;
}

export function clearAccessToken(): void {
  inMemoryAccessToken = null;
  inMemoryUser = null;
}

export function onAuthFailure(callback: () => void): () => void {
  authFailureListeners.push(callback);
  return () => {
    const idx = authFailureListeners.indexOf(callback);
    if (idx !== -1) authFailureListeners.splice(idx, 1);
  };
}

function notifyAuthFailure(): void {
  authFailureListeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[apiClient] Erro no listener de auth failure:', err);
    }
  });
}

// -----------------------------------------------------------------------------
// Controle de Fila e Renovação Sem Race Condition (Mutex)
// -----------------------------------------------------------------------------
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: any) => void;
}> = [];

function processQueue(error: any, token: string | null = null): void {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else if (token) {
      prom.resolve(token);
    }
  });
  failedQueue = [];
}

// -----------------------------------------------------------------------------
// Executor de Requisição HTTP com Injeção de Bearer e Retry em 401
// -----------------------------------------------------------------------------
export interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
  skipRefresh?: boolean;
}

async function executeRequest<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${env.API_URL}${endpoint}`;
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  // Injetar Bearer Token se presente em memória e não for requisição anônima
  if (!options.skipAuth && inMemoryAccessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemoryAccessToken}`);
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include', // Envia cookies HttpOnly (couplerh_refresh_token)
  });

  // Se a requisição foi bem sucedida
  if (response.ok) {
    if (response.status === 204) {
      return {} as T;
    }
    return response.json();
  }

  // Se deu 401 Unauthorized e a requisição permite renovação de token
  const isAuthEndpoint =
    endpoint.includes('/auth/login') ||
    endpoint.includes('/auth/portal/login') ||
    endpoint.includes('/auth/refresh') ||
    endpoint.includes('/auth/logout');

  if (response.status === 401 && !options.skipRefresh && !isAuthEndpoint) {
    if (isRefreshing) {
      // Se já houver renovação em andamento por outra requisição simultânea,
      // enfileira esta promessa e aguarda o novo token sem disparar novo POST /refresh
      return new Promise<string>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((newToken) => {
        // Re-executa a requisição original com o novo token
        const retryHeaders = new Headers(options.headers || {});
        retryHeaders.set('Authorization', `Bearer ${newToken}`);
        return executeRequest<T>(endpoint, {
          ...options,
          headers: retryHeaders,
          skipRefresh: true, // Evita loops infinitos
        });
      });
    }

    // Primeiro 401: assume o lock da renovação
    isRefreshing = true;

    try {
      const refreshResponse = await fetch(`${env.API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      if (!refreshResponse.ok) {
        let refreshErrData: any = {};
        try {
          refreshErrData = await refreshResponse.json();
        } catch {}
        throw new ApiError(
          refreshErrData?.message || 'Sessão expirada. Faça login novamente.',
          refreshResponse.status,
          refreshErrData,
          'SESSION_EXPIRED'
        );
      }

      const refreshData = await refreshResponse.json();
      const newAccessToken = refreshData.access_token;
      setAccessToken(newAccessToken, refreshData.user);

      // Descarrega a fila com o novo token
      processQueue(null, newAccessToken);

      // Re-executa a requisição líder com o novo token
      const retryHeaders = new Headers(options.headers || {});
      retryHeaders.set('Authorization', `Bearer ${newAccessToken}`);
      return await executeRequest<T>(endpoint, {
        ...options,
        headers: retryHeaders,
        skipRefresh: true,
      });
    } catch (refreshError) {
      clearAccessToken();
      processQueue(refreshError, null);
      notifyAuthFailure();
      throw refreshError;
    } finally {
      isRefreshing = false;
    }
  }

  // Outros erros HTTP (400, 403, 404, 500 etc)
  let errorData: any = null;
  try {
    errorData = await response.json();
  } catch {
    errorData = { message: response.statusText };
  }

  throw new ApiError(
    errorData?.message || `Erro na requisição: ${response.statusText}`,
    response.status,
    errorData,
    errorData?.code
  );
}

// -----------------------------------------------------------------------------
// QueryBuilder Fluente para Compatibilidade REST (Sem dependência de Supabase)
// -----------------------------------------------------------------------------
export class QueryBuilder implements PromiseLike<{ data: any; error: any; count?: number }> {
  private table: string;
  private filters: Record<string, any> = {};
  private selectedColumns: string = '*';
  private orderConfig?: { column: string; ascending: boolean };
  private limitCount?: number;
  private mutationData?: any;
  private mutationType?: 'insert' | 'update' | 'upsert' | 'delete';

  constructor(table: string) {
    this.table = table;
  }

  select(columns: string = '*', _options?: any): this {
    this.selectedColumns = columns;
    return this;
  }

  eq(column: string, value: any): this {
    this.filters[column] = value;
    return this;
  }

  neq(column: string, value: any): this {
    this.filters[`${column}__neq`] = value;
    return this;
  }

  gt(column: string, value: any): this {
    this.filters[`${column}__gt`] = value;
    return this;
  }

  gte(column: string, value: any): this {
    this.filters[`${column}__gte`] = value;
    return this;
  }

  lt(column: string, value: any): this {
    this.filters[`${column}__lt`] = value;
    return this;
  }

  lte(column: string, value: any): this {
    this.filters[`${column}__lte`] = value;
    return this;
  }

  is(column: string, value: any): this {
    this.filters[`${column}__is`] = value;
    return this;
  }

  not(column: string, operator: string, value: any): this {
    this.filters[`${column}__not_${operator}`] = value;
    return this;
  }

  like(column: string, value: any): this {
    this.filters[`${column}__like`] = value;
    return this;
  }

  ilike(column: string, value: any): this {
    this.filters[`${column}__ilike`] = value;
    return this;
  }

  in(column: string, values: any[]): this {
    this.filters[`${column}__in`] = values.join(',');
    return this;
  }

  or(conditions: string): this {
    this.filters['__or'] = conditions;
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderConfig = { column, ascending: options?.ascending ?? true };
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): PromiseLike<{ data: any; error: any }> {
    return this.then((res: any) => {
      if (res.data && Array.isArray(res.data)) {
        return { data: res.data[0] || null, error: res.error };
      }
      return res;
    });
  }

  maybeSingle(): PromiseLike<{ data: any; error: any }> {
    return this.single();
  }

  insert(data: any): this {
    this.mutationType = 'insert';
    this.mutationData = data;
    return this;
  }

  update(data: any): this {
    this.mutationType = 'update';
    this.mutationData = data;
    return this;
  }

  upsert(data: any, _options?: any): this {
    this.mutationType = 'upsert';
    this.mutationData = data;
    return this;
  }

  delete(): this {
    this.mutationType = 'delete';
    this.mutationData = data ?? true;
    return this;
  }

  async then<TResult1 = { data: any; error: any; count?: number }, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: any; count?: number }) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    try {
      let result: { data: any; error: any; count?: number };

      if (this.mutationType === 'insert') {
        const res = await apiClient.post<any>(`/api/v1/data/${this.table}`, this.mutationData);
        result = { data: res, error: null };
      } else if (this.mutationType === 'update') {
        const res = await apiClient.patch<any>(`/api/v1/data/${this.table}`, {
          data: this.mutationData,
          filters: this.filters,
        });
        result = { data: res, error: null };
      } else if (this.mutationType === 'upsert') {
        const res = await apiClient.post<any>(`/api/v1/data/${this.table}/upsert`, this.mutationData);
        result = { data: res, error: null };
      } else if (this.mutationType === 'delete') {
        const res = await apiClient.delete<any>(`/api/v1/data/${this.table}`);
        result = { data: res, error: null };
      } else {
        const params = new URLSearchParams();
        params.set('select', this.selectedColumns);
        if (this.orderConfig) {
          params.set('order', `${this.orderConfig.column}:${this.orderConfig.ascending ? 'asc' : 'desc'}`);
        }
        if (this.limitCount) {
          params.set('limit', String(this.limitCount));
        }
        Object.entries(this.filters).forEach(([k, v]) => params.set(k, String(v)));

        const res = await apiClient.get<any>(`/api/v1/data/${this.table}?${params.toString()}`);
        result = { data: res?.data || res || [], error: null, count: res?.count };
      }

      return onfulfilled ? (onfulfilled(result) as any) : (result as any);
    } catch (err: any) {
      const errorResult = { data: null, error: err };
      if (onfulfilled) {
        return onfulfilled(errorResult) as any;
      }
      if (onrejected) {
        return onrejected(err);
      }
      return errorResult as any;
    }
  }
}

// -----------------------------------------------------------------------------
// Cliente Principal Exportado (apiClient)
// -----------------------------------------------------------------------------
export const apiClient = {
  get: <T>(endpoint: string, options?: RequestOptions) =>
    executeRequest<T>(endpoint, { ...options, method: 'GET' }),

  post: <T>(endpoint: string, body?: any, options?: RequestOptions) =>
    executeRequest<T>(endpoint, {
      ...options,
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),

  put: <T>(endpoint: string, body?: any, options?: RequestOptions) =>
    executeRequest<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),

  patch: <T>(endpoint: string, body?: any, options?: RequestOptions) =>
    executeRequest<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),

  delete: <T>(endpoint: string, options?: RequestOptions) =>
    executeRequest<T>(endpoint, { ...options, method: 'DELETE' }),

  from: (table: string): QueryBuilder => new QueryBuilder(table),

  rpc: async (functionName: string, params: Record<string, any> = {}): Promise<{ data: any; error: any }> => {
    try {
      const data = await apiClient.post<any>(`/api/v1/rpc/${functionName}`, params);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err };
    }
  },

  auth: {
    setAccessToken,
    getAccessToken,
    clearAccessToken,
    onAuthFailure,

    async login(credentials: {
      email: string;
      password: string;
      tenant_id?: string;
      mfa_code?: string;
      recovery_code?: string;
    }) {
      const res = await apiClient.post<any>('/api/v1/auth/login', credentials, {
        skipAuth: true,
      });
      if (res?.access_token) {
        setAccessToken(res.access_token, res.user);
      }
      return res;
    },

    async portalLogin(credentials: {
      cpf: string;
      birth_date?: string;
      password?: string;
      tenant_id?: string;
    }) {
      const res = await apiClient.post<any>('/api/v1/auth/portal/login', credentials, {
        skipAuth: true,
      });
      if (res?.access_token) {
        setAccessToken(res.access_token, res.user);
      }
      return res;
    },

    async refresh() {
      const res = await apiClient.post<any>('/api/v1/auth/refresh', {}, {
        skipAuth: true,
        skipRefresh: true,
      });
      if (res?.access_token) {
        setAccessToken(res.access_token, res.user);
      }
      return res;
    },

    async logout() {
      try {
        await apiClient.post<any>('/api/v1/auth/logout', {}, {
          skipRefresh: true,
        });
      } finally {
        clearAccessToken();
      }
    },

    async getMe(): Promise<User> {
      const res = await apiClient.get<any>('/api/v1/auth/me');
      if (res?.user) {
        setAccessToken(inMemoryAccessToken, res.user);
        return res.user;
      }
      return res;
    },

    async getSession(): Promise<{ data: { session: Session | null }; error: any }> {
      try {
        if (!inMemoryAccessToken) {
          try {
            const ref = await apiClient.auth.refresh();
            return {
              data: {
                session: {
                  access_token: ref.access_token,
                  user: ref.user,
                  expires_in: ref.expires_in,
                },
              },
              error: null,
            };
          } catch {
            return { data: { session: null }, error: null };
          }
        }
        const user = await apiClient.auth.getMe();
        return {
          data: {
            session: {
              access_token: inMemoryAccessToken,
              user,
            },
          },
          error: null,
        };
      } catch (err: any) {
        return { data: { session: null }, error: err };
      }
    },

    async getUser(): Promise<{ data: { user: User | null }; error: any }> {
      try {
        const user = await apiClient.auth.getMe();
        return { data: { user }, error: null };
      } catch {
        return { data: { user: null }, error: null };
      }
    },

    async updateUser(attributes: any): Promise<{ data: { user: User | null }; error: any }> {
      try {
        const user = await apiClient.patch<User>('/api/v1/auth/user', attributes);
        return { data: { user }, error: null };
      } catch (err) {
        return { data: { user: null }, error: err };
      }
    },

    async signInWithPassword(params: { email: string; password: string }) {
      try {
        const data = await apiClient.auth.login(params);
        return { data, error: null };
      } catch (err: any) {
        return { data: null, error: err };
      }
    },

    async signOut() {
      await apiClient.auth.logout();
    },

    onAuthStateChange(_callback: (event: string, session: Session | null) => void) {
      return {
        data: {
          subscription: {
            unsubscribe: () => {},
          },
        },
      };
    },

    mfa: {
      async listFactors(): Promise<{ data: { all: any[]; totp: any[] }; error: any }> {
        try {
          const res = await apiClient.get<any>('/api/v1/auth/mfa/factors');
          return { data: res, error: null };
        } catch (err: any) {
          return { data: { all: [], totp: [] }, error: err };
        }
      },
      async enroll(): Promise<{ data: any; error: any }> {
        try {
          const res = await apiClient.post<any>('/api/v1/auth/mfa/enroll');
          return { data: res, error: null };
        } catch (err: any) {
          return { data: null, error: err };
        }
      },
      async verify(params: { factor_id: string; code: string }): Promise<{ data: any; error: any }> {
        try {
          const res = await apiClient.post<any>('/api/v1/auth/mfa/verify', params);
          return { data: res, error: null };
        } catch (err: any) {
          return { data: null, error: err };
        }
      },
      async challenge(params: { code?: string; recovery_code?: string }): Promise<{ data: any; error: any }> {
        try {
          const res = await apiClient.post<any>('/api/v1/auth/mfa/challenge', params);
          return { data: res, error: null };
        } catch (err: any) {
          return { data: null, error: err };
        }
      },
      async unenroll(params: { factor_id: string; current_password: string; code?: string }): Promise<{ data: any; error: any }> {
        try {
          const res = await apiClient.delete<any>(`/api/v1/auth/mfa/${params.factor_id}`, {
            body: JSON.stringify(params),
          });
          return { data: res, error: null };
        } catch (err: any) {
          return { data: null, error: err };
        }
      },
    },
  },

  storage: {
    from(category: string) {
      return {
        async upload(path: string, file: File | Blob) {
          const form = new FormData();
          form.append('file', file);
          form.append('path', path);
          form.append('category', category);
          try {
            const data = await apiClient.post<any>('/api/v1/storage/upload', form);
            return { data, error: null };
          } catch (err: any) {
            return { data: null, error: err };
          }
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: `${env.API_URL}/api/v1/storage/public/${category}/${path}` } };
        },
      };
    },
  },
};

// Alias de transição transparente para o frontend
export const supabase = apiClient;
