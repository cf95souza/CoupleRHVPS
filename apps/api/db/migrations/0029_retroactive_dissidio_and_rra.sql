-- ==============================================================================
-- MIGRATION 0029: Folha Complementar, Dissídio Coletivo Retroativo & RRA (Art. 12-A)
-- FASE V6 — FOLHA-14
-- ==============================================================================

-- 1. Rubricas Oficiais de Dissídio Retroativo e RRA
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias
) VALUES
(
    'a0000000-0000-0000-0000-000000000110',
    '110',
    'Diferença Salarial Retroativa (Dissídio/CCT)',
    'EARNING',
    'SALARY',
    'OTHER',
    'ACTIVE',
    TRUE,
    'FIXO',
    14,
    50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000111',
    '111',
    'Diferença Reflexos Retroativos (HE / DSR / Adicionais)',
    'EARNING',
    'OVERTIME',
    'OTHER',
    'ACTIVE',
    TRUE,
    'FIXO',
    26,
    50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000112',
    '112',
    'Diferença Retroativa Férias e 13º Salário',
    'EARNING',
    'OTHER',
    'OTHER',
    'ACTIVE',
    TRUE,
    'FIXO',
    27,
    50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000915',
    '915',
    'IRRF sobre RRA (Art. 12-A Lei 7.713/88)',
    'DEDUCTION',
    'TAX',
    'IRRF',
    'ACTIVE',
    TRUE,
    'SYSTEM',
    96,
    10,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false, "irrf_mode": "EXCLUSIVO"}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    calculation_order = EXCLUDED.calculation_order,
    discount_priority = EXCLUDED.discount_priority,
    is_system = TRUE,
    incidencias = EXCLUDED.incidencias;

-- 2. Tabela de Lotes de Dissídio / Reajuste Retroativo (public.retroactive_adjustments)
CREATE TABLE IF NOT EXISTS public.retroactive_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    union_id UUID REFERENCES public.unions(id) ON DELETE SET NULL,
    collective_agreement_id UUID REFERENCES public.collective_agreements(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    adjustment_type TEXT NOT NULL DEFAULT 'PERCENTAGE' CHECK (adjustment_type IN ('PERCENTAGE', 'FIXED_TABLE')),
    percentage NUMERIC(8,4) NOT NULL DEFAULT 0.0000 CHECK (percentage >= 0),
    fixed_table_json JSONB DEFAULT '{}'::jsonb,
    start_year INT NOT NULL,
    start_month INT NOT NULL CHECK (start_month BETWEEN 1 AND 12),
    end_year INT NOT NULL,
    end_month INT NOT NULL CHECK (end_month BETWEEN 1 AND 12),
    payment_year INT NOT NULL,
    payment_month INT NOT NULL CHECK (payment_month BETWEEN 1 AND 12),
    payment_period_id UUID REFERENCES public.payroll_periods(id) ON DELETE SET NULL,
    installments_count INT NOT NULL DEFAULT 1 CHECK (installments_count BETWEEN 1 AND 12),
    apply_rra BOOLEAN NOT NULL DEFAULT TRUE,
    esocial_tp_ac_conv CHAR(1) NOT NULL DEFAULT 'A' CHECK (esocial_tp_ac_conv IN ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
    agreement_signature_date DATE,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CALCULATED', 'APPLIED', 'CANCELLED')),
    summary_json JSONB DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retroactive_adjustments_tenant
    ON public.retroactive_adjustments (tenant_id, company_id, created_at DESC);

-- 3. Breakdown por Competência de Origem para eSocial ideADC (public.payslip_retroactive_breakdown)
CREATE TABLE IF NOT EXISTS public.payslip_retroactive_breakdown (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    retroactive_adjustment_id UUID NOT NULL REFERENCES public.retroactive_adjustments(id) ON DELETE CASCADE,
    payslip_id UUID REFERENCES public.payslips(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    origin_year INT NOT NULL,
    origin_month INT NOT NULL CHECK (origin_month BETWEEN 1 AND 13),
    origin_period_type TEXT NOT NULL DEFAULT 'MONTHLY',
    rubric_code TEXT NOT NULL,
    rubric_name TEXT NOT NULL,
    original_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    recalculated_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    diff_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    inss_origin_diff NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    fgts_origin_diff NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    is_prior_calendar_year BOOLEAN NOT NULL DEFAULT FALSE,
    esocial_ide_adc_json JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retro_breakdown_adj
    ON public.payslip_retroactive_breakdown (tenant_id, retroactive_adjustment_id, contract_id);

CREATE INDEX IF NOT EXISTS idx_retro_breakdown_payslip
    ON public.payslip_retroactive_breakdown (tenant_id, payslip_id);

-- 4. RLS Estrita (ENABLE + FORCE ROW LEVEL SECURITY)
ALTER TABLE public.retroactive_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retroactive_adjustments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS retroactive_adjustments_isolation_policy ON public.retroactive_adjustments;
CREATE POLICY retroactive_adjustments_isolation_policy ON public.retroactive_adjustments
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_payslips')
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

ALTER TABLE public.payslip_retroactive_breakdown ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payslip_retroactive_breakdown FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payslip_retroactive_breakdown_isolation_policy ON public.payslip_retroactive_breakdown;
CREATE POLICY payslip_retroactive_breakdown_isolation_policy ON public.payslip_retroactive_breakdown
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
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.retroactive_adjustments TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payslip_retroactive_breakdown TO couplerh_app;

-- 5. Triggers de Auditoria Forense T29
DROP TRIGGER IF EXISTS trg_audit_retroactive_adjustments ON public.retroactive_adjustments;
CREATE TRIGGER trg_audit_retroactive_adjustments
    AFTER INSERT OR UPDATE OR DELETE ON public.retroactive_adjustments
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_payslip_retroactive_breakdown ON public.payslip_retroactive_breakdown;
CREATE TRIGGER trg_audit_payslip_retroactive_breakdown
    AFTER INSERT OR UPDATE OR DELETE ON public.payslip_retroactive_breakdown
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

