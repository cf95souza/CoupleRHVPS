-- ==============================================================================
-- MIGRATION 0036: Conciliação DCTFWeb / FGTS Digital / DARF IRRF
-- FASE V7 — CONT-05
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.tax_reconciliation_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    year INT NOT NULL CHECK (year >= 2000 AND year <= 2100),
    month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
    source_type TEXT NOT NULL CHECK (source_type IN ('DCTFWEB', 'FGTS_DIGITAL', 'IRRF_DARF')),
    engine_base_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    engine_tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    declared_base_amount NUMERIC(15,2),
    declared_tax_amount NUMERIC(15,2),
    diff_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'PENDING_DECLARATION'
        CHECK (status IN ('MATCHED', 'DIVERGENT', 'PENDING_DECLARATION')),
    notes TEXT,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    reconciled_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reconciled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tax_reconciliation_period_source
        UNIQUE (tenant_id, payroll_period_id, source_type)
);

CREATE INDEX IF NOT EXISTS idx_tax_reconciliation_lookup
    ON public.tax_reconciliation_snapshots (tenant_id, company_id, year, month);

-- RLS Estrita e Auditoria Forense T29
ALTER TABLE public.tax_reconciliation_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_reconciliation_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_reconciliation_isolation_policy ON public.tax_reconciliation_snapshots;
CREATE POLICY tax_reconciliation_isolation_policy ON public.tax_reconciliation_snapshots
    FOR ALL
    USING (tenant_id = public.current_app_tenant_id())
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_payroll_accounting')
            OR public.has_permission(tenant_id, 'export_financial_reports')
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_reconciliation_snapshots TO couplerh_app;

DROP TRIGGER IF EXISTS trg_audit_tax_reconciliation_snapshots ON public.tax_reconciliation_snapshots;
CREATE TRIGGER trg_audit_tax_reconciliation_snapshots
    AFTER INSERT OR UPDATE OR DELETE ON public.tax_reconciliation_snapshots
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
