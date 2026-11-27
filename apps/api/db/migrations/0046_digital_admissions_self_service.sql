-- ============================================================================
-- Migration: 0046_digital_admissions_self_service.sql
-- Descrição: Tabelas de Admissão Digital Self-Service (Convites tokenizados,
--            submissão de dados do candidato, documentos e homologação DP)
-- ============================================================================

-- 1. Tabela de Convites de Admissão Digital
CREATE TABLE IF NOT EXISTS public.admission_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invite_token VARCHAR(64) UNIQUE NOT NULL,
  candidate_name VARCHAR(255) NOT NULL,
  candidate_email VARCHAR(255) NOT NULL,
  candidate_phone VARCHAR(30),
  candidate_cpf VARCHAR(14),
  position_id UUID REFERENCES public.positions(id) ON DELETE SET NULL,
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  proposed_salary_cents BIGINT NOT NULL DEFAULT 0,
  hire_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices de consulta rápida
CREATE INDEX IF NOT EXISTS idx_admission_invites_tenant ON public.admission_invites(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admission_invites_token ON public.admission_invites(invite_token);
CREATE INDEX IF NOT EXISTS idx_admission_invites_status ON public.admission_invites(status);
CREATE INDEX IF NOT EXISTS idx_admission_invites_company ON public.admission_invites(company_id);

-- 2. Tabela de Submissões e Dados do Candidato
CREATE TABLE IF NOT EXISTS public.admission_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id UUID UNIQUE NOT NULL REFERENCES public.admission_invites(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  personal_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  address_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  bank_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  dependents_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  transport_option JSONB NOT NULL DEFAULT '{"opt_in": false}'::jsonb,
  time_bank_agreement BOOLEAN NOT NULL DEFAULT false,
  document_file_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  lgpd_consent BOOLEAN NOT NULL DEFAULT true,
  lgpd_consent_text TEXT NOT NULL DEFAULT 'Declaro sob as penas da lei que as informações e documentos fornecidos são autênticos e autorizo expressamente o tratamento dos meus dados pessoais para fins de admissão e cumprimento do contrato de trabalho (Art. 7º, incisos I e V da LGPD).',
  signature_svg TEXT,
  signature_ip VARCHAR(45),
  signature_user_agent TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  worker_id UUID REFERENCES public.workers(id) ON DELETE SET NULL,
  contract_id UUID REFERENCES public.contracts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admission_submissions_tenant ON public.admission_submissions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admission_submissions_invite ON public.admission_submissions(invite_id);

-- 3. Habilitação de RLS e FORCE em ambas as tabelas
ALTER TABLE public.admission_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_invites FORCE ROW LEVEL SECURITY;

ALTER TABLE public.admission_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_submissions FORCE ROW LEVEL SECURITY;

-- 4. Políticas de RLS
DROP POLICY IF EXISTS tenant_isolation_admission_invites ON public.admission_invites;
CREATE POLICY tenant_isolation_admission_invites ON public.admission_invites
  FOR ALL
  TO couplerh_app
  USING (tenant_id = public.current_app_tenant_id())
  WITH CHECK (tenant_id = public.current_app_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_admission_submissions ON public.admission_submissions;
CREATE POLICY tenant_isolation_admission_submissions ON public.admission_submissions
  FOR ALL
  TO couplerh_app
  USING (tenant_id = public.current_app_tenant_id())
  WITH CHECK (tenant_id = public.current_app_tenant_id());

-- 5. Triggers de Auditoria Imutável e Atualização de Timestamp
DROP TRIGGER IF EXISTS trg_audit_admission_invites ON public.admission_invites;
CREATE TRIGGER trg_audit_admission_invites
  AFTER INSERT OR UPDATE OR DELETE ON public.admission_invites
  FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();

DROP TRIGGER IF EXISTS trg_audit_admission_submissions ON public.admission_submissions;
CREATE TRIGGER trg_audit_admission_submissions
  AFTER INSERT OR UPDATE OR DELETE ON public.admission_submissions
  FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
