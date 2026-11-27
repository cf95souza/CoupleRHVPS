-- ==============================================================================
-- Migration 0018: Pensão Alimentícia Enterprise (Multi-Beneficiário & Splits) — FOLHA-03
-- Sistema: coupleRH Enterprise v2.0 (PostgreSQL 17 Puro)
-- ==============================================================================

-- 1. Cadastro Estruturado de Beneficiários de Pensão Alimentícia
CREATE TABLE IF NOT EXISTS public.alimony_beneficiaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    rubric_id UUID REFERENCES public.rubrics(id) ON DELETE RESTRICT,
    beneficiary_name TEXT NOT NULL,
    beneficiary_cpf VARCHAR(11),
    beneficiary_birth_date DATE,
    relationship TEXT,
    court_process_number TEXT,
    court_name TEXT,
    calculation_basis TEXT NOT NULL DEFAULT 'NET_SALARY' CHECK (
        calculation_basis IN ('NET_SALARY', 'GROSS_SALARY', 'BASE_SALARY', 'MINIMUM_WAGE', 'FIXED_AMOUNT')
    ),
    percentage NUMERIC(8,4),
    fixed_amount NUMERIC(15,2),
    min_amount NUMERIC(15,2),
    max_amount NUMERIC(15,2),
    payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER' CHECK (
        payment_method IN ('BANK_TRANSFER', 'PIX', 'JUDICIAL_DEPOSIT')
    ),
    pix_key_type TEXT CHECK (pix_key_type IN ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP') OR pix_key_type IS NULL),
    pix_key TEXT,
    bank_code VARCHAR(10),
    bank_name TEXT,
    bank_agency VARCHAR(20),
    bank_account VARCHAR(30),
    bank_account_type TEXT CHECK (bank_account_type IN ('CORRENTE', 'POUPANCA', 'SALARIO', 'JUDICIAL') OR bank_account_type IS NULL),
    apply_on_monthly BOOLEAN NOT NULL DEFAULT TRUE,
    apply_on_advance BOOLEAN NOT NULL DEFAULT FALSE,
    apply_on_vacation BOOLEAN NOT NULL DEFAULT TRUE,
    apply_on_thirteenth BOOLEAN NOT NULL DEFAULT TRUE,
    apply_on_termination BOOLEAN NOT NULL DEFAULT TRUE,
    apply_on_complementary BOOLEAN NOT NULL DEFAULT TRUE,
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alimony_beneficiaries_lookup
    ON public.alimony_beneficiaries (tenant_id, contract_id, is_active)
    WHERE deleted_at IS NULL;

-- 2. Rateio Auditável de Pensão por Holerite e Beneficiário
CREATE TABLE IF NOT EXISTS public.payslip_alimony_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    payslip_id UUID NOT NULL REFERENCES public.payslips(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    beneficiary_id UUID REFERENCES public.alimony_beneficiaries(id) ON DELETE SET NULL,
    beneficiary_name TEXT NOT NULL,
    beneficiary_cpf VARCHAR(11),
    court_process_number TEXT,
    calculation_basis TEXT NOT NULL,
    percentage_applied NUMERIC(8,4),
    base_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    irrf_converged NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    solver_iterations INT NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
    payment_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payslip_alimony_splits_payslip
    ON public.payslip_alimony_splits (payslip_id);

CREATE INDEX IF NOT EXISTS idx_payslip_alimony_splits_period
    ON public.payslip_alimony_splits (tenant_id, payroll_period_id);

CREATE INDEX IF NOT EXISTS idx_payslip_alimony_splits_beneficiary
    ON public.payslip_alimony_splits (beneficiary_id);

-- 3. Imutabilidade CLT em Folha Fechada para payslip_alimony_splits
CREATE OR REPLACE FUNCTION public.trg_block_closed_payroll_modification() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_period_status TEXT;
    v_period_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'payslips' THEN
        v_period_id := COALESCE(NEW.payroll_period_id, OLD.payroll_period_id);
    ELSIF TG_TABLE_NAME = 'payslip_items' OR TG_TABLE_NAME = 'payroll_memory_calc' THEN
        SELECT payroll_period_id INTO v_period_id FROM public.payslips WHERE id = COALESCE(NEW.payslip_id, OLD.payslip_id);
    ELSIF TG_TABLE_NAME = 'payroll_company_taxes' OR TG_TABLE_NAME = 'payslip_alimony_splits' THEN
        v_period_id := COALESCE(NEW.payroll_period_id, OLD.payroll_period_id);
    END IF;

    IF v_period_id IS NOT NULL THEN
        SELECT status INTO v_period_status FROM public.payroll_periods WHERE id = v_period_id;
        IF v_period_status = 'CLOSED' THEN
            RAISE EXCEPTION 'Operacao Proibida: A folha de pagamento deste periodo esta FECHADA e auditada. Alteracoes sao estritamente vedadas.';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_payslip_alimony_splits_closed_immutability ON public.payslip_alimony_splits;
CREATE TRIGGER trg_payslip_alimony_splits_closed_immutability
    BEFORE UPDATE OR DELETE ON public.payslip_alimony_splits
    FOR EACH ROW EXECUTE FUNCTION public.trg_block_closed_payroll_modification();

-- 4. RLS Obrigatória (ENABLE + FORCE ROW LEVEL SECURITY)
ALTER TABLE public.alimony_beneficiaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alimony_beneficiaries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alimony_beneficiaries_select_policy ON public.alimony_beneficiaries;
DROP POLICY IF EXISTS alimony_beneficiaries_manage_policy ON public.alimony_beneficiaries;

CREATE POLICY alimony_beneficiaries_select_policy ON public.alimony_beneficiaries
    FOR SELECT
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_employees')
            OR public.has_permission(tenant_id, 'calculate_payroll')
            OR public.has_permission(tenant_id, 'view_payslips')
        )
        AND (
            public.current_app_user_id() IS NULL
            OR public.can_access_contract(tenant_id, contract_id)
        )
    );

