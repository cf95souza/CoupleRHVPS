-- ==============================================================================
-- Migration 0007: Funções SECURITY DEFINER para Recuperação e Troca de Senha
-- ==============================================================================

-- 1. Cria token de recuperação de senha com invalidação atômica de anteriores
CREATE OR REPLACE FUNCTION public.auth_create_password_reset_token(
    p_email CITEXT,
    p_token_hash TEXT,
    p_expires_minutes INT DEFAULT 30
)
RETURNS TABLE (
    found BOOLEAN,
    user_id UUID,
    full_name TEXT,
    email CITEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user RECORD;
    v_token_id UUID;
BEGIN
    SELECT u.id, u.full_name, u.email
    INTO v_user
    FROM public.users u
    WHERE u.email = p_email AND u.is_active = TRUE AND u.deleted_at IS NULL;

    IF v_user.id IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::CITEXT;
        RETURN;
    END IF;

    -- Invalida tokens anteriores não utilizados
    UPDATE public.auth_tokens
    SET used_at = NOW()
    WHERE public.auth_tokens.user_id = v_user.id 
      AND public.auth_tokens.token_type = 'PASSWORD_RESET' 
      AND public.auth_tokens.used_at IS NULL;

    -- Cria novo token com expiração
    INSERT INTO public.auth_tokens (
        user_id, token_type, token_hash, expires_at
    )
    VALUES (
        v_user.id,
        'PASSWORD_RESET',
        p_token_hash,
        NOW() + (p_expires_minutes || ' minutes')::INTERVAL
    )
    RETURNING id INTO v_token_id;

    RETURN QUERY SELECT TRUE, v_user.id, v_user.full_name, v_user.email;
END;
$$;

-- 2. Verifica validade de token de recuperação de senha
CREATE OR REPLACE FUNCTION public.auth_verify_password_reset_token(p_token_hash TEXT)
RETURNS TABLE (
    is_valid BOOLEAN,
    is_used BOOLEAN,
    is_expired BOOLEAN,
    user_id UUID,
    email CITEXT,
    full_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row RECORD;
    v_now TIMESTAMPTZ := NOW();
BEGIN
    SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email, u.full_name, u.is_active
    INTO v_row
    FROM public.auth_tokens t
    JOIN public.users u ON u.id = t.user_id
    WHERE t.token_hash = p_token_hash 
      AND t.token_type = 'PASSWORD_RESET'
    ORDER BY t.created_at DESC
    LIMIT 1;

    IF v_row.id IS NULL OR NOT v_row.is_active THEN
        RETURN QUERY SELECT FALSE, FALSE, FALSE, NULL::UUID, NULL::CITEXT, NULL::TEXT;
        RETURN;
    END IF;

    IF v_row.used_at IS NOT NULL THEN
        RETURN QUERY SELECT FALSE, TRUE, FALSE, v_row.user_id, v_row.email, v_row.full_name;
        RETURN;
    END IF;

    IF v_row.expires_at <= v_now THEN
        RETURN QUERY SELECT FALSE, FALSE, TRUE, v_row.user_id, v_row.email, v_row.full_name;
        RETURN;
    END IF;

    RETURN QUERY SELECT TRUE, FALSE, FALSE, v_row.user_id, v_row.email, v_row.full_name;
END;
$$;

-- 3. Consome token de recuperação de senha e atualiza senha com revogação de sessões
CREATE OR REPLACE FUNCTION public.auth_consume_password_reset_token(
    p_token_hash TEXT,
    p_new_password_hash TEXT
)
RETURNS TABLE (
    success BOOLEAN,
    user_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_check RECORD;
BEGIN
    SELECT * INTO v_check
    FROM public.auth_verify_password_reset_token(p_token_hash);

    IF NOT v_check.is_valid THEN
        RETURN QUERY SELECT FALSE, NULL::UUID;
        RETURN;
    END IF;

    -- Marca o token como consumido
    UPDATE public.auth_tokens
    SET used_at = NOW()
    WHERE public.auth_tokens.token_hash = p_token_hash 
      AND public.auth_tokens.token_type = 'PASSWORD_RESET';

    -- Atualiza a senha e destrava a conta
    UPDATE public.users
    SET password_hash = p_new_password_hash,
        failed_login_attempts = 0,
        locked_until = NULL,
        updated_at = NOW()
    WHERE public.users.id = v_check.user_id;

    -- Revoga preventivamente todas as sessões antigas
    UPDATE public.user_sessions
    SET revoked_at = NOW()
    WHERE public.user_sessions.user_id = v_check.user_id 
      AND public.user_sessions.revoked_at IS NULL;

    RETURN QUERY SELECT TRUE, v_check.user_id;
END;
$$;

-- 4. Atualiza senha pessoal do trabalhador autenticado
CREATE OR REPLACE FUNCTION public.auth_change_worker_password(
    p_user_id UUID,
    p_new_password_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.users
    SET password_hash = p_new_password_hash,
        failed_login_attempts = 0,
        locked_until = NULL,
        updated_at = NOW()
    WHERE id = p_user_id AND is_active = TRUE;

    RETURN FOUND;
END;
$$;

-- 5. Busca dados para validação de credencial atual na troca de senha do colaborador
CREATE OR REPLACE FUNCTION public.auth_get_worker_credentials_for_change(p_user_id UUID)
RETURNS TABLE (
    birth_date DATE,
    password_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT w.birth_date, u.password_hash
    FROM public.users u
    LEFT JOIN public.workers w ON w.user_id = u.id
    WHERE u.id = p_user_id AND u.is_active = TRUE
    LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auth_create_password_reset_token(CITEXT, TEXT, INT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_verify_password_reset_token(TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_consume_password_reset_token(TEXT, TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_change_worker_password(UUID, TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_get_worker_credentials_for_change(UUID) TO couplerh_app;

