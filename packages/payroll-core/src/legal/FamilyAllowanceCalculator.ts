/**
 * Calculadora Pura de Salário-Família (CLT / Lei 8.213/91 Arts. 65-70 / Decreto 3.048/99 Arts. 81-92)
 * - Verifica elegibilidade por vínculo previdenciário de empregado (CLT/Temporário/Aprendiz)
 * - Verifica remuneração bruta INSS <= teto vigente (inclusive projeção mensal integral na admissão/demissão — IN INSS 128/2022 art. 363)
 * - Valida filhos/equiparados <= 14 anos (até o mês em que completa 14 anos) ou inválidos/deficientes de qualquer idade
 * - Valida carteira de vacinação (até 6 anos, validade anual de 12 meses) e frequência escolar (7 a 14 anos, validade semestral de 6 meses)
 * - Calcula proporcionalidade na admissão/demissão pelos dias corridos do mês civil
 * - Gera valor exato para rubrica 305 e abatimento integral automático na DCTFWeb
 */

import { getDaysInMonth, formatDate, diffDaysInclusive, parseDateParts } from '../engine/VacationOverlapCalculator.js';
import { multiplyMoney, round2 } from '../utils/money.js';

export interface FamilyAllowanceDependentInput {
  id?: string;
  name?: string;
  full_name?: string;
  cpf?: string | null;
  birth_date: string;
  relationship?: string;
  is_family_salary?: boolean;
  is_family_allowance_dependent?: boolean;
  is_incapacitated?: boolean;
  has_disability?: boolean;
  start_date?: string | null;
  end_date?: string | null;
  vaccination_card_date?: string | null;
  school_frequency_date?: string | null;
}

export type FamilyAllowanceRejectionCode =
  | 'NOT_MARKED_FAMILY_SALARY'
  | 'INELIGIBLE_RELATIONSHIP'
  | 'DUPLICATE'
  | 'OUTSIDE_VALIDITY'
  | 'OVER_AGE_14'
  | 'VACCINATION_MISSING'
  | 'VACCINATION_EXPIRED'
  | 'SCHOOL_FREQUENCY_MISSING'
  | 'SCHOOL_FREQUENCY_EXPIRED';

export interface FamilyAllowanceRejectedDependent {
  dependentId?: string;
  name: string;
  reasonCode: FamilyAllowanceRejectionCode;
  reason: string;
  ageAtCompetence: number;
}

export interface FamilyAllowanceCalculationInput {
  dependents: FamilyAllowanceDependentInput[];
  competenceYear: number;
  competenceMonth: number;
  monthlyInssBase: number;
  contractualSalary?: number;
  familySalaryCeiling: number;
  quotaValue: number;
  admissionDate?: string | null;
  terminationDate?: string | null;
  employeeRegime?: string | null;
  hasInssIncidence?: boolean;
  isFullMonthUnpaidOrInssBenefit?: boolean;
  requireComplianceDocuments?: boolean;
}

export interface FamilyAllowanceCalculationResult {
  eligibleByRegime: boolean;
  eligibleByCeiling: boolean;
  referenceRemunerationForCeiling: number;
  eligibleDependentsCount: number;
  eligibleDependents: Array<{ id?: string; name: string; age: number; isIncapacitated: boolean }>;
  rejectedDependents: FamilyAllowanceRejectedDependent[];
  complianceAlerts: FamilyAllowanceRejectedDependent[];
  proportionalDays: number;
  daysInMonth: number;
  proportionalFactor: number;
  quotaValueApplied: number;
  proportionalQuotaPerDependent: number;
  totalAmount: number;
  dctfWebDeductibleAmount: number;
  reasonNotPaid?: string;
  formulaDescription: string;
}

const INELIGIBLE_REGIMES = new Set(['PJ', 'ESTAGIO', 'ESTAGIARIO', 'AUTONOMOUS', 'AUTONOMO', 'PRO_LABORE', 'SOCIO']);
const INELIGIBLE_RELATIONSHIPS = new Set(['SPOUSE', 'CONJUGE', 'PARENT', 'PAI_MAE', 'PAIS', 'COMPANHEIRO']);

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function monthsElapsedBetween(fromIso: string, toYear: number, toMonth: number): number | null {
  const parts = parseDateParts(fromIso);
  if (!parts) return null;
  return (toYear - parts.year) * 12 + (toMonth - parts.month);
}

function computeCompletedYearsAtCompetence(birthIso: string, competenceYear: number, competenceMonth: number): number {
  const parts = parseDateParts(birthIso);
  if (!parts) return 0;
  let age = competenceYear - parts.year;
  if (competenceMonth < parts.month) {
    age -= 1;
  }
  return Math.max(0, age);
}

