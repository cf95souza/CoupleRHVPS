-- ==============================================================================
-- MIGRATION 0032: Rateio Multi-CC, Projetos, Tomadores (Lei 9.711/98) e Obras CNO (S-1020)
-- FASE V7 — CONT-01
-- ==============================================================================

-- 1. Evolução de public.cost_centers para suportar Projetos, Tomadores e Obras CNO (S-1020)
ALTER TABLE public.cost_centers
    ADD COLUMN IF NOT EXISTS allocation_type TEXT NOT NULL DEFAULT 'COST_CENTER'
        CHECK (allocation_type IN ('COST_CENTER', 'PROJECT', 'TOMADOR', 'CNO_WORK')),
    ADD COLUMN IF NOT EXISTS project_code TEXT,
    ADD COLUMN IF NOT EXISTS tomador_cnpj VARCHAR(18),
    ADD COLUMN IF NOT EXISTS tomador_name TEXT,
    ADD COLUMN IF NOT EXISTS cno_number VARCHAR(20),
    ADD COLUMN IF NOT EXISTS esocial_lotacao_code VARCHAR(30),
    ADD COLUMN IF NOT EXISTS esocial_tp_lotacao VARCHAR(5);

-- 2. Regras de Rateio Configuradas por Contrato (Soma obrigatória = 100%)
CREATE TABLE IF NOT EXISTS public.contract_cost_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    cost_center_id UUID REFERENCES public.cost_centers(id) ON DELETE RESTRICT,
    project_code TEXT,
    tomador_cnpj VARCHAR(18),
    tomador_name TEXT,
    cno_number VARCHAR(20),
    esocial_lotacao_code VARCHAR(30),
    percentage NUMERIC(7,4) NOT NULL CHECK (percentage > 0 AND percentage <= 100),
    valid_from DATE NOT NULL DEFAULT '2020-01-01',
    valid_to DATE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_cost_allocations_contract
    ON public.contract_cost_allocations (tenant_id, contract_id, is_active);

-- 3. Rateio Calculado por Holerite na Competência (Sem perda de centavos)
CREATE TABLE IF NOT EXISTS public.payslip_cost_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    payslip_id UUID NOT NULL REFERENCES public.payslips(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    cost_center_id UUID REFERENCES public.cost_centers(id) ON DELETE SET NULL,
    project_code TEXT,
    tomador_cnpj VARCHAR(18),
    tomador_name TEXT,
    cno_number VARCHAR(20),
    esocial_lotacao_code VARCHAR(30),
    percentage NUMERIC(7,4) NOT NULL CHECK (percentage > 0 AND percentage <= 100),
    gross_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    deductions_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    net_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    inss_employer_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    rat_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    terceiros_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    fgts_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    vacation_provision_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    thirteenth_provision_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    total_employer_cost NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    is_rounding_adjusted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payslip_cost_allocations_period
    ON public.payslip_cost_allocations (tenant_id, payroll_period_id, payslip_id);

-- 4. RLS Estrita e Auditoria Forense T29
ALTER TABLE public.contract_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_cost_allocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_cost_allocations_isolation_policy ON public.contract_cost_allocations;
CREATE POLICY contract_cost_allocations_isolation_policy ON public.contract_cost_allocations
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.can_access_contract(tenant_id, contract_id)
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_payroll_accounting')
            OR public.has_permission(tenant_id, 'manage_employees')
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

ALTER TABLE public.payslip_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payslip_cost_allocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payslip_cost_allocations_isolation_policy ON public.payslip_cost_allocations;
CREATE POLICY payslip_cost_allocations_isolation_policy ON public.payslip_cost_allocations
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_cost_allocations TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payslip_cost_allocations TO couplerh_app;

DROP TRIGGER IF EXISTS trg_audit_contract_cost_allocations ON public.contract_cost_allocations;
CREATE TRIGGER trg_audit_contract_cost_allocations
    AFTER INSERT OR UPDATE OR DELETE ON public.contract_cost_allocations
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_payslip_cost_allocations ON public.payslip_cost_allocations;
CREATE TRIGGER trg_audit_payslip_cost_allocations
    AFTER INSERT OR UPDATE OR DELETE ON public.payslip_cost_allocations
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
