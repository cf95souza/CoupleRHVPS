-- =============================================================================
-- Migration 0014: Saneamento do Motor de Cálculo, Versões, Feriados & Persistência Atômica (FASE V4)
-- Sistema: coupleRH Enterprise v2.0 (PostgreSQL 17 Puro)
-- =============================================================================

-- 1. Evolução de public.payroll_periods (status estendido, período pai e versão)
DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.payroll_periods'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%';

    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.payroll_periods DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.payroll_periods
    ADD CONSTRAINT payroll_periods_status_check
    CHECK (status IN ('DRAFT', 'OPEN', 'CALCULATING', 'CALCULATED', 'CONFERENCE', 'APPROVED', 'CLOSED', 'REOPENED', 'CANCELED'));

ALTER TABLE public.payroll_periods
    ADD COLUMN IF NOT EXISTS parent_period_id UUID REFERENCES public.payroll_periods(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS current_version INT NOT NULL DEFAULT 1;

-- 2. Evolução de public.general_legal_parameters (BUG-06: vigência sem redutor hardcoded)
ALTER TABLE public.general_legal_parameters
    ADD COLUMN IF NOT EXISTS irrf_exemption_limit NUMERIC(15,2),
    ADD COLUMN IF NOT EXISTS irrf_reduction_formula_limit NUMERIC(15,2);

ALTER TABLE public.general_legal_parameters
    ALTER COLUMN irrf_reduction_a DROP NOT NULL,
    ALTER COLUMN irrf_reduction_b DROP NOT NULL;

-- 3. Versionamento em public.rubrics (BUG-09)
ALTER TABLE public.rubrics
    ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS valid_from DATE,
    ADD COLUMN IF NOT EXISTS valid_to DATE,
    ADD COLUMN IF NOT EXISTS previous_version_id UUID REFERENCES public.rubrics(id) ON DELETE SET NULL;

-- 4. Versionamento e Rastreabilidade Legal em public.payslips e public.payslip_items (BUG-09)
ALTER TABLE public.payslips
    ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS legal_version_id UUID REFERENCES public.legal_versions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS engine_version TEXT NOT NULL DEFAULT '2.2.0';

ALTER TABLE public.payslip_items
    ADD COLUMN IF NOT EXISTS rubric_version_id UUID REFERENCES public.rubrics(id) ON DELETE SET NULL;

ALTER TABLE public.payroll_memory_calc
    ADD COLUMN IF NOT EXISTS engine_version TEXT NOT NULL DEFAULT '2.2.0';

-- 5. Eventos Variáveis por Quantidade com Override Explícito de Zero (BUG-04)
ALTER TABLE public.payroll_variable_events
    ADD COLUMN IF NOT EXISTS force_zero_override BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS reference TEXT;

-- 6. Localização IBGE/UF em public.workplaces (BUG-10)
ALTER TABLE public.workplaces
    ADD COLUMN IF NOT EXISTS state_code VARCHAR(2),
    ADD COLUMN IF NOT EXISTS city_code VARCHAR(7);

-- 7. Feriados: Status, Unicidade Multi-Tenant/Âmbito e Política RLS (BUG-10)
ALTER TABLE public.holidays
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE'));

ALTER TABLE public.holidays DROP CONSTRAINT IF EXISTS holidays_date_name_key;

DROP INDEX IF EXISTS idx_holidays_unique_scope;
CREATE UNIQUE INDEX idx_holidays_unique_scope
    ON public.holidays (
        COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        date,
        name,
        COALESCE(state_code, ''),
        COALESCE(city_code, '')
    );

DROP POLICY IF EXISTS holidays_select_policy ON public.holidays;
DROP POLICY IF EXISTS holidays_manage_policy ON public.holidays;
DROP POLICY IF EXISTS tenant_isolation_policy ON public.holidays;

CREATE POLICY holidays_select_policy ON public.holidays
    FOR SELECT
    USING (
        tenant_id IS NULL
        OR tenant_id = public.current_app_tenant_id()
    );

CREATE POLICY holidays_manage_policy ON public.holidays
    FOR ALL
    USING (tenant_id = public.current_app_tenant_id())
    WITH CHECK (tenant_id = public.current_app_tenant_id());

-- 8. Deduções Fixas: Elegibilidade Completa e Teto Total (BUG-10)
ALTER TABLE public.employee_deductions
    ADD COLUMN IF NOT EXISTS rubric_id UUID REFERENCES public.rubrics(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS total_limit NUMERIC(15,2),
    ADD COLUMN IF NOT EXISTS start_date DATE,
    ADD COLUMN IF NOT EXISTS end_date DATE,
    ADD COLUMN IF NOT EXISTS deduct_on_advance BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS apply_on_types TEXT[];

-- 9. Encargos Patronais: Bases Consolidadas e Chave Única por Período/Empresa (BUG-09)
ALTER TABLE public.payroll_company_taxes
    ADD COLUMN IF NOT EXISTS total_base_inss NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS total_base_fgts NUMERIC(15,2) NOT NULL DEFAULT 0.00;

DROP INDEX IF EXISTS idx_payroll_company_taxes_period_company;
CREATE UNIQUE INDEX idx_payroll_company_taxes_period_company
    ON public.payroll_company_taxes (payroll_period_id, company_id)
    WHERE establishment_id IS NULL;

-- 10. Correção de regex em public.import_afd_punch_records (era 'D' em vez de '[^0-9]')
CREATE OR REPLACE FUNCTION public.import_afd_punch_records(
    p_tenant_id UUID,
    p_company_id UUID,
    p_device_id UUID,
    p_punches JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_item JSONB;
    v_inserted INT := 0;
    v_skipped INT := 0;
    v_contract_id UUID;
    v_worker_id UUID;
    v_sha256 TEXT;
BEGIN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_punches)
    LOOP
        SELECT c.id, c.worker_id INTO v_contract_id, v_worker_id
        FROM public.contracts c
        JOIN public.workers w ON w.id = c.worker_id
        WHERE c.tenant_id = p_tenant_id
          AND c.status = 'ACTIVE'
          AND (
            (v_item->>'cpf' IS NOT NULL AND w.cpf = regexp_replace(v_item->>'cpf', '[^0-9]', '', 'g'))
            OR
            (v_item->>'pis' IS NOT NULL AND w.pis = regexp_replace(v_item->>'pis', '[^0-9]', '', 'g'))
          )
        LIMIT 1;

        v_sha256 := encode(digest(p_tenant_id::text || (v_item->>'nsr') || (v_item->>'punched_at'), 'sha256'), 'hex');

        BEGIN
            INSERT INTO public.time_punch_records (
                tenant_id,
                company_id,
                contract_id,
                worker_id,
                device_id,
                nsr,
                record_type,
                punched_at,
                source,
                sha256_hash
            ) VALUES (
                p_tenant_id,
                p_company_id,
                v_contract_id,
                v_worker_id,
                p_device_id,
                (v_item->>'nsr')::bigint,
                COALESCE((v_item->>'record_type')::int, 3),
                (v_item->>'punched_at')::timestamptz,
                'IMPORT',
                v_sha256
            );
            v_inserted := v_inserted + 1;
        EXCEPTION WHEN unique_violation THEN
            v_skipped := v_skipped + 1;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'inserted_count', v_inserted,
        'skipped_count', v_skipped
    );
END;
$$;

-- 11. Função Atômica Transacional public.save_payroll_period (BUG-09)
-- Grava holerites, itens (rubric_version_id), memória de cálculo, encargos patronais
-- e incrementa version em payslips a cada recálculo, respeitando RLS e imutabilidade CLT.
CREATE OR REPLACE FUNCTION public.save_payroll_period(
    p_period_id UUID,
    p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := public.current_app_user_id();
    v_tenant_id UUID := public.current_app_tenant_id();
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

    -- Se for cálculo completo (sem filtro por contrato), remove holerites de contratos que não estão mais no lote
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
            tenant_id,
            payroll_period_id,
            contract_id,
            worker_id,
            gross_salary,
            total_earnings,
            total_deductions,
            net_salary,
            base_inss,
            base_irrf,
            base_fgts,
            fgts_month,
            status,
            legal_version_id,
            engine_version,
            version
        ) VALUES (
            v_tenant_id,
            p_period_id,
            (v_slip->>'contract_id')::uuid,
            v_worker_id,
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

        -- Substitui itens do holerite
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
                tenant_id,
                payslip_id,
                rubric_id,
                rubric_version_id,
                rubric_code,
                rubric_name,
                type,
                reference,
                amount
            ) VALUES (
                v_tenant_id,
                v_payslip_id,
                (v_item->>'rubric_id')::uuid,
                COALESCE(NULLIF(v_item->>'rubric_version_id', '')::uuid, (v_item->>'rubric_id')::uuid),
                COALESCE(v_rubric_code, '000'),
                COALESCE(v_rubric_name, 'Rubrica'),
                v_item_type,
                v_ref_num,
                COALESCE((v_item->>'amount')::numeric, 0)
            );
        END LOOP;

        -- Substitui memória de cálculo do holerite
        DELETE FROM public.payroll_memory_calc WHERE payslip_id = v_payslip_id;

        FOR v_mem IN SELECT * FROM jsonb_array_elements(COALESCE(v_slip->'memory', '[]'::jsonb))
        LOOP
            INSERT INTO public.payroll_memory_calc (
                tenant_id,
                payslip_id,
                rubric_id,
                step_name,
                base_value,
                quantity_used,
                percentage_used,
                parsed_formula,
                result_value,
                origin,
                engine_version
            ) VALUES (
                v_tenant_id,
                v_payslip_id,
                NULLIF(v_mem->>'rubric_id', '')::uuid,
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

    -- Atualiza encargos patronais consolidados por empresa
    DELETE FROM public.payroll_company_taxes
    WHERE payroll_period_id = p_period_id AND tenant_id = v_tenant_id;

    FOR v_tax IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'company_taxes', '[]'::jsonb))
    LOOP
        INSERT INTO public.payroll_company_taxes (
            tenant_id,
            payroll_period_id,
            company_id,
            total_base_inss,
            total_base_fgts,
            inss_patronal,
            rat_amount,
            other_entities_amount,
            fgts_total,
            total_cost
        ) VALUES (
            v_tenant_id,
            p_period_id,
            (v_tax->>'company_id')::uuid,
            COALESCE((v_tax->>'total_base_inss')::numeric, 0),
            COALESCE((v_tax->>'total_base_fgts')::numeric, 0),
            COALESCE((v_tax->>'inss_patronal')::numeric, 0),
            COALESCE((v_tax->>'rat_adjusted')::numeric, 0),
            COALESCE((v_tax->>'terceiros')::numeric, 0),
            COALESCE((v_tax->>'fgts_patronal')::numeric, 0),
            COALESCE((v_tax->>'total_taxes')::numeric, 0)
        );
    END LOOP;

    -- Recalcula totais consolidados do período a partir dos holerites gravados
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
