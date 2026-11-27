-- ==============================================================================
-- MIGRATION 0037: Ponto Eletrônico Enterprise (Multi-Workplaces, Anti-Spoofing,
--                 PWA Offline, QR Code REP-P, Selfie LGPD e Dossiê LGPD 2.0)
-- FASE V8 — PONTO-01 a PONTO-05
-- ==============================================================================

-- 1. Parâmetros de precisão GPS máxima e auditoria externa em public.workplaces
ALTER TABLE public.workplaces
    ADD COLUMN IF NOT EXISTS max_accuracy_meters INT NOT NULL DEFAULT 150,
    ADD COLUMN IF NOT EXISTS allow_external_audit BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Múltiplos Locais Permitidos por Contrato (PONTO-02)
CREATE TABLE IF NOT EXISTS public.contract_allowed_workplaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    workplace_id UUID NOT NULL REFERENCES public.workplaces(id) ON DELETE CASCADE,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    allow_external_audit BOOLEAN NOT NULL DEFAULT FALSE,
    valid_from DATE NOT NULL DEFAULT '2020-01-01',
    valid_to DATE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_contract_allowed_workplaces UNIQUE (tenant_id, contract_id, workplace_id)
);

CREATE INDEX IF NOT EXISTS idx_contract_allowed_workplaces_lookup
    ON public.contract_allowed_workplaces (tenant_id, contract_id, is_active);

ALTER TABLE public.contract_allowed_workplaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_allowed_workplaces FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_allowed_workplaces_isolation_policy ON public.contract_allowed_workplaces;
CREATE POLICY contract_allowed_workplaces_isolation_policy ON public.contract_allowed_workplaces
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.can_access_contract(tenant_id, contract_id)
            OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = contract_allowed_workplaces.contract_id) = public.current_app_worker_id()
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_time_tracking')
            OR public.has_permission(tenant_id, 'manage_employees')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_allowed_workplaces TO couplerh_app;

DROP TRIGGER IF EXISTS trg_audit_contract_allowed_workplaces ON public.contract_allowed_workplaces;
CREATE TRIGGER trg_audit_contract_allowed_workplaces
    AFTER INSERT OR UPDATE OR DELETE ON public.contract_allowed_workplaces
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

