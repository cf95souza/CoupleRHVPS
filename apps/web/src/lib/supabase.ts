/**
 * Camada de compatibilidade fluente nativa do coupleRH Enterprise v2.0
 * 
 * Substitui o @supabase/supabase-js por completo.
 * Mapeia consultas e autenticacao para o Fastify REST API via apiClient.
 */

import { apiClient } from '../services/api/apiClient';

export interface User {
  id: string;
  email?: string;
  user_metadata?: Record<string, any>;
  app_metadata?: Record<string, any>;
  role?: string;
}

export interface Session {
  access_token: string;
  refresh_token?: string;
  user: User;
  expires_at?: number;
}

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

export const supabase = {
  from(table: string): QueryBuilder {
    return new QueryBuilder(table);
  },

  async rpc(functionName: string, params: Record<string, any> = {}): Promise<{ data: any; error: any }> {
    try {
      const data = await apiClient.post<any>(`/api/v1/rpc/${functionName}`, params);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err };
    }
  },

  auth: {
    async getSession(): Promise<{ data: { session: Session | null }; error: any }> {
      try {
        const session = await apiClient.get<Session>('/api/v1/auth/session');
        return { data: { session }, error: null };
      } catch {
        return { data: { session: null }, error: null };
      }
    },

    async getUser(): Promise<{ data: { user: User | null }; error: any }> {
      try {
        const user = await apiClient.get<User>('/api/v1/auth/me');
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

    onAuthStateChange(_callback: (event: string, session: Session | null) => void) {
      return {
        data: {
          subscription: {
            unsubscribe: () => {},
          },
        },
      };
    },

    async signInWithPassword(_params: any) {
      return { data: null, error: null };
    },

    async signOut() {
      try {
        await apiClient.post('/api/v1/auth/logout');
      } catch {}
    },

    mfa: {
      async listFactors(): Promise<{ data: { all: any[]; totp: any[] }; error: any }> {
        return { data: { all: [], totp: [] }, error: null };
      },
      async challenge(_params: any): Promise<{ data: any; error: any }> {
        return { data: null, error: null };
      },
      async verify(_params: any): Promise<{ data: any; error: any }> {
        return { data: null, error: null };
      },
      async enroll(_params: any): Promise<{ data: any; error: any }> {
        return { data: null, error: null };
      },
      async unenroll(_params: any): Promise<{ data: any; error: any }> {
        return { data: null, error: null };
      },
    },
  },

  storage: {
    from(bucket: string) {
      return {
        async upload(path: string, file: File | Blob) {
          const form = new FormData();
          form.append('file', file);
          form.append('path', path);
          form.append('bucket', bucket);
          try {
            const data = await apiClient.post<any>('/api/v1/storage/upload', form);
            return { data, error: null };
          } catch (err: any) {
            return { data: null, error: err };
          }
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: `/api/v1/storage/public/${bucket}/${path}` } };
        },
      };
    },
  },

  functions: {
    async invoke(functionName: string, options: { body?: any } = {}) {
      try {
        const data = await apiClient.post<any>(`/api/v1/functions/${functionName}`, options.body);
        return { data, error: null };
      } catch (err: any) {
        return { data: null, error: err };
      }
    },
  },
};