CREATE POLICY alimony_beneficiaries_manage_policy ON public.alimony_beneficiaries
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_employees')
        )
        AND (
            public.current_app_user_id() IS NULL
            OR public.can_access_contract(tenant_id, contract_id)
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_employees')
        )
        AND (
            public.current_app_user_id() IS NULL
            OR public.can_access_contract(tenant_id, contract_id)
        )
    );

ALTER TABLE public.payslip_alimony_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payslip_alimony_splits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payslip_alimony_splits_select_policy ON public.payslip_alimony_splits;
DROP POLICY IF EXISTS payslip_alimony_splits_write_policy ON public.payslip_alimony_splits;

CREATE POLICY payslip_alimony_splits_select_policy ON public.payslip_alimony_splits
    FOR SELECT
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_payslips')
            OR public.has_permission(tenant_id, 'calculate_payroll')
            OR EXISTS (
                SELECT 1 FROM public.payslips ps
                WHERE ps.id = payslip_alimony_splits.payslip_id
                  AND ps.worker_id = public.current_app_worker_id()
            )
        )
        AND (
            public.current_app_user_id() IS NULL
            OR public.can_access_contract(tenant_id, contract_id)
            OR EXISTS (
                SELECT 1 FROM public.payslips ps
                WHERE ps.id = payslip_alimony_splits.payslip_id
                  AND ps.worker_id = public.current_app_worker_id()
            )
        )
    );

CREATE POLICY payslip_alimony_splits_write_policy ON public.payslip_alimony_splits
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.alimony_beneficiaries TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payslip_alimony_splits TO couplerh_app;

-- 5. Auditoria Forense T29
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers
        WHERE trigger_name = 'audit_alimony_beneficiaries_trigger'
          AND event_object_table = 'alimony_beneficiaries'
    ) THEN
        CREATE TRIGGER audit_alimony_beneficiaries_trigger
            AFTER INSERT OR UPDATE OR DELETE ON public.alimony_beneficiaries
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers
        WHERE trigger_name = 'audit_payslip_alimony_splits_trigger'
          AND event_object_table = 'payslip_alimony_splits'
    ) THEN
        CREATE TRIGGER audit_payslip_alimony_splits_trigger
            AFTER INSERT OR UPDATE OR DELETE ON public.payslip_alimony_splits
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;
END $$;
