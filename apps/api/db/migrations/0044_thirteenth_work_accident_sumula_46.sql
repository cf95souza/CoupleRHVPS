-- ==============================================================================
-- MIGRATION 0044: Suporte à Complementação de 13º Salário por Acidente de Trabalho
-- Legislação: Súmula nº 46 do TST
-- ==============================================================================

-- 1. Adiciona coluna opcional em public.leaves para registro do Abono Anual pago pelo INSS
ALTER TABLE public.leaves
    ADD COLUMN IF NOT EXISTS inss_annual_bonus_amount NUMERIC(15,2) DEFAULT NULL;

COMMENT ON COLUMN public.leaves.inss_annual_bonus_amount IS
    'Valor do Abono Anual de 13º pago pelo INSS durante o afastamento acidentário (Súmula 46 TST)';

-- 2. Insere rubricas de sistema para a Súmula 46 do TST
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias
) VALUES
(
    'a0000000-0000-0000-0000-000000000607',
    '607',
    'Complemento 13º Salário Acidente de Trabalho (Súmula 46 TST)',
    'EARNING',
    'THIRTEENTH',
    'THIRTEENTH',
    'ACTIVE',
    TRUE,
    'FIXO',
    44,
    50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false, "irrf_mode": "EXCLUSIVO"}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000609',
    '609',
    'Abono Anual INSS - Acidente de Trabalho',
    'EARNING',
    'OTHER',
    'THIRTEENTH',
    'ACTIVE',
    TRUE,
    'MANUAL',
    45,
    50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false, "irrf_mode": "ISENTO"}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    calculation_order = EXCLUDED.calculation_order,
    is_system = TRUE,
    incidencias = EXCLUDED.incidencias;
