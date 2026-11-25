/**
 * Motor Unificado de Rescisão Trabalhista (TRCT - BUG-08).
 * - Datas manipuladas estritamente via componentes YYYY-MM-DD em UTC (zero toISOString local).
 * - Projeção do aviso prévio indenizado respeitando virada Dez->Jan e múltiplos avos (>1 avo).
 * - IRRF calculado sem dupla dedução de INSS (passando bruto e INSS ao IRRFCalculator).
 * - Suporte a dependentes elegíveis, aprendiz (FGTS 2%) e aritmética HALF_UP (money.ts).
 */

import { INSSCalculator } from '../legal/INSSCalculator.js';
import { IRRFCalculator } from '../legal/IRRFCalculator.js';
import { FGTSCalculator } from '../legal/FGTSCalculator.js';
import { GeneralLegalParameters, InssBracket, IrrfBracket } from './PayrollContext.js';
import { parseDateParts, formatDate, diffDaysInclusive } from './VacationOverlapCalculator.js';
import { addMoney, divideMoney, multiplyMoney, round2, subtractMoney, sumMoney } from '../utils/money.js';

export type DismissalType =
  | 'WITHOUT_CAUSE'
  | 'WITH_CAUSE'
  | 'RESIGNATION'
  | 'MUTUAL_AGREEMENT'
  | 'CONTRACT_EXPIRATION';

export type NoticeType = 'WORKED' | 'INDEMNIFIED' | 'WAIVED' | 'MIXED';

export interface TerminationCalculationInput {
  baseSalary: number;
  admissionDate: string;
  resignationDate: string;
  noticeDate?: string;
  dismissalType: DismissalType;
  noticeType: NoticeType;
  mediasAdicionais?: number;
  outrosDescontos?: number;
  dependentsCount?: number;
  isApprentice?: boolean;
  fgtsBalancePrior?: number;
  inssParameters: InssBracket[];
  irrfParameters: IrrfBracket[];
  generalLegalParameters: GeneralLegalParameters;
}

export interface TerminationCalculationOutput {
  proventos: {
    saldoSalario: { dias: number; valor: number };
    avisoIndenizado: { dias: number; valor: number };
    decimoTerceiro: { avos: number; valor: number };
    decimoTerceiroAviso: { avos: number; valor: number };
    feriasProporcionais: { avos: number; valor: number };
    umTercoFerias: { valor: number };
  };
  descontos: {
    inssSaldo: { valor: number };
    inssDecimo: { valor: number };
    irrf: { valor: number; baseLegal: number; redutor: number };
    irrfDecimo: { valor: number; baseLegal: number; redutor: number };
    avisoDescontado: { dias: number; valor: number };
    outros: { valor: number };
  };
  encargos: {
    fgtsMes: number;
    fgtsAviso: number;
    fgtsDecimo: number;
    baseMulta: number;
    percentualMulta: number;
    multaFGTS: number;
  };
  totais: {
    bruto: number;
    descontos: number;
    liquido: number;
  };
  metadados: {
    diasAvisoReal: number;
    dataProjetada: string;
    remuneracaoBase: number;
    dependentesConsiderados: number;
  };
}

