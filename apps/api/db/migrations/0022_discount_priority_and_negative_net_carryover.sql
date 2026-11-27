-- ==============================================================================
-- Migration 0022: Prioridade Legal de Descontos, Margem Consignável 35%
--                e Insuficiência de Saldo (499 / 899) — FOLHA-07
-- Sistema: coupleRH Enterprise v2.0 (PostgreSQL 17 Puro)
-- ==============================================================================

-- 1. Prioridade Legal de Descontos nas Rubricas (discount_priority)
--    10: INSS / IRRF (tributários compulsórios)
--    20: Pensão Alimentícia Judicial
--    30: Faltas / DSR / Adiantamento Salarial
--    35: Desconto de Insuficiência de Saldo do Mês Anterior (899)
--    40: Empréstimos Consignados (805) — Trava Legal 35% Lei 10.820/2003
--    50: Benefícios (VT, VR, VA, Saúde, Odonto)
--    60: Convênios / Sindicato / Outros descontos facultativos
ALTER TABLE public.rubrics
    ADD COLUMN IF NOT EXISTS discount_priority INT DEFAULT 99;

CREATE INDEX IF NOT EXISTS idx_rubrics_discount_priority
    ON public.rubrics (discount_priority)
    WHERE type = 'DEDUCTION' AND deleted_at IS NULL;

-- 2. Atualização das prioridades legais nas rubricas existentes
UPDATE public.rubrics SET discount_priority = 10 WHERE code IN ('901', '902');
UPDATE public.rubrics SET discount_priority = 20 WHERE code IN ('904', '804') OR rubric_kind = 'ALIMONY';
UPDATE public.rubrics SET discount_priority = 30 WHERE code IN ('801', '850') OR rubric_kind IN ('ABSENCE', 'ADVANCE');
UPDATE public.rubrics SET discount_priority = 40 WHERE code IN ('805') OR rubric_kind = 'LOAN';
UPDATE public.rubrics SET discount_priority = 50 WHERE rubric_kind = 'BENEFIT';

-- 3. Inserção / Padronização das Rubricas Oficiais de Sistema 499 e 899
-- 499: Insuficiência de Saldo (EARNING neutro sem incidências fiscais)
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias, esocial_nature
) VALUES (
    'a0000000-0000-0000-0000-000000000499',
    '499',
    'Insuficiência de Saldo',
    'EARNING',
    'OTHER',
    'INSUFFICIENCY_CREDIT',
    'ACTIVE',
    TRUE,
    'SYSTEM',
    999,
    NULL,
    '{"rat": false, "fgts": false, "inss": false, "irrf": false, "terceiros": false, "integra_dsr": false, "inss_patronal": false, "gera_base_fgts": false, "gera_base_inss": false, "gera_base_irrf": false}'::jsonb,
    '9908'
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    status = 'ACTIVE',
    is_system = TRUE,
    calculation_form = 'SYSTEM',
    calculation_order = 999,
    discount_priority = NULL,
    incidencias = EXCLUDED.incidencias,
    esocial_nature = EXCLUDED.esocial_nature;

-- 899: Desconto de Insuficiência do Mês Anterior (DEDUCTION neutro sem incidências fiscais)
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias, esocial_nature
) VALUES (
    'a0000000-0000-0000-0000-000000000899',
    '899',
    'Desconto Insuficiência Mês Anterior',
    'DEDUCTION',
    'OTHER',
    'INSUFFICIENCY_DEBIT',
    'ACTIVE',
    TRUE,
    'SYSTEM',
    899,
    35,
    '{"rat": false, "fgts": false, "inss": false, "irrf": false, "terceiros": false, "integra_dsr": false, "inss_patronal": false, "gera_base_fgts": false, "gera_base_inss": false, "gera_base_irrf": false}'::jsonb,
    '9908'
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    status = 'ACTIVE',
    is_system = TRUE,
    calculation_form = 'SYSTEM',
    calculation_order = 899,
    discount_priority = 35,
    incidencias = EXCLUDED.incidencias,
    esocial_nature = EXCLUDED.esocial_nature;

-- 4. Política Configurável de Saldo Negativo na Empresa (negative_net_policy)
--    'INSUFFICIENCY_CARRYOVER' (Padrão Enterprise: gera 499 e agenda 899 na competência seguinte)
--    'CAP_OPTIONAL_DISCOUNTS'  (Limita/corta descontos facultativos até zerar)
--    'BLOCK'                   (Bloqueia se líquido for negativo)
ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS negative_net_policy TEXT NOT NULL DEFAULT 'INSUFFICIENCY_CARRYOVER'
    CHECK (negative_net_policy IN ('BLOCK', 'INSUFFICIENCY_CARRYOVER', 'CAP_OPTIONAL_DISCOUNTS'));

-- 5. Evolução da Tabela public.payroll_loans (Status, Notas e Controle de Término)
ALTER TABLE public.payroll_loans
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'COMPLETED', 'SUSPENDED', 'CANCELLED')),
    ADD COLUMN IF NOT EXISTS notes TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_payroll_loans_contract_status
    ON public.payroll_loans (tenant_id, contract_id, is_active, status);

