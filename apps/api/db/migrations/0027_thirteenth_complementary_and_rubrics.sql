-- ==============================================================================
-- MIGRATION 0027: 13º Salário Enterprise & Complementar de Janeiro (Decreto 10.854/2021)
-- FASE V6 — FOLHA-12
-- ==============================================================================

-- 1. Atualiza CHECK de tipo de folha em public.payroll_periods para aceitar THIRTEENTH_COMPLEMENTARY
DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.payroll_periods'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%type%';

    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.payroll_periods DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.payroll_periods
    ADD CONSTRAINT payroll_periods_type_check
    CHECK (type IN (
        'MONTHLY',
        'ADVANCE',
        'THIRTEENTH_1',
        'THIRTEENTH_2',
        'THIRTEENTH_COMPLEMENTARY',
        'VACATION',
        'TERMINATION',
        'COMPLEMENTARY',
        'PROFIT_SHARING'
    ));

-- 2. Rubricas oficiais para Médias de 13º e Ajuste Complementar de Janeiro
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias
) VALUES
(
    'a0000000-0000-0000-0000-000000000604',
    '604',
    'Médias de Variáveis sobre 13º Salário',
    'EARNING',
    'THIRTEENTH',
    'THIRTEENTH',
    'ACTIVE',
    TRUE,
    'FIXO',
    42,
    50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false, "irrf_mode": "EXCLUSIVO"}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000605',
    '605',
    'Diferença 13º Salário Complementar (Janeiro)',
    'EARNING',
    'THIRTEENTH',
    'THIRTEENTH',
    'ACTIVE',
    TRUE,
    'FIXO',
    43,
    50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false, "irrf_mode": "EXCLUSIVO"}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000606',
    '606',
    'Ajuste 13º Salário Pago a Maior (Janeiro)',
    'DEDUCTION',
    'THIRTEENTH',
    'THIRTEENTH',
    'ACTIVE',
    TRUE,
    'FIXO',
    57,
    50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    calculation_order = EXCLUDED.calculation_order,
    is_system = TRUE,
    incidencias = EXCLUDED.incidencias;
