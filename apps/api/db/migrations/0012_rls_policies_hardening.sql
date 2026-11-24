-- ==============================================================================
-- Migration 0012: Políticas RLS Nativas no PostgreSQL 17 Puro & Imutabilidade Append-Only (RBAC-03)
-- ==============================================================================

-- 1. Criação da Tabela public.document_events com Append-Only Imutável
CREATE TABLE IF NOT EXISTS public.document_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES public.employee_documents(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_id UUID,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_events_tenant_doc ON public.document_events(tenant_id, document_id);

-- Trigger de imutabilidade append-only em document_events
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_document_events_immutable') THEN
        CREATE TRIGGER trg_document_events_immutable
            BEFORE UPDATE OR DELETE ON public.document_events
            FOR EACH ROW EXECUTE FUNCTION audit.trg_block_audit_modification();
    END IF;
END $$;

-- 2. Hardening e RLS Append-Only em audit.logs
ALTER TABLE audit.logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_isolation_policy ON audit.logs;
DROP POLICY IF EXISTS audit_logs_select_policy ON audit.logs;
DROP POLICY IF EXISTS audit_logs_insert_policy ON audit.logs;

-- Leitura: somente para quem possui a permissão 'view_audit_logs' ou super_admin
CREATE POLICY audit_logs_select_policy ON audit.logs
    FOR SELECT
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'view_audit_logs')
        )
    );

-- Escrita: apenas INSERT (proibição absoluta de UPDATE e DELETE na RLS)
CREATE POLICY audit_logs_insert_policy ON audit.logs
    FOR INSERT
    WITH CHECK (
        tenant_id = current_app_tenant_id() OR current_app_tenant_id() IS NULL
    );

-- 3. Hardening e RLS Append-Only em public.signatures_log
ALTER TABLE public.signatures_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signatures_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signatures_log_select_policy ON public.signatures_log;
DROP POLICY IF EXISTS signatures_log_insert_policy ON public.signatures_log;

CREATE POLICY signatures_log_select_policy ON public.signatures_log
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.document_signatures ds
            WHERE ds.id = signatures_log.signature_id
              AND ds.tenant_id = current_app_tenant_id()
        )
    );

CREATE POLICY signatures_log_insert_policy ON public.signatures_log
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.document_signatures ds
            WHERE ds.id = signatures_log.signature_id
              AND ds.tenant_id = current_app_tenant_id()
        )
    );

-- 4. Hardening e RLS Append-Only em public.document_events
ALTER TABLE public.document_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_events_select_policy ON public.document_events;
DROP POLICY IF EXISTS document_events_insert_policy ON public.document_events;

CREATE POLICY document_events_select_policy ON public.document_events
    FOR SELECT
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_documents')
            OR EXISTS (
                SELECT 1 FROM public.employee_documents ed
                WHERE ed.id = document_events.document_id
                  AND ed.worker_id = public.current_app_worker_id()
            )
        )
    );

CREATE POLICY document_events_insert_policy ON public.document_events
    FOR INSERT
    WITH CHECK (
        tenant_id = current_app_tenant_id()
    );

-- 5. Hardening e RLS Append-Only em public.time_punch_records (Portaria MTP 671/2021)
-- Registro original de ponto é 100% imutável. Modificações ou exclusões são vedadas.
DROP POLICY IF EXISTS tenant_isolation_policy ON public.time_punch_records;
DROP POLICY IF EXISTS time_punch_records_select_policy ON public.time_punch_records;
DROP POLICY IF EXISTS time_punch_records_insert_policy ON public.time_punch_records;

CREATE POLICY time_punch_records_select_policy ON public.time_punch_records
    FOR SELECT
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                (contract_id IS NULL OR public.can_access_contract(tenant_id, contract_id))
                AND (
                    public.has_permission(tenant_id, 'view_time_tracking')
                    OR worker_id = public.current_app_worker_id()
                )
            )
        )
    );

CREATE POLICY time_punch_records_insert_policy ON public.time_punch_records
    FOR INSERT
    WITH CHECK (
        tenant_id = current_app_tenant_id()
    );

-- Trigger de imutabilidade append-only para time_punch_records caso não exista
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_time_punch_records_immutable') THEN
        CREATE TRIGGER trg_time_punch_records_immutable
            BEFORE UPDATE OR DELETE ON public.time_punch_records
            FOR EACH ROW EXECUTE FUNCTION audit.trg_block_audit_modification();
    END IF;
END $$;

