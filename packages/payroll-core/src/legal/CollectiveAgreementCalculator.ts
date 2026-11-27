/**
 * CollectiveAgreementCalculator.ts
 * Motor de Convenções Coletivas de Trabalho (CCT / ACT) e Sindicatos.
 * FASE V5 — FOLHA-09: Pisos, ATS (Anuênio, Biênio, Triênio, Quinquênio), Horas Extras Escalonadas,
 * Adicional Noturno CCT, Base de Insalubridade e Estabilidade Pós-Férias.
 */

import { round2 } from '../utils/money.js';

export type AtsType = 'NONE' | 'ANUENIO' | 'BIENIO' | 'TRIENIO' | 'QUINQUENIO';
export type UnhealthinessBaseType = 'MINIMUM_WAGE' | 'BASE_SALARY' | 'CATEGORY_FLOOR';
export type AtsBaseType = 'BASE_SALARY' | 'GROSS_SALARY';

export interface FloorPositionRule {
  cbo?: string;
  position_id?: string;
  floor: number;
}

export interface CollectiveAgreementData {
  id?: string;
  union_id?: string;
  title?: string;
  agreement_type?: 'CCT' | 'ACT';
  start_date?: string;
  end_date?: string;
  base_salary_floor?: number;
  floor_positions?: FloorPositionRule[] | Record<string, number>;
  overtime_percentage_tier1?: number;
  overtime_percentage_tier2?: number;
  overtime_percentage_sunday_holiday?: number;
  night_shift_percentage?: number;
  night_shift_start_time?: string;
  night_shift_end_time?: string;
  night_hour_reduced?: boolean;
  unhealthiness_base_type?: UnhealthinessBaseType;
  ats_type?: AtsType;
  ats_percentage_per_cycle?: number;
  ats_max_percentage?: number | null;
  ats_base_type?: AtsBaseType;
  average_calculation_months?: number;
  average_window_mode?: 'ACQUISITIVE_OR_12M' | 'LAST_12M' | 'LAST_6M' | 'BEST_OF_6M_OR_12M' | 'CALENDAR_YEAR';
  average_monetary_index_rate?: number;
  post_vacation_stability_days?: number;
}

export interface AtsCalculationResult {
  yearsOfService: number;
  cycles: number;
  percentage: number;
  amount: number;
  atsType: AtsType;
}

export interface CategoryFloorValidationResult {
  effectiveFloor: number;
  isBelowFloor: boolean;
  difference: number;
}

export interface PostVacationStabilityResult {
  hasStability: boolean;
  stabilityUntil: string | null;
  remainingDays: number;
}

export class CollectiveAgreementCalculator {
  /**
   * Calcula a quantidade de anos de serviço completos completados pelo trabalhador
   * até o mês da competência da folha de pagamento.
   */
  public static calculateCompletedYearsOfService(
    admissionDateStr: string,
    competenceYear: number,
    competenceMonth: number
  ): number {
    if (!admissionDateStr) return 0;
    const parts = admissionDateStr.substring(0, 10).split('-').map(Number);
    if (parts.length < 3 || isNaN(parts[0]) || isNaN(parts[1])) return 0;
    const [admY, admM] = parts;

    let years = competenceYear - admY;
    // Se o mês de aniversário for posterior ao mês da competência, o ciclo ainda não completou no ano
    if (admM > competenceMonth) {
      years -= 1;
    }
    return Math.max(0, years);
  }

  /**
   * Calcula o Adicional por Tempo de Serviço (ATS — Anuênio, Biênio, Triênio, Quinquênio)
   * com base no tempo de casa e nos parâmetros da CCT.
   */
  public static calculateServiceTimeAllowance(
    admissionDateStr: string,
    competenceYear: number,
    competenceMonth: number,
    baseSalary: number,
    cct?: CollectiveAgreementData | null
  ): AtsCalculationResult {
    const defaultResult: AtsCalculationResult = {
      yearsOfService: 0,
      cycles: 0,
      percentage: 0,
      amount: 0,
      atsType: 'NONE',
    };

    if (!cct || !cct.ats_type || cct.ats_type === 'NONE' || !admissionDateStr || baseSalary <= 0) {
      return defaultResult;
    }

    const years = this.calculateCompletedYearsOfService(admissionDateStr, competenceYear, competenceMonth);
    let cycleDivisor = 1;

    switch (cct.ats_type) {
      case 'ANUENIO':
        cycleDivisor = 1;
        break;
      case 'BIENIO':
        cycleDivisor = 2;
        break;
      case 'TRIENIO':
        cycleDivisor = 3;
        break;
      case 'QUINQUENIO':
        cycleDivisor = 5;
        break;
      default:
        return defaultResult;
    }

    const cycles = Math.floor(years / cycleDivisor);
    if (cycles <= 0) {
      return {
        yearsOfService: years,
        cycles: 0,
        percentage: 0,
        amount: 0,
        atsType: cct.ats_type,
      };
    }

    let percentage = cycles * Number(cct.ats_percentage_per_cycle || 0);
    if (cct.ats_max_percentage !== null && cct.ats_max_percentage !== undefined) {
      const maxPct = Number(cct.ats_max_percentage);
      if (maxPct > 0 && percentage > maxPct) {
        percentage = maxPct;
      }
    }

    const amount = round2(baseSalary * (percentage / 100));

    return {
      yearsOfService: years,
      cycles,
      percentage: round2(percentage),
      amount,
      atsType: cct.ats_type,
    };
  }

