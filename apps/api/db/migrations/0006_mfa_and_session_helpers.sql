-- ==============================================================================
-- Migration 0006: Funções SECURITY DEFINER para Gestão de MFA TOTP e Sessões
-- Permite operações seguras de MFA e controle de timeout de inatividade
-- ==============================================================================

-- 1. Consulta status de MFA do usuário (se tem fator verificado e total)
CREATE OR REPLACE FUNCTION public.auth_get_user_mfa_status(p_user_id UUID)
RETURNS TABLE (
    has_verified_mfa BOOLEAN,
    verified_factors_count INT,
    total_factors_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(BOOL_OR(is_verified), FALSE) as has_verified_mfa,
        COUNT(*) FILTER (WHERE is_verified = TRUE)::INT as verified_factors_count,
        COUNT(*)::INT as total_factors_count
    FROM public.user_mfa_factors
    WHERE user_id = p_user_id;
END;
$$;

-- 2. Consulta configurações de MFA e timeout de inatividade do tenant
CREATE OR REPLACE FUNCTION public.auth_get_tenant_mfa_and_session_settings(p_tenant_id UUID)
RETURNS TABLE (
    require_mfa_roles TEXT[],
    session_timeout_minutes INT,
    max_login_attempts INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_settings JSONB;
    v_roles_json JSONB;
    v_roles TEXT[];
BEGIN
    SELECT settings INTO v_settings
    FROM public.tenants
    WHERE id = p_tenant_id;

    IF v_settings IS NULL THEN
        v_settings := '{}'::jsonb;
    END IF;

    -- Extrai array require_mfa_roles
    v_roles_json := v_settings->'require_mfa_roles';
    IF v_roles_json IS NOT NULL AND jsonb_typeof(v_roles_json) = 'array' THEN
        SELECT ARRAY_AGG(x.val::TEXT) INTO v_roles
        FROM jsonb_array_elements_text(v_roles_json) AS x(val);
    ELSE
        v_roles := ARRAY[]::TEXT[];
    END IF;

    RETURN QUERY
    SELECT 
        COALESCE(v_roles, ARRAY[]::TEXT[]) as require_mfa_roles,
        COALESCE((v_settings->>'session_timeout_minutes')::INT, 60) as session_timeout_minutes,
        COALESCE((v_settings->>'max_login_attempts')::INT, 5) as max_login_attempts;
END;
$$;

-- 3. Validação e atualização de atividade da sessão (Timeout de Inatividade)
CREATE OR REPLACE FUNCTION public.auth_touch_session_activity(
    p_session_id UUID,
    p_max_inactivity_minutes INT DEFAULT 60
)
RETURNS TABLE (
    is_valid BOOLEAN,
    is_expired BOOLEAN,
    user_id UUID,
    aal TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session RECORD;
    v_now TIMESTAMPTZ := NOW();
    v_inactivity_interval INTERVAL;
BEGIN
    SELECT s.id, s.user_id, s.aal, s.last_seen_at, s.expires_at, s.revoked_at
    INTO v_session
    FROM public.user_sessions s
    WHERE s.id = p_session_id;

    IF v_session.id IS NULL OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= v_now THEN
        RETURN QUERY SELECT FALSE, TRUE, NULL::UUID, NULL::TEXT;
        RETURN;
    END IF;

    v_inactivity_interval := (p_max_inactivity_minutes || ' minutes')::INTERVAL;

    -- Se o tempo de inatividade excedeu o limite do tenant
    IF (v_now - v_session.last_seen_at) > v_inactivity_interval THEN
        UPDATE public.user_sessions
        SET revoked_at = v_now
        WHERE id = p_session_id;

        RETURN QUERY SELECT FALSE, TRUE, v_session.user_id, v_session.aal;
        RETURN;
    END IF;

    -- Sessão ativa: atualiza last_seen_at
    UPDATE public.user_sessions
    SET last_seen_at = v_now
    WHERE id = p_session_id;

    RETURN QUERY SELECT TRUE, FALSE, v_session.user_id, v_session.aal;
END;
$$;

-- 4. Promove sessão para AAL2
CREATE OR REPLACE FUNCTION public.auth_promote_session_aal2(p_session_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.user_sessions
    SET aal = 'aal2', last_seen_at = NOW()
    WHERE id = p_session_id AND revoked_at IS NULL;

    RETURN FOUND;
END;
$$;

-- 5. Listagem dos fatores MFA do usuário
CREATE OR REPLACE FUNCTION public.auth_get_user_mfa_factors(p_user_id UUID)
RETURNS TABLE (
    id UUID,
    factor_type TEXT,
    friendly_name TEXT,
    is_verified BOOLEAN,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT f.id, f.factor_type, f.friendly_name, f.is_verified, f.verified_at, f.created_at
    FROM public.user_mfa_factors f
    WHERE f.user_id = p_user_id
    ORDER BY f.created_at ASC;
END;
$$;

-- 6. Grava novo fator MFA pré-verificação (Enroll)
CREATE OR REPLACE FUNCTION public.auth_save_mfa_factor(
    p_user_id UUID,
    p_secret_encrypted TEXT,
    p_recovery_codes_hash JSONB,
    p_friendly_name TEXT DEFAULT 'Aplicativo Autenticador'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_factor_id UUID;
BEGIN
    -- Remove fatores não verificados antigos do usuário para evitar lixo
    DELETE FROM public.user_mfa_factors
    WHERE user_id = p_user_id AND is_verified = FALSE;

    INSERT INTO public.user_mfa_factors (
        user_id, factor_type, friendly_name, secret_encrypted, recovery_codes_hash, is_verified
    )
    VALUES (
        p_user_id, 'TOTP', p_friendly_name, p_secret_encrypted, p_recovery_codes_hash, FALSE
    )
    RETURNING id INTO v_factor_id;

    RETURN v_factor_id;
END;
$$;

-- 7. Busca dados para verificação/desafio (incluindo secret_encrypted e recovery_codes_hash)
CREATE OR REPLACE FUNCTION public.auth_get_mfa_factor_for_verification(
    p_user_id UUID,
    p_factor_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    factor_type TEXT,
    secret_encrypted TEXT,
    recovery_codes_hash JSONB,
    is_verified BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT f.id, f.factor_type, f.secret_encrypted, f.recovery_codes_hash, f.is_verified
    FROM public.user_mfa_factors f
    WHERE f.user_id = p_user_id
      AND (p_factor_id IS NULL OR f.id = p_factor_id)
    ORDER BY f.is_verified DESC, f.created_at DESC
    LIMIT 1;
END;
$$;

-- 8. Marca fator como verificado (Verify)
CREATE OR REPLACE FUNCTION public.auth_verify_mfa_factor(
    p_factor_id UUID,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.user_mfa_factors
    SET is_verified = TRUE, verified_at = NOW()
    WHERE id = p_factor_id AND user_id = p_user_id;

    RETURN FOUND;
END;
$$;

-- 9. Consome um código de recuperação de uso único
CREATE OR REPLACE FUNCTION public.auth_consume_recovery_code(
    p_factor_id UUID,
    p_user_id UUID,
    p_code_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_codes JSONB;
    v_new_codes JSONB;
BEGIN
    SELECT recovery_codes_hash INTO v_codes
    FROM public.user_mfa_factors
    WHERE id = p_factor_id AND user_id = p_user_id AND is_verified = TRUE;

    IF v_codes IS NULL OR jsonb_typeof(v_codes) <> 'array' THEN
        RETURN FALSE;
    END IF;

    -- Verifica se o hash existe no array
    IF NOT (v_codes @> to_jsonb(p_code_hash)) THEN
        RETURN FALSE;
    END IF;

    -- Remove o código usado do array
    SELECT jsonb_agg(elem) INTO v_new_codes
    FROM jsonb_array_elements_text(v_codes) AS elem
    WHERE elem <> p_code_hash;

    IF v_new_codes IS NULL THEN
        v_new_codes := '[]'::jsonb;
    END IF;

    UPDATE public.user_mfa_factors
    SET recovery_codes_hash = v_new_codes
    WHERE id = p_factor_id AND user_id = p_user_id;

    RETURN TRUE;
END;
$$;

-- 10. Remove fator MFA (Unenroll)
CREATE OR REPLACE FUNCTION public.auth_delete_mfa_factor(
    p_factor_id UUID,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.user_mfa_factors
    WHERE id = p_factor_id AND user_id = p_user_id;

    RETURN FOUND;
END;
$$;

-- Concessão de permissões para o role não-superuser da aplicação
GRANT EXECUTE ON FUNCTION public.auth_get_user_mfa_status(UUID) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_get_tenant_mfa_and_session_settings(UUID) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_touch_session_activity(UUID, INT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_promote_session_aal2(UUID) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_get_user_mfa_factors(UUID) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_save_mfa_factor(UUID, TEXT, JSONB, TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_get_mfa_factor_for_verification(UUID, UUID) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_verify_mfa_factor(UUID, UUID) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_consume_recovery_code(UUID, UUID, TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.auth_delete_mfa_factor(UUID, UUID) TO couplerh_app;
