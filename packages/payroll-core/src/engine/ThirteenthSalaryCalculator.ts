/**
 * Módulo de Apuração do 13º Salário (Gratificação Natalina - T19 & FOLHA-12)
 * Legislação: Lei nº 4.090/1962, Lei nº 4.749/1965, Decreto nº 10.854/2021 (Art. 76 e Art. 79)
 * e Súmulas 45 e 60 do TST (médias de horas extras e adicionais).
 */

import { addMoney, round2, subtractMoney, sumMoney } from '../utils/money.js';
import { INSSCalculator } from '../legal/INSSCalculator.js';
import { IRRFCalculator } from '../legal/IRRFCalculator.js';
import { FGTSCalculator } from '../legal/FGTSCalculator.js';
import type { GeneralLegalParameters, InssBracket, IrrfBracket } from './PayrollContext.js';

export interface ThirteenthMonthDetail {
  month: number;
  workedDays: number;
  unjustifiedAbsences: number;
  hasAvo: boolean;
  reason: string;
}

export interface ThirteenthAvosResult {
  totalAvos: number;
  monthDetails: ThirteenthMonthDetail[];
}

/**
 * Retorna o número de dias de um determinado mês e ano.
 */
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Calcula os avos de direito de 13º salário considerando a data de admissão e as faltas injustificadas.
 * Regras (Lei 4.090/62 art. 1º §2º e Decreto 10.854/2021 art. 76):
 * 1. Fração igual ou superior a 15 dias trabalhados no mês civil garante 1 avo (1/12).
 * 2. No mês de admissão: verifica se trabalhou pelo menos 15 dias (ex: 30 - dia + 1 >= 15).
 * 3. Faltas injustificadas superiores a 15 dias no mesmo mês civil acarretam a perda do avo correspondente.
 * 
 * @param admissionDate Data de admissão no formato YYYY-MM-DD
 * @param year Ano da competência do 13º
 * @param upToMonth Mês limite para apuração (ex: 12 para 13º integral, ou 11 para 1ª parcela)
 * @param monthlyUnjustifiedAbsences Mapa de mês (1-12) para quantidade de faltas injustificadas
 */
