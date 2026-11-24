-- ==============================================================================
-- Migration 0009: Fechamento de Brechas P0 de Segurança, RBAC Anti-Escalada,
-- Correção de Fechamento de Folha, Ponto Seguro e Verificação Pública LGPD
-- ==============================================================================

-- 1. Adicionar api_key_hash em time_devices para autenticação segura de coletores REP
ALTER TABLE public.time_devices 
ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

-- 2. Adicionar closure_notes e campos de reabertura em payroll_periods
ALTER TABLE public.payroll_periods
ADD COLUMN IF NOT EXISTS closure_notes TEXT,
ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS reopened_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- 3. Tabela de Trilha Imutável de Reaberturas de Folha (Compliance e Auditoria)
CREATE TABLE IF NOT EXISTS public.payroll_period_reopenings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    reopened_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    reopened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT NOT NULL,
    previous_closed_at TIMESTAMPTZ,
    previous_closed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.payroll_period_reopenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_period_reopenings FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'payroll_period_reopenings' AND policyname = 'tenant_isolation_policy'
    ) THEN
        CREATE POLICY "tenant_isolation_policy" ON public.payroll_period_reopenings
          USING (tenant_id = current_app_tenant_id())
          WITH CHECK (tenant_id = current_app_tenant_id());
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers 
        WHERE trigger_name = 'trg_audit_payroll_period_reopenings'
    ) THEN
        CREATE TRIGGER trg_audit_payroll_period_reopenings
          AFTER INSERT OR UPDATE OR DELETE ON public.payroll_period_reopenings
          FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;
END $$;

-- 4. RPC Anti-Escalada de Privilégio: update_tenant_user_access
CREATE OR REPLACE FUNCTION public.update_tenant_user_access(
    p_tenant_user_id UUID,
    p_role TEXT,
    p_worker_id UUID DEFAULT NULL,
    p_is_active BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_id UUID := public.current_app_user_id();
    v_caller_tenant_id UUID := public.current_app_tenant_id();
    v_caller_role TEXT := public.current_app_role();
    v_target_tenant_id UUID;
    v_target_user_id UUID;
    v_target_role TEXT;
    v_caller_actual_role TEXT;
    v_caller_active BOOLEAN;
BEGIN
    -- 1. Exige autenticação
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Acesso nao autorizado: usuario nao autenticado.' USING ERRCODE = '42501';
    END IF;

    -- 2. Localiza o registro do tenant_user alvo
    SELECT tenant_id, user_id, role 
    INTO v_target_tenant_id, v_target_user_id, v_target_role
    FROM public.tenant_users
    WHERE id = p_tenant_user_id;

    IF v_target_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Usuario do tenant nao encontrado.' USING ERRCODE = 'P0002';
    END IF;

    -- 3. Identifica a role real e atividade do chamador no tenant
    SELECT tu.role, tu.is_active 
    INTO v_caller_actual_role, v_caller_active
    FROM public.tenant_users tu
    WHERE tu.user_id = v_caller_id AND tu.tenant_id = v_target_tenant_id;

    IF v_caller_active IS NULL OR NOT v_caller_active THEN
        RAISE EXCEPTION 'Acesso negado: sua conta ou vinculo com a empresa esta inativo.' USING ERRCODE = '42501';
    END IF;

    -- 4. Regra de Bloqueio P0: Apenas system_admin e tenant_admin podem gerenciar usuários
    -- dp_analyst é expressamente bloqueado!
    IF v_caller_actual_role NOT IN ('system_admin', 'tenant_admin') THEN
        RAISE EXCEPTION 'Acesso negado: Perfil % nao possui permissao para gerenciar usuarios ou alterar acessos.', COALESCE(v_caller_actual_role, 'Sem Perfil') USING ERRCODE = '42501';
    END IF;

    -- 5. Regra de Bloqueio P0: tenant_admin NUNCA pode promover a system_admin ou rebaixar um system_admin
    IF p_role = 'system_admin' AND v_caller_actual_role != 'system_admin' THEN
        RAISE EXCEPTION 'Escalada de privilegio bloqueada: Apenas administradores do sistema podem conceder o perfil system_admin.' USING ERRCODE = '42501';
    END IF;

    IF v_target_role = 'system_admin' AND v_caller_actual_role != 'system_admin' THEN
        RAISE EXCEPTION 'Operacao proibida: Apenas administradores do sistema podem alterar o perfil de outro system_admin.' USING ERRCODE = '42501';
    END IF;

    -- 6. Bloqueio de auto-rebaixamento/auto-desativação para evitar lockout
    IF v_caller_id = v_target_user_id AND (p_role != v_target_role OR p_is_active = FALSE) THEN
        RAISE EXCEPTION 'Operacao proibida: Um administrador nao pode desativar ou rebaixar seu proprio acesso.' USING ERRCODE = '42501';
    END IF;

    -- 7. Validação do enum de role
    IF p_role NOT IN ('system_admin', 'tenant_admin', 'dp_analyst', 'manager', 'employee', 'sst_specialist', 'auditor') THEN
        RAISE EXCEPTION 'Papel de acesso invalido: %', p_role USING ERRCODE = '22023';
    END IF;

    -- 8. Validação de worker_id se fornecido: deve pertencer ao mesmo tenant
    IF p_worker_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.workers WHERE id = p_worker_id AND tenant_id = v_target_tenant_id) THEN
            RAISE EXCEPTION 'Colaborador selecionado nao pertence a esta empresa/tenant.' USING ERRCODE = '23503';
        END IF;
    END IF;

    -- 9. Atualização atômica
    UPDATE public.tenant_users SET
        role = p_role,
        is_active = p_is_active,
        updated_at = NOW()
    WHERE id = p_tenant_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'tenant_user_id', p_tenant_user_id,
        'role', p_role,
        'is_active', p_is_active,
        'updated_at', NOW()
    );
