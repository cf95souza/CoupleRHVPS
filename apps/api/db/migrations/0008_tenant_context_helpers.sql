-- ==============================================================================
-- Migration 0008: Validação Atômica de Atividade do Contexto de Tenant e Usuário
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.auth_assert_tenant_context_active(
    p_user_id UUID,
    p_tenant_id UUID DEFAULT NULL
)
RETURNS TABLE (
    is_active BOOLEAN,
    reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_active BOOLEAN;
    v_tenant_active BOOLEAN;
    v_tenant_user_active BOOLEAN;
BEGIN
    -- 1. Verifica se o usuário global está ativo
    IF p_user_id IS NOT NULL THEN
        SELECT u.is_active INTO v_user_active
        FROM public.users u
        WHERE u.id = p_user_id AND u.deleted_at IS NULL;

        IF v_user_active IS NULL OR NOT v_user_active THEN
            RETURN QUERY SELECT FALSE, 'USER_INACTIVE';
            RETURN;
        END IF;
    END IF;

    -- 2. Se o tenant_id foi informado, verifica se o tenant está ativo
    IF p_tenant_id IS NOT NULL THEN
        SELECT (t.status = 'ACTIVE' AND t.deleted_at IS NULL) INTO v_tenant_active
        FROM public.tenants t
        WHERE t.id = p_tenant_id;

        IF v_tenant_active IS NULL OR NOT v_tenant_active THEN
            RETURN QUERY SELECT FALSE, 'TENANT_INACTIVE';
            RETURN;
        END IF;

        -- 3. Se ambos informados, verifica o vínculo em tenant_users
        IF p_user_id IS NOT NULL THEN
            SELECT tu.is_active INTO v_tenant_user_active
            FROM public.tenant_users tu
            WHERE tu.user_id = p_user_id AND tu.tenant_id = p_tenant_id;

            IF v_tenant_user_active IS NULL OR NOT v_tenant_user_active THEN
                RETURN QUERY SELECT FALSE, 'MEMBERSHIP_INACTIVE';
                RETURN;
            END IF;
        END IF;
    END IF;

    RETURN QUERY SELECT TRUE, 'OK';
END;
$$;

GRANT EXECUTE ON FUNCTION public.auth_assert_tenant_context_active(UUID, UUID) TO couplerh_app;
