-- ============================================================================
-- coupleRH v2.0 Enterprise — Baseline Schema 100% PostgreSQL 17 Puro
-- ============================================================================
-- Arquivo: 0001_baseline_schema.sql
-- Stack: PostgreSQL 17 puro (sem dependência de Supabase, Auth0 ou Vercel)
-- Padrão de Engenharia: Apdata / TOTVS / ADP Expert
-- ============================================================================

-- 1. EXTENSÕES OBRIGATÓRIAS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- 2. SCHEMA DE AUDITORIA & OBSERVABILIDADE
CREATE SCHEMA IF NOT EXISTS audit;

-- 3. FUNÇÕES DE CONTEXTO DE SESSÃO DA APLICAÇÃO (Substitui auth.uid() e auth.jwt())
CREATE OR REPLACE FUNCTION public.current_app_user_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.current_app_tenant_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.current_app_role() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_role_id', true), '')::text;
$$;

CREATE OR REPLACE FUNCTION public.current_app_worker_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_worker_id', true), '')::uuid;
$$;

-- 4. TABELA DE AUDITORIA IMUTÁVEL (audit.logs)
CREATE TABLE IF NOT EXISTS audit.logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID,
    user_id UUID,
    action TEXT NOT NULL,
    table_name TEXT NOT NULL,
    record_id TEXT,
    old_data JSONB,
    new_data JSONB,
    changed_fields TEXT[],
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit.logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record ON audit.logs(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit.logs(user_id);

-- Imutabilidade estrita de audit.logs (Bloqueia UPDATE e DELETE)
CREATE OR REPLACE FUNCTION audit.trg_block_audit_modification() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Operacao Proibida: audit.logs e estritamente imutavel e nao aceita UPDATE ou DELETE.';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit.logs;
CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit.logs
    FOR EACH ROW EXECUTE FUNCTION audit.trg_block_audit_modification();

-- Função genérica de trigger de auditoria
CREATE OR REPLACE FUNCTION audit.audit_trigger_func() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_action TEXT;
    v_old_data JSONB := NULL;
    v_new_data JSONB := NULL;
    v_record_id TEXT := NULL;
    v_tenant_id UUID := NULL;
    v_changed_fields TEXT[] := ARRAY[]::TEXT[];
    v_key TEXT;
BEGIN
    v_action := TG_OP;

    IF TG_OP = 'INSERT' THEN
        v_new_data := to_jsonb(NEW);
        v_record_id := COALESCE(NEW.id::text, '');
        IF v_new_data ? 'tenant_id' THEN
            v_tenant_id := (v_new_data->>'tenant_id')::uuid;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        v_old_data := to_jsonb(OLD);
        v_new_data := to_jsonb(NEW);
        v_record_id := COALESCE(NEW.id::text, OLD.id::text, '');
        IF v_new_data ? 'tenant_id' THEN
            v_tenant_id := (v_new_data->>'tenant_id')::uuid;
        ELSIF v_old_data ? 'tenant_id' THEN
            v_tenant_id := (v_old_data->>'tenant_id')::uuid;
        END IF;

        FOR v_key IN SELECT jsonb_object_keys(v_new_data)
        LOOP
            IF v_new_data->v_key IS DISTINCT FROM v_old_data->v_key THEN
                v_changed_fields := array_append(v_changed_fields, v_key);
            END IF;
        END LOOP;
    ELSIF TG_OP = 'DELETE' THEN
        v_old_data := to_jsonb(OLD);
        v_record_id := COALESCE(OLD.id::text, '');
        IF v_old_data ? 'tenant_id' THEN
            v_tenant_id := (v_old_data->>'tenant_id')::uuid;
        END IF;
    END IF;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := public.current_app_tenant_id();
    END IF;

    INSERT INTO audit.logs (
        tenant_id,
        user_id,
        action,
        table_name,
        record_id,
        old_data,
        new_data,
        changed_fields,
        created_at
    ) VALUES (
        v_tenant_id,
        public.current_app_user_id(),
        v_action,
        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
        v_record_id,
        v_old_data,
        v_new_data,
        v_changed_fields,
        NOW()
    );

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

-- 5. TABELAS NATIVAS DE IDENTIDADE, SEGURANÇA E ARQUIVOS (Substitui auth.* e storage.*)

CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT UNIQUE NOT NULL,
    cpf VARCHAR(11) UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT,
    email_verified_at TIMESTAMPTZ,
    failed_login_attempts INT NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_cpf ON public.users(cpf);

CREATE TABLE IF NOT EXISTS public.user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT UNIQUE NOT NULL,
    aal TEXT NOT NULL DEFAULT 'aal1' CHECK (aal IN ('aal1', 'aal2')),
    ip_address INET,
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON public.user_sessions(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_sessions_refresh ON public.user_sessions(refresh_token_hash);

CREATE TABLE IF NOT EXISTS public.user_mfa_factors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    factor_type TEXT NOT NULL DEFAULT 'TOTP' CHECK (factor_type IN ('TOTP', 'FIDO2')),
    friendly_name TEXT,
    secret_encrypted TEXT NOT NULL,
    recovery_codes_hash JSONB,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_mfa_factors_user ON public.user_mfa_factors(user_id);

CREATE TABLE IF NOT EXISTS public.auth_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token_type TEXT NOT NULL CHECK (token_type IN ('INVITE', 'PASSWORD_RESET', 'PORTAL_ACTIVATION', 'SIGN_OTP')),
    token_hash TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON public.auth_tokens(token_hash);

-- 6. TENANCY & ORGANIZAÇÃO

CREATE TABLE IF NOT EXISTS public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.tenant_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('system_admin', 'tenant_admin', 'dp_analyst', 'manager', 'employee', 'sst_specialist', 'auditor')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_lookup ON public.tenant_users(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS public.tenant_user_scopes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    tenant_user_id UUID NOT NULL REFERENCES public.tenant_users(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('ESTABLISHMENT', 'DEPARTMENT', 'SECTOR', 'COST_CENTER', 'TEAM')),
    scope_target_id UUID NOT NULL,
    can_view_salary BOOLEAN NOT NULL DEFAULT FALSE,
    can_view_medical BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_user_id, scope_type, scope_target_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_user_scopes_lookup ON public.tenant_user_scopes(tenant_user_id, scope_type);

CREATE TABLE IF NOT EXISTS public.stored_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
    worker_id UUID,
    category TEXT NOT NULL CHECK (category IN ('AVATAR', 'DOCUMENT', 'PAYSLIP_PDF', 'CERTIFICATE_A1', 'REPORT', 'AFD_FILE', 'CONTRACT')),
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size BIGINT NOT NULL,
    sha256_hash TEXT NOT NULL,
    storage_rel_path TEXT UNIQUE NOT NULL,
    is_private BOOLEAN NOT NULL DEFAULT TRUE,
    uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stored_files_lookup ON public.stored_files(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_stored_files_worker ON public.stored_files(worker_id);

CREATE TABLE IF NOT EXISTS public.companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    corporate_name TEXT NOT NULL,
    trade_name TEXT,
    cnpj TEXT NOT NULL,
    legal_nature TEXT,
    primary_cnae TEXT,
    tax_regime TEXT,
    address TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    fiscal_config JSONB DEFAULT '{}'::jsonb,
    labor_config JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(tenant_id, cnpj)
);

CREATE TABLE IF NOT EXISTS public.establishments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cnpj TEXT NOT NULL,
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(tenant_id, cnpj)
);

CREATE TABLE IF NOT EXISTS public.departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    code TEXT,
    cost_center_code TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.sectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
    department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.cost_centers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    cbo TEXT,
    description TEXT,
    level TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.workplaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    cost_center_id UUID REFERENCES public.cost_centers(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    address TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    radius_meters INT NOT NULL DEFAULT 50,
    enforce_geofence BOOLEAN NOT NULL DEFAULT FALSE,
    wifi_bssid TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.contract_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    is_clt BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.holidays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'NATIONAL' CHECK (type IN ('NATIONAL', 'STATE', 'MUNICIPAL', 'OPTIONAL')),
    state_code VARCHAR(2),
    city_code VARCHAR(7),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. TRABALHADORES & CONTRATOS

CREATE TABLE IF NOT EXISTS public.workers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id UUID UNIQUE REFERENCES public.users(id) ON DELETE SET NULL,
    full_name TEXT NOT NULL,
    cpf VARCHAR(11) NOT NULL,
    rg TEXT,
    rg_issuer TEXT,
    rg_state VARCHAR(2),
    pis VARCHAR(11),
    ctps_number TEXT,
    ctps_series TEXT,
    ctps_state VARCHAR(2),
    birth_date DATE,
    gender TEXT,
    marital_status TEXT,
    race_ethnicity TEXT,
    mother_name TEXT,
    father_name TEXT,
    email TEXT,
    phone TEXT,
    address_zip TEXT,
    address_street TEXT,
    address_number TEXT,
    address_complement TEXT,
    address_district TEXT,
    address_city TEXT,
    address_state VARCHAR(2),
    bank_code TEXT,
    bank_agency TEXT,
    bank_account TEXT,
    bank_account_type TEXT,
    pix_key TEXT,
    pix_key_type TEXT,
    is_apprentice BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(tenant_id, cpf)
);

CREATE INDEX IF NOT EXISTS idx_workers_tenant_cpf ON public.workers(tenant_id, cpf);
CREATE INDEX IF NOT EXISTS idx_workers_pis ON public.workers(pis);

CREATE TABLE IF NOT EXISTS public.contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    establishment_id UUID NOT NULL REFERENCES public.establishments(id) ON DELETE CASCADE,
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    sector_id UUID REFERENCES public.sectors(id) ON DELETE SET NULL,
    cost_center_id UUID REFERENCES public.cost_centers(id) ON DELETE SET NULL,
    position_id UUID NOT NULL REFERENCES public.positions(id) ON DELETE RESTRICT,
    workplace_id UUID REFERENCES public.workplaces(id) ON DELETE SET NULL,
    contract_type_id UUID REFERENCES public.contract_types(id) ON DELETE RESTRICT,
    registration_number TEXT NOT NULL,
    admission_date DATE NOT NULL,
    experience_end_date DATE,
    termination_date DATE,
    salary_type TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (salary_type IN ('MONTHLY', 'HOURLY', 'DAILY', 'COMMISSION')),
    base_salary NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    monthly_hours NUMERIC(6,2) NOT NULL DEFAULT 220.00,
    weekly_hours NUMERIC(6,2) NOT NULL DEFAULT 44.00,
    regime TEXT NOT NULL DEFAULT 'CLT' CHECK (regime IN ('CLT', 'PJ', 'ESTAGIO', 'APPRENTICE', 'TEMPORARY', 'AUTONOMOUS')),
    overtime_regime TEXT NOT NULL DEFAULT 'STANDARD' CHECK (overtime_regime IN ('STANDARD', 'EXEMPT', 'TIME_BANK')),
    is_telework BOOLEAN NOT NULL DEFAULT FALSE,
    receives_advance BOOLEAN NOT NULL DEFAULT TRUE,
    advance_percentage NUMERIC(5,2) DEFAULT 40.00,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LEAVE', 'VACATION', 'TERMINATED', 'SUSPENDED')),
    incidences JSONB NOT NULL DEFAULT '{"has_inss": true, "has_fgts": true, "has_irrf": true}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(tenant_id, company_id, registration_number)
);

CREATE INDEX IF NOT EXISTS idx_contracts_tenant_worker ON public.contracts(tenant_id, worker_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON public.contracts(status);

CREATE TABLE IF NOT EXISTS public.dependents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cpf VARCHAR(11),
    relationship TEXT NOT NULL,
    birth_date DATE NOT NULL,
    is_irrf_dependent BOOLEAN NOT NULL DEFAULT TRUE,
    is_family_salary BOOLEAN NOT NULL DEFAULT TRUE,
    is_incapacitated BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.contract_salaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    effective_date DATE NOT NULL,
    amount NUMERIC(15,2) NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.employee_deductions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    deduction_type TEXT NOT NULL CHECK (deduction_type IN ('ALIMONY', 'JUDICIAL_ATTACHMENT', 'CONSIGNMENT', 'OTHER')),
    calculation_basis TEXT NOT NULL DEFAULT 'NET_SALARY',
    percentage NUMERIC(6,2),
    fixed_amount NUMERIC(15,2),
    beneficiary_name TEXT,
    beneficiary_cpf VARCHAR(11),
    beneficiary_bank_info JSONB,
    apply_on_vacation BOOLEAN NOT NULL DEFAULT TRUE,
    apply_on_thirteenth BOOLEAN NOT NULL DEFAULT TRUE,
    apply_on_termination BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.leaves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    leave_type TEXT NOT NULL,
    esocial_reason_code TEXT,
    start_date DATE NOT NULL,
    end_date DATE,
    return_date DATE,
    cid10_code TEXT,
    doctor_crm TEXT,
    doctor_state VARCHAR(2),
    is_inss_responsible BOOLEAN NOT NULL DEFAULT FALSE,
    certificate_file_id UUID REFERENCES public.stored_files(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.vacation_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    acquisition_start DATE NOT NULL,
    acquisition_end DATE NOT NULL,
    concessive_end DATE NOT NULL,
    days_accrued INT NOT NULL DEFAULT 30,
    days_taken INT NOT NULL DEFAULT 0,
    days_remaining INT NOT NULL DEFAULT 30,
    absences_count INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'OPEN', 'IN_PROGRESS', 'CLOSED', 'EXPIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.vacation_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    vacation_period_id UUID NOT NULL REFERENCES public.vacation_periods(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days_count INT NOT NULL,
    sell_days_count INT NOT NULL DEFAULT 0,
    wants_thirteenth_advance BOOLEAN NOT NULL DEFAULT FALSE,
    gross_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    inss_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    irrf_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    net_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'CALCULATED', 'PAID', 'CANCELLED')),
    payment_date DATE,
    receipt_file_id UUID REFERENCES public.stored_files(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.terminations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    termination_reason TEXT NOT NULL,
    notice_type TEXT NOT NULL CHECK (notice_type IN ('WORKED', 'INDEMNIFIED', 'DISPENSED', 'NONE')),
    notice_date DATE NOT NULL,
    dismissal_date DATE NOT NULL,
    projected_end_date DATE NOT NULL,
    notice_days INT NOT NULL DEFAULT 30,
    gross_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    deductions_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    net_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    fgts_fine_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    trct_data JSONB,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CALCULATED', 'APPROVED', 'PAID', 'CANCELLED')),
    payment_date DATE,
    receipt_file_id UUID REFERENCES public.stored_files(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. PONTO ELETRÔNICO & JORNADAS (REP-P Portaria MTP 671/2021)

CREATE TABLE IF NOT EXISTS public.work_shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT,
    shift_type TEXT NOT NULL DEFAULT 'WEEKLY' CHECK (shift_type IN ('WEEKLY', 'ROTATING_12X36', 'FLEXIBLE', 'FREE')),
    weekly_hours NUMERIC(6,2) NOT NULL DEFAULT 44.00,
    schedule_data JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.contract_work_shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    work_shift_id UUID NOT NULL REFERENCES public.work_shifts(id) ON DELETE CASCADE,
    valid_from DATE NOT NULL,
    valid_to DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.time_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('REP_C', 'REP_P_MOBILE', 'IMPORT')),
    vendor TEXT,
    model TEXT,
    serial_number TEXT,
    host TEXT,
    port INT,
    last_nsr BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'MAINTENANCE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.time_punch_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    contract_id UUID REFERENCES public.contracts(id) ON DELETE CASCADE,
    worker_id UUID REFERENCES public.workers(id) ON DELETE CASCADE,
    device_id UUID REFERENCES public.time_devices(id) ON DELETE SET NULL,
    workplace_id UUID REFERENCES public.workplaces(id) ON DELETE SET NULL,
    nsr BIGINT NOT NULL,
    record_type INT NOT NULL DEFAULT 3,
    punched_at TIMESTAMPTZ NOT NULL,
    punch_type TEXT CHECK (punch_type IN ('ENTRY', 'INTERVAL_START', 'INTERVAL_END', 'EXIT')),
    source TEXT NOT NULL DEFAULT 'MOBILE' CHECK (source IN ('REP', 'MOBILE', 'IMPORT', 'MANUAL')),
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    accuracy DOUBLE PRECISION,
    is_mock_location BOOLEAN NOT NULL DEFAULT FALSE,
    geofence_status TEXT NOT NULL DEFAULT 'AUDIT_ONLY',
    ip_address INET,
    device_fingerprint TEXT,
    sha256_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_time_punch_contract_time ON public.time_punch_records(contract_id, punched_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_punch_tenant_nsr ON public.time_punch_records(tenant_id, nsr);

-- Imutabilidade estrita do ponto eletrônico (Portaria MTP 671/2021)
CREATE OR REPLACE FUNCTION public.trg_block_time_punch_tampering() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Operacao Proibida: time_punch_records e estritamente imutavel (Portaria MTP 671/2021). Alteracoes ou exclusoes sao vedadas por lei.';
END;
$$;

DROP TRIGGER IF EXISTS trg_time_punch_immutable ON public.time_punch_records;
CREATE TRIGGER trg_time_punch_immutable
    BEFORE UPDATE OR DELETE ON public.time_punch_records
    FOR EACH ROW EXECUTE FUNCTION public.trg_block_time_punch_tampering();

CREATE TABLE IF NOT EXISTS public.time_punch_daily_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    work_date DATE NOT NULL,
    expected_hours NUMERIC(6,2) NOT NULL DEFAULT 8.00,
    worked_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    normal_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    overtime_50_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    overtime_100_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    night_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    dsr_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    absence_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    delay_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    time_bank_balance_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'REGULAR' CHECK (status IN ('REGULAR', 'ABSENCE', 'HOLIDAY', 'WEEKEND', 'LEAVE', 'VACATION')),
    punches JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, contract_id, work_date)
);

CREATE TABLE IF NOT EXISTS public.time_bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    balance_minutes INT NOT NULL DEFAULT 0,
    initial_balance_minutes INT NOT NULL DEFAULT 0,
    closure_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, contract_id)
);