END;
$$;

-- 5. RPC de Fechamento de Folha de Pagamento Corrigida (Eliminando NULL NOT IN e dp_manager)
CREATE OR REPLACE FUNCTION public.close_payroll_period(
    p_period_id UUID,
    p_notes TEXT DEFAULT NULL
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
    v_user_role TEXT;
    v_user_active BOOLEAN;
    v_payslip_count INTEGER := 0;
    v_error_count INTEGER := 0;
    v_negative_net_count INTEGER := 0;
    v_math_error_count INTEGER := 0;
BEGIN
    -- 1. Exige autenticação e contexto de tenant
    IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Acesso nao autorizado: usuario ou tenant nao configurado na sessao.' USING ERRCODE = '42501';
    END IF;

    -- 2. Validar período no escopo do tenant ativo
    SELECT * INTO v_period 
    FROM public.payroll_periods 
    WHERE id = p_period_id AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Periodo de folha % nao encontrado para o tenant ativo.', p_period_id USING ERRCODE = 'P0002';
    END IF;

    IF v_period.status = 'CLOSED' THEN
        RAISE EXCEPTION 'Periodo de folha % ja se encontra fechado.', p_period_id;
    END IF;

    -- 3. Validar permissão estrita anti-null (Apenas system_admin e tenant_admin)
    SELECT tu.role, tu.is_active 
    INTO v_user_role, v_user_active
    FROM public.tenant_users tu 
    WHERE tu.user_id = v_user_id AND tu.tenant_id = v_tenant_id;

    IF v_user_role IS NULL OR NOT v_user_active OR v_user_role NOT IN ('system_admin', 'tenant_admin') THEN
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

    -- 8. Travar holerites com status APPROVED antes de selar o período
    UPDATE public.payslips SET
        status = 'APPROVED',
        updated_at = NOW()
    WHERE payroll_period_id = p_period_id;

    -- 9. Selar o período com status CLOSED e auditoria
    UPDATE public.payroll_periods SET
        status = 'CLOSED',
        closed_at = NOW(),
        closed_by = v_user_id,
        closure_notes = p_notes,
        updated_at = NOW()
    WHERE id = p_period_id;

    RETURN jsonb_build_object(
        'success', true,
        'period_id', p_period_id,
        'status', 'CLOSED',
        'closed_at', NOW(),
        'payslips_closed', v_payslip_count
    );
END;
$$;

-- 6. RPC de Reabertura de Folha de Pagamento Corrigida (Eliminando NULL NOT IN e dp_manager)
CREATE OR REPLACE FUNCTION public.reopen_payroll_period(
    p_period_id UUID,
    p_reason TEXT
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
    v_user_role TEXT;
    v_user_active BOOLEAN;
    v_trimmed_reason TEXT := trim(p_reason);
BEGIN
    -- 1. Exige autenticação
    IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Acesso nao autorizado: usuario ou tenant nao configurado na sessao.' USING ERRCODE = '42501';
    END IF;

    -- 2. Validar justificativa (mínimo 15 caracteres)
    IF length(v_trimmed_reason) < 15 THEN
        RAISE EXCEPTION 'A justificativa de reabertura deve conter no minimo 15 caracteres explicando o motivo legal/contabil.';
    END IF;

    -- 3. Validar período
    SELECT * INTO v_period 
    FROM public.payroll_periods 
    WHERE id = p_period_id AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Periodo de folha % nao encontrado.', p_period_id USING ERRCODE = 'P0002';
    END IF;

    IF v_period.status != 'CLOSED' THEN
        RAISE EXCEPTION 'Apenas folhas fechadas (CLOSED) podem passar por reabertura formal (status atual: %).', v_period.status;
    END IF;

    -- 4. Validar perfil autorizado estrito anti-null (Apenas system_admin e tenant_admin)
    SELECT tu.role, tu.is_active 
    INTO v_user_role, v_user_active
    FROM public.tenant_users tu 
    WHERE tu.user_id = v_user_id AND tu.tenant_id = v_tenant_id;

    IF v_user_role IS NULL OR NOT v_user_active OR v_user_role NOT IN ('system_admin', 'tenant_admin') THEN
        RAISE EXCEPTION 'Acesso negado: Somente administradores (system_admin ou tenant_admin) podem reabrir folhas fechadas (seu perfil: %).', COALESCE(v_user_role, 'Sem Perfil') USING ERRCODE = '42501';
    END IF;

    -- 5. Gravar na trilha imutável de reaberturas
    INSERT INTO public.payroll_period_reopenings (
        tenant_id,
        payroll_period_id,
        reopened_by,
        reopened_at,
        reason,
        previous_closed_at,
        previous_closed_by
    ) VALUES (
        v_tenant_id,
        p_period_id,
        v_user_id,
        NOW(),
        v_trimmed_reason,
        v_period.closed_at,
        v_period.closed_by
    );

    -- 6. Atualizar período para OPEN
    UPDATE public.payroll_periods SET
        status = 'OPEN',
        closed_at = NULL,
        closed_by = NULL,
        reopened_at = NOW(),
        reopened_by = v_user_id,
        updated_at = NOW()
    WHERE id = p_period_id;

    -- 7. Atualizar holerites vigentes para status DRAFT
    UPDATE public.payslips SET
        status = 'DRAFT',
        updated_at = NOW()
    WHERE payroll_period_id = p_period_id;

    RETURN jsonb_build_object(
        'success', true,
        'period_id', p_period_id,
        'status', 'OPEN',
        'reopened_at', NOW(),
        'reason', v_trimmed_reason
    );
END;
$$;

-- 7. Ponto Mobile Seguro: register_mobile_punch com Validação de Ownership e Contrato Ativo
CREATE OR REPLACE FUNCTION public.register_mobile_punch(
    p_worker_id UUID,
    p_punch_type TEXT,
    p_latitude FLOAT8 DEFAULT NULL,
    p_longitude FLOAT8 DEFAULT NULL,
    p_accuracy FLOAT8 DEFAULT NULL,
    p_is_mock BOOLEAN DEFAULT FALSE,
    p_device_fp TEXT DEFAULT NULL,
    p_sha256 TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := public.current_app_user_id();
    v_tenant_id UUID := public.current_app_tenant_id();
    v_user_role TEXT := public.current_app_role();
    v_worker_user_id UUID;
    v_contract_id UUID;
    v_company_id UUID;
    v_next_nsr BIGINT;
    v_device_id UUID;
    v_punch_id UUID;
    v_final_hash TEXT;
BEGIN
    IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Acesso nao autorizado: sessao sem contexto ativo.' USING ERRCODE = '42501';
    END IF;

    -- Localiza o trabalhador no tenant
    SELECT user_id 
    INTO v_worker_user_id
    FROM public.workers 
    WHERE id = p_worker_id AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Colaborador nao localizado no tenant ativo.' USING ERRCODE = 'P0002';
    END IF;

    -- Bloqueio IDOR: se o usuário logado for colaborador, DEVE ser o próprio dono do registro
    IF v_user_role = 'employee' AND (v_worker_user_id IS NULL OR v_worker_user_id != v_user_id) THEN
        RAISE EXCEPTION 'Acesso negado: Nao e permitido registrar ponto para outro colaborador.' USING ERRCODE = '42501';
    END IF;

    -- Valida se o trabalhador possui contrato de trabalho ACTIVE
    SELECT id, company_id INTO v_contract_id, v_company_id
    FROM public.contracts
    WHERE worker_id = p_worker_id 
      AND tenant_id = v_tenant_id 
      AND status = 'ACTIVE'
    ORDER BY admission_date DESC
    LIMIT 1;

    IF v_contract_id IS NULL THEN
        RAISE EXCEPTION 'Registro de ponto bloqueado: Colaborador nao possui contrato de trabalho ativo.' USING ERRCODE = '23503';
    END IF;

    -- Obtém ou provisiona dispositivo virtual mobile para o tenant
    SELECT id INTO v_device_id
    FROM public.time_devices
    WHERE tenant_id = v_tenant_id AND kind = 'REP_P_MOBILE' AND status = 'ACTIVE'
    LIMIT 1;

    IF v_device_id IS NULL THEN
        INSERT INTO public.time_devices (tenant_id, company_id, name, kind, status)
        VALUES (v_tenant_id, v_company_id, 'App Mobile Colaborador', 'REP_P_MOBILE', 'ACTIVE')
        RETURNING id INTO v_device_id;
    END IF;

    -- Incrementa sequencial NSR do dispositivo
    UPDATE public.time_devices 
    SET last_nsr = last_nsr + 1, updated_at = NOW()
    WHERE id = v_device_id
    RETURNING last_nsr INTO v_next_nsr;

    v_final_hash := COALESCE(p_sha256, encode(sha256((v_tenant_id::text || v_next_nsr::text || NOW()::text)::bytea), 'hex'));

    -- Insere batida oficial
    INSERT INTO public.time_punch_records (
        tenant_id,
        company_id,
        contract_id,
        worker_id,
        device_id,
        nsr,
        record_type,
        punched_at,
        punch_type,
        source,
        latitude,
        longitude,
        accuracy,
        is_mock_location,
        device_fingerprint,
        sha256_hash
    ) VALUES (
        v_tenant_id,
        v_company_id,
        v_contract_id,
        p_worker_id,
        v_device_id,
        v_next_nsr,
        3,
        NOW(),
        COALESCE(p_punch_type, 'ENTRY'),
        'MOBILE',
        p_latitude,
        p_longitude,
        p_accuracy,
        COALESCE(p_is_mock, FALSE),
        p_device_fp,
        v_final_hash
    )
    RETURNING id INTO v_punch_id;

    RETURN jsonb_build_object(
        'success', true,
        'punch_id', v_punch_id,
        'nsr', v_next_nsr,
        'punched_at', NOW(),
        'sha256_hash', v_final_hash
    );
END;
$$;

-- 8. Verificação Pública com Mascaramento Estrito LGPD: verify_public_document
CREATE OR REPLACE FUNCTION public.verify_public_document(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_clean_code TEXT := trim(p_code);
    v_doc RECORD;
    v_masked_cpf TEXT;
    v_masked_name TEXT;
    v_name_parts TEXT[];
BEGIN
    SELECT 
        d.id, d.title, d.category, d.status, d.created_at,
        s.signed_at, s.signer_name, s.signer_cpf, s.signed_hash_sha256,
        COALESCE(c.trade_name, c.corporate_name) AS company_name
    INTO v_doc
    FROM public.employee_documents d
    LEFT JOIN public.document_signatures s ON s.document_id = d.id AND s.status = 'COMPLETED'
    LEFT JOIN public.companies c ON c.id = (SELECT company_id FROM public.contracts WHERE worker_id = d.worker_id LIMIT 1)
    WHERE d.id::text = v_clean_code 
       OR d.id::text ILIKE (v_clean_code || '%')
    LIMIT 1;

    IF v_doc.id IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Documento trabalhista nao localizado ou chancela invalida.');
    END IF;

    -- Mascaramento de CPF (ex: 123.***.***-45)
    IF v_doc.signer_cpf IS NOT NULL AND length(v_doc.signer_cpf) >= 11 THEN
        v_masked_cpf := substr(v_doc.signer_cpf, 1, 3) || '.***.***-' || substr(v_doc.signer_cpf, 10, 2);
    ELSE
        v_masked_cpf := '***.***.***-**';
    END IF;

    -- Mascaramento de Nome (ex: Carlos S***)
    IF v_doc.signer_name IS NOT NULL THEN
        v_name_parts := string_to_array(trim(v_doc.signer_name), ' ');
        IF array_length(v_name_parts, 1) > 1 THEN
            v_masked_name := v_name_parts[1] || ' ' || substr(v_name_parts[array_length(v_name_parts, 1)], 1, 1) || '***';
        ELSE
            v_masked_name := substr(v_doc.signer_name, 1, 3) || '***';
        END IF;
    ELSE
        v_masked_name := 'Colaborador Homologado';
    END IF;

    RETURN jsonb_build_object(
        'valid', true,
        'document_id', v_doc.id,
        'title', v_doc.title,
        'category', v_doc.category,
        'status', v_doc.status,
        'company_name', COALESCE(v_doc.company_name, 'Empresa Empregadora'),
        'signer_name_masked', v_masked_name,
        'signer_cpf_masked', v_masked_cpf,
        'signed_at', v_doc.signed_at,
        'sha256_hash', v_doc.signed_hash_sha256
    );
END;
$$;

-- 9. Verificação Pública com Mascaramento Estrito LGPD: verify_public_punch
CREATE OR REPLACE FUNCTION public.verify_public_punch(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_clean_code TEXT := trim(p_code);
    v_punch RECORD;
    v_masked_cpf TEXT;
    v_masked_name TEXT;
    v_name_parts TEXT[];
BEGIN
    SELECT 
        p.id, p.nsr, p.punched_at, p.punch_type, p.source, p.sha256_hash,
        u.full_name AS worker_name, u.cpf AS worker_cpf,
        COALESCE(c.trade_name, c.corporate_name) AS company_name
    INTO v_punch
    FROM public.time_punch_records p
    LEFT JOIN public.workers w ON w.id = p.worker_id
    LEFT JOIN public.users u ON u.id = w.user_id
    LEFT JOIN public.companies c ON c.id = p.company_id
    WHERE p.id::text = v_clean_code
       OR p.sha256_hash = v_clean_code
       OR p.id::text ILIKE (v_clean_code || '%')
    LIMIT 1;

    IF v_punch.id IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Comprovante de ponto eletronico nao localizado ou hash invalido.');
    END IF;

    IF v_punch.worker_cpf IS NOT NULL AND length(v_punch.worker_cpf) >= 11 THEN
        v_masked_cpf := substr(v_punch.worker_cpf, 1, 3) || '.***.***-' || substr(v_punch.worker_cpf, 10, 2);
    ELSE
        v_masked_cpf := '***.***.***-**';
    END IF;

    IF v_punch.worker_name IS NOT NULL THEN
        v_name_parts := string_to_array(trim(v_punch.worker_name), ' ');
        IF array_length(v_name_parts, 1) > 1 THEN
            v_masked_name := v_name_parts[1] || ' ' || substr(v_name_parts[array_length(v_name_parts, 1)], 1, 1) || '***';
        ELSE
            v_masked_name := substr(v_punch.worker_name, 1, 3) || '***';
        END IF;
    ELSE
        v_masked_name := 'Colaborador Homologado';
    END IF;

    RETURN jsonb_build_object(
        'valid', true,
        'punch_id', v_punch.id,
        'nsr', v_punch.nsr,
        'punched_at', v_punch.punched_at,
        'punch_type', v_punch.punch_type,
        'source', v_punch.source,
        'company_name', COALESCE(v_punch.company_name, 'Empresa Empregadora'),
        'worker_name_masked', v_masked_name,
        'worker_cpf_masked', v_masked_cpf,
        'sha256_hash', v_punch.sha256_hash
    );
END;
$$;

-- 10. Função SECURITY DEFINER para Autenticação Prévia de Dispositivo Coletor REP
CREATE OR REPLACE FUNCTION public.auth_get_rep_device_by_serial(p_serial TEXT)
RETURNS TABLE (
    id UUID,
    tenant_id UUID,
    company_id UUID,
    api_key_hash TEXT,
    status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT d.id, d.tenant_id, d.company_id, d.api_key_hash, d.status
    FROM public.time_devices d
    WHERE d.serial_number = p_serial
    LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auth_get_rep_device_by_serial(TEXT) TO couplerh_app;

-- Permissões de Execução para couplerh_app
GRANT EXECUTE ON FUNCTION public.update_tenant_user_access(UUID, TEXT, UUID, BOOLEAN) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.close_payroll_period(UUID, TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.reopen_payroll_period(UUID, TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.register_mobile_punch(UUID, TEXT, FLOAT8, FLOAT8, FLOAT8, BOOLEAN, TEXT, TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.verify_public_document(TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.verify_public_punch(TEXT) TO couplerh_app;
