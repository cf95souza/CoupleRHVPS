-- ==============================================================================
-- MIGRATION 0023: Benefícios Enterprise (FOLHA-08)
-- - Teto Legal de Vale Transporte (Lei 7.418/85 e Decreto 10.854/2021)
-- - Planos de Saúde e Odonto com Registro ANS e Dependentes Vinculados
-- - Gestão de Coparticipação por Procedimento e Importação de Faturas CSV
-- - Rubricas Oficiais de Sistema de Benefícios (905, 907, 908, 909, 910, 911, 912)
-- ==============================================================================

-- 1. Rubricas Oficiais do Sistema para Benefícios Enterprise (Prioridade Legal 50)
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias
) VALUES 
(
    'a0000000-0000-0000-0000-000000000905',
    '905',
    'Desconto Vale Transporte (Lei 7.418/85)',
    'DEDUCTION',
    'BENEFIT',
    'BENEFIT',
    'ACTIVE',
    TRUE,
    'FORMULA',
    50,
    50,
    '{"rat": false, "fgts": false, "inss": false, "irrf": false, "terceiros": false, "integra_dsr": false, "inss_patronal": false, "gera_base_fgts": false, "gera_base_inss": false, "gera_base_irrf": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000907',
    '907',
    'Desconto Plano de Saúde (Titular)',
    'DEDUCTION',
    'BENEFIT',
    'HEALTH',
    'ACTIVE',
    TRUE,
    'MANUAL',
    50,
    50,
    '{"rat": false, "fgts": false, "inss": false, "irrf": false, "terceiros": false, "integra_dsr": false, "inss_patronal": false, "gera_base_fgts": false, "gera_base_inss": false, "gera_base_irrf": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000908',
    '908',
    'Desconto Plano de Saúde (Dependentes)',
    'DEDUCTION',
    'BENEFIT',
    'HEALTH',
    'ACTIVE',
    TRUE,
    'MANUAL',
    50,
    50,
    '{"rat": false, "fgts": false, "inss": false, "irrf": false, "terceiros": false, "integra_dsr": false, "inss_patronal": false, "gera_base_fgts": false, "gera_base_inss": false, "gera_base_irrf": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000909',
    '909',
    'Desconto Coparticipação Plano de Saúde',
    'DEDUCTION',
    'BENEFIT',
    'HEALTH',
    'ACTIVE',
    TRUE,
    'MANUAL',
    50,
    50,
    '{"rat": false, "fgts": false, "inss": false, "irrf": false, "terceiros": false, "integra_dsr": false, "inss_patronal": false, "gera_base_fgts": false, "gera_base_inss": false, "gera_base_irrf": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000910',
    '910',
    'Desconto Plano Odontológico',
    'DEDUCTION',
    'BENEFIT',
    'DENTAL',
    'ACTIVE',
    TRUE,
    'MANUAL',
    50,
    50,
    '{"rat": false, "fgts": false, "inss": false, "irrf": false, "terceiros": false, "integra_dsr": false, "inss_patronal": false, "gera_base_fgts": false, "gera_base_inss": false, "gera_base_irrf": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000911',
    '911',
    'Desconto Coparticipação Plano Odontológico',
    'DEDUCTION',
    'BENEFIT',
    'DENTAL',
    'ACTIVE',
    TRUE,
    'MANUAL',
    50,
    50,
    '{"rat": false, "fgts": false, "inss": false, "irrf": false, "terceiros": false, "integra_dsr": false, "inss_patronal": false, "gera_base_fgts": false, "gera_base_inss": false, "gera_base_irrf": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000912',
    '912',
    'Desconto Vale Refeição / Alimentação (PAT)',
    'DEDUCTION',
    'BENEFIT',
    'MEAL',
    'ACTIVE',
    TRUE,
    'MANUAL',
    50,
    50,
    '{"rat": false, "fgts": false, "inss": false, "irrf": false, "terceiros": false, "integra_dsr": false, "inss_patronal": false, "gera_base_fgts": false, "gera_base_inss": false, "gera_base_irrf": false}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    rubric_kind = EXCLUDED.rubric_kind,
    discount_priority = EXCLUDED.discount_priority,
    is_system = TRUE,
    incidencias = EXCLUDED.incidencias;

-- 2. Evolução de public.benefit_catalogs (ANS, CNPJ da Operadora e Regras Legais)
ALTER TABLE public.benefit_catalogs
    ADD COLUMN IF NOT EXISTS ans_code VARCHAR(20),
    ADD COLUMN IF NOT EXISTS provider_cnpj VARCHAR(14),
    ADD COLUMN IF NOT EXISTS discount_rule VARCHAR(30) NOT NULL DEFAULT 'STANDARD',
    ADD COLUMN IF NOT EXISTS pat_coverage BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'benefit_catalogs_rubric_id_fkey'
    ) THEN
        ALTER TABLE public.benefit_catalogs
            ADD CONSTRAINT benefit_catalogs_rubric_id_fkey
            FOREIGN KEY (rubric_id) REFERENCES public.rubrics(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 3. Evolução de public.employee_benefits (Configurações de VT, Home Office e Custos)
ALTER TABLE public.employee_benefits
    ADD COLUMN IF NOT EXISTS opt_in BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS work_regime VARCHAR(20) NOT NULL DEFAULT 'PRESENTIAL',
    ADD COLUMN IF NOT EXISTS weekly_remote_days INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS daily_passes INT NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS pass_unit_value NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS conceded_benefit_value NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS holder_monthly_cost NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS holder_discount_value NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS company_subsidy_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS notes TEXT;

-- 4. Tabela de Dependentes Vinculados ao Benefício (Plano de Saúde e Odonto com ANS)
CREATE TABLE IF NOT EXISTS public.employee_benefit_dependents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    employee_benefit_id UUID NOT NULL REFERENCES public.employee_benefits(id) ON DELETE CASCADE,
    dependent_id UUID REFERENCES public.dependents(id) ON DELETE SET NULL,
    dependent_name TEXT NOT NULL,
    dependent_cpf VARCHAR(11),
    relationship TEXT NOT NULL DEFAULT 'OTHER',
    birth_date DATE,
    monthly_cost NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (monthly_cost >= 0),
    employee_discount NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (employee_discount >= 0),
    company_subsidy NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (company_subsidy >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_benefit_dependents_tenant_benefit
    ON public.employee_benefit_dependents (tenant_id, employee_benefit_id)
    WHERE deleted_at IS NULL AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_benefit_dependents_dependent_id
    ON public.employee_benefit_dependents (tenant_id, dependent_id)
    WHERE deleted_at IS NULL;

-- 5. Lotes de Importação CSV de Faturas e Coparticipação
CREATE TABLE IF NOT EXISTS public.benefit_import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    benefit_type VARCHAR(50) NOT NULL CHECK (benefit_type IN ('HEALTH_PLAN', 'DENTAL_PLAN', 'OTHER')),
    filename TEXT NOT NULL,
    total_rows INT NOT NULL DEFAULT 0,
    processed_rows INT NOT NULL DEFAULT 0,
    error_count INT NOT NULL DEFAULT 0,
    total_copay_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    imported_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_benefit_import_batches_period
    ON public.benefit_import_batches (tenant_id, payroll_period_id);

-- 6. Tabela de Coparticipações Detalhadas (Faturas de Operadoras de Saúde/Odonto)
CREATE TABLE IF NOT EXISTS public.benefit_copayments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    employee_benefit_id UUID REFERENCES public.employee_benefits(id) ON DELETE SET NULL,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    benefit_type VARCHAR(50) NOT NULL DEFAULT 'HEALTH_PLAN' CHECK (benefit_type IN ('HEALTH_PLAN', 'DENTAL_PLAN', 'OTHER')),
    competence_year INT NOT NULL,
    competence_month INT NOT NULL CHECK (competence_month BETWEEN 1 AND 13),
    invoice_number TEXT,
    procedure_date DATE NOT NULL,
    patient_type VARCHAR(20) NOT NULL DEFAULT 'HOLDER' CHECK (patient_type IN ('HOLDER', 'DEPENDENT')),
    patient_name TEXT NOT NULL,
    patient_cpf VARCHAR(11),
    procedure_code TEXT,
    procedure_description TEXT NOT NULL,
    event_cost NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    copay_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (copay_amount >= 0),
    import_batch_id UUID REFERENCES public.benefit_import_batches(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DEDUCTED', 'CANCELLED')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_benefit_copayments_period_contract
    ON public.benefit_copayments (tenant_id, payroll_period_id, contract_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_benefit_copayments_batch
    ON public.benefit_copayments (tenant_id, import_batch_id)
    WHERE deleted_at IS NULL;

-- 7. RLS Estrita (ENABLE + FORCE ROW LEVEL SECURITY)
ALTER TABLE public.employee_benefit_dependents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_benefit_dependents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_benefit_dependents_isolation_policy ON public.employee_benefit_dependents;
CREATE POLICY employee_benefit_dependents_isolation_policy ON public.employee_benefit_dependents
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    );

ALTER TABLE public.benefit_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.benefit_import_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS benefit_import_batches_isolation_policy ON public.benefit_import_batches;
CREATE POLICY benefit_import_batches_isolation_policy ON public.benefit_import_batches
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    );

ALTER TABLE public.benefit_copayments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.benefit_copayments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS benefit_copayments_isolation_policy ON public.benefit_copayments;
CREATE POLICY benefit_copayments_isolation_policy ON public.benefit_copayments
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        OR public.current_app_user_id() IS NULL
    );

-- 8. Triggers de Auditoria Forense T29
DROP TRIGGER IF EXISTS trg_audit_employee_benefit_dependents ON public.employee_benefit_dependents;
CREATE TRIGGER trg_audit_employee_benefit_dependents
    AFTER INSERT OR UPDATE OR DELETE ON public.employee_benefit_dependents
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_benefit_import_batches ON public.benefit_import_batches;
CREATE TRIGGER trg_audit_benefit_import_batches
    AFTER INSERT OR UPDATE OR DELETE ON public.benefit_import_batches
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_benefit_copayments ON public.benefit_copayments;
CREATE TRIGGER trg_audit_benefit_copayments
    AFTER INSERT OR UPDATE OR DELETE ON public.benefit_copayments
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

-- 9. Concessão de Permissões à Role da Aplicação (couplerh_app)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_benefit_dependents TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.benefit_import_batches TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.benefit_copayments TO couplerh_app;
GRANT SELECT, UPDATE ON public.benefit_catalogs TO couplerh_app;
GRANT SELECT, UPDATE ON public.employee_benefits TO couplerh_app;