CREATE TABLE IF NOT EXISTS public.time_bank_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES public.time_bank_accounts(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('CREDIT', 'DEBIT', 'COMPENSATION', 'PAYOUT', 'EXPIRE')),
    minutes INT NOT NULL,
    reference_date DATE NOT NULL,
    description TEXT,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.time_punch_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    work_date DATE NOT NULL,
    adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('INSERT_PUNCH', 'JUSTIFY_ABSENCE', 'FORGIVE_DELAY', 'OVERTIME_AUTHORIZATION')),
    requested_punches JSONB,
    justification TEXT NOT NULL,
    attachment_file_id UUID REFERENCES public.stored_files(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    decided_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. PARÂMETROS LEGAIS CLT & TABELAS VIGENTES

CREATE TABLE IF NOT EXISTS public.legal_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.inss_parameters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_version_id UUID NOT NULL REFERENCES public.legal_versions(id) ON DELETE CASCADE,
    bracket_number INT NOT NULL,
    base_limit NUMERIC(15,2) NOT NULL,
    aliquot NUMERIC(6,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(legal_version_id, bracket_number)
);

CREATE TABLE IF NOT EXISTS public.irrf_parameters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_version_id UUID NOT NULL REFERENCES public.legal_versions(id) ON DELETE CASCADE,
    bracket_number INT NOT NULL,
    base_limit NUMERIC(15,2),
    aliquot NUMERIC(6,2) NOT NULL,
    deduction NUMERIC(15,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(legal_version_id, bracket_number)
);

CREATE TABLE IF NOT EXISTS public.general_legal_parameters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_version_id UUID NOT NULL UNIQUE REFERENCES public.legal_versions(id) ON DELETE CASCADE,
    minimum_wage NUMERIC(15,2) NOT NULL,
    inss_ceiling NUMERIC(15,2) NOT NULL,
    dependent_deduction NUMERIC(15,2) NOT NULL,
    simplified_discount NUMERIC(15,2) NOT NULL,
    family_salary_ceiling NUMERIC(15,2) NOT NULL,
    family_salary_value NUMERIC(15,2) NOT NULL,
    fgts_standard_aliquot NUMERIC(5,2) NOT NULL DEFAULT 8.00,
    fgts_apprentice_aliquot NUMERIC(5,2) NOT NULL DEFAULT 2.00,
    irrf_reduction_a NUMERIC(15,2) NOT NULL DEFAULT 978.62,
    irrf_reduction_b NUMERIC(10,6) NOT NULL DEFAULT 0.133145,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. FOLHA DE PAGAMENTO, BENEFÍCIOS & RUBRICAS

CREATE TABLE IF NOT EXISTS public.benefit_catalogs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    benefit_type TEXT NOT NULL CHECK (benefit_type IN ('MEAL_VOUCHER', 'FOOD_VOUCHER', 'TRANSPORTATION_VOUCHER', 'HEALTH_PLAN', 'DENTAL_PLAN', 'LIFE_INSURANCE', 'OTHER')),
    default_provider TEXT,
    rubric_id UUID,
    max_deduction_percentage NUMERIC(5,2),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.employee_benefits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    benefit_catalog_id UUID NOT NULL REFERENCES public.benefit_catalogs(id) ON DELETE RESTRICT,
    provider_name TEXT,
    plan_tier TEXT,
    contract_value NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    company_cost NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    employee_discount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    copay_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    start_date DATE NOT NULL,
    end_date DATE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.rubrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('EARNING', 'DEDUCTION', 'NEUTRAL')),
    category TEXT NOT NULL,
    rubric_kind TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'RETIRED')),
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    esocial_nature TEXT,
    legal_basis TEXT,
    calculation_form TEXT NOT NULL DEFAULT 'FORMULA',
    calculation_base TEXT,
    percentage NUMERIC(8,4),
    quantity NUMERIC(8,4),
    divisor NUMERIC(8,4),
    factor NUMERIC(8,4),
    formula TEXT,
    calculation_order INT NOT NULL DEFAULT 100,
    incidencias JSONB NOT NULL DEFAULT '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rubrics_code ON public.rubrics(code);

