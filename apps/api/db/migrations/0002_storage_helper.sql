-- ==============================================================================
-- Migration 0002: Helper Seguro para Download de Arquivos por UUID Assinado (HMAC)
-- Permite leitura pontual de metadados por UUID sob a role couplerh_app
-- mantendo o RLS estrito e ativo para todas as outras consultas
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.get_stored_file_by_id(p_file_id UUID)
RETURNS SETOF public.stored_files
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT * FROM public.stored_files WHERE id = p_file_id AND deleted_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION public.get_stored_file_by_id(UUID) TO couplerh_app;
