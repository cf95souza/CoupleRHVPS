-- ==============================================================================
-- Migration 0015: Worker Assíncrono em Lotes, Simulação What-If & Watchdog Anti-Deadlock (FOLHA-01)
-- Sistema: coupleRH Enterprise v2.0 (PostgreSQL 17 Puro)
-- ==============================================================================

-- 1. Schema dedicado para pg-boss sob a role couplerh_app (NOBYPASSRLS)
CREATE SCHEMA IF NOT EXISTS pgboss;
GRANT USAGE, CREATE ON SCHEMA pgboss TO couplerh_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES TO couplerh_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO couplerh_app;

-- 2. Colunas de trava e heartbeat em public.payroll_periods
ALTER TABLE public.payroll_periods
    ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

-- 3. Tabela oficial de Jobs de Processamento em Lotes e Simulações What-If
CREATE TABLE IF NOT EXISTS public.payroll_calculation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'REAL' CHECK (mode IN ('REAL', 'SIMULATION')),
    scenario_params JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    total_contracts INT NOT NULL DEFAULT 0,
    processed_contracts INT NOT NULL DEFAULT 0,
    error_count INT NOT NULL DEFAULT 0,
    errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    contract_id_filter UUID REFERENCES public.contracts(id) ON DELETE SET NULL,
    restore_period_status TEXT DEFAULT 'DRAFT',
    locked_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices operacionais de consulta, watchdog e exclusividade de execução REAL
CREATE INDEX IF NOT EXISTS idx_payroll_calc_jobs_tenant_period
    ON public.payroll_calculation_jobs (tenant_id, period_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payroll_calc_jobs_active
    ON public.payroll_calculation_jobs (status, heartbeat_at)
    WHERE status IN ('QUEUED', 'RUNNING');

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_calc_jobs_unique_active_real
    ON public.payroll_calculation_jobs (period_id)
    WHERE mode = 'REAL' AND status IN ('QUEUED', 'RUNNING');

-- 4. Habilitação estrita de RLS + FORCE ROW LEVEL SECURITY
ALTER TABLE public.payroll_calculation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_calculation_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_calc_jobs_select_policy ON public.payroll_calculation_jobs;
DROP POLICY IF EXISTS payroll_calc_jobs_insert_policy ON public.payroll_calculation_jobs;
DROP POLICY IF EXISTS payroll_calc_jobs_update_policy ON public.payroll_calculation_jobs;
DROP POLICY IF EXISTS payroll_calc_jobs_delete_policy ON public.payroll_calculation_jobs;

CREATE POLICY payroll_calc_jobs_select_policy ON public.payroll_calculation_jobs
    FOR SELECT
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
            OR public.has_permission(tenant_id, 'view_payslips')
        )
    );

CREATE POLICY payroll_calc_jobs_insert_policy ON public.payroll_calculation_jobs
    FOR INSERT
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

CREATE POLICY payroll_calc_jobs_update_policy ON public.payroll_calculation_jobs
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

CREATE POLICY payroll_calc_jobs_delete_policy ON public.payroll_calculation_jobs
    FOR DELETE
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_calculation_jobs TO couplerh_app;

-- 5. Trigger de Auditoria Forense T29
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers
        WHERE trigger_name = 'audit_payroll_calculation_jobs_trigger'
          AND event_object_table = 'payroll_calculation_jobs'
    ) THEN
        CREATE TRIGGER audit_payroll_calculation_jobs_trigger
            AFTER INSERT OR UPDATE OR DELETE ON public.payroll_calculation_jobs
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;
END $$;