-- 3. Evolução imutável de public.time_punch_records (Anti-Spoofing, Offline PWA, Selfie & Receipt Code)
ALTER TABLE public.time_punch_records
    ADD COLUMN IF NOT EXISTS receipt_code VARCHAR(40),
    ADD COLUMN IF NOT EXISTS device_timestamp TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS server_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS sync_origin TEXT NOT NULL DEFAULT 'ONLINE_API',
    ADD COLUMN IF NOT EXISTS distance_meters DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS speed_kmh DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS fraud_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS selfie_file_id UUID REFERENCES public.stored_files(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS client_uuid UUID;

DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.time_punch_records'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%sync_origin%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.time_punch_records DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.time_punch_records
    ADD CONSTRAINT time_punch_records_sync_origin_check
    CHECK (sync_origin IN ('ONLINE_API', 'OFFLINE_PWA', 'REP_AFD', 'MANUAL_ADJUSTMENT'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_time_punch_receipt_code
    ON public.time_punch_records (receipt_code)
    WHERE receipt_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_time_punch_tenant_client_uuid
    ON public.time_punch_records (tenant_id, client_uuid)
    WHERE client_uuid IS NOT NULL;

-- 4. Expansão de categorias permitidas em public.stored_files (Selfie de Ponto e Atestado Médico)
DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.stored_files'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%category%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.stored_files DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.stored_files
    ADD CONSTRAINT stored_files_category_check
    CHECK (category IN (
        'AVATAR',
        'DOCUMENT',
        'PAYSLIP_PDF',
        'CERTIFICATE_A1',
        'REPORT',
        'AFD_FILE',
        'CONTRACT',
        'PUNCH_SELFIE',
        'MEDICAL_CERTIFICATE'
    ));

-- 5. Tabelas Oficiais LGPD (Consentimentos granulares e Solicitações do Titular)
CREATE TABLE IF NOT EXISTS public.lgpd_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    consent_category TEXT NOT NULL CHECK (consent_category IN (
        'BIOMETRIC_SELFIE_PUNCH',
        'GEOLOCATION_PUNCH',
        'MEDICAL_DATA_PROCESSING',
        'WHATSAPP_NOTIFICATIONS',
        'THIRD_PARTY_BENEFITS'
    )),
    version TEXT NOT NULL DEFAULT '1.0',
    granted BOOLEAN NOT NULL DEFAULT TRUE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lgpd_consents_worker
    ON public.lgpd_consents (tenant_id, worker_id, consent_category);

ALTER TABLE public.lgpd_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lgpd_consents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lgpd_consents_isolation_policy ON public.lgpd_consents;
CREATE POLICY lgpd_consents_isolation_policy ON public.lgpd_consents
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR worker_id = public.current_app_worker_id()
            OR public.has_permission(tenant_id, 'view_employees')
            OR public.has_permission(tenant_id, 'view_audit_logs')
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR worker_id = public.current_app_worker_id()
            OR public.has_permission(tenant_id, 'manage_employees')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lgpd_consents TO couplerh_app;

DROP TRIGGER IF EXISTS trg_audit_lgpd_consents ON public.lgpd_consents;
CREATE TRIGGER trg_audit_lgpd_consents
    AFTER INSERT OR UPDATE OR DELETE ON public.lgpd_consents
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

CREATE TABLE IF NOT EXISTS public.lgpd_subject_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    request_type TEXT NOT NULL,
    justification TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_REVIEW', 'COMPLETED', 'REJECTED')),
    response_notes TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lgpd_subject_requests_worker
    ON public.lgpd_subject_requests (tenant_id, worker_id, requested_at DESC);

ALTER TABLE public.lgpd_subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lgpd_subject_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lgpd_subject_requests_isolation_policy ON public.lgpd_subject_requests;
CREATE POLICY lgpd_subject_requests_isolation_policy ON public.lgpd_subject_requests
    FOR ALL
    USING (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR worker_id = public.current_app_worker_id()
            OR public.has_permission(tenant_id, 'view_employees')
            OR public.has_permission(tenant_id, 'view_audit_logs')
        )
    )
    WITH CHECK (
        tenant_id = public.current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR worker_id = public.current_app_worker_id()
            OR public.has_permission(tenant_id, 'manage_employees')
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lgpd_subject_requests TO couplerh_app;

DROP TRIGGER IF EXISTS trg_audit_lgpd_subject_requests ON public.lgpd_subject_requests;
CREATE TRIGGER trg_audit_lgpd_subject_requests
    AFTER INSERT OR UPDATE OR DELETE ON public.lgpd_subject_requests
    FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

-- 6. Atualização de public.verify_public_punch(p_code) com suporte a receipt_code e dados Portaria 671
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
        p.id, p.nsr, p.punched_at, p.device_timestamp, p.server_received_at,
        p.sync_origin, p.geofence_status, p.receipt_code,
        p.punch_type, p.source, p.sha256_hash,
        COALESCE(w.full_name, u.full_name) AS worker_name,
        COALESCE(w.cpf, u.cpf) AS worker_cpf,
        COALESCE(c.trade_name, c.corporate_name) AS company_name
    INTO v_punch
    FROM public.time_punch_records p
    LEFT JOIN public.workers w ON w.id = p.worker_id
    LEFT JOIN public.users u ON u.id = w.user_id
    LEFT JOIN public.companies c ON c.id = p.company_id
    WHERE p.receipt_code = v_clean_code
       OR p.id::text = v_clean_code
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
        'receipt_code', v_punch.receipt_code,
        'nsr', v_punch.nsr,
        'punched_at', v_punch.punched_at,
        'device_timestamp', v_punch.device_timestamp,
        'server_received_at', v_punch.server_received_at,
        'sync_origin', v_punch.sync_origin,
        'geofence_status', v_punch.geofence_status,
        'punch_type', v_punch.punch_type,
        'source', v_punch.source,
        'company_name', COALESCE(v_punch.company_name, 'Empresa Empregadora'),
        'worker_name_masked', v_masked_name,
        'worker_cpf_masked', v_masked_cpf,
        'sha256_hash', v_punch.sha256_hash
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_public_punch(TEXT) TO couplerh_app;

-- 7. Função Oficial Corrigida public.get_my_lgpd_dossier() (PONTO-05: positions.title e base_salary)
CREATE OR REPLACE FUNCTION public.get_my_lgpd_dossier()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := public.current_app_user_id();
    v_tenant_id UUID := public.current_app_tenant_id();
    v_worker_id UUID := public.current_app_worker_id();
    v_worker JSONB;
    v_contracts JSONB;
    v_consents JSONB;
    v_requests JSONB;
BEGIN
    IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Acesso nao autorizado: sessao sem contexto ativo.' USING ERRCODE = '42501';
    END IF;

    IF v_worker_id IS NULL THEN
        SELECT id INTO v_worker_id
        FROM public.workers
        WHERE tenant_id = v_tenant_id AND user_id = v_user_id
        LIMIT 1;
    END IF;

    IF v_worker_id IS NULL THEN
        RETURN jsonb_build_object('error', 'Titular nao vinculado a um trabalhador.');
    END IF;

    SELECT jsonb_build_object(
        'id', w.id,
        'nome_completo', w.full_name,
        'cpf', w.cpf,
        'email', w.email,
        'data_nascimento', w.birth_date,
        'pis', w.pis
    ) INTO v_worker
    FROM public.workers w
    WHERE w.id = v_worker_id AND w.tenant_id = v_tenant_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'contract_id', c.id,
        'matricula', c.registration_number,
        'empresa', COALESCE(co.trade_name, co.corporate_name),
        'cargo', pos.title,
        'departamento', dep.name,
        'salario_base', c.base_salary,
        'admissao', c.admission_date,
        'status', c.status
    )), '[]'::jsonb) INTO v_contracts
    FROM public.contracts c
    LEFT JOIN public.companies co ON co.id = c.company_id
    LEFT JOIN public.positions pos ON pos.id = c.position_id
    LEFT JOIN public.departments dep ON dep.id = c.department_id
    WHERE c.worker_id = v_worker_id AND c.tenant_id = v_tenant_id AND c.deleted_at IS NULL;

    SELECT COALESCE(jsonb_agg(row_to_json(lc.*) ORDER BY lc.granted_at DESC), '[]'::jsonb)
    INTO v_consents
    FROM public.lgpd_consents lc
    WHERE lc.worker_id = v_worker_id AND lc.tenant_id = v_tenant_id;

    SELECT COALESCE(jsonb_agg(row_to_json(lr.*) ORDER BY lr.requested_at DESC), '[]'::jsonb)
    INTO v_requests
    FROM public.lgpd_subject_requests lr
    WHERE lr.worker_id = v_worker_id AND lr.tenant_id = v_tenant_id;

    RETURN jsonb_build_object(
        'generated_at', NOW(),
        'titular', v_worker,
        'contratos', v_contracts,
        'consentimentos', v_consents,
        'solicitacoes_titular', v_requests,
        'base_legal_principal', 'Execução de Contrato de Trabalho (Art. 7º V LGPD) e Obrigação Legal (Art. 7º II LGPD)'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_lgpd_dossier() TO couplerh_app;