export class FamilyAllowanceCalculator {
  static calculate(input: FamilyAllowanceCalculationInput): FamilyAllowanceCalculationResult {
    const {
      dependents,
      competenceYear,
      competenceMonth,
      monthlyInssBase,
      contractualSalary = 0,
      familySalaryCeiling,
      quotaValue,
      admissionDate,
      terminationDate,
      employeeRegime,
      hasInssIncidence = true,
      isFullMonthUnpaidOrInssBenefit = false,
      requireComplianceDocuments = true,
    } = input;

    const daysInMonth = getDaysInMonth(competenceYear, competenceMonth);
    const monthStart = formatDate(competenceYear, competenceMonth, 1);
    const monthEnd = formatDate(competenceYear, competenceMonth, daysInMonth);

    const regimeUpper = String(employeeRegime || 'CLT').trim().toUpperCase();
    const eligibleByRegime = hasInssIncidence !== false && !INELIGIBLE_REGIMES.has(regimeUpper);

    const admIso = toIsoDate(admissionDate);
    const termIso = toIsoDate(terminationDate);

    let proportionalDays = daysInMonth;
    if (isFullMonthUnpaidOrInssBenefit) {
      proportionalDays = 0;
    } else if ((admIso && admIso > monthEnd) || (termIso && termIso < monthStart)) {
      proportionalDays = 0;
    } else {
      const effectiveStart = admIso && admIso > monthStart ? admIso : monthStart;
      const effectiveEnd = termIso && termIso < monthEnd ? termIso : monthEnd;
      if (effectiveStart !== monthStart || effectiveEnd !== monthEnd) {
        proportionalDays = effectiveEnd >= effectiveStart ? diffDaysInclusive(effectiveStart, effectiveEnd) : 0;
      }
    }

    const isPartialMonth = proportionalDays > 0 && proportionalDays < daysInMonth;
    const baseInssRounded = round2(Math.max(0, monthlyInssBase));
    // IN INSS 128/2022 Art. 363: em admissão/demissão verifica teto pela remuneração mensal equivalente integral
    const referenceRemunerationForCeiling = isPartialMonth && contractualSalary > 0
      ? Math.max(baseInssRounded, round2(contractualSalary))
      : baseInssRounded;

    const eligibleByCeiling =
      familySalaryCeiling > 0 &&
      referenceRemunerationForCeiling > 0 &&
      referenceRemunerationForCeiling <= round2(familySalaryCeiling);

    const eligibleDependents: Array<{ id?: string; name: string; age: number; isIncapacitated: boolean }> = [];
    const rejectedDependents: FamilyAllowanceRejectedDependent[] = [];

    const seenIds = new Set<string>();
    const seenCpfs = new Set<string>();

    for (const dep of dependents || []) {
      const depName = dep.name || dep.full_name || 'Dependente';
      const birthIso = toIsoDate(dep.birth_date);
      const isMarkedFamilySalary = Boolean(
        dep.is_family_salary ?? dep.is_family_allowance_dependent
      );
      const isIncapacitated = Boolean(dep.is_incapacitated ?? dep.has_disability);
      const age = birthIso ? computeCompletedYearsAtCompetence(birthIso, competenceYear, competenceMonth) : 0;

      if (!isMarkedFamilySalary) {
        rejectedDependents.push({
          dependentId: dep.id,
          name: depName,
          reasonCode: 'NOT_MARKED_FAMILY_SALARY',
          reason: 'Dependente não marcado para Salário-Família.',
          ageAtCompetence: age,
        });
        continue;
      }

      if (dep.id) {
        if (seenIds.has(dep.id)) {
          rejectedDependents.push({
            dependentId: dep.id,
            name: depName,
            reasonCode: 'DUPLICATE',
            reason: 'Dependente em duplicidade cadastral (mesmo ID).',
            ageAtCompetence: age,
          });
          continue;
        }
        seenIds.add(dep.id);
      }

      if (dep.cpf) {
        const cleanCpf = String(dep.cpf).replace(/\D/g, '');
        if (cleanCpf.length > 0) {
          if (seenCpfs.has(cleanCpf)) {
            rejectedDependents.push({
              dependentId: dep.id,
              name: depName,
              reasonCode: 'DUPLICATE',
              reason: `Dependente em duplicidade cadastral (CPF ${dep.cpf}).`,
              ageAtCompetence: age,
            });
            continue;
          }
          seenCpfs.add(cleanCpf);
        }
      }

      const relUpper = String(dep.relationship || 'CHILD').trim().toUpperCase();
      if (INELIGIBLE_RELATIONSHIPS.has(relUpper)) {
        rejectedDependents.push({
          dependentId: dep.id,
          name: depName,
          reasonCode: 'INELIGIBLE_RELATIONSHIP',
          reason: `Parentesco '${dep.relationship}' não dá direito ao Salário-Família (apenas filho/enteado/tutelado).`,
          ageAtCompetence: age,
        });
        continue;
      }

      const startIso = toIsoDate(dep.start_date);
      const endIso = toIsoDate(dep.end_date);
      if ((startIso && startIso > monthEnd) || (endIso && endIso < monthStart)) {
        rejectedDependents.push({
          dependentId: dep.id,
          name: depName,
          reasonCode: 'OUTSIDE_VALIDITY',
          reason: 'Dependência fora da vigência na competência.',
          ageAtCompetence: age,
        });
        continue;
      }

      if (!birthIso || birthIso > monthEnd) {
        rejectedDependents.push({
          dependentId: dep.id,
          name: depName,
          reasonCode: 'OUTSIDE_VALIDITY',
          reason: 'Data de nascimento posterior à competência ou não informada.',
          ageAtCompetence: age,
        });
        continue;
      }

      const birthParts = parseDateParts(birthIso)!;
      // Direito cessa no mês seguinte ao que o filho completar 14 anos (Decreto 3.048/99 art. 88 II)
      const exceededAge14 =
        age > 14 || (age === 14 && competenceMonth > birthParts.month);
      if (exceededAge14 && !isIncapacitated) {
        rejectedDependents.push({
          dependentId: dep.id,
          name: depName,
          reasonCode: 'OVER_AGE_14',
          reason: `Idade (${age} anos) superior ao limite legal de 14 anos sem invalidez declarada.`,
          ageAtCompetence: age,
        });
        continue;
      }

      if (requireComplianceDocuments && !isIncapacitated) {
        const bornInCompetence =
          birthParts.year === competenceYear && birthParts.month === competenceMonth;

        if (age <= 6 && !bornInCompetence) {
          const vaccIso = toIsoDate(dep.vaccination_card_date);
          if (!vaccIso) {
            rejectedDependents.push({
              dependentId: dep.id,
              name: depName,
              reasonCode: 'VACCINATION_MISSING',
              reason: `Comprovante anual de vacinação obrigatório ausente para dependente de ${age} ano(s) (Decreto 3.048/99 art. 84).`,
              ageAtCompetence: age,
            });
            continue;
          }
          const monthsSinceVacc = monthsElapsedBetween(vaccIso, competenceYear, competenceMonth);
          if (monthsSinceVacc === null || monthsSinceVacc > 12) {
            rejectedDependents.push({
              dependentId: dep.id,
              name: depName,
              reasonCode: 'VACCINATION_EXPIRED',
              reason: `Caderneta de vacinação vencida (${monthsSinceVacc ?? '?'} meses desde ${vaccIso}; validade máxima anual de 12 meses).`,
              ageAtCompetence: age,
            });
            continue;
          }
        } else if (age >= 7 && age <= 14) {
          const schoolIso = toIsoDate(dep.school_frequency_date);
          if (!schoolIso) {
            rejectedDependents.push({
              dependentId: dep.id,
              name: depName,
              reasonCode: 'SCHOOL_FREQUENCY_MISSING',
              reason: `Comprovante semestral de frequência escolar obrigatório ausente para dependente de ${age} anos (Decreto 3.048/99 art. 84).`,
              ageAtCompetence: age,
            });
            continue;
          }
          const monthsSinceSchool = monthsElapsedBetween(schoolIso, competenceYear, competenceMonth);
          if (monthsSinceSchool === null || monthsSinceSchool > 6) {
            rejectedDependents.push({
              dependentId: dep.id,
              name: depName,
              reasonCode: 'SCHOOL_FREQUENCY_EXPIRED',
              reason: `Comprovante de frequência escolar vencido (${monthsSinceSchool ?? '?'} meses desde ${schoolIso}; validade máxima semestral de 6 meses).`,
              ageAtCompetence: age,
            });
            continue;
          }
        }
      }

      eligibleDependents.push({
        id: dep.id,
        name: depName,
        age,
        isIncapacitated,
      });
    }

    const complianceAlerts = rejectedDependents.filter((r) =>
      r.reasonCode === 'VACCINATION_MISSING' ||
      r.reasonCode === 'VACCINATION_EXPIRED' ||
      r.reasonCode === 'SCHOOL_FREQUENCY_MISSING' ||
      r.reasonCode === 'SCHOOL_FREQUENCY_EXPIRED'
    );

    const eligibleCount = eligibleDependents.length;
    const proportionalFactor = daysInMonth > 0 ? proportionalDays / daysInMonth : 0;
    const quotaSafe = round2(Math.max(0, quotaValue));

    if (!eligibleByRegime) {
      return {
        eligibleByRegime,
        eligibleByCeiling: false,
        referenceRemunerationForCeiling,
        eligibleDependentsCount: eligibleCount,
        eligibleDependents,
        rejectedDependents,
        complianceAlerts,
        proportionalDays,
        daysInMonth,
        proportionalFactor,
        quotaValueApplied: quotaSafe,
        proportionalQuotaPerDependent: 0,
        totalAmount: 0,
        dctfWebDeductibleAmount: 0,
        reasonNotPaid: `Vínculo (${regimeUpper}) não elegível ao Salário-Família.`,
        formulaDescription: `Regime ${regimeUpper} inelegível para Salário-Família`,
      };
    }

    if (isFullMonthUnpaidOrInssBenefit || proportionalDays === 0) {
      return {
        eligibleByRegime,
        eligibleByCeiling,
        referenceRemunerationForCeiling,
        eligibleDependentsCount: eligibleCount,
        eligibleDependents,
        rejectedDependents,
        complianceAlerts,
        proportionalDays: 0,
        daysInMonth,
        proportionalFactor: 0,
        quotaValueApplied: quotaSafe,
        proportionalQuotaPerDependent: 0,
        totalAmount: 0,
        dctfWebDeductibleAmount: 0,
        reasonNotPaid: 'Sem dias trabalhados/remunerados pela empresa na competência.',
        formulaDescription: 'Afastamento integral INSS ou fora da vigência contratual na competência',
      };
    }

    if (!eligibleByCeiling) {
      return {
        eligibleByRegime,
        eligibleByCeiling: false,
        referenceRemunerationForCeiling,
        eligibleDependentsCount: eligibleCount,
        eligibleDependents,
        rejectedDependents,
        complianceAlerts,
        proportionalDays,
        daysInMonth,
        proportionalFactor,
        quotaValueApplied: quotaSafe,
        proportionalQuotaPerDependent: 0,
        totalAmount: 0,
        dctfWebDeductibleAmount: 0,
        reasonNotPaid: `Remuneração bruta INSS (R$ ${referenceRemunerationForCeiling.toFixed(2)}) acima do teto legal (R$ ${round2(familySalaryCeiling).toFixed(2)}).`,
        formulaDescription: `Bruto INSS R$ ${referenceRemunerationForCeiling.toFixed(2)} > Teto R$ ${round2(familySalaryCeiling).toFixed(2)}`,
      };
    }

    if (eligibleCount === 0 || quotaSafe <= 0) {
      return {
        eligibleByRegime,
        eligibleByCeiling: true,
        referenceRemunerationForCeiling,
        eligibleDependentsCount: 0,
        eligibleDependents,
        rejectedDependents,
        complianceAlerts,
        proportionalDays,
        daysInMonth,
        proportionalFactor,
        quotaValueApplied: quotaSafe,
        proportionalQuotaPerDependent: 0,
        totalAmount: 0,
        dctfWebDeductibleAmount: 0,
        reasonNotPaid:
          complianceAlerts.length > 0
            ? complianceAlerts.map((a) => `${a.name}: ${a.reason}`).join(' | ')
            : 'Nenhum dependente elegível para Salário-Família.',
        formulaDescription:
          complianceAlerts.length > 0
            ? `Pendência documental: ${complianceAlerts.map((a) => `${a.name} (${a.reasonCode})`).join(', ')}`
            : 'Sem dependentes elegíveis ao Salário-Família',
      };
    }

    const proportionalQuotaPerDependent = round2(quotaSafe * proportionalFactor);
    const totalAmount =
      proportionalDays === daysInMonth
        ? multiplyMoney(quotaSafe, eligibleCount)
        : round2(quotaSafe * eligibleCount * proportionalFactor);

    const proportionLabel =
      proportionalDays < daysInMonth
        ? ` × (${proportionalDays}/${daysInMonth} dias)`
        : '';

    return {
      eligibleByRegime: true,
      eligibleByCeiling: true,
      referenceRemunerationForCeiling,
      eligibleDependentsCount: eligibleCount,
      eligibleDependents,
      rejectedDependents,
      complianceAlerts,
      proportionalDays,
      daysInMonth,
      proportionalFactor,
      quotaValueApplied: quotaSafe,
      proportionalQuotaPerDependent,
      totalAmount,
      dctfWebDeductibleAmount: totalAmount,
      formulaDescription: `R$ ${quotaSafe.toFixed(2)} × ${eligibleCount} cotas${proportionLabel} [Bruto INSS R$ ${referenceRemunerationForCeiling.toFixed(2)} ≤ Teto R$ ${round2(familySalaryCeiling).toFixed(2)}]`,
    };
  }
}
