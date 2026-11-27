-- ==============================================================================
-- MIGRATION 0035: Remessas CNAB 240 Multi-Banco (Seg. A+B / PIX / Pensão) & Retorno .ret
-- FASE V7 — CONT-04
-- ==============================================================================

-- 1. Dados Bancários Pagadores da Empresa
ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS payment_bank_code VARCHAR(10),
    ADD COLUMN IF NOT EXISTS payment_agency VARCHAR(15),
    ADD COLUMN IF NOT EXISTS payment_agency_digit VARCHAR(5),
    ADD COLUMN IF NOT EXISTS payment_account VARCHAR(25),
    ADD COLUMN IF NOT EXISTS payment_account_digit VARCHAR(5),
    ADD COLUMN IF NOT EXISTS payment_agreement_code VARCHAR(30),
    ADD COLUMN IF NOT EXISTS payment_pix_key TEXT;

-- 2. Cabeçalho de Remessa Bancária CNAB 240
CREATE TABLE IF NOT EXISTS public.cnab_remittances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    bank_code VARCHAR(10) NOT NULL,
    bank_name TEXT NOT NULL,
    payment_channel TEXT NOT NULL DEFAULT 'MIXED' CHECK (payment_channel IN ('MIXED', 'TED_CC', 'PIX')),
    sequential_number INT NOT NULL DEFAULT 1,
    payment_date DATE NOT NULL,
    include_alimony BOOLEAN NOT NULL DEFAULT TRUE,
    total_records INT NOT NULL DEFAULT 0,
    employees_count INT NOT NULL DEFAULT 0,
    alimony_count INT NOT NULL DEFAULT 0,
    total_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    file_name TEXT NOT NULL,
    file_content TEXT NOT NULL,
    file_hash_sha256 VARCHAR(64) NOT NULL,
    status TEXT NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'REJECTED')),
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cnab_remittances_period
    ON public.cnab_remittances (tenant_id, payroll_period_id, created_at DESC);

-- 3. Itens Individuais de Pagamento da Remessa (Empregados + Pensionistas)
CREATE TABLE IF NOT EXISTS public.cnab_remittance_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    remittance_id UUID NOT NULL REFERENCES public.cnab_remittances(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    payslip_id UUID REFERENCES public.payslips(id) ON DELETE SET NULL,
    contract_id UUID REFERENCES public.contracts(id) ON DELETE SET NULL,
    alimony_split_id UUID REFERENCES public.payslip_alimony_splits(id) ON DELETE SET NULL,
    beneficiary_type TEXT NOT NULL CHECK (beneficiary_type IN ('EMPLOYEE', 'ALIMONY')),
    beneficiary_name TEXT NOT NULL,
    beneficiary_cpf VARCHAR(14),
    payment_method TEXT NOT NULL CHECK (payment_method IN ('CC', 'POUPANCA', 'SALARIO', 'TED', 'PIX')),
    bank_code VARCHAR(10),
    agency VARCHAR(15),
    account VARCHAR(30),
    pix_key TEXT,
    pix_key_type VARCHAR(15),
    amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    your_number VARCHAR(20) NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'REJECTED', 'RETURNED')),
    bank_occurrence_code VARCHAR(20),
    bank_occurrence_message TEXT,
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cnab_remittance_items_lookup
    ON public.cnab_remittance_items (tenant_id, remittance_id, your_number);

-- 4. Lotes de Retorno Bancário (.ret) Importados e Conciliados
CREATE TABLE IF NOT EXISTS public.cnab_return_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    remittance_id UUID REFERENCES public.cnab_remittances(id) ON DELETE SET NULL,
    bank_code VARCHAR(10) NOT NULL,
    file_name TEXT NOT NULL,
    file_hash_sha256 VARCHAR(64) NOT NULL,
    total_items INT NOT NULL DEFAULT 0,
    paid_count INT NOT NULL DEFAULT 0,
    rejected_count INT NOT NULL DEFAULT 0,
    total_paid_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    imported_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. RLS Estrita e Auditoria Forense T29
ALTER TABLE public.cnab_remittances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cnab_remittances FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cnab_remittance_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cnab_remittance_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cnab_return_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cnab_return_imports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cnab_remittances_isolation_policy ON public.cnab_remittances;
CREATE POLICY cnab_remittances_isolation_policy ON public.cnab_remittances
    FOR ALL
    USING (tenant_id = public.current_app_tenant_id())
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'export_financial_reports')
            OR public.has_permission(tenant_id, 'view_payroll_accounting')
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

DROP POLICY IF EXISTS cnab_remittance_items_isolation_policy ON public.cnab_remittance_items;
CREATE POLICY cnab_remittance_items_isolation_policy ON public.cnab_remittance_items
    FOR ALL
    USING (tenant_id = public.current_app_tenant_id())
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'export_financial_reports')
            OR public.has_permission(tenant_id, 'view_payroll_accounting')
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

DROP POLICY IF EXISTS cnab_return_imports_isolation_policy ON public.cnab_return_imports;
CREATE POLICY cnab_return_imports_isolation_policy ON public.cnab_return_imports
    FOR ALL
    USING (tenant_id = public.current_app_tenant_id())
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'export_financial_reports')
            OR public.has_permission(tenant_id, 'view_payroll_accounting')
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cnab_remittances TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cnab_remittance_items TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cnab_return_imports TO couplerh_app;

DROP TRIGGER IF EXISTS trg_audit_cnab_remittances ON public.cnab_remittances;
CREATE TRIGGER trg_audit_cnab_remittances
    AFTER INSERT OR UPDATE OR DELETE ON public.cnab_remittances
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_cnab_remittance_items ON public.cnab_remittance_items;
CREATE TRIGGER trg_audit_cnab_remittance_items
    AFTER INSERT OR UPDATE OR DELETE ON public.cnab_remittance_items
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_cnab_return_imports ON public.cnab_return_imports;
CREATE TRIGGER trg_audit_cnab_return_imports
    AFTER INSERT OR UPDATE OR DELETE ON public.cnab_return_imports
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
