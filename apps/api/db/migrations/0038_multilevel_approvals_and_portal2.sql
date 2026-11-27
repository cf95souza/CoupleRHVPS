-- ==============================================================================
-- MIGRATION 0038: Workflow Multinível de Aprovações (Gestor -> DP) & Portal 2.0
-- FASE V8 — PONTO-05 e PONTO-06
-- ==============================================================================

-- 1. Evolução de public.time_punch_adjustments para atestados, folgas de banco e fluxo 2 etapas
ALTER TABLE public.time_punch_adjustments
    ADD COLUMN IF NOT EXISTS end_date DATE,
    ADD COLUMN IF NOT EXISTS requested_minutes INT,
    ADD COLUMN IF NOT EXISTS cid10_code TEXT,
    ADD COLUMN IF NOT EXISTS doctor_crm TEXT,
    ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS manager_decided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS manager_notes TEXT,
    ADD COLUMN IF NOT EXISTS dp_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS dp_decided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dp_notes TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.time_punch_adjustments'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%adjustment_type%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.time_punch_adjustments DROP CONSTRAINT %I;', v_conname);
    END IF;

    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.time_punch_adjustments'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.time_punch_adjustments DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.time_punch_adjustments
    ADD CONSTRAINT time_punch_adjustments_type_check
    CHECK (adjustment_type IN (
        'INSERT_PUNCH',
        'JUSTIFY_ABSENCE',
        'FORGIVE_DELAY',
        'OVERTIME_AUTHORIZATION',
        'MEDICAL_CERTIFICATE',
        'TIME_BANK_DAY_OFF',
        'WORK_SCHEDULE_CHANGE'
    )),
    ADD CONSTRAINT time_punch_adjustments_status_check
    CHECK (status IN (
        'PENDING',
        'PENDING_MANAGER',
        'APPROVED_MANAGER',
        'REJECTED_MANAGER',
        'APPROVED_DP',
        'REJECTED_DP',
        'APPROVED',
        'REJECTED'
    ));

ALTER TABLE public.time_punch_adjustments
    ALTER COLUMN status SET DEFAULT 'PENDING_MANAGER';

-- RLS estrita em time_punch_adjustments (Colaborador + Gestor por can_access_contract + DP)
DROP POLICY IF EXISTS tenant_isolation_policy ON public.time_punch_adjustments;
DROP POLICY IF EXISTS time_punch_adjustments_select_policy ON public.time_punch_adjustments;
DROP POLICY IF EXISTS time_punch_adjustments_insert_policy ON public.time_punch_adjustments;
DROP POLICY IF EXISTS time_punch_adjustments_update_policy ON public.time_punch_adjustments;
DROP POLICY IF EXISTS time_punch_adjustments_delete_policy ON public.time_punch_adjustments;

CREATE POLICY time_punch_adjustments_select_policy ON public.time_punch_adjustments
    FOR SELECT
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'view_time_tracking')
                    OR public.has_permission(tenant_id, 'manage_time_tracking')
                    OR public.has_permission(tenant_id, 'approve_team_requests')
                )
            )
            OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = time_punch_adjustments.contract_id) = public.current_app_worker_id()
        )
    );

CREATE POLICY time_punch_adjustments_insert_policy ON public.time_punch_adjustments
    FOR INSERT
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_time_tracking')
            OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = time_punch_adjustments.contract_id) = public.current_app_worker_id()
        )
    );

CREATE POLICY time_punch_adjustments_update_policy ON public.time_punch_adjustments
    FOR UPDATE
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'manage_time_tracking')
                    OR public.has_permission(tenant_id, 'approve_team_requests')
                )
            )
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'manage_time_tracking')
                    OR public.has_permission(tenant_id, 'approve_team_requests')
                )
            )
        )
    );

CREATE POLICY time_punch_adjustments_delete_policy ON public.time_punch_adjustments
    FOR DELETE
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_time_tracking')
        )
    );

-- 2. Evolução de public.vacation_schedules para fluxo Gestor -> DP e autoatendimento
ALTER TABLE public.vacation_schedules
    ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS manager_decided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS manager_notes TEXT;

DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.vacation_schedules'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.vacation_schedules DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.vacation_schedules
    ADD CONSTRAINT vacation_schedules_status_check
    CHECK (status IN (
        'REQUESTED',
        'PENDING_MANAGER',
        'APPROVED_MANAGER',
        'REJECTED_MANAGER',
        'APPROVED',
        'CALCULATED',
        'PAID',
        'CANCELLED'
    ));

-- Atualiza policies de vacation_schedules para incluir colaborador (INSERT) e gestor (SELECT/UPDATE via approve_team_requests + can_access_contract)
DROP POLICY IF EXISTS vacation_schedules_select_policy ON public.vacation_schedules;
CREATE POLICY vacation_schedules_select_policy ON public.vacation_schedules
    FOR SELECT
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'manage_vacations')
                    OR public.has_permission(tenant_id, 'approve_team_requests')
                    OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = vacation_schedules.contract_id) = public.current_app_worker_id()
                )
            )
        )
    );

DROP POLICY IF EXISTS vacation_schedules_insert_policy ON public.vacation_schedules;
CREATE POLICY vacation_schedules_insert_policy ON public.vacation_schedules
    FOR INSERT
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
            OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = vacation_schedules.contract_id) = public.current_app_worker_id()
        )
    );

DROP POLICY IF EXISTS vacation_schedules_update_policy ON public.vacation_schedules;
CREATE POLICY vacation_schedules_update_policy ON public.vacation_schedules
    FOR UPDATE
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'manage_vacations')
                    OR public.has_permission(tenant_id, 'approve_team_requests')
                )
            )
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'manage_vacations')
                    OR public.has_permission(tenant_id, 'approve_team_requests')
                )
            )
        )
    );

-- 3. Controle de Aceite/Contestação do Espelho de Ponto Mensal pelo Colaborador
CREATE TABLE IF NOT EXISTS public.timesheet_closures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    year INT NOT NULL CHECK (year >= 2000 AND year <= 2100),
    month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SIGNED_EMPLOYEE', 'CONTESTED', 'CLOSED_DP')),
    employee_signed_at TIMESTAMPTZ,
    employee_signature_hash TEXT,
    contest_reason TEXT,
    contest_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_timesheet_closures_contract_month UNIQUE (tenant_id, contract_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_timesheet_closures_lookup
    ON public.timesheet_closures (tenant_id, contract_id, year DESC, month DESC);

ALTER TABLE public.timesheet_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_closures FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS timesheet_closures_isolation_policy ON public.timesheet_closures;
CREATE POLICY timesheet_closures_isolation_policy ON public.timesheet_closures
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'view_time_tracking')
                    OR public.has_permission(tenant_id, 'manage_time_tracking')
                )
            )
            OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = timesheet_closures.contract_id) = public.current_app_worker_id()
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_time_tracking')
            OR public.has_permission(tenant_id, 'close_time_period')
            OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = timesheet_closures.contract_id) = public.current_app_worker_id()
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.timesheet_closures TO couplerh_app;

DROP TRIGGER IF EXISTS trg_audit_timesheet_closures ON public.timesheet_closures;
CREATE TRIGGER trg_audit_timesheet_closures
    AFTER INSERT OR UPDATE OR DELETE ON public.timesheet_closures
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
