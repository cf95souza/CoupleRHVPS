-- ==============================================================================
-- MIGRATION 0033: Razão Contábil de Provisões Reais Acumuladas com Baixa Mensal
-- FASE V7 — CONT-02
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.accounting_provisions_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    cost_center_id UUID REFERENCES public.cost_centers(id) ON DELETE SET NULL,
    year INT NOT NULL CHECK (year >= 2000 AND year <= 2100),
    month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
    provision_type TEXT NOT NULL CHECK (provision_type IN ('VACATION', 'THIRTEENTH')),
    opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    monthly_accrual NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    salary_adjustment_diff NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    averages_adjustment NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    settlements_paid NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    closing_balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    charges_opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    charges_monthly_accrual NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    charges_adjustment_diff NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    charges_settlements_paid NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    charges_closing_balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    net_accounting_entry NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    net_charges_entry NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    effective_employer_rate NUMERIC(8,4) NOT NULL DEFAULT 0.0000,
    avos_accumulated INT NOT NULL DEFAULT 0,
    reference_salary NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    breakdown_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'CALCULATED' CHECK (status IN ('CALCULATED', 'CLOSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_accounting_provisions_ledger_period_contract_type
        UNIQUE (tenant_id, payroll_period_id, contract_id, provision_type)
);

CREATE INDEX IF NOT EXISTS idx_accounting_provisions_ledger_lookup
    ON public.accounting_provisions_ledger (tenant_id, company_id, year, month, provision_type);

CREATE INDEX IF NOT EXISTS idx_accounting_provisions_ledger_contract
    ON public.accounting_provisions_ledger (tenant_id, contract_id, year DESC, month DESC);

-- RLS Estrita e Auditoria Forense T29
ALTER TABLE public.accounting_provisions_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_provisions_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounting_provisions_ledger_isolation_policy ON public.accounting_provisions_ledger;
CREATE POLICY accounting_provisions_ledger_isolation_policy ON public.accounting_provisions_ledger
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_payroll_accounting')
            OR public.has_permission(tenant_id, 'calculate_payroll')
            OR public.can_access_contract(tenant_id, contract_id)
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_payroll_accounting')
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounting_provisions_ledger TO couplerh_app;

DROP TRIGGER IF EXISTS trg_audit_accounting_provisions_ledger ON public.accounting_provisions_ledger;
CREATE TRIGGER trg_audit_accounting_provisions_ledger
    AFTER INSERT OR UPDATE OR DELETE ON public.accounting_provisions_ledger
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