-- Atualização da Função can_access_contract com avaliação antecipada de escopo ALL
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
    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- 1. Obter vínculo do usuário no tenant PRIMEIRO
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

    -- 5. Validação de Folha Confidencial
    IF v_is_confidential THEN
        IF NOT public.has_permission(p_tenant_id, 'view_executive_payroll') THEN
            RETURN FALSE;
        END IF;
    END IF;

    -- 6. SELF_ONLY: Apenas o próprio contrato do colaborador
    IF v_scope_mode = 'SELF_ONLY' THEN
        RETURN v_user_worker_id IS NOT NULL AND v_worker_id = v_user_worker_id;
    END IF;

    -- 7. OWN_TEAM: Próprio contrato + subordinados diretos ou do depto/setor gerenciado
    IF v_scope_mode = 'OWN_TEAM' THEN
        IF v_user_worker_id IS NULL THEN
            RETURN FALSE;
        END IF;

        IF v_worker_id = v_user_worker_id THEN
            RETURN TRUE;
        END IF;

        IF v_manager_worker_id = v_user_worker_id THEN
            RETURN TRUE;
        END IF;

        IF v_department_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.departments d 
            WHERE d.id = v_department_id AND d.manager_worker_id = v_user_worker_id
        ) THEN
            RETURN TRUE;
        END IF;

        IF v_sector_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.sectors s 
            WHERE s.id = v_sector_id AND s.manager_worker_id = v_user_worker_id
        ) THEN
            RETURN TRUE;
        END IF;

        RETURN FALSE;
    END IF;

    -- 8. RESTRICTED: Acesso baseado em escopos explícitos concedidos na tabela tenant_user_scopes (Interseção Dimensional)
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

-- 6. Políticas RLS Combinadas em public.contracts
DROP POLICY IF EXISTS tenant_isolation_policy ON public.contracts;
DROP POLICY IF EXISTS contracts_select_policy ON public.contracts;
DROP POLICY IF EXISTS contracts_modify_policy ON public.contracts;
DROP POLICY IF EXISTS contracts_insert_policy ON public.contracts;
DROP POLICY IF EXISTS contracts_update_policy ON public.contracts;
DROP POLICY IF EXISTS contracts_delete_policy ON public.contracts;

CREATE POLICY contracts_select_policy ON public.contracts
    FOR SELECT
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.can_access_contract(tenant_id, id)
        )
    );

CREATE POLICY contracts_insert_policy ON public.contracts
    FOR INSERT
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_employees')
        )
    );

CREATE POLICY contracts_update_policy ON public.contracts
    FOR UPDATE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_employees')
        )
    )
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_employees')
        )
    );

CREATE POLICY contracts_delete_policy ON public.contracts
    FOR DELETE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_employees')
        )
    );

-- 7. Políticas RLS Combinadas em public.payslips e public.payslip_items
DROP POLICY IF EXISTS tenant_isolation_policy ON public.payslips;
DROP POLICY IF EXISTS payslips_select_policy ON public.payslips;
DROP POLICY IF EXISTS payslips_modify_policy ON public.payslips;
DROP POLICY IF EXISTS payslips_insert_policy ON public.payslips;
DROP POLICY IF EXISTS payslips_update_policy ON public.payslips;
DROP POLICY IF EXISTS payslips_delete_policy ON public.payslips;

CREATE POLICY payslips_select_policy ON public.payslips
    FOR SELECT
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'view_payslips')
                    OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = payslips.contract_id) = public.current_app_worker_id()
                )
            )
        )
    );

CREATE POLICY payslips_insert_policy ON public.payslips
    FOR INSERT
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

CREATE POLICY payslips_update_policy ON public.payslips
    FOR UPDATE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    )
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

CREATE POLICY payslips_delete_policy ON public.payslips
    FOR DELETE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'calculate_payroll')
        )
    );

DROP POLICY IF EXISTS tenant_isolation_policy ON public.payslip_items;
DROP POLICY IF EXISTS payslip_items_select_policy ON public.payslip_items;
DROP POLICY IF EXISTS payslip_items_modify_policy ON public.payslip_items;
DROP POLICY IF EXISTS payslip_items_insert_policy ON public.payslip_items;
DROP POLICY IF EXISTS payslip_items_update_policy ON public.payslip_items;
DROP POLICY IF EXISTS payslip_items_delete_policy ON public.payslip_items;

CREATE POLICY payslip_items_select_policy ON public.payslip_items
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.payslips p
            WHERE p.id = payslip_items.payslip_id
              AND p.tenant_id = current_app_tenant_id()
              AND (
                  public.current_app_user_id() IS NULL
                  OR (
                      public.can_access_contract(p.tenant_id, p.contract_id)
                      AND (
                          public.has_permission(p.tenant_id, 'view_payslips')
                          OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = p.contract_id) = public.current_app_worker_id()
                      )
                  )
              )
        )
    );

