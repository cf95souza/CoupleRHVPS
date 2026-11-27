-- ==============================================================================
-- MIGRATION 0026: Férias Enterprise (CLT Art. 130, 134, 137 Dobro, Partidas, Coletivas)
-- FASE V6 — FOLHA-11
-- ==============================================================================

-- 1. Tabela de Lotes de Férias Coletivas (CLT Arts. 139–140)
CREATE TABLE IF NOT EXISTS public.collective_vacation_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days_count INT NOT NULL CHECK (days_count >= 1 AND days_count <= 30),
    notice_date DATE,
    status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('DRAFT', 'APPROVED', 'CALCULATED', 'PAID', 'CANCELLED')),
    notes TEXT,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_collective_vacation_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_collective_vacation_batches_tenant
    ON public.collective_vacation_batches (tenant_id, company_id, start_date DESC);

-- 2. Evolução de public.vacation_schedules
ALTER TABLE public.vacation_schedules
    ADD COLUMN IF NOT EXISTS is_collective BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS collective_batch_id UUID,
    ADD COLUMN IF NOT EXISTS double_vacation_days INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS averages_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS split_months_json JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS validation_warnings JSONB DEFAULT '[]'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_vacation_schedules_collective_batch'
    ) THEN
        ALTER TABLE public.vacation_schedules
            ADD CONSTRAINT fk_vacation_schedules_collective_batch
            FOREIGN KEY (collective_batch_id)
            REFERENCES public.collective_vacation_batches(id)
            ON DELETE SET NULL;
    END IF;
END $$;

-- 3. Rubricas Oficiais de Férias em Dobro (Indenizatória Art. 137) e Médias (Art. 142)
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias
) VALUES
(
    'a0000000-0000-0000-0000-000000000705',
    '705',
    'Férias em Dobro (Indenizatória - CLT Art. 137)',
    'EARNING',
    'VACATION',
    'VACATION',
    'ACTIVE',
    TRUE,
    'FIXO',
    49,
    50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000706',
    '706',
    '1/3 sobre Férias em Dobro (Indenizatória)',
    'EARNING',
    'VACATION',
    'VACATION',
    'ACTIVE',
    TRUE,
    'FIXO',
    50,
    50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000707',
    '707',
    'Médias de Variáveis sobre Férias',
    'EARNING',
    'VACATION',
    'VACATION',
    'ACTIVE',
    TRUE,
    'FIXO',
    44,
    50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    calculation_order = EXCLUDED.calculation_order,
    is_system = TRUE,
    incidencias = EXCLUDED.incidencias;

-- 4. RLS Estrita (ENABLE + FORCE ROW LEVEL SECURITY) em collective_vacation_batches
ALTER TABLE public.collective_vacation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collective_vacation_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS collective_vacation_batches_isolation_policy ON public.collective_vacation_batches;
CREATE POLICY collective_vacation_batches_isolation_policy ON public.collective_vacation_batches
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_vacations')
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.collective_vacation_batches TO couplerh_app;

-- 5. Auditoria Forense T29
DROP TRIGGER IF EXISTS trg_audit_collective_vacation_batches ON public.collective_vacation_batches;
CREATE TRIGGER trg_audit_collective_vacation_batches
    AFTER INSERT OR UPDATE OR DELETE ON public.collective_vacation_batches
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
