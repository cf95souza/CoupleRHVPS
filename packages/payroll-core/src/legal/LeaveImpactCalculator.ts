import { round2 } from '../utils/money.js';

export type CanonicalLeaveCategory =
  | 'SICK_LEAVE'         // eSocial 03: Auxílio-Doença comum (15d empresa + INSS >= 16º dia)
  | 'WORK_ACCIDENT'      // eSocial 01: Acidente de Trabalho / Doença Ocupacional (15d empresa + INSS + FGTS obrigatório + estabilidade 12m)
  | 'MATERNITY'          // eSocial 17/Q1: Licença-Maternidade (120d dedutível DCTFWeb + 180d Empresa Cidadã)
  | 'PATERNITY'          // eSocial 29: Licença-Paternidade (5d ou 20d pagos pela empresa)
  | 'MILITARY_SERVICE'   // eSocial 19: Serviço Militar Obrigatório (sem salário empresa, FGTS obrigatório mantido)
  | 'UNPAID_LEAVE'       // eSocial 21/22: Licença sem vencimentos / Suspensão não remunerada
  | 'SUSPENSION'         // Suspensão disciplinar CLT art. 474
  | 'OTHER';

export interface LeaveRecordInput {
  id: string;
  contract_id?: string;
  leave_type: string;
  esocial_reason_code?: string | null;
  start_date: string;
  end_date?: string | null;
  return_date?: string | null;
  cid10_code?: string | null;
  is_inss_responsible?: boolean;
  is_same_cid_relapse?: boolean;
  parent_leave_id?: string | null;
  is_extended_maternity?: boolean;
  status?: string;
  inss_annual_bonus_amount?: number | null;
}

export interface LeavePeriodImpactResult {
  workedSalaryDays: number;
  companyPaidSickDays: number;
  inssPaidDays: number;
  maternityDeductibleDays: number;
  maternityExtendedDays: number;
  unpaidLeaveDays: number;
  fgtsCompulsoryLeaveDays: number;
  maternityDctfWebDeductibleAmount: number;
  sameCidAggregatedCount: number;
  hasActiveWorkAccidentStability: boolean;
  stabilityUntil: string | null;
  appliedLeaveIds: string[];
  notes: string[];
}

export interface VacationAcquisitionLeaveEvaluation {
  acquisitionStart: string;
  acquisitionEnd: string;
  inssBenefitDays: number;
  maternityDaysIgnored: number;
  thresholdDays: number;
  lostByLeave: boolean;
  lossReason: string | null;
}

interface DayClassification {
  category: CanonicalLeaveCategory;
  leaveId: string;
  isEmployerPaidSick: boolean;
  isInssCovered: boolean;
  isMaternityDctfDeductible: boolean;
  isMaternityExtended: boolean;
  isEmployerPaidPaternity: boolean;
  isUnpaid: boolean;
  isFgtsCompulsory: boolean;
  countsForThirteenth: boolean;
}