CREATE POLICY payslip_items_insert_policy ON public.payslip_items
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.payslips p
            WHERE p.id = payslip_items.payslip_id
              AND p.tenant_id = current_app_tenant_id()
              AND (
                  public.current_app_user_id() IS NULL
                  OR public.has_permission(p.tenant_id, 'calculate_payroll')
              )
        )
    );

CREATE POLICY payslip_items_update_policy ON public.payslip_items
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.payslips p
            WHERE p.id = payslip_items.payslip_id
              AND p.tenant_id = current_app_tenant_id()
              AND (
                  public.current_app_user_id() IS NULL
                  OR public.has_permission(p.tenant_id, 'calculate_payroll')
              )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.payslips p
            WHERE p.id = payslip_items.payslip_id
              AND p.tenant_id = current_app_tenant_id()
              AND (
                  public.current_app_user_id() IS NULL
                  OR public.has_permission(p.tenant_id, 'calculate_payroll')
              )
        )
    );

CREATE POLICY payslip_items_delete_policy ON public.payslip_items
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.payslips p
            WHERE p.id = payslip_items.payslip_id
              AND p.tenant_id = current_app_tenant_id()
              AND (
                  public.current_app_user_id() IS NULL
                  OR public.has_permission(p.tenant_id, 'calculate_payroll')
              )
        )
    );

-- 8. Políticas RLS Combinadas em public.terminations
DROP POLICY IF EXISTS tenant_isolation_policy ON public.terminations;
DROP POLICY IF EXISTS terminations_select_policy ON public.terminations;
DROP POLICY IF EXISTS terminations_modify_policy ON public.terminations;
DROP POLICY IF EXISTS terminations_insert_policy ON public.terminations;
DROP POLICY IF EXISTS terminations_update_policy ON public.terminations;
DROP POLICY IF EXISTS terminations_delete_policy ON public.terminations;

CREATE POLICY terminations_select_policy ON public.terminations
    FOR SELECT
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'manage_terminations')
                    OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = terminations.contract_id) = public.current_app_worker_id()
                )
            )
        )
    );

CREATE POLICY terminations_insert_policy ON public.terminations
    FOR INSERT
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_terminations')
        )
    );

CREATE POLICY terminations_update_policy ON public.terminations
    FOR UPDATE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_terminations')
        )
    )
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_terminations')
        )
    );

CREATE POLICY terminations_delete_policy ON public.terminations
    FOR DELETE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_terminations')
        )
    );

-- 9. Políticas RLS Combinadas em public.vacation_periods e public.vacation_schedules
DROP POLICY IF EXISTS tenant_isolation_policy ON public.vacation_periods;
DROP POLICY IF EXISTS vacation_periods_select_policy ON public.vacation_periods;
DROP POLICY IF EXISTS vacation_periods_modify_policy ON public.vacation_periods;
DROP POLICY IF EXISTS vacation_periods_insert_policy ON public.vacation_periods;
DROP POLICY IF EXISTS vacation_periods_update_policy ON public.vacation_periods;
DROP POLICY IF EXISTS vacation_periods_delete_policy ON public.vacation_periods;

CREATE POLICY vacation_periods_select_policy ON public.vacation_periods
    FOR SELECT
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'manage_vacations')
                    OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = vacation_periods.contract_id) = public.current_app_worker_id()
                )
            )
        )
    );

CREATE POLICY vacation_periods_insert_policy ON public.vacation_periods
    FOR INSERT
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    );

CREATE POLICY vacation_periods_update_policy ON public.vacation_periods
    FOR UPDATE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    )
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    );

CREATE POLICY vacation_periods_delete_policy ON public.vacation_periods
    FOR DELETE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    );

DROP POLICY IF EXISTS tenant_isolation_policy ON public.vacation_schedules;
DROP POLICY IF EXISTS vacation_schedules_select_policy ON public.vacation_schedules;
DROP POLICY IF EXISTS vacation_schedules_modify_policy ON public.vacation_schedules;
DROP POLICY IF EXISTS vacation_schedules_insert_policy ON public.vacation_schedules;
DROP POLICY IF EXISTS vacation_schedules_update_policy ON public.vacation_schedules;
DROP POLICY IF EXISTS vacation_schedules_delete_policy ON public.vacation_schedules;

CREATE POLICY vacation_schedules_select_policy ON public.vacation_schedules
    FOR SELECT
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                public.can_access_contract(tenant_id, contract_id)
                AND (
                    public.has_permission(tenant_id, 'manage_vacations')
                    OR (SELECT c.worker_id FROM public.contracts c WHERE c.id = vacation_schedules.contract_id) = public.current_app_worker_id()
                )
            )
        )
    );

CREATE POLICY vacation_schedules_insert_policy ON public.vacation_schedules
    FOR INSERT
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    );