export function calculateThirteenthAvos(
  admissionDate: string | undefined | null,
  year: number,
  upToMonth: number = 12,
  monthlyUnjustifiedAbsences: Record<number, number> = {},
  monthlyNonCreditedLeaveDays: Record<number, number> = {}
): ThirteenthAvosResult {
  const monthDetails: ThirteenthMonthDetail[] = [];
  let totalAvos = 0;

  let admYear = 0;
  let admMonth = 0;
  let admDay = 0;

  if (admissionDate) {
    const parts = admissionDate.split('-');
    if (parts.length >= 3) {
      admYear = parseInt(parts[0], 10);
      admMonth = parseInt(parts[1], 10);
      admDay = parseInt(parts[2], 10);
    }
  }

  for (let m = 1; m <= upToMonth; m++) {
    const daysInCurrentMonth = getDaysInMonth(year, m);
    const absences = monthlyUnjustifiedAbsences[m] || 0;
    const leaveNonCredited = monthlyNonCreditedLeaveDays[m] || 0;

    // Caso 1: Admitido em ano futuro
    if (admYear > year) {
      monthDetails.push({
        month: m,
        workedDays: 0,
        unjustifiedAbsences: absences,
        hasAvo: false,
        reason: 'Contrato não iniciado neste ano civil',
      });
      continue;
    }

    // Caso 2: Mês anterior à admissão no mesmo ano
    if (admYear === year && m < admMonth) {
      monthDetails.push({
        month: m,
        workedDays: 0,
        unjustifiedAbsences: absences,
        hasAvo: false,
        reason: 'Mês anterior à admissão do colaborador',
      });
      continue;
    }

    // Caso 3: Mês de admissão no mesmo ano
    if (admYear === year && m === admMonth) {
      const baseDays = Math.max(0, daysInCurrentMonth - admDay + 1);
      const workedDays = Math.max(0, baseDays - leaveNonCredited);
      if (workedDays >= 15) {
        if (absences > 15 || (leaveNonCredited > 0 && workedDays - absences < 15)) {
          monthDetails.push({
            month: m,
            workedDays: Math.max(0, workedDays - absences),
            unjustifiedAbsences: absences,
            hasAvo: false,
            reason: `Perda do avo por faltas/afastamento sem remuneração no mês (${absences} faltas, ${leaveNonCredited}d afast. não creditados)`,
          });
        } else {
          totalAvos += 1;
          monthDetails.push({
            month: m,
            workedDays,
            unjustifiedAbsences: absences,
            hasAvo: true,
            reason: `Admitido no mês com ${workedDays} dias computáveis (>= 15 dias)`,
          });
        }
      } else {
        monthDetails.push({
          month: m,
          workedDays,
          unjustifiedAbsences: absences,
          hasAvo: false,
          reason: `Menos de 15 dias computáveis na admissão (${workedDays} dias; ${leaveNonCredited}d afast. sem remuneração)`,
        });
      }
      continue;
    }

    // Caso 4: Meses após a admissão (ou admitido em ano anterior)
    const afterLeave = Math.max(0, daysInCurrentMonth - leaveNonCredited);
    const workedDays = Math.max(0, afterLeave - absences);
    const lostByAbsences = absences > 15;
    const lostByLeave = leaveNonCredited > 0 && workedDays < 15;

    if (lostByAbsences || lostByLeave) {
      monthDetails.push({
        month: m,
        workedDays,
        unjustifiedAbsences: absences,
        hasAvo: false,
        reason: lostByLeave
          ? `Perda do avo por afastamento previdenciário/suspensão (${leaveNonCredited}d sem crédito empresa; apenas ${workedDays}d computáveis < 15d)`
          : `Perda do avo por mais de 15 faltas injustificadas no mês (${absences} faltas)`,
      });
    } else {
      totalAvos += 1;
      monthDetails.push({
        month: m,
        workedDays,
        unjustifiedAbsences: absences,
        hasAvo: true,
        reason: 'Mês integralmente computado (>= 15 dias de efetivo trabalho)',
      });
    }
  }

  return {
    totalAvos: Math.min(12, Math.max(0, totalAvos)),
    monthDetails,
  };
}

export interface ThirteenthSalaryValues {
  baseRemunerationWithAverages: number;
  totalThirteenthGross: number;
  firstInstallmentGross: number;
  firstInstallmentBase?: number;
  firstInstallmentAverages?: number;
  secondInstallmentGross: number;
  advanceDeduction: number;
  netPayable: number;
}

/**
 * Calcula a remuneração integral de 13º salário com médias de variáveis (Súmulas 45 e 60 TST).
 * 
 * @param baseSalary Salário contratual base
 * @param variableAverages Média de horas extras, adicionais e comissões do ano
 * @param avos Quantidade de avos de direito (0 a 12)
 * @param type Tipo de folha ('THIRTEENTH_1', 'THIRTEENTH_2' ou 'THIRTEENTH_SINGLE')
 * @param advancesPaid Valor total de adiantamentos de 13º pagos no ano (para desconto na 2ª parcela ou parcela única)
 */
