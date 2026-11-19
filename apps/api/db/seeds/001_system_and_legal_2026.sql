-- ============================================================================
-- coupleRH v2.0 Enterprise — Seeds de Sistema & Parâmetros Legais CLT 2026
-- ============================================================================
-- Arquivo: 001_system_and_legal_2026.sql
-- ============================================================================

-- 1. VIGÊNCIA LEGAL CLT 2026
INSERT INTO public.legal_versions (id, code, description, valid_from, valid_to, is_active)
VALUES (
    'c0000000-0000-0000-0000-000000002026',
    'LEGAL_2026',
    'Tabelas Legais, Alíquotas e Parâmetros Fiscais CLT vigência 2026',
    '2026-01-01',
    NULL,
    TRUE
) ON CONFLICT (code) DO UPDATE SET
    description = EXCLUDED.description,
    is_active = EXCLUDED.is_active;

-- 2. PARÂMETROS GERAIS CLT 2026
-- Salário mínimo R$ 1.518,00 | Teto INSS R$ 8.157,41 | Dedução dependente R$ 189,59
-- Desconto simplificado IRRF R$ 564,80 | Cota família R$ 62,04 (teto R$ 1.819,26)
-- Redutor IRRF Reforma 2026: A = 978.62, B = 0.133145 (isenção até R$ 5.000)
INSERT INTO public.general_legal_parameters (
    id,
    legal_version_id,
    minimum_wage,
    inss_ceiling,
    dependent_deduction,
    simplified_discount,
    family_salary_ceiling,
    family_salary_value,
    fgts_standard_aliquot,
    fgts_apprentice_aliquot,
    irrf_reduction_a,
    irrf_reduction_b
) VALUES (
    'c0000000-0000-0000-0000-000000002027',
    'c0000000-0000-0000-0000-000000002026',
    1518.00,
    8157.41,
    189.59,
    564.80,
    1819.26,
    62.04,
    8.00,
    2.00,
    978.62,
    0.133145
) ON CONFLICT (legal_version_id) DO UPDATE SET
    minimum_wage = EXCLUDED.minimum_wage,
    inss_ceiling = EXCLUDED.inss_ceiling,
    dependent_deduction = EXCLUDED.dependent_deduction,
    simplified_discount = EXCLUDED.simplified_discount,
    family_salary_ceiling = EXCLUDED.family_salary_ceiling,
    family_salary_value = EXCLUDED.family_salary_value,
    fgts_standard_aliquot = EXCLUDED.fgts_standard_aliquot,
    fgts_apprentice_aliquot = EXCLUDED.fgts_apprentice_aliquot,
    irrf_reduction_a = EXCLUDED.irrf_reduction_a,
    irrf_reduction_b = EXCLUDED.irrf_reduction_b;

-- 3. FAIXAS PROGRESSIVAS DO INSS 2026 (Portaria Interministerial MPS/MF)
INSERT INTO public.inss_parameters (legal_version_id, bracket_number, base_limit, aliquot)
VALUES
    ('c0000000-0000-0000-0000-000000002026', 1, 1518.00, 7.50),
    ('c0000000-0000-0000-0000-000000002026', 2, 2793.88, 9.00),
    ('c0000000-0000-0000-0000-000000002026', 3, 4190.83, 12.00),
    ('c0000000-0000-0000-0000-000000002026', 4, 8157.41, 14.00)
ON CONFLICT (legal_version_id, bracket_number) DO UPDATE SET
    base_limit = EXCLUDED.base_limit,
    aliquot = EXCLUDED.aliquot;

-- 4. FAIXAS PROGRESSIVAS DO IRRF 2026 (Receita Federal do Brasil)
INSERT INTO public.irrf_parameters (legal_version_id, bracket_number, base_limit, aliquot, deduction)
VALUES
    ('c0000000-0000-0000-0000-000000002026', 1, 2259.20, 0.00, 0.00),
    ('c0000000-0000-0000-0000-000000002026', 2, 2826.65, 7.50, 169.44),
    ('c0000000-0000-0000-0000-000000002026', 3, 3751.05, 15.00, 381.44),
    ('c0000000-0000-0000-0000-000000002026', 4, 4664.68, 22.50, 662.77),
    ('c0000000-0000-0000-0000-000000002026', 5, NULL, 27.50, 896.00)