CREATE POLICY vacation_schedules_update_policy ON public.vacation_schedules
    FOR UPDATE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    )
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    );

CREATE POLICY vacation_schedules_delete_policy ON public.vacation_schedules
    FOR DELETE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_vacations')
        )
    );

-- 10. Políticas RLS Combinadas em public.employee_documents
DROP POLICY IF EXISTS tenant_isolation_policy ON public.employee_documents;
DROP POLICY IF EXISTS employee_documents_select_policy ON public.employee_documents;
DROP POLICY IF EXISTS employee_documents_modify_policy ON public.employee_documents;
DROP POLICY IF EXISTS employee_documents_insert_policy ON public.employee_documents;
DROP POLICY IF EXISTS employee_documents_update_policy ON public.employee_documents;
DROP POLICY IF EXISTS employee_documents_delete_policy ON public.employee_documents;

CREATE POLICY employee_documents_select_policy ON public.employee_documents
    FOR SELECT
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR (
                (contract_id IS NULL OR public.can_access_contract(tenant_id, contract_id))
                AND (
                    public.has_permission(tenant_id, 'manage_documents')
                    OR worker_id = public.current_app_worker_id()
                )
            )
        )
    );

CREATE POLICY employee_documents_insert_policy ON public.employee_documents
    FOR INSERT
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_documents')
        )
    );

CREATE POLICY employee_documents_update_policy ON public.employee_documents
    FOR UPDATE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_documents')
        )
    )
    WITH CHECK (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_documents')
        )
    );

CREATE POLICY employee_documents_delete_policy ON public.employee_documents
    FOR DELETE
    USING (
        tenant_id = current_app_tenant_id()
        AND (
            public.current_app_user_id() IS NULL
            OR public.has_permission(tenant_id, 'manage_documents')
        )
    );

-- Sincronização automática e retrocompatibilidade de role_id em tenant_users
CREATE OR REPLACE FUNCTION public.trg_sync_tenant_user_role_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF (NEW.role_id IS NULL OR (TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role)) AND NEW.role IS NOT NULL THEN
        SELECT id INTO NEW.role_id
        FROM public.roles
        WHERE tenant_id IS NULL AND slug = NEW.role
        LIMIT 1;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_users_sync_role_id ON public.tenant_users;
CREATE TRIGGER trg_tenant_users_sync_role_id
    BEFORE INSERT OR UPDATE ON public.tenant_users
    FOR EACH ROW EXECUTE FUNCTION public.trg_sync_tenant_user_role_id();

UPDATE public.tenant_users tu
SET role_id = r.id
FROM public.roles r
WHERE r.tenant_id IS NULL
  AND r.slug = tu.role
  AND (tu.role_id IS NULL OR tu.role_id != r.id);

-- Atualização de has_permission com fallback resiliente para tu.role legado
CREATE OR REPLACE FUNCTION public.has_permission(p_tenant_id UUID, p_permission_slug TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_users tu
    JOIN public.users u ON u.id = tu.user_id
    LEFT JOIN public.roles r ON (r.id = tu.role_id OR (r.tenant_id IS NULL AND r.slug = tu.role))
    LEFT JOIN public.role_permissions rp ON rp.role_id = r.id
    LEFT JOIN public.permissions p ON p.id = rp.permission_id
    WHERE tu.user_id = public.current_app_user_id()
      AND tu.tenant_id = p_tenant_id
      AND tu.is_active = TRUE
      AND u.is_active = TRUE
      AND (
        -- 1. Super Admin Global tem acesso irrestrito
        tu.role = 'system_admin'
        OR r.slug = 'system_admin'
        -- 2. Permissão explícita concedida pelo papel
        OR p.slug = p_permission_slug
      )
  );
$$;

-- Função SECURITY DEFINER para validação segura de assinatura de documentos (com tenant isolation)
CREATE OR REPLACE FUNCTION public.get_document_for_signature(p_document_id UUID)
RETURNS TABLE (
    id UUID,
    worker_id UUID,
    status TEXT,
    tenant_id UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT d.id, d.worker_id, d.status, d.tenant_id
    FROM public.employee_documents d
    WHERE d.id = p_document_id
      AND d.tenant_id = current_app_tenant_id();
$$;

-- 11. Concessão de Privilégios no PostgreSQL 17 para couplerh_app
GRANT USAGE ON SCHEMA audit TO couplerh_app;
GRANT SELECT, INSERT ON audit.logs TO couplerh_app;
GRANT SELECT, INSERT ON public.signatures_log TO couplerh_app;
GRANT SELECT, INSERT ON public.document_events TO couplerh_app;
GRANT EXECUTE ON FUNCTION public.get_document_for_signature(UUID) TO couplerh_app;
