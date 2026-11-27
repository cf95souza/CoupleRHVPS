-- ==============================================================================
-- MIGRATION 0040: Cofre de Certificados A1 (AES-256-GCM), Lotes mTLS e Eventos eSocial
-- FASE V9 — ESOC-01, ESOC-02, ESOC-03
-- ==============================================================================

-- 1. Evolução de public.esocial_certificates (Cofre Seguro A1 ICP-Brasil)
ALTER TABLE public.esocial_certificates
    ALTER COLUMN file_id DROP NOT NULL,
    ALTER COLUMN certificate_encrypted_password DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'HOMOLOGATION',
    ADD COLUMN IF NOT EXISTS filename TEXT,
    ADD COLUMN IF NOT EXISTS subject_name TEXT,
    ADD COLUMN IF NOT EXISTS cnpj TEXT,
    ADD COLUMN IF NOT EXISTS issuer_dn TEXT,
    ADD COLUMN IF NOT EXISTS serial_number TEXT,
    ADD COLUMN IF NOT EXISTS thumbprint_sha256 TEXT,
    ADD COLUMN IF NOT EXISTS encrypted_pfx_envelope TEXT,
    ADD COLUMN IF NOT EXISTS key_version TEXT NOT NULL DEFAULT 'v1-aes256gcm',
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS revocation_reason TEXT,
    ADD COLUMN IF NOT EXISTS last_expiry_alert_tier INT,
    ADD COLUMN IF NOT EXISTS last_expiry_alert_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.esocial_certificates'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%environment%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.esocial_certificates DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.esocial_certificates
    ADD CONSTRAINT esocial_certificates_environment_check
    CHECK (environment IN ('PRODUCTION', 'HOMOLOGATION'));

CREATE INDEX IF NOT EXISTS idx_esocial_certificates_company_env
    ON public.esocial_certificates(tenant_id, company_id, environment, is_active);

-- 2. Tabela public.esocial_batches (Lotes de Transmissão Assíncrona mTLS / SERPRO)
CREATE TABLE IF NOT EXISTS public.esocial_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    certificate_id UUID REFERENCES public.esocial_certificates(id) ON DELETE SET NULL,
    environment TEXT NOT NULL DEFAULT 'HOMOLOGATION' CHECK (environment IN ('PRODUCTION', 'HOMOLOGATION')),
    layout_version TEXT NOT NULL DEFAULT 'S-1.3' CHECK (layout_version IN ('S-1.2', 'S-1.3')),
    group_type INT NOT NULL DEFAULT 1 CHECK (group_type IN (1, 2, 3)),
    protocol_number TEXT,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SENDING', 'SENT', 'POLLING', 'PROCESSED', 'PARTIAL', 'REJECTED', 'FAILED')),
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    next_retry_at TIMESTAMPTZ,
    request_xml TEXT,
    response_xml TEXT,
    http_status INT,
    cd_resposta TEXT,
    desc_resposta TEXT,
    error_message TEXT,
    sent_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_esocial_batches_tenant_company
    ON public.esocial_batches(tenant_id, company_id, environment, created_at DESC);

-- 3. Evolução de public.esocial_events (Layouts S-1.2/S-1.3, Validação XSD, XML-DSig & Recibos)
ALTER TABLE public.esocial_events
    ADD COLUMN IF NOT EXISTS layout_version TEXT NOT NULL DEFAULT 'S-1.3',
    ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES public.esocial_batches(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS payroll_period_id UUID REFERENCES public.payroll_periods(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES public.contracts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS worker_id UUID REFERENCES public.workers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reference_entity_type TEXT,
    ADD COLUMN IF NOT EXISTS reference_entity_id UUID,
    ADD COLUMN IF NOT EXISTS period_year INT,
    ADD COLUMN IF NOT EXISTS period_month INT,
    ADD COLUMN IF NOT EXISTS xml_sha256 TEXT,
    ADD COLUMN IF NOT EXISTS xsd_valid BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS xsd_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS signature_digest TEXT,
    ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS receipt_xml TEXT;

DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.esocial_events'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.esocial_events DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.esocial_events
    ADD CONSTRAINT esocial_events_status_check
    CHECK (status IN ('DRAFT', 'VALIDATED', 'SIGNED', 'QUEUED', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED'));

CREATE INDEX IF NOT EXISTS idx_esocial_events_lookup
    ON public.esocial_events(tenant_id, company_id, event_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_esocial_events_batch
    ON public.esocial_events(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_esocial_events_period
    ON public.esocial_events(tenant_id, payroll_period_id) WHERE payroll_period_id IS NOT NULL;

-- 4. Hardening RLS + Triggers de Auditoria T29 + Grants para couplerh_app
DO $$
DECLARE
    t TEXT;
    esoc_tables TEXT[] := ARRAY['esocial_certificates', 'esocial_batches', 'esocial_events'];
BEGIN
    FOREACH t IN ARRAY esoc_tables
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);

        EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%I ON public.%I;', t, t);
        EXECUTE format(
            'CREATE TRIGGER trg_audit_%I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();',
            t, t
        );

        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON public.%I;', t);
        EXECUTE format('DROP POLICY IF EXISTS %I_rls_policy ON public.%I;', t, t);
        EXECUTE format(
            'CREATE POLICY %I_rls_policy ON public.%I FOR ALL USING (tenant_id = public.current_app_tenant_id() AND (public.current_app_user_id() IS NULL OR public.has_permission(tenant_id, ''manage_esocial''))) WITH CHECK (tenant_id = public.current_app_tenant_id() AND (public.current_app_user_id() IS NULL OR public.has_permission(tenant_id, ''manage_esocial'')));',
            t, t
        );

        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO couplerh_app;', t);
    END LOOP;
END $$;
