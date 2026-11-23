-- ==============================================================================
-- Migration 0005: Funções SECURITY DEFINER para Resolução de Autenticação
-- Permite lookup seguro durante login pré-contexto RLS
-- ==============================================================================

-- 1. Busca usuário por e-mail para login administrativo/RH
CREATE OR REPLACE FUNCTION public.auth_get_user_for_login(p_email CITEXT)
RETURNS TABLE (
    id UUID,
    email CITEXT,
    password_hash TEXT,
    full_name TEXT,
    failed_login_attempts INT,
    locked_until TIMESTAMPTZ,
    is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT u.id, u.email, u.password_hash, u.full_name, u.failed_login_attempts, u.locked_until, u.is_active
    FROM public.users u
    WHERE u.email = p_email AND u.deleted_at IS NULL;
END;
$$;

-- 2. Busca tenant e perfil ativo do usuário
CREATE OR REPLACE FUNCTION public.auth_get_user_tenant_membership(p_user_id UUID)
RETURNS TABLE (
    tenant_id UUID,
    tenant_name TEXT,
    role TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT tu.tenant_id, t.name as tenant_name, tu.role
    FROM public.tenant_users tu
    JOIN public.tenants t ON t.id = tu.tenant_id
    WHERE tu.user_id = p_user_id AND tu.is_active = TRUE
    ORDER BY tu.created_at ASC
    LIMIT 1;
END;
$$;

-- 3. Busca trabalhador ativo por CPF para login do Portal do Colaborador
CREATE OR REPLACE FUNCTION public.auth_get_worker_for_portal_login(p_cpf VARCHAR(11))
RETURNS TABLE (
    id UUID,
    tenant_id UUID,
    user_id UUID,
    full_name TEXT,
    cpf VARCHAR(11),
    birth_date DATE,
    email TEXT,
    contract_status TEXT,
    position_title TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT w.id, w.tenant_id, w.user_id, w.full_name, w.cpf, w.birth_date, w.email,
           c.status as contract_status, pos.title as position_title
    FROM public.workers w
    JOIN public.contracts c ON c.worker_id = w.id
    LEFT JOIN public.positions pos ON pos.id = c.position_id
    WHERE w.cpf = p_cpf AND c.status = 'ACTIVE'
    ORDER BY c.created_at DESC
    LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auth_get_user_for_login(CITEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_get_user_tenant_membership(UUID) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_get_worker_for_portal_login(VARCHAR(11)) TO couplerh_app;

-- 4. Busca dados completos do usuário para /me
CREATE OR REPLACE FUNCTION public.auth_get_me(p_user_id UUID)
RETURNS TABLE (
    id UUID,
    email CITEXT,
    cpf VARCHAR(11),
    full_name TEXT,
    phone TEXT,
    last_login_at TIMESTAMPTZ,
    tenant_id UUID,
    role TEXT,
    tenant_name TEXT,
    worker_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT u.id, u.email, u.cpf, u.full_name, u.phone, u.last_login_at,
           tu.tenant_id, tu.role, t.name as tenant_name,
           w.id as worker_id
    FROM public.users u
    LEFT JOIN public.tenant_users tu ON tu.user_id = u.id AND tu.is_active = TRUE
    LEFT JOIN public.tenants t ON t.id = tu.tenant_id
    LEFT JOIN public.workers w ON w.user_id = u.id AND w.tenant_id = tu.tenant_id
    WHERE u.id = p_user_id AND u.is_active = TRUE
    LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auth_get_me(UUID) TO couplerh_app;

-- 5. Helper de provisioning/associação de conta do colaborador no login do portal
CREATE OR REPLACE FUNCTION public.auth_ensure_portal_worker_user(
    p_worker_id UUID,
    p_tenant_id UUID,
    p_cpf VARCHAR(11),
    p_full_name TEXT,
    p_email TEXT,
    p_password_hash TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    -- 1. Verifica se o trabalhador já possui user_id vinculado
    SELECT user_id INTO v_user_id
    FROM public.workers
    WHERE id = p_worker_id;

    -- 2. Se não possuir, verifica se já existe usuário com esse CPF em public.users
    IF v_user_id IS NULL THEN
        SELECT id INTO v_user_id
        FROM public.users
        WHERE cpf = p_cpf;
    END IF;

    -- 3. Se ainda não existir, cria o registro em public.users
    IF v_user_id IS NULL THEN
        INSERT INTO public.users (cpf, full_name, email, password_hash, is_active, failed_login_attempts)
        VALUES (p_cpf, p_full_name, p_email, p_password_hash, TRUE, 0)
        RETURNING id INTO v_user_id;
    END IF;

    -- 4. Atualiza o worker com o user_id (se ainda não estava)
    UPDATE public.workers
    SET user_id = v_user_id
    WHERE id = p_worker_id AND (user_id IS NULL OR user_id <> v_user_id);

    -- 5. Garante a membership em tenant_users com perfil 'employee'
    INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
    VALUES (p_tenant_id, v_user_id, 'employee', TRUE)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET is_active = TRUE;

    -- 6. Atualiza auditoria de login
    UPDATE public.users
    SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW()
    WHERE id = v_user_id;

    RETURN v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auth_ensure_portal_worker_user(UUID, UUID, VARCHAR(11), TEXT, TEXT, TEXT) TO couplerh_app;