-- 6. Tabela de Rastreabilidade de Saldos Devedores / Insuficiência de Saldo
CREATE TABLE IF NOT EXISTS public.employee_balance_debts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    source_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    source_payslip_id UUID REFERENCES public.payslips(id) ON DELETE CASCADE,
    amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
    balance_remaining NUMERIC(15,2) NOT NULL CHECK (balance_remaining >= 0),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DEDUCTED', 'PARTIALLY_DEDUCTED', 'CANCELLED')),
    competence_year INT NOT NULL,
    competence_month INT NOT NULL CHECK (competence_month BETWEEN 1 AND 13),
    target_year INT NOT NULL,
    target_month INT NOT NULL CHECK (target_month BETWEEN 1 AND 13),
    cleared_period_id UUID REFERENCES public.payroll_periods(id) ON DELETE SET NULL,
    cleared_payslip_id UUID REFERENCES public.payslips(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_debts_contract_status
    ON public.employee_balance_debts (tenant_id, contract_id, status)
    WHERE status IN ('PENDING', 'PARTIALLY_DEDUCTED');

CREATE INDEX IF NOT EXISTS idx_balance_debts_target_comp
    ON public.employee_balance_debts (tenant_id, target_year, target_month, status);

-- RLS Obrigatória (ENABLE + FORCE ROW LEVEL SECURITY)
ALTER TABLE public.employee_balance_debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_balance_debts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_balance_debts_select_policy ON public.employee_balance_debts;
DROP POLICY IF EXISTS employee_balance_debts_manage_policy ON public.employee_balance_debts;

CREATE POLICY employee_balance_debts_select_policy ON public.employee_balance_debts
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
            OR public.can_access_contract(tenant_id, contract_id)
            OR worker_id = public.current_app_worker_id()
        )
    );

CREATE POLICY employee_balance_debts_manage_policy ON public.employee_balance_debts
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
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
        AND (
            public.current_app_user_id() IS NULL
            OR public.can_access_contract(tenant_id, contract_id)
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_balance_debts TO couplerh_app;

-- Trigger Forense T29
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers
        WHERE trigger_name = 'audit_employee_balance_debts_trigger'
          AND event_object_table = 'employee_balance_debts'
    ) THEN
        CREATE TRIGGER audit_employee_balance_debts_trigger
            AFTER INSERT OR UPDATE OR DELETE ON public.employee_balance_debts
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;
END $$;

