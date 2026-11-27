-- ==============================================================================
-- Migration 0020: Salário-Família Automático, Vacina/Escola & DCTFWeb — FOLHA-05
-- Sistema: coupleRH Enterprise v2.0 (PostgreSQL 17 Puro)
-- ==============================================================================

-- 1. Evolução de public.dependents (Vigência, Certidão, Vacinação Anual e Frequência Escolar Semestral)
ALTER TABLE public.dependents
    ADD COLUMN IF NOT EXISTS start_date DATE,
    ADD COLUMN IF NOT EXISTS end_date DATE,
    ADD COLUMN IF NOT EXISTS birth_certificate_number TEXT,
    ADD COLUMN IF NOT EXISTS vaccination_card_date DATE,
    ADD COLUMN IF NOT EXISTS school_frequency_date DATE,
    ADD COLUMN IF NOT EXISTS vaccination_proof_file_id UUID REFERENCES public.stored_files(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS school_proof_file_id UUID REFERENCES public.stored_files(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dependents_worker_family_salary
    ON public.dependents (tenant_id, worker_id)
    WHERE deleted_at IS NULL;

-- 2. Padronização da Rubrica Oficial 305 (Salário-Família — Natureza eSocial 1409)
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    esocial_nature, legal_basis,
    calculation_form, calculation_base, calculation_order, factor, percentage, formula, incidencias
) VALUES (
    'a0000000-0000-0000-0000-000000000305',
    '305',
    'Salário-Família',
    'EARNING',
    'FAMILY_SALARY',
    'FAMILY_SALARY',
    'ACTIVE',
    TRUE,
    '1409',
    'Lei 8.213/91 Arts. 65-70; Decreto 3.048/99 Arts. 81-92',
    'SYSTEM',
    NULL,
    35,
    NULL,
    NULL,
    'COTA_FAMILIA * NUM_DEPENDENTES_SF * PROPORCAO_SF',
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    status = 'ACTIVE',
    is_system = TRUE,
    esocial_nature = EXCLUDED.esocial_nature,
    legal_basis = EXCLUDED.legal_basis,
    calculation_form = EXCLUDED.calculation_form,
    calculation_order = EXCLUDED.calculation_order,
    formula = EXCLUDED.formula,
    incidencias = EXCLUDED.incidencias,
    deleted_at = NULL,
    updated_at = NOW();

-- Aposenta antiga seed 501 de Salário Família (para evitar conflito de código com Férias legado e duplicidade)
UPDATE public.rubrics
SET status = 'RETIRED',
    deleted_at = COALESCE(deleted_at, NOW()),
    updated_at = NOW()
WHERE code = '501'
  AND (rubric_kind = 'FAMILY_SALARY' OR category = 'FAMILY_SALARY');
