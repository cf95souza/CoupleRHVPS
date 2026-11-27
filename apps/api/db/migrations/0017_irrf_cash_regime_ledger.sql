-- ==============================================================================
-- Migration 0017: IRRF em Regime de Caixa (Lei 7.713/88 / IN RFB 1.500) — FOLHA-02
-- Sistema: coupleRH Enterprise v2.0 (PostgreSQL 17 Puro)
-- ==============================================================================

-- 1. Evolução de public.payroll_periods: payment_date (garantido NOT NULL) + irrf_regime
ALTER TABLE public.payroll_periods
    ADD COLUMN IF NOT EXISTS irrf_regime TEXT NOT NULL DEFAULT 'CASH';

DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.payroll_periods'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%irrf_regime%';

    IF v_conname IS NULL THEN
        ALTER TABLE public.payroll_periods
            ADD CONSTRAINT payroll_periods_irrf_regime_check
            CHECK (irrf_regime IN ('CASH', 'COMPETENCE'));
    END IF;
END $$;

UPDATE public.payroll_periods
SET payment_date = (make_date(year, month, 1) + INTERVAL '1 month' + INTERVAL '4 days')::date
WHERE payment_date IS NULL;

ALTER TABLE public.payroll_periods
    ALTER COLUMN payment_date SET NOT NULL,
    ALTER COLUMN payment_date SET DEFAULT CURRENT_DATE;

-- 2. Ledger Oficial de IRRF em Regime de Caixa (public.irrf_cash_ledger)
CREATE TABLE IF NOT EXISTS public.irrf_cash_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    payslip_id UUID NOT NULL REFERENCES public.payslips(id) ON DELETE CASCADE,
    cash_year INT NOT NULL,
    cash_month INT NOT NULL CHECK (cash_month BETWEEN 1 AND 12),
    payment_date DATE NOT NULL,
    taxation_bucket TEXT NOT NULL CHECK (
        taxation_bucket IN (
            'MONTHLY_CASH',
            'VACATION_EXCLUSIVE',
            'THIRTEENTH_EXCLUSIVE',
            'PLR_EXCLUSIVE',
            'RRA_EXCLUSIVE'
        )
    ),
    gross_taxable NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    inss_deducted NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    alimony_deducted NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    dependents_deducted NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    simplified_used BOOLEAN NOT NULL DEFAULT FALSE,
    irrf_withheld NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (payslip_id, taxation_bucket)
);

CREATE INDEX IF NOT EXISTS idx_irrf_cash_ledger_lookup
    ON public.irrf_cash_ledger (tenant_id, worker_id, cash_year, cash_month, taxation_bucket);

CREATE INDEX IF NOT EXISTS idx_irrf_cash_ledger_period
    ON public.irrf_cash_ledger (period_id);

-- 3. RLS Obrigatória (ENABLE + FORCE ROW LEVEL SECURITY)
ALTER TABLE public.irrf_cash_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.irrf_cash_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS irrf_cash_ledger_select_policy ON public.irrf_cash_ledger;
DROP POLICY IF EXISTS irrf_cash_ledger_insert_policy ON public.irrf_cash_ledger;
DROP POLICY IF EXISTS irrf_cash_ledger_update_policy ON public.irrf_cash_ledger;
DROP POLICY IF EXISTS irrf_cash_ledger_delete_policy ON public.irrf_cash_ledger;

CREATE POLICY irrf_cash_ledger_select_policy ON public.irrf_cash_ledger
    FOR SELECT
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_payslips')
            OR public.has_permission(tenant_id, 'calculate_payroll')
            OR worker_id = public.current_app_worker_id()
        )
        AND (
            public.current_app_user_id() IS NULL
            OR worker_id = public.current_app_worker_id()
            OR public.can_access_contract(tenant_id, contract_id)
        )
    );

CREATE POLICY irrf_cash_ledger_insert_policy ON public.irrf_cash_ledger
    FOR INSERT
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

CREATE POLICY irrf_cash_ledger_update_policy ON public.irrf_cash_ledger
    FOR UPDATE
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

CREATE POLICY irrf_cash_ledger_delete_policy ON public.irrf_cash_ledger
    FOR DELETE
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.irrf_cash_ledger TO couplerh_app;

-- 4. Trigger de Auditoria Forense T29
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers
        WHERE trigger_name = 'audit_irrf_cash_ledger_trigger'
          AND event_object_table = 'irrf_cash_ledger'
    ) THEN
        CREATE TRIGGER audit_irrf_cash_ledger_trigger
            AFTER INSERT OR UPDATE OR DELETE ON public.irrf_cash_ledger
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;
END $$;
