-- ==============================================================================
-- MIGRATION 0042: Helpers SECURITY DEFINER para Cron de Vencimento A1 (60/30/15/7d)
-- FASE V9 — ESOC-01
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.esocial_list_expiring_certificates(p_tenant_id UUID DEFAULT NULL)
RETURNS TABLE (
    id UUID,
    tenant_id UUID,
    company_id UUID,
    subject_name TEXT,
    cnpj TEXT,
    environment TEXT,
    valid_to TIMESTAMPTZ,
    last_expiry_alert_tier INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ec.id,
        ec.tenant_id,
        ec.company_id,
        ec.subject_name,
        ec.cnpj,
        ec.environment,
        ec.valid_to,
        ec.last_expiry_alert_tier
    FROM public.esocial_certificates ec
    WHERE ec.is_active = TRUE
      AND ec.revoked_at IS NULL
      AND ec.valid_to <= NOW() + INTERVAL '60 days'
      AND (p_tenant_id IS NULL OR ec.tenant_id = p_tenant_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.esocial_mark_certificate_alert_tier(p_certificate_id UUID, p_tier INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.esocial_certificates
    SET last_expiry_alert_tier = p_tier,
        last_expiry_alert_at = NOW(),
        updated_at = NOW()
    WHERE id = p_certificate_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.esocial_list_expiring_certificates(UUID) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.esocial_mark_certificate_alert_tier(UUID, INT) TO couplerh_app;