CREATE TABLE IF NOT EXISTS public.payroll_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    year INT NOT NULL,
    month INT NOT NULL,
    type TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (type IN ('MONTHLY', 'THIRTEENTH_1', 'THIRTEENTH_2', 'VACATION', 'TERMINATION', 'COMPLEMENTARY', 'ADVANCE')),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CALCULATING', 'CALCULATED', 'APPROVED', 'CLOSED')),
    payment_date DATE NOT NULL,
    competence_date DATE NOT NULL,
    legal_version_id UUID REFERENCES public.legal_versions(id) ON DELETE SET NULL,
    total_earnings NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    total_deductions NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    total_net NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    closed_at TIMESTAMPTZ,
    closed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, company_id, year, month, type)
);

CREATE TABLE IF NOT EXISTS public.payroll_variable_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    rubric_id UUID NOT NULL REFERENCES public.rubrics(id) ON DELETE RESTRICT,
    quantity NUMERIC(10,4),
    manual_value NUMERIC(15,2),
    origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL', 'TIME_TRACKING', 'IMPORT', 'SYSTEM')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.payroll_fixed_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    rubric_id UUID NOT NULL REFERENCES public.rubrics(id) ON DELETE RESTRICT,
    value_type TEXT NOT NULL DEFAULT 'AMOUNT' CHECK (value_type IN ('AMOUNT', 'PERCENT')),
    amount NUMERIC(15,2),
    percentage NUMERIC(6,2),
    valid_from DATE NOT NULL,
    valid_to DATE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.payslips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    gross_salary NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    total_earnings NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    total_deductions NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    net_salary NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    base_inss NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    base_irrf NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    base_fgts NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    fgts_month NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CALCULATED', 'APPROVED', 'LOCKED')),
    pdf_file_id UUID REFERENCES public.stored_files(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(payroll_period_id, contract_id)
);

