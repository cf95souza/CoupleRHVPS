-- =============================================================================
-- Migration 0013: Funções SQL e Views de Mascaramento LGPD & Sigilo Salarial
-- Sistema: coupleRH Enterprise v2.0
-- Conformidade: LGPD (Lei 13.709/2018) Art. 11 & Resolução CFM 1.851/2008
-- =============================================================================

-- 1. Funções Determinísticas de Sanitização e Mascaramento SQL
CREATE OR REPLACE FUNCTION public.mask_cpf(p_cpf TEXT)
RETURNS TEXT AS $$
DECLARE
    v_clean TEXT;
BEGIN
    IF p_cpf IS NULL THEN
        RETURN NULL;
    END IF;
    v_clean := regexp_replace(p_cpf, '\D', '', 'g');
    IF length(v_clean) <> 11 THEN
        RETURN '***.***.***-**';
    END IF;
    RETURN '***.' || substr(v_clean, 4, 3) || '.' || substr(v_clean, 7, 3) || '-**';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.mask_pis(p_pis TEXT)
RETURNS TEXT AS $$
DECLARE
    v_clean TEXT;
BEGIN
    IF p_pis IS NULL THEN
        RETURN NULL;
    END IF;
    v_clean := regexp_replace(p_pis, '\D', '', 'g');
    IF length(v_clean) < 10 THEN
        RETURN '***.*****.**-*';
    END IF;
    RETURN '***.*****.' || substr(v_clean, length(v_clean) - 1, 1) || '-' || right(v_clean, 1);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.mask_pix(p_pix TEXT)
RETURNS TEXT AS $$
DECLARE
    v_trimmed TEXT;
BEGIN
    IF p_pix IS NULL THEN
        RETURN NULL;
    END IF;
    v_trimmed := trim(p_pix);
    IF length(v_trimmed) <= 4 THEN
        RETURN '***';
    END IF;
    RETURN substr(v_trimmed, 1, 2) || '***' || right(v_trimmed, 2);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.mask_bank_account(p_acc TEXT)
RETURNS TEXT AS $$
BEGIN
    IF p_acc IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN '*****-' || right(trim(p_acc), 1);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.mask_bank_agency(p_agency TEXT)
RETURNS TEXT AS $$
BEGIN
    IF p_agency IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN '***-' || right(trim(p_agency), 1);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 2. View SQL de Contratos com Sigilo Salarial e Mascaramento LGPD
CREATE OR REPLACE VIEW public.view_contracts_masked AS
SELECT
    c.id,
    c.tenant_id,
    c.worker_id,
    c.company_id,
    c.establishment_id,
    c.department_id,
    c.sector_id,
    c.cost_center_id,
    c.position_id,
    c.workplace_id,
    c.contract_type_id,
    c.manager_worker_id,
    c.registration_number,
    c.admission_date,
    c.experience_end_date,
    c.termination_date,
    c.salary_type,
    c.monthly_hours,
    c.weekly_hours,
    c.regime,
    c.overtime_regime,
    c.is_telework,
    c.receives_advance,
    c.advance_percentage,
    c.status,
    c.is_confidential_payroll,
    c.created_at,
    c.updated_at,
    -- Sigilo Salarial (view_salaries)
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(c.tenant_id, 'view_salaries')
        THEN c.base_salary
        ELSE NULL
    END AS base_salary,
    -- Dados do Trabalhador / PII Mascarado (view_pii_unmasked)
    w.full_name,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(c.tenant_id, 'view_pii_unmasked')
        THEN w.cpf
        ELSE public.mask_cpf(w.cpf)
    END AS cpf,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(c.tenant_id, 'view_pii_unmasked')
        THEN w.rg
        ELSE '***'
    END AS rg,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(c.tenant_id, 'view_pii_unmasked')
        THEN w.pis
        ELSE public.mask_pis(w.pis)
    END AS pis,
    w.birth_date,
    w.gender,
    w.marital_status,
    w.email,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(c.tenant_id, 'view_pii_unmasked')
        THEN w.phone
        ELSE CASE WHEN w.phone IS NOT NULL THEN '(**) *****-' || right(regexp_replace(w.phone, '\D', '', 'g'), 4) ELSE NULL END
    END AS phone,
    w.bank_code,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(c.tenant_id, 'view_pii_unmasked')
        THEN w.bank_agency
        ELSE public.mask_bank_agency(w.bank_agency)
    END AS bank_agency,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(c.tenant_id, 'view_pii_unmasked')
        THEN w.bank_account
        ELSE public.mask_bank_account(w.bank_account)
    END AS bank_account,
    w.bank_account_type,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(c.tenant_id, 'view_pii_unmasked')
        THEN w.pix_key
        ELSE public.mask_pix(w.pix_key)
    END AS pix_key,
    w.pix_key_type,
    w.is_apprentice,
    w.is_active AS worker_is_active
FROM public.contracts c
JOIN public.workers w ON w.id = c.worker_id
WHERE (
    c.is_confidential_payroll = FALSE
    OR public.current_app_user_id() IS NULL
    OR public.has_permission(c.tenant_id, 'view_executive_payroll')
);

-- 3. View SQL de Afastamentos / Atestados com Sigilo Médico (Resolução CFM 1.851/2008 & LGPD Art. 11)
CREATE OR REPLACE VIEW public.view_leaves_masked AS
SELECT
    l.id,
    l.tenant_id,
    l.contract_id,
    l.leave_type,
    l.esocial_reason_code,
    l.start_date,
    l.end_date,
    l.return_date,
    l.is_inss_responsible,
    l.status,
    l.created_at,
    l.updated_at,
    -- CID-10 e dados médicos restritos a medicina e segurança do trabalho (view_medical_cid)
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(l.tenant_id, 'view_medical_cid')
        THEN l.cid10_code
        ELSE NULL
    END AS cid10_code,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(l.tenant_id, 'view_medical_cid')
        THEN l.doctor_crm
        ELSE NULL
    END AS doctor_crm,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(l.tenant_id, 'view_medical_cid')
        THEN l.doctor_state
        ELSE NULL
    END AS doctor_state,
    CASE
        WHEN public.current_app_user_id() IS NULL
             OR public.has_permission(l.tenant_id, 'view_medical_cid')
        THEN l.certificate_file_id
        ELSE NULL
    END AS certificate_file_id
FROM public.leaves l;

-- 4. Concessão de Privilégios ao Usuário da Aplicação
GRANT EXECUTE ON FUNCTION public.mask_cpf(TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.mask_pis(TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.mask_pix(TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.mask_bank_account(TEXT) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.mask_bank_agency(TEXT) TO couplerh_app;

GRANT SELECT ON public.view_contracts_masked TO couplerh_app;
GRANT SELECT ON public.view_leaves_masked TO couplerh_app;
