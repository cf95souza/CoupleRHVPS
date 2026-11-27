-- ==============================================================================
-- Migration 0019: Afastamentos eSocial (Tabela 18), FGTS Legal, DCTFWeb Maternidade & Perda Férias (FOLHA-04)
-- Sistema: coupleRH Enterprise v2.0 (PostgreSQL 17 Puro)
-- ==============================================================================

-- 1. Evolução de public.leaves (60d CID, Estabilidade 12m, Prorrogação Maternidade 180d, Dias Empresa)
ALTER TABLE public.leaves
    ADD COLUMN IF NOT EXISTS company_paid_days INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_same_cid_relapse BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS parent_leave_id UUID REFERENCES public.leaves(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS stability_until DATE,
    ADD COLUMN IF NOT EXISTS is_extended_maternity BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE INDEX IF NOT EXISTS idx_leaves_contract_dates
    ON public.leaves (tenant_id, contract_id, start_date, end_date);

-- 2. Evolução de public.payroll_company_taxes (Dedução automática DCTFWeb Salário-Maternidade / Salário-Família)
ALTER TABLE public.payroll_company_taxes
    ADD COLUMN IF NOT EXISTS maternity_deduction NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS family_salary_deduction NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS net_inss_due NUMERIC(15,2) NOT NULL DEFAULT 0.00;

-- 3. Evolução de public.vacation_periods (Perda de aquisitivo por >180d de benefício previdenciário - CLT art. 133 IV)
DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.vacation_periods'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%';

    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.vacation_periods DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.vacation_periods
    ADD CONSTRAINT vacation_periods_status_check
    CHECK (status IN ('DRAFT', 'OPEN', 'IN_PROGRESS', 'CLOSED', 'EXPIRED', 'FORFEITED'));

ALTER TABLE public.vacation_periods
    ADD COLUMN IF NOT EXISTS lost_by_leave BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS leave_days_in_acquisition INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS loss_reason TEXT;

-- 4. Rubricas oficiais de Afastamentos (Salário-Maternidade 104, Auxílio-Doença 15d 105, Base FGTS Afastamento 906)
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_base, calculation_order, factor, percentage, formula, incidencias
) VALUES
(
    'a0000000-0000-0000-0000-000000000104',
    '104', 'Salário-Maternidade (Dedutível DCTFWeb)', 'EARNING', 'MATERNITY', 'MATERNITY_LEAVE', 'ACTIVE', TRUE,
    'DIAS', 'SALARIO_BASE', 12, NULL, 100.0000, '(SALARIO_BASE / 30) * QUANTIDADE',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000105',
    '105', 'Atestado / Auxílio-Doença (Primeiros 15 Dias Empresa)', 'EARNING', 'SICK_LEAVE', 'SICK_LEAVE_COMPANY', 'ACTIVE', TRUE,
    'DIAS', 'SALARIO_BASE', 13, NULL, 100.0000, '(SALARIO_BASE / 30) * QUANTIDADE',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000906',
    '906', 'Base FGTS Afastamento Legal (Acidente Trabalho / Serviço Militar)', 'NEUTRAL', 'TAX', 'FGTS_COMPULSORY_BASE', 'ACTIVE', TRUE,
    'DIAS', 'SALARIO_BASE', 88, NULL, 100.0000, '(SALARIO_BASE / 30) * QUANTIDADE',
    '{"inss": false, "irrf": false, "fgts": true, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    calculation_form = EXCLUDED.calculation_form,
    calculation_base = EXCLUDED.calculation_base,
    calculation_order = EXCLUDED.calculation_order,
    percentage = EXCLUDED.percentage,
    formula = EXCLUDED.formula,
    incidencias = EXCLUDED.incidencias;

-- 5. Atualização de public.save_payroll_period para persistir deduções DCTFWeb em payroll_company_taxes
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

        INSERT INTO public.payslips (
            tenant_id, payroll_period_id, contract_id, worker_id,
            gross_salary, total_earnings, total_deductions, net_salary,
            base_inss, base_irrf, base_fgts, fgts_month,
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