-- 7. Atualização da RPC public.close_payroll_period para Baixar Consignados e Saldo Devedor
CREATE OR REPLACE FUNCTION public.close_payroll_period(
    p_period_id UUID,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID := public.current_app_user_id();
    v_tenant_id UUID := public.current_app_tenant_id();
    v_period RECORD;
    v_user_role TEXT;
    v_user_active BOOLEAN;
    v_payslip_count INTEGER := 0;
    v_error_count INTEGER := 0;
    v_negative_net_count INTEGER := 0;
    v_math_error_count INTEGER := 0;
    v_next_year INT;
    v_next_month INT;
    v_next_period_id UUID;
    v_rubric_899_id UUID;
    v_slip RECORD;
    v_loan RECORD;
    v_debt RECORD;
    v_closed_loans_count INT := 0;
    v_created_debts_count INT := 0;
    v_cleared_debts_count INT := 0;
BEGIN
    -- 1. Exige autenticação e contexto de tenant
    IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Acesso nao autorizado: usuario ou tenant nao configurado na sessao.' USING ERRCODE = '42501';
    END IF;

    -- 2. Validar período no escopo do tenant ativo
    SELECT * INTO v_period 
    FROM public.payroll_periods 
    WHERE id = p_period_id AND tenant_id = v_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Periodo de folha % nao encontrado para o tenant ativo.', p_period_id USING ERRCODE = 'P0002';
    END IF;

    IF v_period.status = 'CLOSED' THEN
        RAISE EXCEPTION 'Periodo de folha % ja se encontra fechado.', p_period_id;
    END IF;

    -- 3. Validar permissão estrita anti-null (system_admin ou tenant_admin ou calculate_payroll)
    SELECT tu.role, tu.is_active 
    INTO v_user_role, v_user_active
    FROM public.tenant_users tu 
    WHERE tu.user_id = v_user_id AND tu.tenant_id = v_tenant_id;

    IF (v_user_role IS NULL OR NOT v_user_active OR v_user_role NOT IN ('system_admin', 'tenant_admin'))
       AND NOT public.has_permission(v_tenant_id, 'calculate_payroll') THEN
        RAISE EXCEPTION 'Acesso negado: Perfil % nao possui permissao para fechar folha de pagamento.', COALESCE(v_user_role, 'Sem Perfil') USING ERRCODE = '42501';
    END IF;

    -- 4. Validar se existem holerites no período
    SELECT count(*) INTO v_payslip_count 
    FROM public.payslips 
    WHERE payroll_period_id = p_period_id;

    IF v_payslip_count = 0 THEN
        RAISE EXCEPTION 'Fechamento de folha bloqueado: Nenhum holerite foi gerado ou processado para este periodo.';
    END IF;

    -- 5. BLOQUEIO CLT: Colaboradores com status de erro
    SELECT count(*) INTO v_error_count 
    FROM public.payslips 
    WHERE payroll_period_id = p_period_id 
      AND (status IN ('ERROR', 'CALCULATION_ERROR', 'ERRO_CALCULO') OR status ILIKE '%ERROR%');

    IF v_error_count > 0 THEN
        RAISE EXCEPTION 'Fechamento de folha bloqueado (Compliance/CLT): Existem % colaboradores com calculo em erro no periodo. Regularize os calculos antes de fechar a folha.', v_error_count;
    END IF;

    -- 6. BLOQUEIO CLT Art. 462: Colaboradores com salário líquido negativo
    SELECT count(*) INTO v_negative_net_count 
    FROM public.payslips 
    WHERE payroll_period_id = p_period_id AND net_salary < 0;

    IF v_negative_net_count > 0 THEN
        RAISE EXCEPTION 'Fechamento de folha bloqueado (CLT Art. 462): Existem % colaboradores com salario liquido negativo. Nao e permitido fechar a folha com descontos superiores ao rendimento total.', v_negative_net_count;
    END IF;

    -- 7. BLOQUEIO Invariante Matemática T6: Líquido != (Proventos - Descontos)
    SELECT count(*) INTO v_math_error_count 
    FROM public.payslips 
    WHERE payroll_period_id = p_period_id 
      AND abs(net_salary - (total_earnings - total_deductions)) > 0.01;

    IF v_math_error_count > 0 THEN
        RAISE EXCEPTION 'Fechamento de folha bloqueado (Invariante T6): Existem % holerites com divergencia matematica entre salario liquido e (Proventos - Descontos).', v_math_error_count;
    END IF;

    -- 8. Baixa Automática de Parcelas de Empréstimos Consignados (rubrica 805)
    FOR v_slip IN 
        SELECT ps.contract_id, pi.amount AS loan_installment
        FROM public.payslips ps
        JOIN public.payslip_items pi ON pi.payslip_id = ps.id
        WHERE ps.payroll_period_id = p_period_id
          AND pi.rubric_code = '805'
          AND pi.amount > 0
    LOOP
        SELECT id, total_installments, paid_installments INTO v_loan
        FROM public.payroll_loans
        WHERE tenant_id = v_tenant_id
          AND contract_id = v_slip.contract_id
          AND is_active = TRUE
          AND status = 'ACTIVE'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE;

        IF FOUND THEN
            UPDATE public.payroll_loans SET
                paid_installments = paid_installments + 1,
                is_active = CASE WHEN paid_installments + 1 >= total_installments THEN FALSE ELSE TRUE END,
                status = CASE WHEN paid_installments + 1 >= total_installments THEN 'COMPLETED' ELSE 'ACTIVE' END,
                updated_at = NOW()
            WHERE id = v_loan.id;

            IF v_loan.paid_installments + 1 >= v_loan.total_installments THEN
                v_closed_loans_count := v_closed_loans_count + 1;
            END IF;
        END IF;
    END LOOP;

    -- 9. Apuração de Competência Seguinte para Insuficiência de Saldo
    IF v_period.month >= 12 THEN
        v_next_year := v_period.year + 1;
        v_next_month := 1;
    ELSE
        v_next_year := v_period.year;
        v_next_month := v_period.month + 1;
    END IF;

    -- Buscar período da competência seguinte se já existir
    SELECT id INTO v_next_period_id
    FROM public.payroll_periods
    WHERE tenant_id = v_tenant_id
      AND company_id = v_period.company_id
      AND year = v_next_year
      AND month = v_next_month
      AND type = 'MONTHLY'
      AND status <> 'CLOSED'
    LIMIT 1;

    SELECT id INTO v_rubric_899_id
    FROM public.rubrics
    WHERE code = '899' AND (tenant_id = v_tenant_id OR is_system = TRUE)
    LIMIT 1;

    -- 10. Agendamento de Insuficiência de Saldo (rubrica 499) para a competência seguinte (rubrica 899)
    FOR v_slip IN
        SELECT ps.id AS payslip_id, ps.contract_id, ps.worker_id, pi.amount AS debt_amount
        FROM public.payslips ps
        JOIN public.payslip_items pi ON pi.payslip_id = ps.id
        WHERE ps.payroll_period_id = p_period_id
          AND pi.rubric_code = '499'
          AND pi.amount > 0
    LOOP
        INSERT INTO public.employee_balance_debts (
            tenant_id, contract_id, worker_id, source_period_id, source_payslip_id,
            amount, balance_remaining, status, competence_year, competence_month,
            target_year, target_month
        ) VALUES (
            v_tenant_id, v_slip.contract_id, v_slip.worker_id, p_period_id, v_slip.payslip_id,
            v_slip.debt_amount, v_slip.debt_amount, 'PENDING', v_period.year, v_period.month,
            v_next_year, v_next_month
        );
        v_created_debts_count := v_created_debts_count + 1;

        -- Se a competência seguinte já estiver criada, injeta automaticamente o evento variável 899
        IF v_next_period_id IS NOT NULL AND v_rubric_899_id IS NOT NULL THEN
            INSERT INTO public.payroll_variable_events (
                tenant_id, payroll_period_id, contract_id, rubric_id,
                manual_value, quantity, origin
            ) VALUES (
                v_tenant_id, v_next_period_id, v_slip.contract_id, v_rubric_899_id,
                v_slip.debt_amount, 1, 'SYSTEM'
            )
            ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;

    -- 11. Baixa de débitos anteriores quitados nesta competência (rubrica 899)
    FOR v_slip IN
        SELECT ps.id AS payslip_id, ps.contract_id, pi.amount AS cleared_amount
        FROM public.payslips ps
        JOIN public.payslip_items pi ON pi.payslip_id = ps.id
        WHERE ps.payroll_period_id = p_period_id
          AND pi.rubric_code = '899'
          AND pi.amount > 0
    LOOP
        UPDATE public.employee_balance_debts SET
            balance_remaining = GREATEST(0, balance_remaining - v_slip.cleared_amount),
            status = CASE WHEN balance_remaining - v_slip.cleared_amount <= 0 THEN 'DEDUCTED' ELSE 'PARTIALLY_DEDUCTED' END,
            cleared_period_id = p_period_id,
            cleared_payslip_id = v_slip.payslip_id,
            updated_at = NOW()
        WHERE tenant_id = v_tenant_id
          AND contract_id = v_slip.contract_id
          AND status IN ('PENDING', 'PARTIALLY_DEDUCTED')
          AND target_year = v_period.year
          AND target_month = v_period.month;

        IF FOUND THEN
            v_cleared_debts_count := v_cleared_debts_count + 1;
        END IF;
    END LOOP;

    -- 12. Travar holerites com status APPROVED antes de selar o período
    UPDATE public.payslips SET
        status = 'APPROVED',
        updated_at = NOW()
    WHERE payroll_period_id = p_period_id;

    -- 13. Selar o período com status CLOSED e auditoria
    UPDATE public.payroll_periods SET
        status = 'CLOSED',
        closed_at = NOW(),
        closed_by = v_user_id,
        closure_notes = p_notes,
        updated_at = NOW()
    WHERE id = p_period_id;

    RETURN jsonb_build_object(
        'success', true,
        'closed', true,
        'period_id', p_period_id,
        'payslip_count', v_payslip_count,
        'completed_loans', v_closed_loans_count,
        'created_debts', v_created_debts_count,
        'cleared_debts', v_cleared_debts_count,
        'message', 'Folha fechada com sucesso em conformidade total CLT.'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_payroll_period(UUID, TEXT) TO couplerh_app;
