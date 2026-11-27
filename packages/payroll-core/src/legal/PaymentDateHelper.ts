export type SalaryPaymentRule = 'FIFTH_BUSINESS_DAY' | 'LAST_DAY_OF_MONTH';

export interface CompanyPaymentPolicy {
  salary_payment_rule?: SalaryPaymentRule;
  withhold_irrf_on_advance?: boolean;
}

function formatUtcIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Calcula o 5º dia útil de um mês/ano conforme CLT art. 459 §1º e IN MTE 01/89:
 * - Domingo não é dia útil; sábado conta como dia útil se não for feriado.
 * - Feriados informados em `holidaysIso` ('YYYY-MM-DD') são desconsiderados.
 */
export function calculateFifthBusinessDay(
  year: number,
  month: number,
  holidaysIso: string[] = []
): string {
  const holidaySet = new Set(holidaysIso.map((h) => h.slice(0, 10)));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let businessDays = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const dt = new Date(Date.UTC(year, month - 1, day));
    const iso = formatUtcIsoDate(year, month, day);
    const weekday = dt.getUTCDay(); // 0 = Domingo
    if (weekday !== 0 && !holidaySet.has(iso)) {
      businessDays++;
      if (businessDays === 5) {
        return iso;
      }
    }
  }

  return formatUtcIsoDate(year, month, Math.min(5, daysInMonth));
}

/**
 * Determina a data padrão de pagamento (`payment_date`) conforme o tipo da folha
 * e a política de pagamento configurada em `companies.labor_config`.
 */
export function calculateDefaultPaymentDate(
  year: number,
  month: number,
  periodType: string,
  laborConfig?: CompanyPaymentPolicy | null,
  holidaysIso: string[] = []
): string {
  const normalizedType = String(periodType || 'MONTHLY').toUpperCase();
  const rule: SalaryPaymentRule = laborConfig?.salary_payment_rule || 'FIFTH_BUSINESS_DAY';

  if (normalizedType === 'ADVANCE') {
    return formatUtcIsoDate(year, month, 20);
  }

  if (normalizedType === 'THIRTEENTH_1' || normalizedType === 'THIRTEENTH_SINGLE') {
    return formatUtcIsoDate(year, 11, 30);
  }

  if (normalizedType === 'THIRTEENTH_2') {
    return formatUtcIsoDate(year, 12, 20);
  }

  if (rule === 'LAST_DAY_OF_MONTH') {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return formatUtcIsoDate(year, month, lastDay);
  }

  // MONTHLY / COMPLEMENTARY sob regra do 5º dia útil -> mês seguinte
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return calculateFifthBusinessDay(nextYear, nextMonth, holidaysIso);
}
