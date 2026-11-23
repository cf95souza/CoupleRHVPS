-- ==============================================================================
-- Migration 0004: Flexibilidade de Identidade e Autenticação de Usuários
-- Permite que colaboradores operacionais usem CPF como identificador sem obrigatoriedade de e-mail
-- ==============================================================================

-- 1. Permite que o e-mail seja opcional para colaboradores com CPF
ALTER TABLE public.users ALTER COLUMN email DROP NOT NULL;

-- 2. Garante que todo usuário possua ao menos um identificador único (e-mail ou CPF)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_identification'
    ) THEN
        ALTER TABLE public.users 
        ADD CONSTRAINT chk_users_identification 
        CHECK (email IS NOT NULL OR cpf IS NOT NULL);
    END IF;
END $$;

-- 3. Índices de busca rápida para login corporativo e do portal
CREATE INDEX IF NOT EXISTS idx_users_email_active ON public.users(email) WHERE is_active = TRUE AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_cpf_active ON public.users(cpf) WHERE is_active = TRUE AND cpf IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_sessions_lookup ON public.user_sessions(user_id, revoked_at) WHERE revoked_at IS NULL;
