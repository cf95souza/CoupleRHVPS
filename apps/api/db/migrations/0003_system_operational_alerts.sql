-- ==============================================================================
-- Migration 0003: Tabela de Alertas Operacionais do Sistema (Observabilidade)
-- Suporte ao monitoramento leve, Uptime Kuma e registro de incidentes operacionais
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.system_operational_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
    category VARCHAR(50) NOT NULL CHECK (category IN ('DATABASE', 'STORAGE', 'QUEUE', 'AUTH', 'BACKUP', 'SYSTEM', 'SECURITY')),
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para consulta rápida de alertas pendentes e ordenação temporal
CREATE INDEX IF NOT EXISTS idx_operational_alerts_active 
    ON public.system_operational_alerts(severity, created_at DESC) 
    WHERE is_resolved = FALSE;

CREATE INDEX IF NOT EXISTS idx_operational_alerts_created_at 
    ON public.system_operational_alerts(created_at DESC);

-- Permissões para a role restrita da aplicação
GRANT SELECT, INSERT, UPDATE ON public.system_operational_alerts TO couplerh_app;