  /**
   * Valida se o salário contratual atende ao piso salarial da categoria profissional
   * fixado na Convenção Coletiva (geral ou por função/CBO).
   */
  public static validateCategoryFloor(
    baseSalary: number,
    cct?: CollectiveAgreementData | null,
    positionInfo?: { cbo?: string; positionId?: string } | null
  ): CategoryFloorValidationResult {
    if (!cct) {
      return { effectiveFloor: 0, isBelowFloor: false, difference: 0 };
    }

    let effectiveFloor = Number(cct.base_salary_floor || 0);

    // Verifica se há piso específico por CBO ou Cargo
    if (cct.floor_positions && positionInfo) {
      if (Array.isArray(cct.floor_positions)) {
        const found = cct.floor_positions.find(
          (rule) =>
            (positionInfo.cbo && rule.cbo && rule.cbo === positionInfo.cbo) ||
            (positionInfo.positionId && rule.position_id && rule.position_id === positionInfo.positionId)
        );
        if (found && Number(found.floor) > 0) {
          effectiveFloor = Number(found.floor);
        }
      } else if (typeof cct.floor_positions === 'object') {
        const key = positionInfo.cbo || positionInfo.positionId || '';
        const floorVal = (cct.floor_positions as Record<string, number>)[key];
        if (floorVal && Number(floorVal) > 0) {
          effectiveFloor = Number(floorVal);
        }
      }
    }

    const isBelowFloor = effectiveFloor > 0 && baseSalary < effectiveFloor;
    const difference = isBelowFloor ? round2(effectiveFloor - baseSalary) : 0;

    return {
      effectiveFloor: round2(effectiveFloor),
      isBelowFloor,
      difference,
    };
  }

  /**
   * Determina a base de cálculo para o adicional de insalubridade de acordo com a CCT
   * (Salário Mínimo Nacional, Piso da Categoria ou Salário Base do Contrato).
   */
  public static resolveUnhealthinessBase(
    generalLegalMinWage: number,
    baseSalary: number,
    cct?: CollectiveAgreementData | null
  ): number {
    if (!cct || !cct.unhealthiness_base_type || cct.unhealthiness_base_type === 'MINIMUM_WAGE') {
      return generalLegalMinWage;
    }

    if (cct.unhealthiness_base_type === 'CATEGORY_FLOOR') {
      const floor = Number(cct.base_salary_floor || 0);
      return floor > 0 ? floor : generalLegalMinWage;
    }

    if (cct.unhealthiness_base_type === 'BASE_SALARY') {
      return baseSalary > 0 ? baseSalary : generalLegalMinWage;
    }

    return generalLegalMinWage;
  }

  /**
   * Retorna os percentuais de horas extras aplicáveis (faixa 1, faixa 2 e domingos/feriados)
   * respeitando a Convenção Coletiva (ou o padrão CLT 50% / 100%).
   */
  public static resolveOvertimeRates(cct?: CollectiveAgreementData | null): {
    tier1Percentage: number;
    tier2Percentage: number;
    sundayHolidayPercentage: number;
  } {
    return {
      tier1Percentage: Number(cct?.overtime_percentage_tier1 ?? 50.0),
      tier2Percentage: Number(cct?.overtime_percentage_tier2 ?? 100.0),
      sundayHolidayPercentage: Number(cct?.overtime_percentage_sunday_holiday ?? 100.0),
    };
  }

  /**
   * Retorna os parâmetros de adicional noturno configurados na CCT
   * (percentual, faixa de horário e redução de hora ficta).
   */
  public static resolveNightShiftParams(cct?: CollectiveAgreementData | null): {
    percentage: number;
    startTime: string;
    endTime: string;
    reducedHour: boolean;
  } {
    return {
      percentage: Number(cct?.night_shift_percentage ?? 20.0),
      startTime: cct?.night_shift_start_time || '22:00:00',
      endTime: cct?.night_shift_end_time || '05:00:00',
      reducedHour: cct?.night_hour_reduced !== false,
    };
  }

  /**
   * Avalia a estabilidade provisória no emprego pós-retorno de férias prevista na CCT.
   */
  public static checkPostVacationStability(
    vacationEndDateStr: string,
    targetDateStr: string,
    cct?: CollectiveAgreementData | null
  ): PostVacationStabilityResult {
    const days = Number(cct?.post_vacation_stability_days || 0);
    if (days <= 0 || !vacationEndDateStr || !targetDateStr) {
      return { hasStability: false, stabilityUntil: null, remainingDays: 0 };
    }

    const vacEnd = new Date(vacationEndDateStr.substring(0, 10) + 'T00:00:00Z');
    const target = new Date(targetDateStr.substring(0, 10) + 'T00:00:00Z');

    const stabilityUntilDate = new Date(vacEnd.getTime() + days * 24 * 60 * 60 * 1000);
    const stabilityUntilStr = stabilityUntilDate.toISOString().substring(0, 10);

    const diffMs = stabilityUntilDate.getTime() - target.getTime();
    const remainingDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));

    return {
      hasStability: remainingDays > 0,
      stabilityUntil: stabilityUntilStr,
      remainingDays: Math.max(0, remainingDays),
    };
  }
}
