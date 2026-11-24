-- ==============================================================================
-- Migration 0010: RBAC Dinâmico, Matriz de Permissões Granulares e has_permission
-- ==============================================================================

-- 1. Tabela de Permissões (Catálogo Oficial de Ações do Sistema)
CREATE TABLE IF NOT EXISTS public.permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK (category IN (
        'ORGANIZATION', 'COMPENSATION_PAYROLL', 'ACCOUNTING_FISCAL',
        'TIME_TRACKING', 'OCCUPATIONAL_HEALTH_SST', 'GOVERNANCE_SYSTEM'
    )),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabela de Papéis (Roles Nativas de Sistema e Perfis Customizados por Tenant)
CREATE TABLE IF NOT EXISTS public.roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_roles_tenant_slug UNIQUE (tenant_id, slug)
);

-- Índice parcial para roles de sistema globais (tenant_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_system_roles_slug 
ON public.roles(slug) WHERE tenant_id IS NULL;

-- 3. Tabela Associativa Papel <-> Permissão
CREATE TABLE IF NOT EXISTS public.role_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_role_permission UNIQUE (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON public.role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission ON public.role_permissions(permission_id);

-- 4. Adicionar coluna role_id em tenant_users e remover enum restritivo hardcoded
ALTER TABLE public.tenant_users
ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES public.roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_users_role_id ON public.tenant_users(role_id);

-- Elimina a constraint legada que limitava roles a um enum estático (eliminando o bug do resolveRoleEnum)
ALTER TABLE public.tenant_users
DROP CONSTRAINT IF EXISTS tenant_users_role_check;

-- 5. RLS nas tabelas RBAC
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions FORCE ROW LEVEL SECURITY;

-- Permissões são públicas/leitura geral para qualquer contexto do tenant
DROP POLICY IF EXISTS permissions_read_policy ON public.permissions;
CREATE POLICY permissions_read_policy ON public.permissions
    FOR SELECT USING (TRUE);

-- Roles: permite ver roles do tenant ativo OU roles de sistema globais
DROP POLICY IF EXISTS roles_isolation_policy ON public.roles;
CREATE POLICY roles_isolation_policy ON public.roles
    FOR ALL
    USING (tenant_id = current_app_tenant_id() OR (is_system = TRUE AND tenant_id IS NULL))
    WITH CHECK (tenant_id = current_app_tenant_id() AND is_system = FALSE);

-- Role Permissions: leitura permitida se a role estiver acessível
DROP POLICY IF EXISTS role_permissions_isolation_policy ON public.role_permissions;
CREATE POLICY role_permissions_isolation_policy ON public.role_permissions
    FOR ALL
    USING (EXISTS (
        SELECT 1 FROM public.roles r 
        WHERE r.id = role_permissions.role_id 
          AND (r.tenant_id = current_app_tenant_id() OR (r.is_system = TRUE AND r.tenant_id IS NULL))
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.roles r 
        WHERE r.id = role_permissions.role_id 
          AND r.tenant_id = current_app_tenant_id() 
          AND r.is_system = FALSE
    ));

-- Triggers de auditoria imutável
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_audit_roles') THEN
        CREATE TRIGGER trg_audit_roles
            AFTER INSERT OR UPDATE OR DELETE ON public.roles
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_audit_role_permissions') THEN
        CREATE TRIGGER trg_audit_role_permissions
            AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions
            FOR EACH ROW EXECUTE FUNCTION audit.audit_trigger_func();
    END IF;
END $$;

-- 6. Inserção do Catálogo Oficial de ~28 Permissões Granulares
INSERT INTO public.permissions (name, slug, category, description) VALUES
    -- Organização & Cadastros
    ('Visualizar Dashboard', 'view_dashboard', 'ORGANIZATION', 'Acesso aos indicadores gerenciais e estatísticas'),
    ('Gerenciar Empresas', 'manage_companies', 'ORGANIZATION', 'Criar e editar cadastros de empresas e filiais'),
    ('Gerenciar Estrutura Organizacional', 'manage_org_structure', 'ORGANIZATION', 'Gerenciar departamentos, cargos, setores e centros de custo'),
    ('Visualizar Colaboradores', 'view_employees', 'ORGANIZATION', 'Listar e visualizar dados cadastrais de colaboradores'),
    ('Gerenciar Colaboradores', 'manage_employees', 'ORGANIZATION', 'Admitir, editar e transferir colaboradores'),
    ('Visualizar PII Desmascarado', 'view_pii_unmasked', 'ORGANIZATION', 'Visualizar CPF, PIS, RG e dados sensíveis sem máscara LGPD'),
    ('Gerenciar Documentos', 'manage_documents', 'ORGANIZATION', 'Criar, fazer upload e gerenciar documentos trabalhistas'),
    ('Aprovar Documentos Pessoais', 'approve_personal_docs', 'ORGANIZATION', 'Homologar documentos enviados pelo colaborador'),

    -- Sigilo Salarial & Folha
    ('Visualizar Salários', 'view_salaries', 'COMPENSATION_PAYROLL', 'Visualizar salários-base, históricos salariais e remunerações'),
    ('Visualizar Folha Executiva Confidencial', 'view_executive_payroll', 'COMPENSATION_PAYROLL', 'Acesso a contratos e salários de sócios e diretores'),
    ('Gerenciar Rubricas', 'manage_rubrics', 'COMPENSATION_PAYROLL', 'Criar, parametrizar e alterar rubricas de folha'),
    ('Gerenciar Parâmetros Legais', 'manage_legal_parameters', 'COMPENSATION_PAYROLL', 'Tabelas INSS, IRRF, Salário Mínimo e parâmetros trabalhistas'),
    ('Gerenciar Eventos de Folha', 'manage_payroll_events', 'COMPENSATION_PAYROLL', 'Lançar variáveis, comissões, adicionais e descontos'),
    ('Calcular Folha de Pagamento', 'calculate_payroll', 'COMPENSATION_PAYROLL', 'Processar e simular cálculo de folha mensal e 13º'),
    ('Fechar Folha de Pagamento', 'close_payroll', 'COMPENSATION_PAYROLL', 'Selar períodos de folha e travar modificações'),
    ('Reabrir Folha de Pagamento', 'reopen_payroll', 'COMPENSATION_PAYROLL', 'Reabrir formalmente períodos de folha fechados'),
    ('Visualizar Holerites', 'view_payslips', 'COMPENSATION_PAYROLL', 'Visualizar e exportar demonstrativos de pagamento de colaboradores'),
    ('Gerenciar Rescisões', 'manage_terminations', 'COMPENSATION_PAYROLL', 'Calcular, homologar e emitir termos rescisórios CLT'),
    ('Gerenciar Férias', 'manage_vacations', 'COMPENSATION_PAYROLL', 'Programar, calcular e emitir recibos e avisos de férias'),
    ('Gerenciar Afastamentos', 'manage_leaves', 'COMPENSATION_PAYROLL', 'Registrar afastamentos previdenciários e licenças médicas'),
    ('Gerenciar Benefícios', 'manage_benefits', 'COMPENSATION_PAYROLL', 'Gerenciar plano de saúde, vale transporte, alimentação e adesões'),
    ('Gerenciar Empréstimos Consignados', 'manage_loans', 'COMPENSATION_PAYROLL', 'Contratos de empréstimo e amortizações em folha'),

    -- Contabilidade & Fiscal
    ('Visualizar Contabilização de Folha', 'view_payroll_accounting', 'ACCOUNTING_FISCAL', 'Rateios contábeis, centros de custo e conciliação'),
    ('Exportar Relatórios Financeiros', 'export_financial_reports', 'ACCOUNTING_FISCAL', 'Exportar relatórios contábeis, provisões e CNAB'),
    ('Gerenciar eSocial', 'manage_esocial', 'ACCOUNTING_FISCAL', 'Transmitir, assinar e consultar eventos do eSocial S-1.3'),

    -- Ponto & Equipe
    ('Visualizar Ponto Eletrônico', 'view_time_tracking', 'TIME_TRACKING', 'Consultar espelhos de ponto, batidas e banco de horas'),
    ('Gerenciar Ponto Eletrônico', 'manage_time_tracking', 'TIME_TRACKING', 'Ajustar batidas, abonar faltas e configurar escalas e jornadas'),
    ('Aprovar Solicitações de Equipe', 'approve_team_requests', 'TIME_TRACKING', 'Gestor aprovar abonos, horas extras e solicitações de subordinados'),
    ('Fechar Período de Ponto', 'close_time_period', 'TIME_TRACKING', 'Encerrar período de ponto Portaria MTP 671/2021'),
    ('Exportar Fiscal de Ponto', 'export_time_fiscal', 'TIME_TRACKING', 'Exportar arquivos AFD/AFDT/ACJEF fiscais'),

    -- SST
    ('Visualizar SST', 'view_sst', 'OCCUPATIONAL_HEALTH_SST', 'Consultar riscos, exames ASO e dados de segurança do trabalho'),
    ('Gerenciar SST', 'manage_sst', 'OCCUPATIONAL_HEALTH_SST', 'Lançar laudos PGR/PCMSO, EPIs, CAT e eventos S-2210/S-2220/S-2240'),
    ('Visualizar CID Médico', 'view_medical_cid', 'OCCUPATIONAL_HEALTH_SST', 'Acesso sigiloso a diagnósticos médicos e códigos CID-10'),

    -- Governança & Portal
    ('Visualizar Trilha de Auditoria', 'view_audit_logs', 'GOVERNANCE_SYSTEM', 'Consultar logs imutáveis de alterações em audit.logs'),
    ('Gerenciar Usuários e Acessos', 'manage_users', 'GOVERNANCE_SYSTEM', 'Convidar, desativar e atribuir perfis a usuários'),
    ('Gerenciar Perfis e Permissões', 'manage_roles', 'GOVERNANCE_SYSTEM', 'Criar e customizar papéis e matrizes de permissão'),
    ('Gerenciar Configurações Gerais', 'manage_settings', 'GOVERNANCE_SYSTEM', 'Configurações do tenant, backups e integrações'),
    ('Portal do Colaborador (Autoatendimento)', 'self_service_portal', 'GOVERNANCE_SYSTEM', 'Acesso às próprias informações, espelho de ponto e holerites')
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description;

-- 7. Inserção dos Papéis de Sistema Globais (is_system = TRUE, tenant_id IS NULL)
INSERT INTO public.roles (name, slug, description, is_system, tenant_id) VALUES
    ('Super Administrador do Sistema', 'system_admin', 'Acesso irrestrito a todos os recursos e tenants', TRUE, NULL),
    ('Administrador da Empresa', 'tenant_admin', 'Gestão completa da empresa/tenant', TRUE, NULL),
    ('Analista de Departamento Pessoal', 'dp_analyst', 'Operação de folha, ponto, benefícios e admissões', TRUE, NULL),
    ('Gestor de Equipe', 'manager', 'Aprovações de ponto, férias e visualização de equipe', TRUE, NULL),
    ('Colaborador', 'employee', 'Autoatendimento no portal do colaborador', TRUE, NULL),
    ('Especialista em SST', 'sst_specialist', 'Gestão de segurança e saúde no trabalho', TRUE, NULL),
    ('Auditor Externo', 'auditor', 'Acesso de leitura para fiscalização e conformidade', TRUE, NULL)
ON CONFLICT (slug) WHERE tenant_id IS NULL DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description;

-- 8. Atribuição de Permissões aos Papéis de Sistema Padrão
-- 8.1 tenant_admin (Todas as permissões exceto super admin de sistema)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.slug = 'tenant_admin' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- 8.2 dp_analyst (Operação de DP/Folha/Ponto sem manage_users/manage_roles/manage_settings)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.slug = 'dp_analyst' AND r.tenant_id IS NULL
  AND p.slug NOT IN ('manage_users', 'manage_roles', 'manage_settings', 'view_executive_payroll', 'reopen_payroll')
ON CONFLICT DO NOTHING;

-- 8.3 manager (Gestão de equipe e aprovações de ponto/férias)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.slug = 'manager' AND r.tenant_id IS NULL
  AND p.slug IN ('view_dashboard', 'view_employees', 'view_time_tracking', 'approve_team_requests', 'manage_vacations')
ON CONFLICT DO NOTHING;

-- 8.4 employee (Autoatendimento no portal)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.slug = 'employee' AND r.tenant_id IS NULL
  AND p.slug IN ('self_service_portal')
ON CONFLICT DO NOTHING;

-- 8.5 sst_specialist (SST completo e CID médico)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.slug = 'sst_specialist' AND r.tenant_id IS NULL
  AND p.slug IN ('view_dashboard', 'view_employees', 'view_sst', 'manage_sst', 'view_medical_cid')
ON CONFLICT DO NOTHING;

-- 8.6 auditor (Somente leitura para auditoria e logs)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.slug = 'auditor' AND r.tenant_id IS NULL
  AND p.slug IN ('view_dashboard', 'view_employees', 'view_salaries', 'view_payslips', 'view_time_tracking', 'view_audit_logs', 'view_payroll_accounting')
ON CONFLICT DO NOTHING;

-- 9. Sincronizar role_id dos registros existentes em tenant_users
UPDATE public.tenant_users tu
SET role_id = r.id
FROM public.roles r
WHERE r.slug = tu.role
  AND r.tenant_id IS NULL
  AND tu.role_id IS NULL;

-- 10. Função SQL Oficial has_permission (PostgreSQL 17 Puro, STABLE, SECURITY DEFINER)
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
    LEFT JOIN public.roles r ON r.id = tu.role_id
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

-- Permissões de execução para couplerh_app
GRANT EXECUTE ON FUNCTION public.has_permission(UUID, TEXT) TO couplerh_app;
GRANT SELECT ON public.permissions TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.roles TO couplerh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO couplerh_app;
