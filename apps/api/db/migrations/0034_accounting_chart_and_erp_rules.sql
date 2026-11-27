-- ==============================================================================
-- MIGRATION 0034: Plano de Contas Parametrizável, Regras D/C e Lotes Exportadores ERP
-- FASE V7 — CONT-03
-- ==============================================================================

-- 1. Plano de Contas Contábil Editável
CREATE TABLE IF NOT EXISTS public.accounting_chart_of_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    account_code VARCHAR(40) NOT NULL,
    account_name TEXT NOT NULL,
    reduced_code VARCHAR(20),
    account_type TEXT NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EXPENSE', 'REVENUE', 'TRANSITORY')),
    nature TEXT NOT NULL CHECK (nature IN ('DEBIT', 'CREDIT')),
    requires_cost_center BOOLEAN NOT NULL DEFAULT FALSE,
    is_system_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_chart_tenant_company_code
    ON public.accounting_chart_of_accounts (
        tenant_id,
        COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
        account_code
    );

-- 2. Regras de Parametrização Contábil (Rubrica / Encargo / Provisão / Líquido)
CREATE TABLE IF NOT EXISTS public.accounting_mapping_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    rule_scope TEXT NOT NULL CHECK (rule_scope IN ('RUBRIC', 'EMPLOYER_TAX', 'PROVISION', 'NET_SALARY')),
    rubric_code VARCHAR(20),
    event_key VARCHAR(60) NOT NULL,
    debit_account_id UUID REFERENCES public.accounting_chart_of_accounts(id) ON DELETE RESTRICT,
    credit_account_id UUID REFERENCES public.accounting_chart_of_accounts(id) ON DELETE RESTRICT,
    history_template TEXT NOT NULL,
    erp_history_code VARCHAR(20),
    split_by_cost_center BOOLEAN NOT NULL DEFAULT TRUE,
    priority INT NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounting_mapping_rules_lookup
    ON public.accounting_mapping_rules (tenant_id, company_id, rule_scope, event_key);

-- 3. Registro Auditável de Lotes Exportados para ERPs Contábeis
CREATE TABLE IF NOT EXISTS public.accounting_export_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    erp_format TEXT NOT NULL CHECK (erp_format IN ('DOMINIO', 'ALTERDATA', 'PROTHEUS', 'SENIOR', 'CSV_CONFIGURABLE')),
    total_debit NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    total_credit NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    entries_count INT NOT NULL DEFAULT 0,
    is_balanced BOOLEAN NOT NULL DEFAULT TRUE,
    file_name TEXT NOT NULL,
    file_hash_sha256 VARCHAR(64) NOT NULL,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounting_export_batches_period
    ON public.accounting_export_batches (tenant_id, payroll_period_id, created_at DESC);

-- 4. RLS Estrita e Auditoria Forense T29
ALTER TABLE public.accounting_chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_chart_of_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_mapping_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_mapping_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_export_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_export_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounting_chart_isolation_policy ON public.accounting_chart_of_accounts;
CREATE POLICY accounting_chart_isolation_policy ON public.accounting_chart_of_accounts
    FOR ALL
    USING (tenant_id = public.current_app_tenant_id())
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_payroll_accounting')
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

DROP POLICY IF EXISTS accounting_rules_isolation_policy ON public.accounting_mapping_rules;
CREATE POLICY accounting_rules_isolation_policy ON public.accounting_mapping_rules
    FOR ALL
    USING (tenant_id = public.current_app_tenant_id())
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_payroll_accounting')
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

DROP POLICY IF EXISTS accounting_batches_isolation_policy ON public.accounting_export_batches;
CREATE POLICY accounting_batches_isolation_policy ON public.accounting_export_batches
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_chart_of_accounts TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_mapping_rules TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_export_batches TO couplerh_app;

DROP TRIGGER IF EXISTS trg_audit_accounting_chart_of_accounts ON public.accounting_chart_of_accounts;
CREATE TRIGGER trg_audit_accounting_chart_of_accounts
    AFTER INSERT OR UPDATE OR DELETE ON public.accounting_chart_of_accounts
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_accounting_mapping_rules ON public.accounting_mapping_rules;
CREATE TRIGGER trg_audit_accounting_mapping_rules
    AFTER INSERT OR UPDATE OR DELETE ON public.accounting_mapping_rules
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_accounting_export_batches ON public.accounting_export_batches;
CREATE TRIGGER trg_audit_accounting_export_batches
    AFTER INSERT OR UPDATE OR DELETE ON public.accounting_export_batches
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