export function calculateThirteenthValues(
  baseSalary: number,
  variableAverages: number,
  avos: number,
  type: 'THIRTEENTH_1' | 'THIRTEENTH_2' | 'THIRTEENTH_SINGLE' | '13TH',
  advancesPaid: number = 0
): ThirteenthSalaryValues {
  const baseRemunerationWithAverages = sumMoney([baseSalary, variableAverages]);
  const totalThirteenthGross = round2((baseRemunerationWithAverages / 12) * avos);

  if (type === 'THIRTEENTH_1') {
    const baseThirteenthGross = round2((baseSalary / 12) * avos);
    const firstInstallmentBase = round2(baseThirteenthGross / 2);
    const averagesThirteenthGross = round2((variableAverages / 12) * avos);
    const firstInstallmentAverages = round2(averagesThirteenthGross / 2);
    const firstInstallmentGross = addMoney(firstInstallmentBase, firstInstallmentAverages);
    return {
      baseRemunerationWithAverages,
      totalThirteenthGross,
      firstInstallmentGross,
      firstInstallmentBase,
      firstInstallmentAverages,
      secondInstallmentGross: 0,
      advanceDeduction: 0,
      netPayable: firstInstallmentGross,
    };
  }

  // 2ª Parcela ou Parcela Única
  const advanceDeduction = round2(advancesPaid);
  const netPayable = Math.max(0, round2(totalThirteenthGross - advanceDeduction));

  return {
    baseRemunerationWithAverages,
    totalThirteenthGross,
    firstInstallmentGross: 0,
    secondInstallmentGross: totalThirteenthGross,
    advanceDeduction,
    netPayable,
  };
}

export interface ThirteenthComplementaryInput {
  baseSalary: number;
  recalculatedFullYearAverages: number;
  avos: number;
  priorSecondInstallmentGross: number;
  priorInss13Withheld: number;
  priorIrrf13Withheld: number;
  priorFgts13Base: number;
  dependentsCount?: number;
  alimony13Total?: number;
  isApprentice?: boolean;
  inssParameters: InssBracket[];
  irrfParameters: IrrfBracket[];
  generalLegalParameters: GeneralLegalParameters;
}

export interface ThirteenthComplementaryResult {
  recalculatedTotalGross: number;
  grossDifference: number;
  positiveComplementGross: number;
  negativeOverpaymentDeduction: number;
  totalInss13Due: number;
  inssDifference: number;
  totalIrrf13Due: number;
  irrfDifference: number;
  fgtsDifferentialBase: number;
  fgtsDifference: number;
  netDifferencePayable: number;
  formulaDescription: string;
}

/**
 * Decreto nº 10.854/2021 Art. 79:
 * Ajuste / Complementar de 13º Salário em Janeiro após fechamento integral das variáveis de Dezembro.
 */
export function calculateThirteenthComplementary(
  input: ThirteenthComplementaryInput
): ThirteenthComplementaryResult {
  const baseWithAvg = addMoney(input.baseSalary, input.recalculatedFullYearAverages);
  const recalculatedTotalGross = round2((baseWithAvg / 12) * Math.min(12, Math.max(0, input.avos)));
  const grossDifference = subtractMoney(recalculatedTotalGross, input.priorSecondInstallmentGross);
  const positiveComplementGross = grossDifference > 0 ? grossDifference : 0;
  const negativeOverpaymentDeduction = grossDifference < 0 ? Math.abs(grossDifference) : 0;

  const totalInssRes = INSSCalculator.calculate(recalculatedTotalGross, input.inssParameters);
  const inssDifference = Math.max(0, subtractMoney(totalInssRes.value, input.priorInss13Withheld));

  const totalIrrfRes = IRRFCalculator.calculate(
    recalculatedTotalGross,
    totalInssRes.value,
    input.dependentsCount || 0,
    input.irrfParameters,
    input.generalLegalParameters,
    input.alimony13Total || 0
  );
  const irrfDifference = Math.max(0, subtractMoney(totalIrrfRes.value, input.priorIrrf13Withheld));

  const fgtsDifferentialBase = Math.max(0, subtractMoney(recalculatedTotalGross, input.priorFgts13Base));
  const fgtsRes = FGTSCalculator.calculate(
    fgtsDifferentialBase,
    Boolean(input.isApprentice),
    input.generalLegalParameters.fgts_standard_aliquot,
    input.generalLegalParameters.fgts_apprentice_aliquot
  );

  const netDifferencePayable = subtractMoney(
    positiveComplementGross,
    sumMoney([negativeOverpaymentDeduction, inssDifference, irrfDifference])
  );

  return {
    recalculatedTotalGross,
    grossDifference,
    positiveComplementGross,
    negativeOverpaymentDeduction,
    totalInss13Due: totalInssRes.value,
    inssDifference,
    totalIrrf13Due: totalIrrfRes.value,
    irrfDifference,
    fgtsDifferentialBase,
    fgtsDifference: fgtsRes.value,
    netDifferencePayable,
    formulaDescription: `Decreto 10.854/2021 Art. 79: 13º Recalculado R$ ${recalculatedTotalGross.toFixed(2)} - Pago Dez R$ ${input.priorSecondInstallmentGross.toFixed(2)} = Dif. R$ ${grossDifference.toFixed(2)} | INSS Dif: R$ ${inssDifference.toFixed(2)} | IRRF Dif: R$ ${irrfDifference.toFixed(2)}`,
  };
}

