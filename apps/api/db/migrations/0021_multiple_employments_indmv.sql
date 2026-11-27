-- ==============================================================================
-- Migration 0021: Múltiplos Vínculos Previdenciários (INSS Outro Empregador — indMV 1/2/3) — FOLHA-06
-- Sistema: coupleRH Enterprise v2.0 (PostgreSQL 17 Puro)
-- ==============================================================================

-- 1. Cadastro Estruturado de Vínculos Externos (eSocial S-1200 infoMV / remunOutrEmpr)
CREATE TABLE IF NOT EXISTS public.employee_other_employments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    contract_id UUID REFERENCES public.contracts(id) ON DELETE CASCADE,
    employer_cnpj VARCHAR(14) NOT NULL,
    employer_name TEXT NOT NULL,
    esocial_category_code VARCHAR(10) NOT NULL DEFAULT '101',
    ind_mv SMALLINT NOT NULL CHECK (ind_mv IN (1, 2, 3)),
    competence_year INT NOT NULL,
    competence_month INT NOT NULL CHECK (competence_month BETWEEN 1 AND 13),
    remuneration_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (remuneration_amount >= 0),
    inss_withheld NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (inss_withheld >= 0),
    is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_other_employments_worker_comp
    ON public.employee_other_employments (tenant_id, worker_id, competence_year, competence_month)
    WHERE deleted_at IS NULL AND is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_other_employments_unique_cnpj_comp
    ON public.employee_other_employments (tenant_id, worker_id, employer_cnpj, competence_year, competence_month)
    WHERE deleted_at IS NULL;

-- 2. Rastreabilidade de Múltiplos Vínculos (indMV) nos Holerites (S-1200 infoMV)
ALTER TABLE public.payslips
    ADD COLUMN IF NOT EXISTS ind_mv SMALLINT CHECK (ind_mv IN (1, 2, 3) OR ind_mv IS NULL),
    ADD COLUMN IF NOT EXISTS other_employments_base NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS other_employments_inss NUMERIC(15,2) NOT NULL DEFAULT 0.00;

-- 3. RLS Obrigatória (ENABLE + FORCE ROW LEVEL SECURITY) em employee_other_employments
ALTER TABLE public.employee_other_employments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_other_employments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_other_employments_select_policy ON public.employee_other_employments;
DROP POLICY IF EXISTS employee_other_employments_manage_policy ON public.employee_other_employments;

CREATE POLICY employee_other_employments_select_policy ON public.employee_other_employments
    FOR SELECT
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_employees')
            OR public.has_permission(tenant_id, 'calculate_payroll')
            OR public.has_permission(tenant_id, 'view_payslips')
            OR worker_id = public.current_app_worker_id()
        )
        AND (
            public.current_app_user_id() IS NULL
            OR contract_id IS NULL
            OR public.can_access_contract(tenant_id, contract_id)
            OR worker_id = public.current_app_worker_id()
        )
    );

CREATE POLICY employee_other_employments_manage_policy ON public.employee_other_employments
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_employees')
        )
        AND (
            public.current_app_user_id() IS NULL
            OR contract_id IS NULL
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
            OR contract_id IS NULL
            OR public.can_access_contract(tenant_id, contract_id)
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_other_employments TO couplerh_app;

-- 4. Auditoria Forense T29
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers
        WHERE trigger_name = 'audit_employee_other_employments_trigger'
          AND event_object_table = 'employee_other_employments'
    ) THEN
        CREATE TRIGGER audit_employee_other_employments_trigger
            AFTER INSERT OR UPDATE OR DELETE ON public.employee_other_employments
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;
END $$;