function addDaysUTC(dateStr: string, days: number): string {
  const parts = parseDateParts(dateStr);
  if (!parts) throw new Error(`Data inválida: '${dateStr}'`);
  const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function daysInCivilMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Conta os avos de 13º salário dentro de um intervalo inclusivo [startStr, endStr] no ano civil de referência.
 * Considera >= 15 dias no mês civil como 1 avo (Art. 1º §2º Lei 4.090/1962).
 */
function countThirteenthAvosInRange(startStr: string, endStr: string, targetYear: number): number {
  const s = parseDateParts(startStr);
  const e = parseDateParts(endStr);
  if (!s || !e) return 0;

  let avos = 0;
  for (let m = 1; m <= 12; m++) {
    const mStart = formatDate(targetYear, m, 1);
    const mEnd = formatDate(targetYear, m, daysInCivilMonth(targetYear, m));

    const effStart = startStr > mStart ? startStr : mStart;
    const effEnd = endStr < mEnd ? endStr : mEnd;

    if (effEnd >= effStart) {
      const worked = diffDaysInclusive(effStart, effEnd);
      if (worked >= 15) {
        avos += 1;
      }
    }
  }
  return avos;
}

/**
 * Calcula avos totais considerando mudança de ano (ex: Dezembro -> Janeiro/Fevereiro pela projeção do aviso).
 * Para 13º na rescisão, apura os avos do ano da saída e os avos adicionais gerados pela projeção
 * (inclusive virada para o ano seguinte quando o aviso indenizado projeta >= 15 dias em janeiro/fevereiro).
 */
function calculateThirteenthAndProjectionAvos(
  admissionDate: string,
  resignationDate: string,
  projectedEndDate: string
): { workedAvos: number; noticeProjectedAvos: number } {
  const termParts = parseDateParts(resignationDate);
  const projParts = parseDateParts(projectedEndDate);
  if (!termParts || !projParts) {
    return { workedAvos: 0, noticeProjectedAvos: 0 };
  }

  const termYearStart = formatDate(termParts.year, 1, 1);
  const effStartYear = admissionDate > termYearStart ? admissionDate : termYearStart;

  const workedAvos = countThirteenthAvosInRange(effStartYear, resignationDate, termParts.year);

  if (projectedEndDate <= resignationDate) {
    return { workedAvos, noticeProjectedAvos: 0 };
  }

  // Avos totais no ano da rescisão até o limite do aviso projetado
  const totalSameYearWithProj = countThirteenthAvosInRange(effStartYear, projectedEndDate, termParts.year);
  let noticeProjectedAvos = Math.max(0, totalSameYearWithProj - workedAvos);

  // Virada de ano (ex: demissão em 20/12 com aviso de 45 dias -> projeta até 03/02 do ano seguinte)
  if (projParts.year > termParts.year) {
    for (let y = termParts.year + 1; y <= projParts.year; y++) {
      const nextYearStart = formatDate(y, 1, 1);
      noticeProjectedAvos += countThirteenthAvosInRange(nextYearStart, projectedEndDate, y);
    }
  }

  return { workedAvos, noticeProjectedAvos };
}

export class TerminationCalculator {
  public static calculate(input: TerminationCalculationInput): TerminationCalculationOutput {
    const admParts = parseDateParts(input.admissionDate);
    const termParts = parseDateParts(input.resignationDate);
    if (!admParts || !termParts) {
      throw new Error('Datas de admissão e desligamento inválidas (esperado YYYY-MM-DD).');
    }

    const medias = Number(input.mediasAdicionais || 0);
    const outrosDesc = Number(input.outrosDescontos || 0);
    const dependents = Math.max(0, Number(input.dependentsCount || 0));
    const isApprentice = Boolean(input.isApprentice);

    const remuneracaoBase = addMoney(input.baseSalary, medias);

    // 1. Regras por motivo do desligamento
    let direitoAviso = false;
    let descontaAvisoNaoCumprido = false;
    let direitoFeriasProporcionais = true;
    let direitoDecimoProporcional = true;
    let percentualMultaFGTS = 0;
    let multiplicadorAvisoIndenizado = 1;

    switch (input.dismissalType) {
      case 'WITHOUT_CAUSE':
        direitoAviso = true;
        percentualMultaFGTS = 0.40;
        break;
      case 'RESIGNATION':
        direitoAviso = false;
        descontaAvisoNaoCumprido = true;
        percentualMultaFGTS = 0;
        break;
      case 'WITH_CAUSE':
        direitoAviso = false;
        direitoFeriasProporcionais = false;
        direitoDecimoProporcional = false;
        percentualMultaFGTS = 0;
        break;
      case 'CONTRACT_EXPIRATION':
        direitoAviso = false;
        percentualMultaFGTS = 0;
        break;
      case 'MUTUAL_AGREEMENT':
        direitoAviso = true;
        multiplicadorAvisoIndenizado = 0.5;
        percentualMultaFGTS = 0.20;
        break;
    }

    // 2. Saldo de Salário
    let daysInTerminationMonth = Math.min(30, termParts.day);
    if (admParts.year === termParts.year && admParts.month === termParts.month) {
      const diff = diffDaysInclusive(input.admissionDate, input.resignationDate);
      daysInTerminationMonth = Math.min(30, diff);
    }
    const saldoSalarioValor = multiplyMoney(divideMoney(remuneracaoBase, 30), daysInTerminationMonth);

    // 3. Aviso Prévio (Lei 12.506/2011: 30 + 3 dias por ano completo, máx 90 dias)
    const totalWorkedDays = diffDaysInclusive(input.admissionDate, input.resignationDate);
    const anosCompletos = Math.floor(Math.max(0, totalWorkedDays - 1) / 365);
    let diasAvisoTotal = Math.min(90, 30 + anosCompletos * 3);

    let avisoIndenizadoValor = 0;
    let avisoDescontadoValor = 0;

    if (input.noticeType === 'INDEMNIFIED') {
      if (direitoAviso) {
        avisoIndenizadoValor = round2((remuneracaoBase / 30) * diasAvisoTotal * multiplicadorAvisoIndenizado);
      } else if (descontaAvisoNaoCumprido) {
        avisoDescontadoValor = remuneracaoBase; // 30 dias
        diasAvisoTotal = 0;
      } else {
        diasAvisoTotal = 0;
      }
    } else {
      diasAvisoTotal = 0;
    }

    // 4. Projeção da Data Final do Aviso Prévio (OJ 82 SDI-1 TST / IN MTP)
    const dataProjetada =
      diasAvisoTotal > 0 && direitoAviso && input.noticeType === 'INDEMNIFIED'
        ? addDaysUTC(input.resignationDate, diasAvisoTotal)
        : input.resignationDate;

    // 5. 13º Salário Proporcional + 13º Projetado (inclusive Dez -> Jan e > 1 avo)
    let decimoAvos = 0;
    let decimoAvisoAvos = 0;
    if (direitoDecimoProporcional) {
      const avosCalc = calculateThirteenthAndProjectionAvos(
        input.admissionDate,
        input.resignationDate,
        dataProjetada
      );
      decimoAvos = avosCalc.workedAvos;
      decimoAvisoAvos = avosCalc.noticeProjectedAvos;
    }

    const decimoValor = round2((remuneracaoBase / 12) * decimoAvos);
    const decimoAvisoValor = round2((remuneracaoBase / 12) * decimoAvisoAvos);

    // 6. Férias Proporcionais + 1/3 Constitucional exato (divideMoney(..., 3))
    let feriasAvos = 0;
    if (direitoFeriasProporcionais) {
      const diffProjDays = diffDaysInclusive(input.admissionDate, dataProjetada);
      // Apura meses completos no ciclo aquisitivo corrente (a partir do último aniversário contratual)
      const totalMonthsApprox = Math.floor(diffProjDays / 30);
      const leftoverDays = diffProjDays % 30;
      let totalAvos = totalMonthsApprox + (leftoverDays >= 15 ? 1 : 0);
      feriasAvos = totalAvos % 12;
      if (feriasAvos === 0 && totalAvos > 0 && leftoverDays >= 15) {
        feriasAvos = 12;
      }
    }
    const feriasValor = round2((remuneracaoBase / 12) * feriasAvos);
    const umTercoFeriasValor = divideMoney(feriasValor, 3);

    // 7. Tributação (INSS e IRRF sem dupla dedução de INSS!)
    const inssSaldoResult = INSSCalculator.calculate(saldoSalarioValor, input.inssParameters);
    const inssSaldoValor = inssSaldoResult.value;

    const totalDecimoTributavel = addMoney(decimoValor, decimoAvisoValor);
    const inssDecimoResult = INSSCalculator.calculate(totalDecimoTributavel, input.inssParameters);
    const inssDecimoValor = inssDecimoResult.value;

    // BUG-08 FIX: Passa o SALÁRIO BRUTO (saldoSalarioValor) e o INSS real para o IRRFCalculator,
    // evitando descontar INSS duas vezes da base do IRRF!
    const irrfSaldoResult = IRRFCalculator.calculate(
      saldoSalarioValor,
      inssSaldoValor,
      dependents,
      input.irrfParameters,
      input.generalLegalParameters
    );

    // Tributação exclusiva do 13º na rescisão
    const irrfDecimoResult =
      totalDecimoTributavel > 0
        ? IRRFCalculator.calculate(
            totalDecimoTributavel,
            inssDecimoValor,
            dependents,
            input.irrfParameters,
            input.generalLegalParameters
          )
        : { value: 0, legalBase: 0, reductionAmount: 0, usedSimplified: false, grossIncome: 0 };

    // 8. FGTS e Multa Rescisória
    const fgtsStd = input.generalLegalParameters.fgts_standard_aliquot;
    const fgtsApp = input.generalLegalParameters.fgts_apprentice_aliquot;

    const fgtsMes = FGTSCalculator.calculate(saldoSalarioValor, isApprentice, fgtsStd, fgtsApp).value;
    const fgtsAviso = FGTSCalculator.calculate(avisoIndenizadoValor, isApprentice, fgtsStd, fgtsApp).value;
    const fgtsDecimo = FGTSCalculator.calculate(totalDecimoTributavel, isApprentice, fgtsStd, fgtsApp).value;

    const estimatedSaldoPrior =
      input.fgtsBalancePrior !== undefined
        ? Number(input.fgtsBalancePrior)
        : FGTSCalculator.calculate(
            round2(remuneracaoBase * (totalWorkedDays / 30)),
            isApprentice,
            fgtsStd,
            fgtsApp
          ).value;

    const baseMulta = sumMoney([estimatedSaldoPrior, fgtsMes, fgtsAviso, fgtsDecimo]);
    const multaFGTS = multiplyMoney(baseMulta, percentualMultaFGTS);

    // 9. Totais
    const proventosTotal = sumMoney([
      saldoSalarioValor,
      avisoIndenizadoValor,
      decimoValor,
      decimoAvisoValor,
      feriasValor,
      umTercoFeriasValor,
    ]);
    const descontosTotal = sumMoney([
      inssSaldoValor,
      inssDecimoValor,
      irrfSaldoResult.value,
      irrfDecimoResult.value,
      avisoDescontadoValor,
      outrosDesc,
    ]);
    const liquido = subtractMoney(proventosTotal, descontosTotal);

    return {
      proventos: {
        saldoSalario: { dias: daysInTerminationMonth, valor: saldoSalarioValor },
        avisoIndenizado: {
          dias: direitoAviso && input.noticeType === 'INDEMNIFIED' ? diasAvisoTotal : 0,
          valor: avisoIndenizadoValor,
        },
        decimoTerceiro: { avos: decimoAvos, valor: decimoValor },
        decimoTerceiroAviso: { avos: decimoAvisoAvos, valor: decimoAvisoValor },
        feriasProporcionais: { avos: feriasAvos, valor: feriasValor },
        umTercoFerias: { valor: umTercoFeriasValor },
      },
      descontos: {
        inssSaldo: { valor: inssSaldoValor },
        inssDecimo: { valor: inssDecimoValor },
        irrf: {
          valor: irrfSaldoResult.value,
          baseLegal: irrfSaldoResult.legalBase,
          redutor: irrfSaldoResult.reductionAmount,
        },
        irrfDecimo: {
          valor: irrfDecimoResult.value,
          baseLegal: irrfDecimoResult.legalBase,
          redutor: irrfDecimoResult.reductionAmount,
        },
        avisoDescontado: {
          dias: descontaAvisoNaoCumprido && input.noticeType === 'INDEMNIFIED' ? 30 : 0,
          valor: avisoDescontadoValor,
        },
        outros: { valor: outrosDesc },
      },
      encargos: {
        fgtsMes,
        fgtsAviso,
        fgtsDecimo,
        baseMulta,
        percentualMulta: percentualMultaFGTS,
        multaFGTS,
      },
      totais: {
        bruto: proventosTotal,
        descontos: descontosTotal,
        liquido,
      },
      metadados: {
        diasAvisoReal: diasAvisoTotal,
        dataProjetada,
        remuneracaoBase,
        dependentesConsiderados: dependents,
      },
    };
  }
}