ON CONFLICT (legal_version_id, bracket_number) DO UPDATE SET
    base_limit = EXCLUDED.base_limit,
    aliquot = EXCLUDED.aliquot,
    deduction = EXCLUDED.deduction;

-- 5. FERIADOS NACIONAIS OFICIAIS BRASILEIROS
INSERT INTO public.holidays (date, name, type)
VALUES
    ('2026-01-01', 'Confraternização Universal', 'NATIONAL'),
    ('2026-04-21', 'Tiradentes', 'NATIONAL'),
    ('2026-05-01', 'Dia do Trabalho', 'NATIONAL'),
    ('2026-09-07', 'Independência do Brasil', 'NATIONAL'),
    ('2026-10-12', 'Nossa Senhora Aparecida', 'NATIONAL'),
    ('2026-11-02', 'Finados', 'NATIONAL'),
    ('2026-11-15', 'Proclamação da República', 'NATIONAL'),
    ('2026-11-20', 'Dia Nacional de Zumbi e da Consciência Negra', 'NATIONAL'),
    ('2026-12-25', 'Natal', 'NATIONAL')
ON CONFLICT DO NOTHING;

-- 6. CATÁLOGO MESTRE DE RUBRICAS CLT DE SISTEMA (is_system = true)
-- Incidências contextuais rigorosas: INSS, IRRF, FGTS, DSR, Médias
INSERT INTO public.rubrics (
    id, code, name, type, category, rubric_kind, status, is_system,
    calculation_form, calculation_order, formula, incidencias
) VALUES
-- Vencimentos (EARNING)
(
    'a0000000-0000-0000-0000-000000000101',
    '101', 'Salário Base Contratual', 'EARNING', 'SALARY', 'SALARY_BASE', 'ACTIVE', TRUE,
    'FORMULA', 10, 'SALARIO_BASE',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000102',
    '102', 'Horas Extras 50%', 'EARNING', 'OVERTIME', 'OVERTIME', 'ACTIVE', TRUE,
    'FORMULA', 20, '(BASE_HORA_EXTRA / DIVISOR) * 1.5 * HORAS_EXTRAS_50',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": true}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000103',
    '103', 'Horas Extras 100%', 'EARNING', 'OVERTIME', 'OVERTIME', 'ACTIVE', TRUE,
    'FORMULA', 21, '(BASE_HORA_EXTRA / DIVISOR) * 2.0 * HORAS_EXTRAS_100',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": true}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000150',
    '150', 'Adicional de Insalubridade', 'EARNING', 'ALLOWANCE', 'INSALUBRIDADE', 'ACTIVE', TRUE,
    'FORMULA', 15, 'SALARIO_MINIMO * (PERCENTUAL / 100)',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000151',
    '151', 'Adicional de Periculosidade', 'EARNING', 'ALLOWANCE', 'PERICULOSIDADE', 'ACTIVE', TRUE,
    'FORMULA', 16, 'SALARIO_BASE * 0.30',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000301',
    '301', 'Adicional Noturno 20%', 'EARNING', 'NIGHT_SHIFT', 'ADIC_NOTURNO', 'ACTIVE', TRUE,
    'FORMULA', 25, '(BASE_HORA_EXTRA / DIVISOR) * 0.20 * HORAS_NOTURNAS',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": true}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000401',
    '401', 'DSR sobre Horas Extras', 'EARNING', 'DSR', 'DSR', 'ACTIVE', TRUE,
    'FORMULA', 30, '(BASE_DSR / DIAS_UTEIS) * DIAS_DSR',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000402',
    '402', 'DSR sobre Adicional Noturno', 'EARNING', 'DSR', 'DSR_NOTURNO', 'ACTIVE', TRUE,
    'FORMULA', 31, '(BASE_DSR_NOTURNO / DIAS_UTEIS) * DIAS_DSR',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000501',
    '501', 'Salário Família', 'EARNING', 'FAMILY_SALARY', 'FAMILY_SALARY', 'ACTIVE', TRUE,
    'FORMULA', 35, 'COTA_FAMILIA * NUM_DEPENDENTES_SF',
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000601',
    '601', '13º Salário - 1ª Parcela', 'EARNING', 'THIRTEENTH', 'THIRTEENTH', 'ACTIVE', TRUE,
    'FORMULA', 40, 'SALARIO_BASE / 2',
    '{"inss": false, "irrf": false, "fgts": true, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000602',
    '602', '13º Salário - 2ª Parcela', 'EARNING', 'THIRTEENTH', 'THIRTEENTH', 'ACTIVE', TRUE,
    'FORMULA', 41, 'SALARIO_BASE',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000701',
    '701', 'Férias Gozadas no Mês', 'EARNING', 'VACATION', 'VACATION', 'ACTIVE', TRUE,
    'FORMULA', 45, '(SALARIO_BASE / 30) * DIAS_FERIAS',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000702',
    '702', '1/3 Constitucional de Férias', 'EARNING', 'VACATION', 'VACATION', 'ACTIVE', TRUE,
    'FORMULA', 46, 'VALOR_FERIAS / 3',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),