function parseIsoUtc(dateStr: string): Date {
  const clean = dateStr.slice(0, 10);
  const [y, m, d] = clean.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIsoUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate()
  ).padStart(2, '0')}`;
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function diffDaysInclusive(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
}

export function addMonthsIsoUtc(dateStr: string, months: number): string {
  const clean = dateStr.slice(0, 10);
  const [y, m, d] = clean.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return toIsoUtc(dt);
}

export function normalizeCid10(cid?: string | null): string {
  return String(cid || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Normaliza `leave_type` e `esocial_reason_code` (Tabela 18 eSocial) para categoria canônica.
 */
export function resolveCanonicalLeaveCategory(
  leaveType?: string | null,
  esocialCode?: string | null
): CanonicalLeaveCategory {
  const lt = String(leaveType || '').trim().toUpperCase();
  const ec = String(esocialCode || '').trim().toUpperCase();

  if (ec === '01' || lt.includes('WORK_ACCIDENT') || lt.includes('ACIDENTE')) {
    return 'WORK_ACCIDENT';
  }
  if (ec === '03' || lt.includes('SICK') || lt.includes('DOENCA') || lt.includes('DOENÇA') || lt.includes('ATESTADO')) {
    return 'SICK_LEAVE';
  }
  if (['17', '35', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'].includes(ec) || lt.includes('MATERNITY') || lt.includes('MATERNIDADE')) {
    return 'MATERNITY';
  }
  if (ec === '29' || lt.includes('PATERNITY') || lt.includes('PATERNIDADE')) {
    return 'PATERNITY';
  }
  if (ec === '19' || lt.includes('MILITARY') || lt.includes('MILITAR')) {
    return 'MILITARY_SERVICE';
  }
  if (['21', '22', '37'].includes(ec) || lt.includes('UNPAID') || lt.includes('SEM_VENCIMENTO') || lt.includes('SEM_REMUNERACAO')) {
    return 'UNPAID_LEAVE';
  }
  if (lt.includes('SUSPENS')) {
    return 'SUSPENSION';
  }
  return 'OTHER';
}

/**
 * Calcula a data limite de estabilidade provisória de 12 meses para Acidente de Trabalho
 * (Art. 118 da Lei 8.213/1991: exigido afastamento > 15 dias).
 */
export function computeWorkAccidentStabilityDate(leave: LeaveRecordInput): string | null {
  const category = resolveCanonicalLeaveCategory(leave.leave_type, leave.esocial_reason_code);
  if (category !== 'WORK_ACCIDENT') return null;

  const endRef = leave.end_date || leave.return_date;
  if (!endRef) return null;

  const start = parseIsoUtc(leave.start_date);
  const end = parseIsoUtc(endRef);
  const totalDays = diffDaysInclusive(start, end);

  if (totalDays <= 15 && !leave.is_inss_responsible) {
    return null;
  }

  const returnRef = leave.return_date
    ? leave.return_date.slice(0, 10)
    : toIsoUtc(addDaysUtc(end, 1));
  return addMonthsIsoUtc(returnRef, 12);
}

/**
 * Constrói a linha do tempo diária de afastamentos com soma de atestados da mesma CID em 60 dias
 * (Decreto 3.048/1999 art. 75 §§ 4º e 5º) e apura classificação exata de cada dia civil.
 */
export function buildLeaveTimelineMap(
  leaves: LeaveRecordInput[],
  horizonEndDate: string
): {
  dayMap: Map<string, DayClassification>;
  sameCidAggregatedCount: number;
  latestWorkAccidentStabilityUntil: string | null;
} {
  const activeLeaves = (leaves || [])
    .filter((l) => String(l.status || 'ACTIVE').toUpperCase() !== 'CANCELLED' && Boolean(l.start_date))
    .slice()
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  const dayMap = new Map<string, DayClassification>();
  const horizonDt = parseIsoUtc(horizonEndDate);

  // Estado acumulado por CID normalizada para regra de 60 dias (Decreto 3.048/99 art. 75 §§ 4-5)
  interface CidClusterState {
    companyDaysUsed: number;
    lastEndDt: Date;
  }
  const cidState = new Map<string, CidClusterState>();
  let sameCidAggregatedCount = 0;
  let latestWorkAccidentStabilityUntil: string | null = null;

  for (const leave of activeLeaves) {
    const category = resolveCanonicalLeaveCategory(leave.leave_type, leave.esocial_reason_code);
    const startDt = parseIsoUtc(leave.start_date);
    if (startDt.getTime() > horizonDt.getTime()) continue;

    const effectiveEndStr = leave.end_date
      ? leave.end_date.slice(0, 10)
      : toIsoUtc(horizonDt);
    const rawEndDt = parseIsoUtc(effectiveEndStr);
    const clippedEndDt = rawEndDt.getTime() > horizonDt.getTime() ? horizonDt : rawEndDt;

    if (category === 'WORK_ACCIDENT') {
      const stab = computeWorkAccidentStabilityDate(leave);
      if (stab && (!latestWorkAccidentStabilityUntil || stab > latestWorkAccidentStabilityUntil)) {
        latestWorkAccidentStabilityUntil = stab;
      }
    }

    let priorCompanyDaysUsed = 0;
    const isSickOrAccident = category === 'SICK_LEAVE' || category === 'WORK_ACCIDENT';
    const normCid = normalizeCid10(leave.cid10_code);

    if (isSickOrAccident && normCid.length > 0) {
      const prev = cidState.get(normCid);
      if (prev) {
        const gapDays = Math.floor((startDt.getTime() - prev.lastEndDt.getTime()) / 86400000);
        if (gapDays <= 60) {
          priorCompanyDaysUsed = prev.companyDaysUsed;
          sameCidAggregatedCount++;
        }
      }
    } else if (isSickOrAccident && leave.is_same_cid_relapse) {
      // Recidiva explícita sem código CID-10 informado: considera carência de 15 dias já consumida
      priorCompanyDaysUsed = 15;
    }

    let dayOffsetInLeave = 0;
    for (let dt = startDt; dt.getTime() <= clippedEndDt.getTime(); dt = addDaysUtc(dt, 1)) {
      dayOffsetInLeave++;
      const iso = toIsoUtc(dt);

      let info: DayClassification = {
        category,
        leaveId: leave.id,
        isEmployerPaidSick: false,
        isInssCovered: false,
        isMaternityDctfDeductible: false,
        isMaternityExtended: false,
        isEmployerPaidPaternity: false,
        isUnpaid: false,
        isFgtsCompulsory: false,
        countsForThirteenth: false,
      };

      if (category === 'SICK_LEAVE') {
        const cumulativeCompanyDay = priorCompanyDaysUsed + dayOffsetInLeave;
        if (cumulativeCompanyDay <= 15) {
          info.isEmployerPaidSick = true;
          info.countsForThirteenth = true;
        } else {
          info.isInssCovered = true;
        }
      } else if (category === 'WORK_ACCIDENT') {
        const cumulativeCompanyDay = priorCompanyDaysUsed + dayOffsetInLeave;
        info.isFgtsCompulsory = true; // Art. 15 §5º Lei 8.036/90 mantém FGTS durante TODO o B91
        if (cumulativeCompanyDay <= 15) {
          info.isEmployerPaidSick = true;
          info.countsForThirteenth = true;
        } else {
          info.isInssCovered = true;
        }
      } else if (category === 'MATERNITY') {
        info.countsForThirteenth = true;
        // Lei 8.213/91 art. 72 §1º: 120 dias são dedutíveis na DCTFWeb; prorrogação Empresa Cidadã (121..180) não abate DCTFWeb previdenciária
        if (dayOffsetInLeave <= 120) {
          info.isMaternityDctfDeductible = true;
        } else {
          info.isMaternityExtended = true;
        }
      } else if (category === 'PATERNITY') {
        info.isEmployerPaidPaternity = true;
        info.countsForThirteenth = true;
      } else if (category === 'MILITARY_SERVICE') {
        info.isUnpaid = true;
        info.isFgtsCompulsory = true; // Art. 15 §5º Lei 8.036/90 mantém FGTS no Serviço Militar
      } else if (category === 'UNPAID_LEAVE' || category === 'SUSPENSION') {
        info.isUnpaid = true;
      } else {
        info.isEmployerPaidPaternity = true;
        info.countsForThirteenth = true;
      }

      dayMap.set(iso, info);
    }

    if (isSickOrAccident && normCid.length > 0) {
      const totalUsed = Math.min(15, priorCompanyDaysUsed + dayOffsetInLeave);
      cidState.set(normCid, {
        companyDaysUsed: totalUsed,
        lastEndDt: clippedEndDt,
      });
    }
  }

  return {
    dayMap,
    sameCidAggregatedCount,
    latestWorkAccidentStabilityUntil,
  };
}

export class LeaveImpactCalculator {
  /**
   * Avalia o impacto dos afastamentos na competência mensal de folha (dias trabalhados,
   * dias de atestado empresa, INSS, maternidade dedutível na DCTFWeb e base FGTS obrigatória).
   */
  public static calculatePeriodImpact(params: {
    leaves: LeaveRecordInput[];
    periodYear: number;
    periodMonth: number;
    baseEligibleDays: number; // Dias comerciais disponíveis após admissão/férias (normalmente 30)
    baseSalary: number;
  }): LeavePeriodImpactResult {
    const { leaves, periodYear, periodMonth, baseEligibleDays, baseSalary } = params;
    if (!leaves || leaves.length === 0) {
      return {
        workedSalaryDays: baseEligibleDays,
        companyPaidSickDays: 0,
        inssPaidDays: 0,
        maternityDeductibleDays: 0,
        maternityExtendedDays: 0,
        unpaidLeaveDays: 0,
        fgtsCompulsoryLeaveDays: 0,
        maternityDctfWebDeductibleAmount: 0,
        sameCidAggregatedCount: 0,
        hasActiveWorkAccidentStability: false,
        stabilityUntil: null,
        appliedLeaveIds: [],
        notes: [],
      };
    }

    const daysInMonth = new Date(Date.UTC(periodYear, periodMonth, 0)).getUTCDate();
    const startOfMonthStr = `${periodYear}-${String(periodMonth).padStart(2, '0')}-01`;
    const endOfMonthStr = `${periodYear}-${String(periodMonth).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const { dayMap, sameCidAggregatedCount, latestWorkAccidentStabilityUntil } =
      buildLeaveTimelineMap(leaves, endOfMonthStr);

    let sickCompanyCalDays = 0;
    let inssCalDays = 0;
    let matDeductibleCalDays = 0;
    let matExtendedCalDays = 0;
    let unpaidCalDays = 0;
    let fgtsCompulsoryCalDays = 0;
    let totalLeaveCalDaysInMonth = 0;
    const appliedSet = new Set<string>();

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${periodYear}-${String(periodMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const info = dayMap.get(iso);
      if (!info) continue;

      appliedSet.add(info.leaveId);

      // Paternidade mantém pagamento normal dentro do Salário Base sem precisar segregar rubrica
      if (info.isEmployerPaidPaternity) {
        continue;
      }

      totalLeaveCalDaysInMonth++;

      if (info.isEmployerPaidSick) sickCompanyCalDays++;
      if (info.isInssCovered) inssCalDays++;
      if (info.isMaternityDctfDeductible) matDeductibleCalDays++;
      if (info.isMaternityExtended) matExtendedCalDays++;
      if (info.isUnpaid) unpaidCalDays++;
      if (info.isFgtsCompulsory && info.isInssCovered) {
        // Apenas os dias SEM salário empresa (16º dia B91 ou Serviço Militar) exigem base FGTS via rubrica 906
        fgtsCompulsoryCalDays++;
      } else if (info.isFgtsCompulsory && info.category === 'MILITARY_SERVICE') {
        fgtsCompulsoryCalDays++;
      }
    }

    const fullMonthOnLeave = totalLeaveCalDaysInMonth >= daysInMonth;

    let companyPaidSickDays = 0;
    let maternityDeductibleDays = 0;
    let maternityExtendedDays = 0;
    let inssPaidDays = 0;
    let unpaidLeaveDays = 0;
    let fgtsCompulsoryLeaveDays = 0;
    let workedSalaryDays = baseEligibleDays;

    if (totalLeaveCalDaysInMonth > 0 && baseEligibleDays > 0) {
      if (fullMonthOnLeave) {
        workedSalaryDays = 0;
        if (matDeductibleCalDays + matExtendedCalDays >= daysInMonth) {
          maternityDeductibleDays = Math.min(baseEligibleDays, matDeductibleCalDays);
          maternityExtendedDays = Math.max(0, baseEligibleDays - maternityDeductibleDays);
          if (matExtendedCalDays === 0) {
            maternityDeductibleDays = baseEligibleDays;
          }
        } else {
          companyPaidSickDays = Math.min(baseEligibleDays, sickCompanyCalDays);
          maternityDeductibleDays = Math.min(baseEligibleDays, matDeductibleCalDays);
          maternityExtendedDays = Math.min(baseEligibleDays, matExtendedCalDays);
          inssPaidDays = Math.min(baseEligibleDays, inssCalDays);
          unpaidLeaveDays = Math.min(baseEligibleDays, unpaidCalDays);
          fgtsCompulsoryLeaveDays =
            fgtsCompulsoryCalDays >= daysInMonth
              ? baseEligibleDays
              : Math.min(baseEligibleDays, fgtsCompulsoryCalDays);
        }
      } else {
        companyPaidSickDays = Math.min(baseEligibleDays, sickCompanyCalDays);
        maternityDeductibleDays = Math.min(baseEligibleDays, matDeductibleCalDays);
        maternityExtendedDays = Math.min(baseEligibleDays, matExtendedCalDays);
        inssPaidDays = Math.min(baseEligibleDays, inssCalDays);
        unpaidLeaveDays = Math.min(baseEligibleDays, unpaidCalDays);
        fgtsCompulsoryLeaveDays = Math.min(baseEligibleDays, fgtsCompulsoryCalDays);

        const totalSegregated =
          companyPaidSickDays +
          maternityDeductibleDays +
          maternityExtendedDays +
          inssPaidDays +
          unpaidLeaveDays;
        workedSalaryDays = Math.max(0, baseEligibleDays - totalSegregated);
      }
    }

    const maternityDctfWebDeductibleAmount =
      maternityDeductibleDays > 0
        ? round2((baseSalary / 30) * maternityDeductibleDays)
        : 0;

    const notes: string[] = [];
    if (companyPaidSickDays > 0) {
      notes.push(`Auxílio-doença/atestado empresa: ${companyPaidSickDays} dia(s)`);
    }
    if (inssPaidDays > 0) {
      notes.push(`Afastamento INSS (>= 16º dia): ${inssPaidDays} dia(s)`);
    }
    if (sameCidAggregatedCount > 0) {
      notes.push(`Soma automática de atestados mesma CID em 60d aplicada (${sameCidAggregatedCount} vínculo(s))`);
    }
    if (fgtsCompulsoryLeaveDays > 0) {
      notes.push(`FGTS obrigatório mantido durante afastamento legal: ${fgtsCompulsoryLeaveDays} dia(s)`);
    }
    if (maternityDeductibleDays > 0) {
      notes.push(
        `Salário-Maternidade dedutível DCTFWeb: ${maternityDeductibleDays} dia(s) = R$ ${maternityDctfWebDeductibleAmount.toFixed(2)}`
      );
    }
    if (maternityExtendedDays > 0) {
      notes.push(`Prorrogação Empresa Cidadã (121-180d): ${maternityExtendedDays} dia(s)`);
    }
    if (unpaidLeaveDays > 0) {
      notes.push(`Licença não remunerada / Serviço Militar: ${unpaidLeaveDays} dia(s)`);
    }

    const hasActiveWorkAccidentStability = Boolean(
      latestWorkAccidentStabilityUntil && latestWorkAccidentStabilityUntil >= startOfMonthStr
    );

    return {
      workedSalaryDays,
      companyPaidSickDays,
      inssPaidDays,
      maternityDeductibleDays,
      maternityExtendedDays,
      unpaidLeaveDays,
      fgtsCompulsoryLeaveDays,
      maternityDctfWebDeductibleAmount,
      sameCidAggregatedCount,
      hasActiveWorkAccidentStability,
      stabilityUntil: latestWorkAccidentStabilityUntil,
      appliedLeaveIds: Array.from(appliedSet),
      notes,
    };
  }

  /**
   * Mapeia os dias sem crédito salarial da empresa no ano civil para cálculo preciso
   * dos avos de 13º salário (Lei 4.090/62):
   * - Dias de Auxílio-Doença/Acidente pelo INSS (>= 16º dia), Serviço Militar e Licença sem Vencimentos
   *   reduzem o avo mensal quando restarem < 15 dias trabalhados/empresa no mês.
   * - Licença-Maternidade e os primeiros 15 dias empresa preservam os avos.
   */
  public static getMonthlyLeaveNonCreditedDaysForThirteenth(
    leaves: LeaveRecordInput[],
    year: number,
    upToMonth: number = 12
  ): Record<number, number> {
    const result: Record<number, number> = {};
    if (!leaves || leaves.length === 0) return result;

    const lastDay = new Date(Date.UTC(year, upToMonth, 0)).getUTCDate();
    const horizon = `${year}-${String(upToMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const { dayMap } = buildLeaveTimelineMap(leaves, horizon);

    for (let m = 1; m <= upToMonth; m++) {
      const daysInM = new Date(Date.UTC(year, m, 0)).getUTCDate();
      let nonCredited = 0;
      for (let d = 1; d <= daysInM; d++) {
        const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const info = dayMap.get(iso);
        if (info && !info.countsForThirteenth) {
          nonCredited++;
        }
      }
      if (nonCredited > 0) {
        result[m] = nonCredited;
      }
    }

    return result;
  }

  /**
   * Avalia perda de período aquisitivo de férias conforme CLT Art. 133 inciso IV:
   * Empregado que tiver percebido da Previdência Social prestações de acidente de trabalho
   * ou de auxílio-doença por mais de 180 dias (contínuos ou descontínuos) no período aquisitivo
   * perde o direito às férias desse período (Licença-Maternidade não entra na contagem).
   */
  public static evaluateVacationAcquisitionLoss(params: {
    acquisitionStart: string;
    acquisitionEnd: string;
    leaves: LeaveRecordInput[];
  }): VacationAcquisitionLeaveEvaluation {
    const { acquisitionStart, acquisitionEnd, leaves } = params;
    const acqStartStr = acquisitionStart.slice(0, 10);
    const acqEndStr = acquisitionEnd.slice(0, 10);

    const { dayMap } = buildLeaveTimelineMap(leaves, acqEndStr);

    let inssBenefitDays = 0;
    let maternityDaysIgnored = 0;

    const startDt = parseIsoUtc(acqStartStr);
    const endDt = parseIsoUtc(acqEndStr);

    for (let dt = startDt; dt.getTime() <= endDt.getTime(); dt = addDaysUtc(dt, 1)) {
      const iso = toIsoUtc(dt);
      const info = dayMap.get(iso);
      if (!info) continue;

      if (info.category === 'MATERNITY') {
        maternityDaysIgnored++;
        continue;
      }

      if ((info.category === 'SICK_LEAVE' || info.category === 'WORK_ACCIDENT') && info.isInssCovered) {
        inssBenefitDays++;
      }
    }

    const thresholdDays = 180;
    const lostByLeave = inssBenefitDays > thresholdDays;

    return {
      acquisitionStart: acqStartStr,
      acquisitionEnd: acqEndStr,
      inssBenefitDays,
      maternityDaysIgnored,
      thresholdDays,
      lostByLeave,
      lossReason: lostByLeave
        ? `Perda do período aquisitivo por percepção de benefício previdenciário por ${inssBenefitDays} dias (> 180 dias — CLT Art. 133 IV).`
        : null,
    };
  }
}
