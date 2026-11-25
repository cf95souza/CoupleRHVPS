/**
 * Catálogo Único Oficial de Variáveis do Motor de Folha (BUG-05).
 * Fonte única de verdade em PT-BR compartilhada entre PayrollContext,
 * PayrollEngine, Wizard de Rubricas e API REST.
 */

export interface PayrollVariableMetadata {
  name: string;
  label: string;
  description: string;
  defaultValue: number;
}

export const PAYROLL_VARIABLES_CATALOG: readonly PayrollVariableMetadata[] = [
  {
    name: 'SALARIO_BASE',
    label: 'Salário Base Contratual',
    description: 'Salário contratual integral definido no contrato de trabalho.',
    defaultValue: 0,
  },
  {
    name: 'SALARIO_CONTRATUAL',
    label: 'Salário Contratual',
    description: 'Alias oficial para o salário base contratual integral.',
    defaultValue: 0,
  },
  {
    name: 'SALARIO_MINIMO',
    label: 'Salário Mínimo Vigente',
    description: 'Salário mínimo nacional da tabela legal vigente na competência.',
    defaultValue: 0,
  },
  {
    name: 'DIVISOR',
    label: 'Divisor da Jornada',
    description: 'Divisor mensal de horas da escala contratual (ex: 220, 180, 150).',
    defaultValue: 220,
  },
  {
    name: 'FATOR',
    label: 'Fator Multiplicador',
    description: 'Fator multiplicador da rubrica em avaliação (ex: 1.5 para HE 50%, 2.0 para HE 100%).',
    defaultValue: 1,
  },
  {
    name: 'QUANTIDADE',
    label: 'Quantidade Lançada',
    description: 'Quantidade de horas, dias ou unidades lançadas para a rubrica em avaliação.',
    defaultValue: 0,
  },
  {
    name: 'PERCENTUAL',
    label: 'Percentual Configurado',
    description: 'Alíquota percentual configurada na rubrica ou no evento do contrato.',
    defaultValue: 0,
  },
  {
    name: 'DIAS_TRABALHADOS',
    label: 'Dias Trabalhados no Mês',
    description: 'Dias comerciais trabalhados na competência (considerando admissão/férias).',
    defaultValue: 30,
  },
  {
    name: 'HORAS_TRABALHADAS',
    label: 'Horas Trabalhadas',
    description: 'Carga horária mensal de referência do contrato.',
    defaultValue: 220,
  },
  {
    name: 'DIAS_UTEIS',
    label: 'Dias Úteis da Competência',
    description: 'Dias úteis reais do calendário considerando feriados da lotação.',
    defaultValue: 26,
  },
  {
    name: 'DIAS_INUTEIS',
    label: 'Domingos e Feriados (DSR)',
    description: 'Quantidade de domingos e feriados aplicáveis na competência.',
    defaultValue: 4,
  },
  {
    name: 'DEPENDENTES',
    label: 'Dependentes Elegíveis IRRF',
    description: 'Quantidade de dependentes elegíveis para dedução do IRRF.',
    defaultValue: 0,
  },
  {
    name: 'BASE_DSR',
    label: 'Base do DSR',
    description: 'Soma das verbas variáveis habituais que integram o cálculo do DSR.',
    defaultValue: 0,
  },
  {
    name: 'BASE_DSR_NOTURNO',
    label: 'Base do DSR Noturno',
    description: 'Soma do adicional noturno que integra o DSR noturno separado.',
    defaultValue: 0,
  },
  {
    name: 'BASE_HORA_EXTRA',
    label: 'Base da Hora Extra Diurna (Súmula 264 TST)',
    description: 'Salário contratual integral somado aos adicionais habituais (sem adicional noturno).',
    defaultValue: 0,
  },
  {
    name: 'BASE_HORA_EXTRA_NOTURNA',
    label: 'Base da Hora Extra Noturna (OJ 97 SDI-1 TST)',
    description: 'Salário contratual integral + adicionais habituais + adicional noturno.',
    defaultValue: 0,
  },
  {
    name: 'BASE_FERIAS',
    label: 'Base de Férias',
    description: 'Remuneração base composta para cálculo de férias.',
    defaultValue: 0,
  },
  {
    name: 'BASE_13',
    label: 'Base de 13º Salário',
    description: 'Remuneração base composta para cálculo de 13º salário.',
    defaultValue: 0,
  },
] as const;

export const PUBLISHED_PAYROLL_VARIABLES = PAYROLL_VARIABLES_CATALOG.map((v) => v.name);

const LEGACY_ENGLISH_ALIASES: Record<string, string> = {
  SALARY: 'SALARIO_BASE',
  MINIMUM_WAGE: 'SALARIO_MINIMO',
  FACTOR: 'FATOR',
  QUANTITY: 'QUANTIDADE',
  PERCENTAGE: 'PERCENTUAL',
  WORKED_DAYS: 'DIAS_TRABALHADOS',
  WORKED_HOURS: 'HORAS_TRABALHADAS',
  BUSINESS_DAYS: 'DIAS_UTEIS',
  REST_DAYS: 'DIAS_INUTEIS',
  DIAS_DSR: 'DIAS_INUTEIS',
};

/**
 * Normaliza um identificador de variável ou base de cálculo legado em inglês para PT-BR oficial.
 */
export function normalizeVariableName(name: string): string {
  const upper = (name || '').trim().toUpperCase();
  return LEGACY_ENGLISH_ALIASES[upper] || upper;
}

/**
 * Normaliza variáveis presentes em expressões matemáticas para o padrão PT-BR oficial.
 */
export function normalizeFormulaVariables(formula: string): string {
  if (!formula) return formula;
  let normalized = formula;
  for (const [legacy, ptbr] of Object.entries(LEGACY_ENGLISH_ALIASES)) {
    normalized = normalized.replace(new RegExp(`\\b${legacy}\\b`, 'gi'), ptbr);
  }
  return normalized;
}
