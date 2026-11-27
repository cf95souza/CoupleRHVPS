-- ==============================================================================
-- MIGRATION 0030: Categorias Especiais de Vínculos (Multi-Regime eSocial)
-- FASE V6 — FOLHA-15: Pró-Labore, Autônomo/RPA, Estagiário, Intermitente, Horista/Comissionista
-- ==============================================================================

-- 1. Evolução de public.contract_types
ALTER TABLE public.contract_types
    ADD COLUMN IF NOT EXISTS esocial_category_code VARCHAR(10) NOT NULL DEFAULT '101',
    ADD COLUMN IF NOT EXISTS calculation_regime TEXT NOT NULL DEFAULT 'CLT'
        CHECK (calculation_regime IN ('CLT', 'PRO_LABORE', 'AUTONOMOUS_RPA', 'INTERN', 'INTERMITTENT', 'HOURLY', 'DAILY', 'COMMISSION_ONLY', 'APPRENTICE')),
    ADD COLUMN IF NOT EXISTS has_inss BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS has_fgts BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS has_13th BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS has_vacation BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS has_employer_rat BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS has_employer_third_parties BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. Evolução de public.contracts
ALTER TABLE public.contracts
    ADD COLUMN IF NOT EXISTS esocial_category_code VARCHAR(10),
    ADD COLUMN IF NOT EXISTS calculation_regime TEXT
        CHECK (calculation_regime IS NULL OR calculation_regime IN ('CLT', 'PRO_LABORE', 'AUTONOMOUS_RPA', 'INTERN', 'INTERMITTENT', 'HOURLY', 'DAILY', 'COMMISSION_ONLY', 'APPRENTICE')),
    ADD COLUMN IF NOT EXISTS autonomous_service_type TEXT
        CHECK (autonomous_service_type IS NULL OR autonomous_service_type IN ('GENERAL', 'FREIGHT_TRANSPORT', 'PASSENGER_TRANSPORT')),
    ADD COLUMN IF NOT EXISTS iss_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (iss_rate >= 0 AND iss_rate <= 10),
    ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(15,4),
    ADD COLUMN IF NOT EXISTS daily_rate NUMERIC(15,4);

-- 3. Tabela de Convocações de Trabalho Intermitente (CLT Art. 452-A / eSocial S-2260)
CREATE TABLE IF NOT EXISTS public.intermittent_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    call_date DATE NOT NULL,
    work_start_date DATE NOT NULL,
    work_end_date DATE NOT NULL,
    hours_worked NUMERIC(8,2) NOT NULL CHECK (hours_worked > 0),
    hourly_rate NUMERIC(15,4) NOT NULL CHECK (hourly_rate >= 0),
    gross_salary NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    vacation_proportional NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    vacation_third NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    thirteenth_proportional NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    dsr_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'PAID', 'CANCELLED')),
    payroll_period_id UUID REFERENCES public.payroll_periods(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_intermittent_dates CHECK (work_end_date >= work_start_date)
);

CREATE INDEX IF NOT EXISTS idx_intermittent_calls_contract
    ON public.intermittent_calls (tenant_id, contract_id, work_start_date);

-- 4. Rubricas Oficiais para Regimes Especiais
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias
) VALUES
(
    'a0000000-0000-0000-0000-000000000115',
    '115', 'Pró-Labore (Sócio / Diretor)', 'EARNING', 'SALARY', 'OTHER', 'ACTIVE', TRUE,
    'FIXO', 10, 50,
    '{"inss": true, "irrf": true, "fgts": false, "inss_patronal": true, "rat": false, "terceiros": false, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000116',
    '116', 'Remuneração Autônomo / RPA', 'EARNING', 'SALARY', 'OTHER', 'ACTIVE', TRUE,
    'FIXO', 10, 50,
    '{"inss": true, "irrf": true, "fgts": false, "inss_patronal": true, "rat": false, "terceiros": false, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000117',
    '117', 'Bolsa-Auxílio Estagiário (Lei 11.788/2008)', 'EARNING', 'SALARY', 'OTHER', 'ACTIVE', TRUE,
    'FIXO', 10, 50,
    '{"inss": false, "irrf": true, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": true, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000118',
    '118', 'Recesso Remunerado Estágio (Lei 11.788/2008)', 'EARNING', 'VACATION', 'VACATION', 'ACTIVE', TRUE,
    'FIXO', 44, 50,
    '{"inss": false, "irrf": true, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": true, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000119',
    '119', 'Salário Trabalho Intermitente (Art. 452-A CLT)', 'EARNING', 'SALARY', 'OTHER', 'ACTIVE', TRUE,
    'HORAS', 10, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000120',
    '120', 'Férias Proporcionais + 1/3 (Intermitente)', 'EARNING', 'VACATION', 'VACATION', 'ACTIVE', TRUE,
    'FIXO', 15, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000121',
    '121', '13º Salário Proporcional (Intermitente)', 'EARNING', 'THIRTEENTH', 'THIRTEENTH', 'ACTIVE', TRUE,
    'FIXO', 16, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000122',
    '122', 'DSR sobre Salário Horista / Intermitente / Comissões', 'EARNING', 'DSR', 'DSR', 'ACTIVE', TRUE,
    'FIXO', 30, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000123',
    '123', 'Complemento Garantia Mínima (Comissionista)', 'EARNING', 'SALARY', 'OTHER', 'ACTIVE', TRUE,
    'FIXO', 31, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000916',
    '916', 'Retenção SEST / SENAT (2,5% Transportador Autônomo)', 'DEDUCTION', 'TAX', 'OTHER', 'ACTIVE', TRUE,
    'SYSTEM', 92, 10,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000917',
    '917', 'ISS Retido na Fonte (Autônomo / RPA)', 'DEDUCTION', 'TAX', 'OTHER', 'ACTIVE', TRUE,
    'SYSTEM', 93, 10,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
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

-- 5. RLS Estrita em intermittent_calls
ALTER TABLE public.intermittent_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intermittent_calls FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intermittent_calls_isolation_policy ON public.intermittent_calls;
CREATE POLICY intermittent_calls_isolation_policy ON public.intermittent_calls
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
            OR public.has_permission(tenant_id, 'manage_employees')
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.intermittent_calls TO couplerh_app;

-- 6. Auditoria Forense T29
DROP TRIGGER IF EXISTS trg_audit_intermittent_calls ON public.intermittent_calls;
CREATE TRIGGER trg_audit_intermittent_calls
    AFTER INSERT OR UPDATE OR DELETE ON public.intermittent_calls
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
