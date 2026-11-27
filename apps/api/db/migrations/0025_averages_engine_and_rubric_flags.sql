-- ==============================================================================
-- MIGRATION 0025: Motor de Médias Configurável por CCT (AveragesCalculator)
-- FASE V6 — FOLHA-10
-- ==============================================================================

-- 1. Colunas de parametrização de médias em public.rubrics
ALTER TABLE public.rubrics
    ADD COLUMN IF NOT EXISTS average_type TEXT NOT NULL DEFAULT 'NONE'
        CHECK (average_type IN ('NONE', 'HOURS_QUANTITY', 'MONETARY_VALUE', 'MONETARY_INDEXED')),
    ADD COLUMN IF NOT EXISTS include_in_vacation_avg BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS include_in_13th_avg BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS include_in_notice_avg BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Configuração de janela e correção monetária em public.collective_agreements
ALTER TABLE public.collective_agreements
    ADD COLUMN IF NOT EXISTS average_window_mode TEXT NOT NULL DEFAULT 'ACQUISITIVE_OR_12M'
        CHECK (average_window_mode IN ('ACQUISITIVE_OR_12M', 'LAST_12M', 'LAST_6M', 'BEST_OF_6M_OR_12M', 'CALENDAR_YEAR')),
    ADD COLUMN IF NOT EXISTS average_monetary_index_rate NUMERIC(8,6) NOT NULL DEFAULT 0.000000;

-- 3. Atualização das rubricas oficiais de sistema (Súmula 347 TST + Súmula 45/60 TST)
UPDATE public.rubrics
SET average_type = 'HOURS_QUANTITY',
    include_in_vacation_avg = TRUE,
    include_in_13th_avg = TRUE,
    include_in_notice_avg = TRUE
WHERE code IN ('102', '103', '150', '160', '301')
   OR (rubric_kind IN ('OVERTIME', 'ADIC_NOTURNO', 'NIGHT_SHIFT') AND type = 'EARNING');

-- Garante que Insalubridade (150) não seja tratada como horas (apenas HE 150 legado se houver; 150 oficial é INSALUBRIDADE)
UPDATE public.rubrics
SET average_type = 'NONE',
    include_in_vacation_avg = FALSE,
    include_in_13th_avg = FALSE,
    include_in_notice_avg = FALSE
WHERE code = '150' AND rubric_kind = 'INSALUBRIDADE';

UPDATE public.rubrics
SET average_type = 'MONETARY_VALUE',
    include_in_vacation_avg = TRUE,
    include_in_13th_avg = TRUE,
    include_in_notice_avg = TRUE
WHERE code IN ('401', '402')
   OR (rubric_kind IN ('DSR', 'DSR_NOTURNO', 'COMMISSION') AND type = 'EARNING');