-- 6. Função Watchdog Anti-Deadlock (executa via pg-boss a cada 2 minutos)
CREATE OR REPLACE FUNCTION public.recover_stuck_payroll_calculations(
    p_stale_minutes INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job RECORD;
    v_period RECORD;
    v_recovered_jobs JSONB := '[]'::jsonb;
    v_recovered_periods JSONB := '[]'::jsonb;
    v_restore_status TEXT;
    v_has_payslips BOOLEAN;
BEGIN
    -- 6.1 Recupera jobs em QUEUED ou RUNNING com heartbeat/trava expirados
    FOR v_job IN
        SELECT id, tenant_id, company_id, period_id, mode, status, restore_period_status,
               COALESCE(heartbeat_at, locked_at, updated_at) AS last_pulse
        FROM public.payroll_calculation_jobs
        WHERE status IN ('QUEUED', 'RUNNING')
          AND COALESCE(heartbeat_at, locked_at, updated_at) < NOW() - make_interval(mins => p_stale_minutes)
        FOR UPDATE
    LOOP
        UPDATE public.payroll_calculation_jobs
        SET status = 'FAILED',
            finished_at = NOW(),
            updated_at = NOW(),
            error_count = GREATEST(error_count, 1),
            errors_json = COALESCE(errors_json, '[]'::jsonb) || jsonb_build_array(
                jsonb_build_object(
                    'code', 'WATCHDOG_TIMEOUT',
                    'error', 'Watchdog: processamento interrompido por inatividade (heartbeat expirado).'
                )
            )
        WHERE id = v_job.id;

        v_recovered_jobs := v_recovered_jobs || jsonb_build_array(
            jsonb_build_object(
                'job_id', v_job.id,
                'tenant_id', v_job.tenant_id,
                'company_id', v_job.company_id,
                'period_id', v_job.period_id,
                'mode', v_job.mode,
                'previous_status', v_job.status,
                'last_pulse', v_job.last_pulse
            )
        );

        IF v_job.mode = 'REAL' THEN
            v_restore_status := COALESCE(NULLIF(v_job.restore_period_status, ''), 'DRAFT');
            UPDATE public.payroll_periods
            SET status = v_restore_status,
                locked_at = NULL,
                heartbeat_at = NULL,
                updated_at = NOW()
            WHERE id = v_job.period_id
              AND status = 'CALCULATING';

            IF FOUND THEN
                v_recovered_periods := v_recovered_periods || jsonb_build_array(
                    jsonb_build_object(
                        'period_id', v_job.period_id,
                        'tenant_id', v_job.tenant_id,
                        'restored_status', v_restore_status,
                        'reason', 'JOB_HEARTBEAT_TIMEOUT'
                    )
                );
            END IF;
        END IF;
    END LOOP;

    -- 6.2 Recupera períodos órfãos presos em CALCULATING sem job REAL ativo recente
    FOR v_period IN
        SELECT pp.id, pp.tenant_id, pp.company_id,
               COALESCE(pp.heartbeat_at, pp.locked_at, pp.updated_at) AS last_pulse
        FROM public.payroll_periods pp
        WHERE pp.status = 'CALCULATING'
          AND COALESCE(pp.heartbeat_at, pp.locked_at, pp.updated_at) < NOW() - make_interval(mins => p_stale_minutes)
          AND NOT EXISTS (
              SELECT 1
              FROM public.payroll_calculation_jobs j
              WHERE j.period_id = pp.id
                AND j.mode = 'REAL'
                AND j.status IN ('QUEUED', 'RUNNING')
                AND COALESCE(j.heartbeat_at, j.locked_at, j.updated_at) >= NOW() - make_interval(mins => p_stale_minutes)
          )
        FOR UPDATE
    LOOP
        SELECT EXISTS(
            SELECT 1 FROM public.payslips ps WHERE ps.payroll_period_id = v_period.id
        ) INTO v_has_payslips;

        v_restore_status := CASE WHEN v_has_payslips THEN 'CALCULATED' ELSE 'DRAFT' END;

        UPDATE public.payroll_periods
        SET status = v_restore_status,
            locked_at = NULL,
            heartbeat_at = NULL,
            updated_at = NOW()
        WHERE id = v_period.id;

        v_recovered_periods := v_recovered_periods || jsonb_build_array(
            jsonb_build_object(
                'period_id', v_period.id,
                'tenant_id', v_period.tenant_id,
                'restored_status', v_restore_status,
                'reason', 'ORPHAN_CALCULATING_LOCK',
                'last_pulse', v_period.last_pulse
            )
        );
    END LOOP;

    RETURN jsonb_build_object(
        'recovered_jobs', v_recovered_jobs,
        'recovered_periods', v_recovered_periods
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.recover_stuck_payroll_calculations(INT) TO couplerh_app;

-- 7. Função defensiva para destravamento imediato em falha catastrófica do worker
CREATE OR REPLACE FUNCTION public.worker_fail_payroll_job(
    p_job_id UUID,
    p_error TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job RECORD;
    v_restore_status TEXT;
BEGIN
    SELECT id, period_id, mode, restore_period_status
    INTO v_job
    FROM public.payroll_calculation_jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    UPDATE public.payroll_calculation_jobs
    SET status = 'FAILED',
        finished_at = NOW(),
        updated_at = NOW(),
        error_count = GREATEST(error_count, 1),
        errors_json = COALESCE(errors_json, '[]'::jsonb) || jsonb_build_array(
            jsonb_build_object(
                'code', 'WORKER_FATAL_ERROR',
                'error', COALESCE(p_error, 'Erro inesperado no worker de cálculo.')
            )
        )
    WHERE id = p_job_id;

    IF v_job.mode = 'REAL' THEN
        v_restore_status := COALESCE(NULLIF(v_job.restore_period_status, ''), 'DRAFT');
        UPDATE public.payroll_periods
        SET status = v_restore_status,
            locked_at = NULL,
            heartbeat_at = NULL,
            updated_at = NOW()
        WHERE id = v_job.period_id
          AND status = 'CALCULATING';
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_fail_payroll_job(UUID, TEXT) TO couplerh_app;