-- 5. Atualização da RPC public.save_payroll_period para gravar metadados de indMV nos holerites
CREATE OR REPLACE FUNCTION public.save_payroll_period(p_period_id UUID, p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tenant_id UUID := public.current_app_tenant_id();
    v_user_id UUID := public.current_app_user_id();
    v_period RECORD;
    v_contract_filter UUID;
    v_slip JSONB;
    v_item JSONB;
    v_mem JSONB;
    v_tax JSONB;
    v_payslip_id UUID;
    v_worker_id UUID;
    v_rubric_code TEXT;
    v_rubric_name TEXT;
    v_item_type TEXT;
    v_ref_num NUMERIC(10,4);
    v_ind_mv SMALLINT;
    v_saved_count INT := 0;
    v_total_earnings NUMERIC(15,2) := 0.00;
    v_total_deductions NUMERIC(15,2) := 0.00;
    v_total_net NUMERIC(15,2) := 0.00;
    v_period_legal_version UUID;
BEGIN
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Acesso nao autorizado: tenant nao configurado na sessao.' USING ERRCODE = '42501';
    END IF;

    IF v_user_id IS NOT NULL AND NOT public.has_permission(v_tenant_id, 'calculate_payroll') THEN
        RAISE EXCEPTION 'Acesso negado: usuario sem permissao calculate_payroll.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_period
    FROM public.payroll_periods
    WHERE id = p_period_id AND tenant_id = v_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Periodo de folha % nao encontrado para o tenant ativo.', p_period_id USING ERRCODE = 'P0002';
    END IF;

    IF v_period.status = 'CLOSED' THEN
        RAISE EXCEPTION 'Operacao Proibida: A folha de pagamento % esta FECHADA e nao pode ser recalculada.', p_period_id;
    END IF;

    v_contract_filter := NULLIF(p_payload->>'contract_id_filter', '')::uuid;

    IF v_contract_filter IS NULL THEN
        DELETE FROM public.payslips
        WHERE payroll_period_id = p_period_id
          AND tenant_id = v_tenant_id
          AND contract_id NOT IN (
              SELECT (s->>'contract_id')::uuid
              FROM jsonb_array_elements(COALESCE(p_payload->'payslips', '[]'::jsonb)) AS s
          );
    END IF;

    FOR v_slip IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'payslips', '[]'::jsonb))
    LOOP
        SELECT worker_id INTO v_worker_id
        FROM public.contracts
        WHERE id = (v_slip->>'contract_id')::uuid
          AND tenant_id = v_tenant_id;

        IF v_worker_id IS NULL THEN
            RAISE EXCEPTION 'Contrato % nao encontrado no tenant.', v_slip->>'contract_id';
        END IF;

        IF v_period_legal_version IS NULL AND NULLIF(v_slip->>'legal_version_id', '') IS NOT NULL THEN
            v_period_legal_version := (v_slip->>'legal_version_id')::uuid;
        END IF;

        v_ind_mv := NULLIF(v_slip->>'ind_mv', '')::smallint;

        INSERT INTO public.payslips (
            tenant_id, payroll_period_id, contract_id, worker_id,
            gross_salary, total_earnings, total_deductions, net_salary,
            base_inss, base_irrf, base_fgts, fgts_month,
            ind_mv, other_employments_base, other_employments_inss,
            status, legal_version_id, engine_version, version
        ) VALUES (
            v_tenant_id, p_period_id, (v_slip->>'contract_id')::uuid, v_worker_id,
            COALESCE((v_slip->>'total_earnings')::numeric, 0),
            COALESCE((v_slip->>'total_earnings')::numeric, 0),
            COALESCE((v_slip->>'total_deductions')::numeric, 0),
            COALESCE((v_slip->>'net_salary')::numeric, 0),
            COALESCE((v_slip->>'base_inss')::numeric, 0),
            COALESCE((v_slip->>'base_irrf')::numeric, 0),
            COALESCE((v_slip->>'base_fgts')::numeric, 0),
            COALESCE((v_slip->>'fgts_month')::numeric, 0),
            v_ind_mv,
            COALESCE((v_slip->>'other_employments_base')::numeric, 0),
            COALESCE((v_slip->>'other_employments_inss')::numeric, 0),
            CASE
                WHEN (v_slip->>'status') IN ('DRAFT', 'CALCULATED', 'APPROVED', 'LOCKED') THEN v_slip->>'status'
                ELSE 'CALCULATED'
            END,
            NULLIF(v_slip->>'legal_version_id', '')::uuid,
            COALESCE(NULLIF(v_slip->>'engine_version', ''), '2.2.0'),
            1
        )
        ON CONFLICT (payroll_period_id, contract_id) DO UPDATE SET
            gross_salary = EXCLUDED.gross_salary,
            total_earnings = EXCLUDED.total_earnings,
            total_deductions = EXCLUDED.total_deductions,
            net_salary = EXCLUDED.net_salary,
            base_inss = EXCLUDED.base_inss,
            base_irrf = EXCLUDED.base_irrf,
            base_fgts = EXCLUDED.base_fgts,
            fgts_month = EXCLUDED.fgts_month,
            ind_mv = EXCLUDED.ind_mv,
            other_employments_base = EXCLUDED.other_employments_base,
            other_employments_inss = EXCLUDED.other_employments_inss,
            status = EXCLUDED.status,
            legal_version_id = COALESCE(EXCLUDED.legal_version_id, public.payslips.legal_version_id),
            engine_version = EXCLUDED.engine_version,
            version = public.payslips.version + 1,
            updated_at = NOW()
        RETURNING id INTO v_payslip_id;

        DELETE FROM public.payslip_items WHERE payslip_id = v_payslip_id;

        FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_slip->'items', '[]'::jsonb))
        LOOP
            SELECT code, name, type INTO v_rubric_code, v_rubric_name, v_item_type
            FROM public.rubrics
            WHERE id = (v_item->>'rubric_id')::uuid;

            v_item_type := COALESCE(NULLIF(v_item->>'type', ''), v_item_type, 'EARNING');
            IF v_item_type = 'BASE' THEN
                v_item_type := 'NEUTRAL';
            END IF;

            BEGIN
                v_ref_num := NULLIF(regexp_replace(COALESCE(v_item->>'reference', ''), '[^0-9.\-]', '', 'g'), '')::numeric;
            EXCEPTION WHEN OTHERS THEN
                v_ref_num := NULL;
            END;

            INSERT INTO public.payslip_items (
                tenant_id, payslip_id, rubric_id, rubric_version_id,
                rubric_code, rubric_name, type, reference, amount
            ) VALUES (
                v_tenant_id, v_payslip_id, (v_item->>'rubric_id')::uuid,
                COALESCE(NULLIF(v_item->>'rubric_version_id', '')::uuid, (v_item->>'rubric_id')::uuid),
                COALESCE(v_rubric_code, '000'),
                COALESCE(v_rubric_name, 'Rubrica'),
                v_item_type, v_ref_num, COALESCE((v_item->>'amount')::numeric, 0)
            );
        END LOOP;

        DELETE FROM public.payroll_memory_calc WHERE payslip_id = v_payslip_id;

        FOR v_mem IN SELECT * FROM jsonb_array_elements(COALESCE(v_slip->'memory', '[]'::jsonb))
        LOOP
            INSERT INTO public.payroll_memory_calc (
                tenant_id, payslip_id, rubric_id, step_name,
                base_value, quantity_used, percentage_used,
                parsed_formula, result_value, origin, engine_version
            ) VALUES (
                v_tenant_id, v_payslip_id, NULLIF(v_mem->>'rubric_id', '')::uuid,
                COALESCE(v_mem->>'step_name', 'Etapa'),
                COALESCE((v_mem->>'base_value')::numeric, 0),
                COALESCE((v_mem->>'quantity_used')::numeric, 0),
                COALESCE((v_mem->>'percentage_used')::numeric, 0),
                COALESCE(v_mem->>'parsed_formula', ''),
                COALESCE((v_mem->>'result_value')::numeric, 0),
                COALESCE(v_mem->>'origin', 'ENGINE'),
                COALESCE(NULLIF(v_mem->>'engine_version', ''), '2.2.0')
            );
        END LOOP;

        v_saved_count := v_saved_count + 1;
    END LOOP;

    DELETE FROM public.payroll_company_taxes
    WHERE payroll_period_id = p_period_id AND tenant_id = v_tenant_id;

    FOR v_tax IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'company_taxes', '[]'::jsonb))
    LOOP
        INSERT INTO public.payroll_company_taxes (
            tenant_id, payroll_period_id, company_id,
            total_base_inss, total_base_fgts,
            inss_patronal, rat_amount, other_entities_amount,
            fgts_total, maternity_deduction, family_salary_deduction,
            net_inss_due, total_cost
        ) VALUES (
            v_tenant_id, p_period_id, (v_tax->>'company_id')::uuid,
            COALESCE((v_tax->>'total_base_inss')::numeric, 0),
            COALESCE((v_tax->>'total_base_fgts')::numeric, 0),
            COALESCE((v_tax->>'inss_patronal')::numeric, 0),
            COALESCE((v_tax->>'rat_adjusted')::numeric, 0),
            COALESCE((v_tax->>'terceiros')::numeric, 0),
            COALESCE((v_tax->>'fgts_patronal')::numeric, 0),
            COALESCE((v_tax->>'maternity_deduction')::numeric, 0),
            COALESCE((v_tax->>'family_salary_deduction')::numeric, 0),
            COALESCE((v_tax->>'net_inss_due')::numeric, 0),
            COALESCE((v_tax->>'total_taxes')::numeric, 0)
        );
    END LOOP;

    SELECT
        COALESCE(SUM(total_earnings), 0),
        COALESCE(SUM(total_deductions), 0),
        COALESCE(SUM(net_salary), 0)
    INTO v_total_earnings, v_total_deductions, v_total_net
    FROM public.payslips
    WHERE payroll_period_id = p_period_id AND tenant_id = v_tenant_id;

    UPDATE public.payroll_periods SET
        status = 'CALCULATED',
        legal_version_id = COALESCE(v_period_legal_version, legal_version_id),
        total_earnings = v_total_earnings,
        total_deductions = v_total_deductions,
        total_net = v_total_net,
        current_version = current_version + 1,
        updated_at = NOW()
    WHERE id = p_period_id;

    RETURN jsonb_build_object(
        'success', true,
        'period_id', p_period_id,
        'saved_payslips', v_saved_count,
        'total_earnings', v_total_earnings,
        'total_deductions', v_total_deductions,
        'total_net', v_total_net
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_payroll_period(UUID, JSONB) TO couplerh_app;
