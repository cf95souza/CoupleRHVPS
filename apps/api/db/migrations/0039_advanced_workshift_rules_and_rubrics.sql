-- ==============================================================================
-- MIGRATION 0039: Regras Avançadas de Jornada (OJ 97, Sobreaviso, Prontidão,
--                 Escalas Rotativas, Banco Negativo por CCT & Rubricas 108/109/124/125)
-- FASE V8 — PONTO-07
-- ==============================================================================

-- 1. Evolução de public.work_shifts para Escalas Rotativas e Janela Noturna Configurável
ALTER TABLE public.work_shifts
    ADD COLUMN IF NOT EXISTS rotation_pattern_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS rotation_anchor_date DATE,
    ADD COLUMN IF NOT EXISTS night_start_hour INT NOT NULL DEFAULT 22,
    ADD COLUMN IF NOT EXISTS night_end_hour INT NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS night_extended_prorrogation BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.work_shifts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%shift_type%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.work_shifts DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.work_shifts
    ADD CONSTRAINT work_shifts_shift_type_check
    CHECK (shift_type IN (
        'WEEKLY',
        'ROTATING_12X36',
        'SHIFT_12X36',
        'ROTATING_5X1',
        'ROTATING_6X1',
        'ROTATING_6X2',
        'ROTATING_4X2',
        'ROTATING_24X48',
        'FLEXIBLE',
        'FREE'
    ));

-- 2. Parâmetros de Banco de Horas Negativo e HE Noturna OJ 97 na CCT
ALTER TABLE public.collective_agreements
    ADD COLUMN IF NOT EXISTS time_bank_allow_negative BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS time_bank_max_negative_minutes INT NOT NULL DEFAULT 2400,
    ADD COLUMN IF NOT EXISTS time_bank_negative_deduction_rule TEXT NOT NULL DEFAULT 'COMPENSATE_ONLY',
    ADD COLUMN IF NOT EXISTS overtime_night_oj97_enabled BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.collective_agreements'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%time_bank_negative_deduction_rule%';
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.collective_agreements DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.collective_agreements
    ADD CONSTRAINT collective_agreements_tb_neg_rule_check
    CHECK (time_bank_negative_deduction_rule IN ('COMPENSATE_ONLY', 'DEDUCT_ON_CLOSURE', 'DEDUCT_ON_TERMINATION_ONLY'));

-- 3. Evolução de public.time_punch_daily_summaries para HE Noturna OJ 97, Sobreaviso e Prontidão
ALTER TABLE public.time_punch_daily_summaries
    ADD COLUMN IF NOT EXISTS night_overtime_50_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS night_overtime_100_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS standby_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS readiness_hours NUMERIC(6,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS inconsistencies_json JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 4. Cadastro Oficial de Rubricas Avançadas de Jornada (OJ 97, Sobreaviso 1/3, Prontidão 2/3)
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_base, percentage, factor,
    calculation_order, discount_priority,
    average_type, include_in_vacation_avg, include_in_13th_avg, include_in_notice_avg,
    incidencias
) VALUES
(
    'a0000000-0000-0000-0000-000000000108',
    '108',
    'Hora Extra Noturna 50% (OJ 97 SDI-1 TST)',
    'EARNING',
    'OVERTIME',
    'OVERTIME',
    'ACTIVE',
    TRUE,
    'HORAS',
    'BASE_HORA_EXTRA_NOTURNA',
    50.0000,
    1.5000,
    26,
    50,
    'HOURS_QUANTITY',
    TRUE,
    TRUE,
    TRUE,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": true}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000109',
    '109',
    'Hora Extra Noturna 100% (OJ 97 SDI-1 TST)',
    'EARNING',
    'OVERTIME',
    'OVERTIME',
    'ACTIVE',
    TRUE,
    'HORAS',
    'BASE_HORA_EXTRA_NOTURNA',
    100.0000,
    2.0000,
    27,
    50,
    'HOURS_QUANTITY',
    TRUE,
    TRUE,
    TRUE,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": true}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000124',
    '124',
    'Adicional de Sobreaviso (1/3 Art. 244 §2º CLT)',
    'EARNING',
    'OVERTIME',
    'OTHER',
    'ACTIVE',
    TRUE,
    'HORAS',
    'SALARIO_BASE',
    33.3300,
    0.3333,
    28,
    50,
    'HOURS_QUANTITY',
    TRUE,
    TRUE,
    TRUE,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": true}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000125',
    '125',
    'Adicional de Prontidão (2/3 Art. 244 §3º CLT)',
    'EARNING',
    'OVERTIME',
    'OTHER',
    'ACTIVE',
    TRUE,
    'HORAS',
    'SALARIO_BASE',
    66.6700,
    0.6667,
    29,
    50,
    'HOURS_QUANTITY',
    TRUE,
    TRUE,
    TRUE,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": true}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    calculation_form = EXCLUDED.calculation_form,
    calculation_base = EXCLUDED.calculation_base,
    percentage = EXCLUDED.percentage,
    factor = EXCLUDED.factor,
    calculation_order = EXCLUDED.calculation_order,
    average_type = EXCLUDED.average_type,
    include_in_vacation_avg = EXCLUDED.include_in_vacation_avg,
    include_in_13th_avg = EXCLUDED.include_in_13th_avg,
    include_in_notice_avg = EXCLUDED.include_in_notice_avg,
    is_system = TRUE,
    incidencias = EXCLUDED.incidencias;