-- Descontos (DEDUCTION)
(
    'a0000000-0000-0000-0000-000000000801',
    '801', 'Faltas Injustificadas', 'DEDUCTION', 'ABSENCE', 'ABSENCE', 'ACTIVE', TRUE,
    'FORMULA', 50, '(SALARIO_BASE / 30) * DIAS_FALTA',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000802',
    '802', 'DSR sobre Faltas', 'DEDUCTION', 'ABSENCE', 'ABSENCE', 'ACTIVE', TRUE,
    'FORMULA', 51, '(SALARIO_BASE / 30) * DIAS_DSR_PERDIDOS',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000803',
    '803', 'Atrasos e Saídas Antecipadas', 'DEDUCTION', 'LATE', 'LATE', 'ACTIVE', TRUE,
    'FORMULA', 52, '(SALARIO_BASE / DIVISOR) * HORAS_ATRASO',
    '{"inss": true, "irrf": true, "fgts": true, "inss_patronal": true, "rat": true, "terceiros": true, "gera_base_inss": true, "gera_base_irrf": true, "gera_base_fgts": true, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000603',
    '603', '13º Salário - Dedução 1ª Parcela', 'DEDUCTION', 'THIRTEENTH', 'THIRTEENTH', 'ACTIVE', TRUE,
    'FORMULA', 55, 'VALOR_ADIANTAMENTO_13',
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000901',
    '901', 'Contribuição INSS', 'DEDUCTION', 'TAX', 'INSS', 'ACTIVE', TRUE,
    'SYSTEM', 90, NULL,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000902',
    '902', 'IRRF Mensal', 'DEDUCTION', 'TAX', 'IRRF', 'ACTIVE', TRUE,
    'SYSTEM', 95, NULL,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000904',
    '904', 'Pensão Alimentícia Judicial', 'DEDUCTION', 'ALIMONY', 'ALIMONY', 'ACTIVE', TRUE,
    'SYSTEM', 85, NULL,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000905',
    '905', 'Desconto Vale Transporte (6%)', 'DEDUCTION', 'BENEFIT', 'BENEFIT', 'ACTIVE', TRUE,
    'FORMULA', 60, 'MIN(VALOR_VT, SALARIO_BASE * 0.06)',
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),

-- Rubricas Informativas e Tributos Patronais (NEUTRAL)
(
    'a0000000-0000-0000-0000-000000000903',
    '903', 'FGTS Mensal do Empregado', 'NEUTRAL', 'TAX', 'FGTS', 'ACTIVE', TRUE,
    'SYSTEM', 99, NULL,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
),
(
    'a0000000-0000-0000-0000-000000000999',
    '999', 'Estouro de Folha (Insuficiência de Saldo)', 'EARNING', 'OTHER', 'OTHER', 'ACTIVE', TRUE,
    'SYSTEM', 100, NULL,
    '{"inss": false, "irrf": false, "fgts": false, "inss_patronal": false, "rat": false, "terceiros": false, "gera_base_inss": false, "gera_base_irrf": false, "gera_base_fgts": false, "integra_dsr": false}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    category = EXCLUDED.category,
    rubric_kind = EXCLUDED.rubric_kind,
    formula = EXCLUDED.formula,
    incidencias = EXCLUDED.incidencias;

-- ============================================================================
-- FIM DOS SEEDS 001_system_and_legal_2026.sql
-- ============================================================================
