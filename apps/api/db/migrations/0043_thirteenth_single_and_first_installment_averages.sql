-- ==============================================================================
-- MIGRATION 0043: Suporte a Parcela Única de 13º Salário e Médias na 1ª Parcela
-- FASE V9.5 — IMP-01
-- ==============================================================================

-- 1. Atualiza CHECK constraint de public.payroll_periods para aceitar THIRTEENTH_SINGLE
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
        'THIRTEENTH_SINGLE',
        'THIRTEENTH_COMPLEMENTARY',
        'VACATION',
        'TERMINATION',
        'COMPLEMENTARY',
        'PROFIT_SHARING'
    ));

-- 2. Adiciona flag configurável por CCT para inclusão de médias na 1ª Parcela de 13º
ALTER TABLE public.collective_agreements
    ADD COLUMN IF NOT EXISTS include_averages_in_13th_first_installment BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.collective_agreements.include_averages_in_13th_first_installment IS
    'Indica se a 1ª parcela do 13º salário (THIRTEENTH_1) deve incluir 50% das médias apuradas no ano-base até a competência (padrão TRUE)';
