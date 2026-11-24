import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  apiClient,
  setAccessToken,
  getAccessToken,
  clearAccessToken,
  getCurrentUser,
  onAuthFailure,
  ApiError,
} from '../src/lib/apiClient';

describe('Cliente HTTP Tipado Oficial do Frontend (SEC-06)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearAccessToken();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('1. Gerenciamento de Access Token em Memória (Anti-XSS)', () => {
    it('deve armazenar e recuperar o token exclusivamente em memória', () => {
      expect(getAccessToken()).toBeNull();
      expect(getCurrentUser()).toBeNull();

      const fakeUser = { id: 'usr-123', email: 'rh@empresa.com', role: 'system_admin' };
      setAccessToken('token_jwt_secreto_123', fakeUser);

      expect(getAccessToken()).toBe('token_jwt_secreto_123');
      expect(getCurrentUser()).toEqual(fakeUser);

      clearAccessToken();
      expect(getAccessToken()).toBeNull();
      expect(getCurrentUser()).toBeNull();
    });
  });

  describe('2. Injeção de Cabeçalho Authorization e Credentials HttpOnly', () => {
    it('deve injetar Authorization Bearer e credentials include em requisições autenticadas', async () => {
      setAccessToken('token_ativo_456');

      let interceptedInit: RequestInit | undefined;
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        interceptedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, url }),
        } as Response;
      });

      const result = await apiClient.get<any>('/api/v1/users/me');

      expect(result).toEqual({ success: true, url: '/api/v1/users/me' });
      expect(interceptedInit?.credentials).toBe('include');
      const headers = new Headers(interceptedInit?.headers);
      expect(headers.get('Authorization')).toBe('Bearer token_ativo_456');
      expect(headers.get('Content-Type')).toBe('application/json');
    });

    it('não deve injetar Authorization quando skipAuth for verdadeiro', async () => {
      setAccessToken('token_ativo_456');

      let interceptedInit: RequestInit | undefined;
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        interceptedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ public: true }),
        } as Response;
      });

      await apiClient.get<any>('/api/v1/public/verify-document/123', { skipAuth: true });

      const headers = new Headers(interceptedInit?.headers);
      expect(headers.get('Authorization')).toBeNull();
    });
  });

  describe('3. Renovação Automática com Fila Anti-Race Condition em 401', () => {
    it('deve tratar 401, renovar o token via POST /auth/refresh e re-executar a requisição com sucesso', async () => {
      setAccessToken('token_expirado');

      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        callCount++;

        // 1ª chamada: a requisição original dá 401 (token expirado)
        if (callCount === 1 && url.includes('/api/v1/data/workers')) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ message: 'Token expirado', code: 'TOKEN_EXPIRED' }),
          } as Response;
        }

        // 2ª chamada: refresh token disparado automaticamente com cookies HttpOnly
        if (url.includes('/api/v1/auth/refresh')) {
          expect(init?.credentials).toBe('include');
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'novo_token_renovado_789',
              user: { id: 'usr-1', email: 'rh@empresa.com' },
            }),
          } as Response;
        }

        // 3ª chamada: re-tentativa da requisição original com o novo token
        if (url.includes('/api/v1/data/workers')) {
          const headers = new Headers(init?.headers);
          expect(headers.get('Authorization')).toBe('Bearer novo_token_renovado_789');
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'w-1', name: 'João' }] }),
          } as Response;
        }

        throw new Error(`Chamada inesperada para: ${url}`);
      });

      const res = await apiClient.get<any>('/api/v1/data/workers');
      expect(res).toEqual({ data: [{ id: 'w-1', name: 'João' }] });
      expect(getAccessToken()).toBe('novo_token_renovado_789');
      expect(callCount).toBe(3);
    });

    it('deve enfileirar requisições simultâneas em 401 e disparar apenas UMA chamada de refresh (sem race condition)', async () => {
      setAccessToken('token_expirado_concorrente');

      let refreshCalls = 0;
      let workersCalls = 0;
      let payrollCalls = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/v1/auth/refresh')) {
          refreshCalls++;
          // Simula pequena latência na renovação do token
          await new Promise((r) => setTimeout(r, 20));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'token_unico_renovado_999',
              user: { id: 'usr-conc' },
            }),
          } as Response;
        }

        if (url.includes('/api/v1/data/workers')) {
          workersCalls++;
          const headers = new Headers(init?.headers);
          if (headers.get('Authorization') === 'Bearer token_expirado_concorrente') {
            return {
              ok: false,
              status: 401,
              json: async () => ({ message: 'Token expirado' }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ endpoint: 'workers', token: headers.get('Authorization') }),
          } as Response;
        }

        if (url.includes('/api/v1/payroll/summary')) {
          payrollCalls++;
          const headers = new Headers(init?.headers);
          if (headers.get('Authorization') === 'Bearer token_expirado_concorrente') {
            return {
              ok: false,
              status: 401,
              json: async () => ({ message: 'Token expirado' }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ endpoint: 'payroll', token: headers.get('Authorization') }),
          } as Response;
        }

        throw new Error(`Chamada inesperada para: ${url}`);
      });

      // Dispara 2 requisições concorrentes simultâneas com token expirado
      const [workersRes, payrollRes] = await Promise.all([
        apiClient.get<any>('/api/v1/data/workers'),
        apiClient.get<any>('/api/v1/payroll/summary'),
      ]);

      // Ambas as requisições devem receber a resposta com sucesso após o refresh
      expect(workersRes).toEqual({
        endpoint: 'workers',
        token: 'Bearer token_unico_renovado_999',
      });
      expect(payrollRes).toEqual({
        endpoint: 'payroll',
        token: 'Bearer token_unico_renovado_999',
      });

      // Ponto crucial da prova anti-race condition:
      // O endpoint de refresh deve ter sido chamado EXATAMENTE UMA VEZ
      expect(refreshCalls).toBe(1);
      // Cada endpoint sofreu 1 falha + 1 retry = 2 chamadas
      expect(workersCalls).toBe(2);
      expect(payrollCalls).toBe(2);
      expect(getAccessToken()).toBe('token_unico_renovado_999');
    });

    it('deve limpar token, notificar onAuthFailure e rejeitar fila caso o refresh falhe com 401', async () => {
      setAccessToken('token_revogado');

      let authFailureNotified = false;
      const unsubscribe = onAuthFailure(() => {
        authFailureNotified = true;
      });

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/auth/refresh')) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ message: 'Refresh token revogado ou inválido' }),
          } as Response;
        }

        return {
          ok: false,
          status: 401,
          json: async () => ({ message: 'Sessão expirada' }),
        } as Response;
      });

      await expect(apiClient.get<any>('/api/v1/private/profile')).rejects.toThrow(ApiError);

      expect(getAccessToken()).toBeNull();
      expect(authFailureNotified).toBe(true);

      unsubscribe();
    });
  });

  describe('4. Métodos Nativos de Autenticação (RH vs Portal)', () => {
    it('deve realizar login de RH e persistir o token em memória', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'jwt_admin_session_token',
          user: { id: 'admin-1', role: 'tenant_admin' },
        }),
      } as Response);

      const res = await apiClient.auth.login({
        email: 'gestao@empresa.com',
        password: 'SenhaForte123@!',
      });

      expect(res.access_token).toBe('jwt_admin_session_token');
      expect(getAccessToken()).toBe('jwt_admin_session_token');
      expect(getCurrentUser()).toEqual({ id: 'admin-1', role: 'tenant_admin' });
    });

    it('deve realizar login do portal com CPF e Data de Nascimento e persistir token em memória', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'jwt_portal_session_token',
          user: { id: 'emp-1', role: 'employee' },
        }),
      } as Response);

      const res = await apiClient.auth.portalLogin({
        cpf: '123.456.789-00',
        birth_date: '15/03/1990',
      });

      expect(res.access_token).toBe('jwt_portal_session_token');
      expect(getAccessToken()).toBe('jwt_portal_session_token');
      expect(getCurrentUser()).toEqual({ id: 'emp-1', role: 'employee' });
    });

    it('deve limpar a memória ao executar logout', async () => {
      setAccessToken('token_ativo');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ message: 'Logout realizado' }),
      } as Response);

      await apiClient.auth.logout();

      expect(getAccessToken()).toBeNull();
      expect(getCurrentUser()).toBeNull();
    });
  });
});
