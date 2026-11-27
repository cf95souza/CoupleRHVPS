-- ==============================================================================
-- MIGRATION 0024: Sindicatos, Convenções Coletivas (CCT/ACT), ATS e Pisos
-- FASE V5 — FOLHA-09: Sindicatos e Convenções Coletivas (CCT)
-- ==============================================================================

-- 1. Permissão RBAC Oficial
INSERT INTO public.permissions (name, slug, category, description)
VALUES (
    'Gerenciar Sindicatos e CCT',
    'manage_unions',
    'ORGANIZATION',
    'Cadastrar e parametrizar sindicatos, convenções coletivas (CCT) e acordos coletivos (ACT)'
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description;

-- Concede manage_unions para system_admin, tenant_admin e dp_analyst
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE p.slug = 'manage_unions'
  AND r.slug IN ('system_admin', 'tenant_admin', 'dp_analyst')
ON CONFLICT DO NOTHING;

-- 2. Rubricas Oficiais de Sistema para ATS e Piso CCT
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias
) VALUES
(
    'a0000000-0000-0000-0000-000000000106',
    '106',
    'Adicional por Tempo de Serviço (ATS)',
    'EARNING',
    'ALLOWANCE',
    'ALLOWANCE',
    'ACTIVE',
    TRUE,
    'PERCENTUAL',
    25,
    50,
    '{"rat": true, "fgts": true, "inss": true, "irrf": true, "terceiros": true, "integra_dsr": false, "inss_patronal": true, "gera_base_fgts": true, "gera_base_inss": true, "gera_base_irrf": true}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000107',
    '107',
    'Diferença de Piso Salarial (CCT)',
    'EARNING',
    'BASE',
    'SALARY_BASE',
    'ACTIVE',
    TRUE,
    'VALOR',
    11,
    50,
    '{"rat": true, "fgts": true, "inss": true, "irrf": true, "terceiros": true, "integra_dsr": false, "inss_patronal": true, "gera_base_fgts": true, "gera_base_inss": true, "gera_base_irrf": true}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    discount_priority = EXCLUDED.discount_priority,
    is_system = TRUE,
    incidencias = EXCLUDED.incidencias;

-- 3. Tabela de Sindicatos (public.unions)
CREATE TABLE IF NOT EXISTS public.unions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    code VARCHAR(50),
    cnpj VARCHAR(18) NOT NULL,
    name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255),
    union_type VARCHAR(30) NOT NULL DEFAULT 'EMPLOYEE' CHECK (union_type IN ('EMPLOYEE', 'EMPLOYER')),
    base_month SMALLINT NOT NULL CHECK (base_month BETWEEN 1 AND 12),
    state VARCHAR(2),
    city VARCHAR(100),
    phone VARCHAR(30),
    email VARCHAR(255),
    website VARCHAR(255),
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_unions_tenant_cnpj
    ON public.unions (tenant_id, cnpj)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_unions_tenant_active
    ON public.unions (tenant_id, is_active)
    WHERE deleted_at IS NULL;

-- 4. Tabela de Convenções e Acordos Coletivos (public.collective_agreements)
CREATE TABLE IF NOT EXISTS public.collective_agreements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    union_id UUID NOT NULL REFERENCES public.unions(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    agreement_type VARCHAR(30) NOT NULL DEFAULT 'CCT' CHECK (agreement_type IN ('CCT', 'ACT')),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    base_salary_floor NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (base_salary_floor >= 0),
    floor_positions JSONB DEFAULT '[]'::jsonb,
    overtime_percentage_tier1 NUMERIC(5,2) NOT NULL DEFAULT 50.00 CHECK (overtime_percentage_tier1 >= 0),
    overtime_percentage_tier2 NUMERIC(5,2) NOT NULL DEFAULT 100.00 CHECK (overtime_percentage_tier2 >= 0),
    overtime_percentage_sunday_holiday NUMERIC(5,2) NOT NULL DEFAULT 100.00 CHECK (overtime_percentage_sunday_holiday >= 0),
    night_shift_percentage NUMERIC(5,2) NOT NULL DEFAULT 20.00 CHECK (night_shift_percentage >= 0),
    night_shift_start_time TIME NOT NULL DEFAULT '22:00:00',
    night_shift_end_time TIME NOT NULL DEFAULT '05:00:00',
    night_hour_reduced BOOLEAN NOT NULL DEFAULT TRUE,
    unhealthiness_base_type VARCHAR(30) NOT NULL DEFAULT 'MINIMUM_WAGE'
        CHECK (unhealthiness_base_type IN ('MINIMUM_WAGE', 'BASE_SALARY', 'CATEGORY_FLOOR')),
    ats_type VARCHAR(30) NOT NULL DEFAULT 'NONE'
        CHECK (ats_type IN ('NONE', 'ANUENIO', 'BIENIO', 'TRIENIO', 'QUINQUENIO')),
    ats_percentage_per_cycle NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (ats_percentage_per_cycle >= 0),
    ats_max_percentage NUMERIC(5,2) CHECK (ats_max_percentage IS NULL OR ats_max_percentage >= 0),
    ats_base_type VARCHAR(30) NOT NULL DEFAULT 'BASE_SALARY'
        CHECK (ats_base_type IN ('BASE_SALARY', 'GROSS_SALARY')),
    average_calculation_months SMALLINT NOT NULL DEFAULT 12 CHECK (average_calculation_months BETWEEN 1 AND 24),
    post_vacation_stability_days SMALLINT NOT NULL DEFAULT 0 CHECK (post_vacation_stability_days >= 0),
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_cct_validity CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_cct_tenant_union
    ON public.collective_agreements (tenant_id, union_id, is_active)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cct_tenant_dates
    ON public.collective_agreements (tenant_id, start_date, end_date)
    WHERE deleted_at IS NULL;

-- 5. Vinculação nos Contratos de Trabalho (public.contracts)
ALTER TABLE public.contracts
    ADD COLUMN IF NOT EXISTS union_id UUID REFERENCES public.unions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS collective_agreement_id UUID REFERENCES public.collective_agreements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contracts_union_id
    ON public.contracts (tenant_id, union_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contracts_cct_id
    ON public.contracts (tenant_id, collective_agreement_id)
    WHERE deleted_at IS NULL;

-- 6. Row Level Security (RLS) Estrita
ALTER TABLE public.unions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unions_isolation_policy ON public.unions;
CREATE POLICY unions_isolation_policy ON public.unions
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    );

ALTER TABLE public.collective_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collective_agreements FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS collective_agreements_isolation_policy ON public.collective_agreements;
CREATE POLICY collective_agreements_isolation_policy ON public.collective_agreements
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    );

-- 7. Triggers de Auditoria Forense T29
DROP TRIGGER IF EXISTS trg_audit_unions ON public.unions;
CREATE TRIGGER trg_audit_unions
    AFTER INSERT OR UPDATE OR DELETE ON public.unions
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_collective_agreements ON public.collective_agreements;
CREATE TRIGGER trg_audit_collective_agreements
    AFTER INSERT OR UPDATE OR DELETE ON public.collective_agreements
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

-- 8. Concessão de Permissões à Role da Aplicação (couplerh_app)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.unions TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.collective_agreements TO couplerh_app;