CREATE TABLE IF NOT EXISTS public.payslip_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    payslip_id UUID NOT NULL REFERENCES public.payslips(id) ON DELETE CASCADE,
    rubric_id UUID NOT NULL REFERENCES public.rubrics(id) ON DELETE RESTRICT,
    rubric_code TEXT NOT NULL,
    rubric_name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('EARNING', 'DEDUCTION', 'NEUTRAL')),
    reference NUMERIC(10,4),
    amount NUMERIC(15,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.payroll_memory_calc (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    payslip_id UUID NOT NULL REFERENCES public.payslips(id) ON DELETE CASCADE,
    rubric_id UUID REFERENCES public.rubrics(id) ON DELETE SET NULL,
    step_name TEXT NOT NULL,
    base_value NUMERIC(15,2) NOT NULL,
    quantity_used NUMERIC(10,4) NOT NULL,
    percentage_used NUMERIC(8,4) NOT NULL,
    parsed_formula TEXT NOT NULL,
    result_value NUMERIC(15,2) NOT NULL,
    origin TEXT NOT NULL DEFAULT 'ENGINE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.payroll_company_taxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    payroll_period_id UUID NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    establishment_id UUID REFERENCES public.establishments(id) ON DELETE CASCADE,
    inss_patronal NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    rat_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    fap_factor NUMERIC(5,4) NOT NULL DEFAULT 1.0000,
    other_entities_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    fgts_total NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    total_cost NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.payroll_loans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    financial_institution TEXT NOT NULL,
    contract_number TEXT NOT NULL,
    total_amount NUMERIC(15,2) NOT NULL,
    installment_amount NUMERIC(15,2) NOT NULL,
    total_installments INT NOT NULL,
    paid_installments INT NOT NULL DEFAULT 0,
    start_date DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Triggers de Imutabilidade para Folha Fechada
CREATE OR REPLACE FUNCTION public.trg_block_closed_payroll_modification() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_period_status TEXT;
    v_period_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'payslips' THEN
        v_period_id := COALESCE(NEW.payroll_period_id, OLD.payroll_period_id);
    ELSIF TG_TABLE_NAME = 'payslip_items' OR TG_TABLE_NAME = 'payroll_memory_calc' THEN
        SELECT payroll_period_id INTO v_period_id FROM public.payslips WHERE id = COALESCE(NEW.payslip_id, OLD.payslip_id);
    ELSIF TG_TABLE_NAME = 'payroll_company_taxes' THEN
        v_period_id := COALESCE(NEW.payroll_period_id, OLD.payroll_period_id);
    END IF;

    IF v_period_id IS NOT NULL THEN
        SELECT status INTO v_period_status FROM public.payroll_periods WHERE id = v_period_id;
        IF v_period_status = 'CLOSED' THEN
            RAISE EXCEPTION 'Operacao Proibida: A folha de pagamento deste periodo esta FECHADA e auditada. Alteracoes sao estritamente vedadas.';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_payslips_closed_immutability ON public.payslips;
CREATE TRIGGER trg_payslips_closed_immutability
    BEFORE UPDATE OR DELETE ON public.payslips
    FOR EACH ROW EXECUTE FUNCTION public.trg_block_closed_payroll_modification();

DROP TRIGGER IF EXISTS trg_payslip_items_closed_immutability ON public.payslip_items;
CREATE TRIGGER trg_payslip_items_closed_immutability
    BEFORE UPDATE OR DELETE ON public.payslip_items
    FOR EACH ROW EXECUTE FUNCTION public.trg_block_closed_payroll_modification();

DROP TRIGGER IF EXISTS trg_payroll_memory_closed_immutability ON public.payroll_memory_calc;
CREATE TRIGGER trg_payroll_memory_closed_immutability
    BEFORE UPDATE OR DELETE ON public.payroll_memory_calc
    FOR EACH ROW EXECUTE FUNCTION public.trg_block_closed_payroll_modification();

DROP TRIGGER IF EXISTS trg_payroll_company_taxes_closed_immutability ON public.payroll_company_taxes;
CREATE TRIGGER trg_payroll_company_taxes_closed_immutability
    BEFORE UPDATE OR DELETE ON public.payroll_company_taxes
    FOR EACH ROW EXECUTE FUNCTION public.trg_block_closed_payroll_modification();

-- 11. ASSINATURAS DIGITAIS & DOCUMENTOS ELETRÔNICOS

CREATE TABLE IF NOT EXISTS public.employee_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
    contract_id UUID REFERENCES public.contracts(id) ON DELETE SET NULL,
    file_id UUID NOT NULL REFERENCES public.stored_files(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SIGNED', 'REJECTED', 'EXPIRED')),
    requires_signature BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.document_signatures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES public.employee_documents(id) ON DELETE CASCADE,
    signer_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    signer_name TEXT NOT NULL,
    signer_cpf VARCHAR(11) NOT NULL,
    signer_role TEXT NOT NULL DEFAULT 'EMPLOYEE',
    signature_type TEXT NOT NULL DEFAULT 'ELECTRONIC_PIN' CHECK (signature_type IN ('ELECTRONIC_PIN', 'BIOMETRIC_DRAW', 'CERTIFICATE_ICP')),
    signature_data TEXT,
    otp_hash TEXT,
    ip_address INET,
    user_agent TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    signed_hash_sha256 TEXT,
    signed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.signatures_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signature_id UUID NOT NULL REFERENCES public.document_signatures(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    event_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Imutabilidade do log de assinaturas
DROP TRIGGER IF EXISTS trg_signatures_log_immutable ON public.signatures_log;
CREATE TRIGGER trg_signatures_log_immutable
    BEFORE UPDATE OR DELETE ON public.signatures_log
    FOR EACH ROW EXECUTE FUNCTION audit.trg_block_audit_modification();

-- 12. ESOCIAL & OBRIGAÇÕES FISCAIS NA VPS ORACLE

CREATE TABLE IF NOT EXISTS public.esocial_certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES public.stored_files(id) ON DELETE RESTRICT,
    certificate_encrypted_password TEXT NOT NULL,
    subject_dn TEXT NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.esocial_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    event_id TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'HOMOLOGATION' CHECK (environment IN ('PRODUCTION', 'HOMOLOGATION')),
    xml_content TEXT NOT NULL,
    signed_xml TEXT,
    protocol_number TEXT,
    receipt_number TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SIGNED', 'SENT', 'ACCEPTED', 'REJECTED')),
    error_details JSONB,
    sent_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.esocial_totalizers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    period_year INT NOT NULL,
    period_month INT NOT NULL,
    raw_response JSONB NOT NULL,
    inss_segurados NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    inss_patronal NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    fgts_total NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. RPC / FUNÇÃO NATIVA DE IMPORTAÇÃO DE BATIDAS AFD (Portaria 671)
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
        -- Localiza trabalhador pelo PIS ou CPF
        SELECT c.id, c.worker_id INTO v_contract_id, v_worker_id
        FROM public.contracts c
        JOIN public.workers w ON w.id = c.worker_id
        WHERE c.tenant_id = p_tenant_id
          AND c.status = 'ACTIVE'
          AND (
            (v_item->>'cpf' IS NOT NULL AND w.cpf = regexp_replace(v_item->>'cpf', 'D', '', 'g'))
            OR
            (v_item->>'pis' IS NOT NULL AND w.pis = regexp_replace(v_item->>'pis', 'D', '', 'g'))
          )
        LIMIT 1;

        v_sha256 := encode(digest(p_tenant_id::text || (v_item->>'nsr') || (v_item->>'punched_at'), 'sha256'), 'hex');

        -- Tenta inserir batida se não existir pelo NSR no dispositivo
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

-- 14. ROW LEVEL SECURITY (RLS) NATIVA POSTGRESQL 17 PURO

-- Habilita e Força RLS nas tabelas multi-tenant
DO $$
DECLARE
    t TEXT;
    tables TEXT[] := ARRAY[
        'tenants', 'tenant_users', 'tenant_user_scopes', 'stored_files', 'companies',
        'establishments', 'departments', 'sectors', 'cost_centers', 'positions',
        'workplaces', 'contract_types', 'holidays', 'workers', 'contracts',
        'dependents', 'contract_salaries', 'employee_deductions', 'leaves',
        'vacation_periods', 'vacation_schedules', 'terminations', 'work_shifts',
        'contract_work_shifts', 'time_devices', 'time_punch_records',
        'time_punch_daily_summaries', 'time_bank_accounts', 'time_bank_transactions',
        'time_punch_adjustments', 'benefit_catalogs', 'employee_benefits',
        'rubrics', 'payroll_periods', 'payroll_variable_events', 'payroll_fixed_events',
        'payslips', 'payslip_items', 'payroll_memory_calc', 'payroll_company_taxes',
        'payroll_loans', 'employee_documents', 'document_signatures',
        'esocial_certificates', 'esocial_events', 'esocial_totalizers'
    ];
BEGIN
    FOREACH t IN ARRAY tables
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);
        
        -- Trigger de auditoria automatica
        EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%I ON public.%I;', t, t);
        EXECUTE format('CREATE TRIGGER trg_audit_%I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();', t, t);
    END LOOP;
END;
$$;

-- Políticas de RLS padrão por tenant_id
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'stored_files', 'companies', 'establishments', 'departments', 'sectors',
        'cost_centers', 'positions', 'workplaces', 'contract_types', 'workers',
        'contracts', 'dependents', 'contract_salaries', 'employee_deductions',
        'leaves', 'vacation_periods', 'vacation_schedules', 'terminations',
        'work_shifts', 'contract_work_shifts', 'time_devices', 'time_punch_records',
        'time_punch_daily_summaries', 'time_bank_accounts', 'time_bank_transactions',
        'time_punch_adjustments', 'benefit_catalogs', 'employee_benefits',
        'payroll_periods', 'payroll_variable_events', 'payroll_fixed_events',
        'payslips', 'payslip_items', 'payroll_memory_calc', 'payroll_company_taxes',
        'payroll_loans', 'employee_documents', 'document_signatures',
        'esocial_certificates', 'esocial_events', 'esocial_totalizers'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_tables
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON public.%I;', t);
        EXECUTE format('CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (tenant_id = public.current_app_tenant_id()) WITH CHECK (tenant_id = public.current_app_tenant_id());', t);
    END LOOP;
END;
$$;

-- Política de RLS para tenants
DROP POLICY IF EXISTS tenant_self_policy ON public.tenants;
CREATE POLICY tenant_self_policy ON public.tenants FOR ALL
    USING (id = public.current_app_tenant_id())
    WITH CHECK (id = public.current_app_tenant_id());

-- Política de RLS para tenant_users
DROP POLICY IF EXISTS tenant_users_policy ON public.tenant_users;
CREATE POLICY tenant_users_policy ON public.tenant_users FOR ALL
    USING (tenant_id = public.current_app_tenant_id())
    WITH CHECK (tenant_id = public.current_app_tenant_id());

-- Política de RLS para rubrics (permite ver rubricas de sistema com tenant_id IS NULL ou do tenant)
DROP POLICY IF EXISTS rubrics_isolation_policy ON public.rubrics;
CREATE POLICY rubrics_isolation_policy ON public.rubrics FOR ALL
    USING (tenant_id = public.current_app_tenant_id() OR is_system = TRUE)
    WITH CHECK (tenant_id = public.current_app_tenant_id());

-- 15. ROLE NÃO-SUPERUSER DA APLICAÇÃO (couplerh_app)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'couplerh_app') THEN
        CREATE ROLE couplerh_app WITH LOGIN PASSWORD 'couplerh_app_password_2026';
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO couplerh_app;
GRANT USAGE ON SCHEMA audit TO couplerh_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO couplerh_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO couplerh_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO couplerh_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO couplerh_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO couplerh_app;

-- ============================================================================
-- FIM DA BASELINE 0001_baseline_schema.sql
-- ============================================================================
