-- ==============================================================================
-- Migration 0011: Escopo Organizacional Multidimensional e can_access_contract (RBAC-02)
-- ==============================================================================

-- 1. Atualizar public.contracts com manager_worker_id e is_confidential_payroll
ALTER TABLE public.contracts
ADD COLUMN IF NOT EXISTS manager_worker_id UUID REFERENCES public.workers(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS is_confidential_payroll BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_contracts_manager_worker_id ON public.contracts(tenant_id, manager_worker_id);
CREATE INDEX IF NOT EXISTS idx_contracts_confidential ON public.contracts(tenant_id, is_confidential_payroll);

-- 2. Atualizar departments e sectors com manager_worker_id
ALTER TABLE public.departments
ADD COLUMN IF NOT EXISTS manager_worker_id UUID REFERENCES public.workers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_departments_manager ON public.departments(tenant_id, manager_worker_id);

ALTER TABLE public.sectors
ADD COLUMN IF NOT EXISTS manager_worker_id UUID REFERENCES public.workers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sectors_manager ON public.sectors(tenant_id, manager_worker_id);

-- 3. Atualizar public.tenant_users com worker_id e scope_mode
ALTER TABLE public.tenant_users
ADD COLUMN IF NOT EXISTS worker_id UUID REFERENCES public.workers(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS scope_mode TEXT NOT NULL DEFAULT 'ALL' CHECK (scope_mode IN ('ALL', 'RESTRICTED', 'OWN_TEAM', 'SELF_ONLY'));

CREATE INDEX IF NOT EXISTS idx_tenant_users_worker_id ON public.tenant_users(worker_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_scope_mode ON public.tenant_users(scope_mode);

-- 4. Atualizar public.tenant_user_scopes para cobrir COMPANY, ESTABLISHMENT, WORKPLACE
ALTER TABLE public.tenant_user_scopes
DROP CONSTRAINT IF EXISTS tenant_user_scopes_scope_type_check;

ALTER TABLE public.tenant_user_scopes
ADD CONSTRAINT tenant_user_scopes_scope_type_check
CHECK (scope_type IN ('COMPANY', 'ESTABLISHMENT', 'DEPARTMENT', 'SECTOR', 'COST_CENTER', 'WORKPLACE', 'TEAM'));

-- RLS em public.tenant_user_scopes
ALTER TABLE public.tenant_user_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_user_scopes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_user_scopes_isolation_policy ON public.tenant_user_scopes;
CREATE POLICY tenant_user_scopes_isolation_policy ON public.tenant_user_scopes
    FOR ALL
    USING (tenant_id = current_app_tenant_id())
    WITH CHECK (tenant_id = current_app_tenant_id());

-- Trigger de auditoria imutável em tenant_user_scopes se não existir
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_audit_tenant_user_scopes') THEN
        CREATE TRIGGER trg_audit_tenant_user_scopes
            AFTER INSERT OR UPDATE OR DELETE ON public.tenant_user_scopes
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;
END $$;

-- 5. Função SQL Oficial public.can_access_contract(p_tenant_id, p_contract_id)
CREATE OR REPLACE FUNCTION public.can_access_contract(p_tenant_id UUID, p_contract_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := public.current_app_user_id();
    v_role TEXT;
    v_scope_mode TEXT;
    v_user_worker_id UUID;
    v_is_active BOOLEAN;
    v_worker_id UUID;
    v_company_id UUID;
    v_establishment_id UUID;
    v_department_id UUID;
    v_sector_id UUID;
    v_cost_center_id UUID;
    v_workplace_id UUID;
    v_manager_worker_id UUID;
    v_is_confidential BOOLEAN;
BEGIN
    -- Se não houver usuário autenticado no contexto
    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- 1. Obter vínculo do usuário no tenant
    SELECT 
        tu.role,
        COALESCE(tu.scope_mode, 'ALL'),
        COALESCE(tu.worker_id, (SELECT w.id FROM public.workers w WHERE w.user_id = v_user_id AND w.tenant_id = p_tenant_id LIMIT 1)),
        tu.is_active AND u.is_active
    INTO 
        v_role,
        v_scope_mode,
        v_user_worker_id,
        v_is_active
    FROM public.tenant_users tu
    JOIN public.users u ON u.id = tu.user_id
    WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id;

    IF NOT FOUND OR NOT COALESCE(v_is_active, FALSE) THEN
        RETURN FALSE;
    END IF;

    -- 2. Super Admin Global possui bypass irrestrito
    IF v_role = 'system_admin' THEN
        RETURN TRUE;
    END IF;

    -- 3. ALL: Acesso irrestrito a todos os contratos da empresa
    IF v_scope_mode = 'ALL' THEN
        -- Se for folha confidencial e o contrato existir, valida permissão
        IF EXISTS (
            SELECT 1 FROM public.contracts c
            WHERE c.id = p_contract_id AND c.tenant_id = p_tenant_id AND c.is_confidential_payroll = TRUE
        ) THEN
            RETURN public.has_permission(p_tenant_id, 'view_executive_payroll');
        END IF;
        RETURN TRUE;
    END IF;

    -- 4. Obter dados do contrato no tenant (para RESTRICTED, OWN_TEAM, SELF_ONLY)
    SELECT 
        c.worker_id, c.company_id, c.establishment_id, c.department_id,
        c.sector_id, c.cost_center_id, c.workplace_id, c.manager_worker_id,
        COALESCE(c.is_confidential_payroll, FALSE)
    INTO 
        v_worker_id, v_company_id, v_establishment_id, v_department_id,
        v_sector_id, v_cost_center_id, v_workplace_id, v_manager_worker_id,
        v_is_confidential
    FROM public.contracts c
    WHERE c.id = p_contract_id AND c.tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- 3. Validação de Folha Confidencial (Diretoria / Sócios)
    IF v_is_confidential THEN
        IF NOT public.has_permission(p_tenant_id, 'view_executive_payroll') THEN
            RETURN FALSE;
        END IF;
    END IF;

    -- 4. Super Admin Global possui bypass irrestrito
    IF v_role = 'system_admin' THEN
        RETURN TRUE;
    END IF;

    -- 5. Avaliação do Escopo Organizacional (scope_mode)
    
    -- 5.1 ALL: Acesso irrestrito a todos os contratos da empresa
    IF v_scope_mode = 'ALL' THEN
        RETURN TRUE;
    END IF;

    -- 5.2 SELF_ONLY: Apenas o próprio contrato do colaborador
    IF v_scope_mode = 'SELF_ONLY' THEN
        RETURN v_user_worker_id IS NOT NULL AND v_worker_id = v_user_worker_id;
    END IF;

    -- 5.3 OWN_TEAM: Próprio contrato + subordinados diretos ou do depto/setor gerenciado
    IF v_scope_mode = 'OWN_TEAM' THEN
        IF v_user_worker_id IS NULL THEN
            RETURN FALSE;
        END IF;

        -- Próprio contrato
        IF v_worker_id = v_user_worker_id THEN
            RETURN TRUE;
        END IF;

        -- Subordinado direto (gerente imediato registrado no contrato)
        IF v_manager_worker_id = v_user_worker_id THEN
            RETURN TRUE;
        END IF;

        -- Gestor do departamento
        IF v_department_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.departments d 
            WHERE d.id = v_department_id AND d.manager_worker_id = v_user_worker_id
        ) THEN
            RETURN TRUE;
        END IF;

        -- Gestor do setor
        IF v_sector_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.sectors s 
            WHERE s.id = v_sector_id AND s.manager_worker_id = v_user_worker_id
        ) THEN
            RETURN TRUE;
        END IF;

        RETURN FALSE;
    END IF;

    -- 5.4 RESTRICTED: Interseção estrita dos níveis configurados em tenant_user_scopes
    IF v_scope_mode = 'RESTRICTED' THEN
        -- Filtro COMPANY
        IF EXISTS (
            SELECT 1 FROM public.tenant_user_scopes tus 
            JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
            WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id AND tus.scope_type = 'COMPANY'
        ) THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.tenant_user_scopes tus 
                JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
                WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id 
                  AND tus.scope_type = 'COMPANY' AND tus.scope_target_id = v_company_id
            ) THEN
                RETURN FALSE;
            END IF;
        END IF;

        -- Filtro ESTABLISHMENT
        IF EXISTS (
            SELECT 1 FROM public.tenant_user_scopes tus 
            JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
            WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id AND tus.scope_type = 'ESTABLISHMENT'
        ) THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.tenant_user_scopes tus 
                JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
                WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id 
                  AND tus.scope_type = 'ESTABLISHMENT' AND tus.scope_target_id = v_establishment_id
            ) THEN
                RETURN FALSE;
            END IF;
        END IF;

        -- Filtro DEPARTMENT
        IF EXISTS (
            SELECT 1 FROM public.tenant_user_scopes tus 
            JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
            WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id AND tus.scope_type = 'DEPARTMENT'
        ) THEN
            IF v_department_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.tenant_user_scopes tus 
                JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
                WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id 
                  AND tus.scope_type = 'DEPARTMENT' AND tus.scope_target_id = v_department_id
            ) THEN
                RETURN FALSE;
            END IF;
        END IF;

        -- Filtro SECTOR
        IF EXISTS (
            SELECT 1 FROM public.tenant_user_scopes tus 
            JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
            WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id AND tus.scope_type = 'SECTOR'
        ) THEN
            IF v_sector_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.tenant_user_scopes tus 
                JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
                WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id 
                  AND tus.scope_type = 'SECTOR' AND tus.scope_target_id = v_sector_id
            ) THEN
                RETURN FALSE;
            END IF;
        END IF;

        -- Filtro COST_CENTER
        IF EXISTS (
            SELECT 1 FROM public.tenant_user_scopes tus 
            JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
            WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id AND tus.scope_type = 'COST_CENTER'
        ) THEN
            IF v_cost_center_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.tenant_user_scopes tus 
                JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
                WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id 
                  AND tus.scope_type = 'COST_CENTER' AND tus.scope_target_id = v_cost_center_id
            ) THEN
                RETURN FALSE;
            END IF;
        END IF;

        -- Filtro WORKPLACE
        IF EXISTS (
            SELECT 1 FROM public.tenant_user_scopes tus 
            JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
            WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id AND tus.scope_type = 'WORKPLACE'
        ) THEN
            IF v_workplace_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.tenant_user_scopes tus 
                JOIN public.tenant_users tu ON tu.id = tus.tenant_user_id 
                WHERE tu.user_id = v_user_id AND tu.tenant_id = p_tenant_id 
                  AND tus.scope_type = 'WORKPLACE' AND tus.scope_target_id = v_workplace_id
            ) THEN
                RETURN FALSE;
            END IF;
        END IF;

        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$;

-- 6. Função Utilitária para Listagem Filtrada de Contratos Acessíveis
CREATE OR REPLACE FUNCTION public.get_accessible_contract_ids(p_tenant_id UUID)
RETURNS TABLE (contract_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT c.id
    FROM public.contracts c
    WHERE c.tenant_id = p_tenant_id
      AND public.can_access_contract(p_tenant_id, c.id);
$$;

-- 7. Concessão de Privilégios para couplerh_app
GRANT EXECUTE ON FUNCTION public.can_access_contract(UUID, UUID) TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.get_accessible_contract_ids(UUID) TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_user_scopes TO couplerh_app;
