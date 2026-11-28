-- ==============================================================================
-- MIGRATION 0045: Motor de Notificações In-App e Alertas Corporativos (ENT-01)
-- FASE V10 — CONF-04 & ENT-01
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.user_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN (
        'VACATION_ALERT',
        'ASO_EXAM_ALERT',
        'TIME_BANK_ALERT',
        'TIMESHEET_CLOSURE',
        'PAYSLIP_RELEASED',
        'ESOCIAL_ALERT',
        'SYSTEM_ALERT',
        'SECURITY_ALERT'
    )),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    link TEXT,
    severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices de consulta rápida para o sininho e listagens
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
    ON public.user_notifications(tenant_id, user_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_created
    ON public.user_notifications(tenant_id, created_at DESC);

-- Permissões para role da aplicação
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notifications TO couplerh_app;

-- Overload conveniente para has_permission usando tenant do contexto
CREATE OR REPLACE FUNCTION public.has_permission(p_permission_slug TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT public.has_permission(public.current_app_tenant_id(), p_permission_slug);
$$;
GRANT EXECUTE ON FUNCTION public.has_permission(TEXT) TO couplerh_app;

-- RLS (Row Level Security)
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    DROP POLICY IF EXISTS p_user_notifications_tenant_select ON public.user_notifications;
    DROP POLICY IF EXISTS p_user_notifications_tenant_insert ON public.user_notifications;
    DROP POLICY IF EXISTS p_user_notifications_tenant_update ON public.user_notifications;
    DROP POLICY IF EXISTS p_user_notifications_tenant_delete ON public.user_notifications;
END $$;

CREATE POLICY p_user_notifications_tenant_select ON public.user_notifications
    FOR SELECT TO couplerh_app
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            user_id = public.current_app_user_id()
            OR public.has_permission(tenant_id, 'settings:read')
        )
    );

CREATE POLICY p_user_notifications_tenant_insert ON public.user_notifications
    FOR INSERT TO couplerh_app
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
    );

CREATE POLICY p_user_notifications_tenant_update ON public.user_notifications
    FOR UPDATE TO couplerh_app
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            user_id = public.current_app_user_id()
            OR public.has_permission(tenant_id, 'settings:write')
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
    );

CREATE POLICY p_user_notifications_tenant_delete ON public.user_notifications
    FOR DELETE TO couplerh_app
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            user_id = public.current_app_user_id()
            OR public.has_permission(tenant_id, 'settings:write')
        )
    );

-- Trigger de Auditoria (schema audit)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'audit_trigger_func') THEN
        DROP TRIGGER IF EXISTS audit_user_notifications ON public.user_notifications;
        CREATE TRIGGER audit_user_notifications
            AFTER INSERT OR UPDATE OR DELETE ON public.user_notifications
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;
END $$;