/**
 * Decreto nº 3.048/1999 Art. 96 e IN RFB nº 2.110/2022 Art. 227:
 * Proporcional do 13º Salário-Maternidade dedutível na DCTFWeb.
 * A dedução é apurada à razão de 1/12 por mês (ou fração >= 15 dias) de licença
 * dentro dos 12 meses do ano civil (diasLicencaNoAno / 360, teto 1.0).
 */
export function calculateThirteenthMaternityDeduction(
  grossThirteenth: number,
  avos: number,
  maternityDeductibleDaysInYear: number
): number {
  if (grossThirteenth <= 0 || avos <= 0 || maternityDeductibleDaysInYear <= 0) return 0;
  const ratio = Math.min(1, maternityDeductibleDaysInYear / 360);
  const calculated = round2(grossThirteenth * ratio);
  return Math.min(grossThirteenth, calculated);
}

export interface ThirteenthWorkAccidentComplementInput {
  baseSalary: number;
  variableAverages: number;
  companyAvos: number; // Avos computáveis pela empresa (ex.: meses trabalhados + primeiros 15 dias)
  inssAnnualBonusAmount: number; // Valor informado do Abono Anual pago pelo INSS
}

export interface ThirteenthWorkAccidentComplementResult {
  fullYearThirteenthGross: number; // 13º integral devido no ano (12/12)
  companyProportionalGross: number; // 13º proporcional pago pela empresa
  inssAnnualBonusAmount: number;
  complementAmount: number; // Diferença a complementar pelo empregador
  isComplementDue: boolean;
  formulaDescription: string;
}

/**
 * Súmula nº 46 do TST:
 * "As faltas ou ausências decorrentes de acidente do trabalho não são consideradas para os efeitos de cálculo da gratificação natalina."
 * Garante que o empregado acidentado receba o 13º Salário integral.
 * O empregador complementa a diferença entre o 13º integral e a soma do 13º pago pela empresa com o Abono Anual pago pelo INSS.
 */
export function calculateThirteenthWorkAccidentComplement(
  input: ThirteenthWorkAccidentComplementInput
): ThirteenthWorkAccidentComplementResult {
  const fullBase = addMoney(input.baseSalary, input.variableAverages);
  const fullYearThirteenthGross = round2(fullBase); // 12 avos
  const companyProportionalGross = round2((fullBase / 12) * Math.min(12, Math.max(0, input.companyAvos)));
  const totalPaidSoFar = addMoney(companyProportionalGross, input.inssAnnualBonusAmount);
  const complementAmount = Math.max(0, subtractMoney(fullYearThirteenthGross, totalPaidSoFar));

  return {
    fullYearThirteenthGross,
    companyProportionalGross,
    inssAnnualBonusAmount: round2(input.inssAnnualBonusAmount),
    complementAmount,
    isComplementDue: complementAmount > 0,
    formulaDescription: `Súmula 46 TST: 13º Integral R$ ${fullYearThirteenthGross.toFixed(2)} - (13º Empresa R$ ${companyProportionalGross.toFixed(2)} + Abono INSS R$ ${Number(input.inssAnnualBonusAmount).toFixed(2)}) = Complemento R$ ${complementAmount.toFixed(2)}`,
  };
}
