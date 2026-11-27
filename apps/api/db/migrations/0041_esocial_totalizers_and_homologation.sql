-- ==============================================================================
-- MIGRATION 0041: Totalizadores eSocial (S-5001 a S-5013) & Gate de Homologação
-- FASE V9 — ESOC-04, ESOC-05
-- ==============================================================================

-- 1. Evolução de public.esocial_totalizers para Confronto CoupleRH x Governo
ALTER TABLE public.esocial_totalizers
    ADD COLUMN IF NOT EXISTS payroll_period_id UUID REFERENCES public.payroll_periods(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS worker_id UUID REFERENCES public.workers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES public.contracts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS cpf TEXT,
    ADD COLUMN IF NOT EXISTS receipt_number TEXT,
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'HOMOLOGATION',
    ADD COLUMN IF NOT EXISTS raw_xml TEXT,
    ADD COLUMN IF NOT EXISTS irrf_retido NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS fgts_base NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS inss_base NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS inss_terceiros NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS inss_rat_ajustado NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS maternity_deduction NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS family_salary_deduction NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS couple_inss_segurados NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS couple_inss_patronal NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS couple_irrf_retido NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS couple_fgts_total NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS diff_inss_segurados NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS diff_inss_patronal NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS diff_irrf_retido NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS diff_fgts_total NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS reconciliation_status TEXT NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS divergences_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.esocial_totalizers'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%reconciliation_status%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.esocial_totalizers DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.esocial_totalizers
    ADD CONSTRAINT esocial_totalizers_reconciliation_status_check
    CHECK (reconciliation_status IN ('PENDING', 'MATCHED', 'DIVERGENT'));

CREATE INDEX IF NOT EXISTS idx_esocial_totalizers_company_period
    ON public.esocial_totalizers(tenant_id, company_id, period_year, period_month, event_type);

-- 2. Flag de Liberação de Produção por Empresa (somente após Homologação em Produção Restrita)
ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS esocial_production_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS esocial_homologated_at TIMESTAMPTZ;

-- 3. Tabela de Ciclos de Homologação em Produção Restrita (ESOC-05)
CREATE TABLE IF NOT EXISTS public.esocial_homologation_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    payroll_period_id UUID REFERENCES public.payroll_periods(id) ON DELETE SET NULL,
    environment TEXT NOT NULL DEFAULT 'HOMOLOGATION' CHECK (environment IN ('HOMOLOGATION', 'PRODUCTION')),
    status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'APPROVED', 'FAILED')),
    required_events_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    accepted_receipts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    totalizer_max_diff NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    production_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
    unlocked_at TIMESTAMPTZ,
    unlocked_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_esocial_homolog_cycles_company
    ON public.esocial_homologation_cycles(tenant_id, company_id, created_at DESC);

-- 4. Hardening RLS + Triggers de Auditoria T29 + Grants para couplerh_app
DO $$
DECLARE
    t TEXT;
    esoc_tables TEXT[] := ARRAY['esocial_totalizers', 'esocial_homologation_cycles'];
BEGIN
    FOREACH t IN ARRAY esoc_tables
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);

        EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%I ON public.%I;', t, t);
        EXECUTE format(
            'CREATE TRIGGER trg_audit_%I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();',
            t, t
        );

        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON public.%I;', t);
        EXECUTE format('DROP POLICY IF EXISTS %I_rls_policy ON public.%I;', t, t);
        EXECUTE format(
            'CREATE POLICY %I_rls_policy ON public.%I FOR ALL USING (tenant_id = public.current_app_tenant_id() AND (public.current_app_user_id() IS NULL OR public.has_permission(tenant_id, ''manage_esocial''))) WITH CHECK (tenant_id = public.current_app_tenant_id() AND (public.current_app_user_id() IS NULL OR public.has_permission(tenant_id, ''manage_esocial'')));',
            t, t
        );

        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO couplerh_app;', t);
    END LOOP;
END $$;
