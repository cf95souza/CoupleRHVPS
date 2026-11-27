-- ==============================================================================
-- MIGRATION 0028: Motor Unificado de Rescisão (TRCT) + Rescisão Complementar
-- FASE V6 — FOLHA-13
-- ==============================================================================

-- 1. Evolução de public.terminations para vínculo oficial com folha e rescisão complementar
ALTER TABLE public.terminations
    ADD COLUMN IF NOT EXISTS payroll_period_id UUID REFERENCES public.payroll_periods(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS payslip_id UUID REFERENCES public.payslips(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS parent_termination_id UUID REFERENCES public.terminations(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_complementary BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS complementary_reason TEXT,
    ADD COLUMN IF NOT EXISTS esocial_reason_code VARCHAR(10),
    ADD COLUMN IF NOT EXISTS notice_worked_days INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS notice_indemnified_days INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS art_477_cap_applied BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS fgts_balance_real NUMERIC(15,2) NOT NULL DEFAULT 0.00;

-- Atualiza CHECK de notice_type para incluir 'MIXED' (NT 184/2012) e 'WAIVED'
DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.terminations'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%notice_type%';

    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.terminations DROP CONSTRAINT %I;', v_conname);
    END IF;
END $$;

ALTER TABLE public.terminations
    ADD CONSTRAINT terminations_notice_type_check
    CHECK (notice_type IN ('WORKED', 'INDEMNIFIED', 'WAIVED', 'DISPENSED', 'MIXED', 'NONE'));

CREATE INDEX IF NOT EXISTS idx_terminations_parent
    ON public.terminations (tenant_id, parent_termination_id)
    WHERE parent_termination_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_terminations_contract
    ON public.terminations (tenant_id, contract_id, created_at DESC);

-- 2. Rubricas Oficiais de Rescisão Trabalhista (TRCT / eSocial)
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, discount_priority, incidencias
) VALUES
(
    'a0000000-0000-0000-0000-000000000510',
    '510', 'Saldo de Salário (Rescisão)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'DIAS', 10, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000511',
    '511', 'Aviso Prévio Indenizado (Lei 12.506/2011)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'DIAS', 11, 50,
    '{"inss": false, "irrf": false, "fgts": true, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000512',
    '512', '13º Salário Proporcional (Rescisão)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'AVOS', 12, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false, "irrf_mode": "EXCLUSIVO"}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000513',
    '513', '13º Salário Indenizado (Projeção Aviso Prévio)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'AVOS', 13, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false, "irrf_mode": "EXCLUSIVO"}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000514',
    '514', 'Férias Vencidas (Rescisão)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'FIXO', 14, 50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000515',
    '515', 'Férias Vencidas em Dobro (Art. 137 - Rescisão)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'FIXO', 15, 50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000516',
    '516', 'Férias Proporcionais (Rescisão)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'AVOS', 16, 50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000517',
    '517', '1/3 Constitucional sobre Férias (Rescisão)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'FIXO', 17, 50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000518',
    '518', 'Indenização Adicional Art. 9º Lei 7.238/84 (Trintídio Data-Base)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'FIXO', 18, 50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000519',
    '519', 'Quitação Saldo Positivo Banco de Horas (HE Rescisória)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'HORAS', 19, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000520',
    '520', 'Indenização Quebra de Contrato Prazo Determinado (Art. 479 CLT)', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'FIXO', 20, 50,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000521',
    '521', 'Diferença de Rescisão Complementar', 'EARNING', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'FIXO', 21, 50,
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000580',
    '580', 'Desconto Aviso Prévio Não Cumprido / Art. 480 CLT', 'DEDUCTION', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'FIXO', 60, 30,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000581',
    '581', 'Outros Descontos Rescisórios', 'DEDUCTION', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'FIXO', 61, 60,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000582',
    '582', 'INSS sobre 13º Salário Rescisório', 'DEDUCTION', 'TAX', 'INSS', 'ACTIVE', TRUE,
    'SYSTEM', 91, 10,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000583',
    '583', 'IRRF sobre 13º Salário Rescisório', 'DEDUCTION', 'TAX', 'IRRF', 'ACTIVE', TRUE,
    'SYSTEM', 96, 10,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000590',
    '590', 'Multa Rescisória FGTS (40% / 20%)', 'NEUTRAL', 'TERMINATION', 'TERMINATION', 'ACTIVE', TRUE,
    'SYSTEM', 98, 99,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    calculation_order = EXCLUDED.calculation_order,
    discount_priority = EXCLUDED.discount_priority,
    is_system = TRUE,
    incidencias = EXCLUDED.incidencias;
