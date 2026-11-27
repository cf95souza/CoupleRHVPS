/**
 * TerminationOrchestrator.ts
 * FASE V6 — FOLHA-13: Motor Unificado de Rescisão Trabalhista (TRCT) + Rescisão Complementar.
 *
 * Unifica cálculo trabalhista completo ao padrão de saída `RawCalculatedPayslip` + `payroll_memory_calc`:
 * - Todos os motivos eSocial (01, 02, 03, 04, 05, 06, 07, 10, 14, 17, 33).
 * - Aviso Prévio Lei 12.506/2011: Trabalhado, Indenizado e Misto (Nota Técnica 184/2012 MTE)
 *   com projeção inclusive virada Dezembro -> Janeiro.
 * - Férias vencidas, em dobro (CLT Art. 137) e proporcionais via `vacation_periods` com redução Art. 130.
 * - Médias automáticas configuráveis via `AveragesCalculator` (Súmulas 347, 45 e 60 TST).
 * - Indenização Adicional Art. 9º Lei 7.238/84 (demissão projetada nos 30 dias anteriores à data-base).
 * - Quitação de saldo positivo de Banco de Horas como Hora Extra (CLT Art. 59 §3º).
 * - Teto de descontos não tributários Art. 477 §5º CLT (máximo 1 remuneração mensal do empregado).
 * - Multa FGTS 40% ou 20% sobre saldo real FGTS + depósitos da rescisão.
 * - Rescisão Complementar apurando exclusivamente as diferenças sobre o TRCT original.
 */

import { INSSCalculator } from '../legal/INSSCalculator.js';
import { IRRFCalculator } from '../legal/IRRFCalculator.js';
import { FGTSCalculator } from '../legal/FGTSCalculator.js';
import {
  FamilyAllowanceCalculator,
  type FamilyAllowanceDependentInput,
} from '../legal/FamilyAllowanceCalculator.js';
import {
  AveragesCalculator,
  type AverageWindowMode,
  type HistoricalRubricEntry,
} from '../legal/AveragesCalculator.js';
import { VacationEnterpriseCalculator } from '../legal/VacationEnterpriseCalculator.js';
import { diffDaysInclusive, formatDate, parseDateParts } from './VacationOverlapCalculator.js';
import type {
  GeneralLegalParameters,
  InssBracket,
  IrrfBracket,
  Rubric,
} from './PayrollContext.js';
import type { RawCalculatedPayslip, RawPayrollMemory, RawPayslipItem } from './AtomicPersistence.js';
import { addMoney, divideMoney, multiplyMoney, round2, subtractMoney, sumMoney } from '../utils/money.js';

export type UnifiedDismissalReason =
  | 'WITHOUT_CAUSE' // 02 - Demissão sem justa causa
  | 'WITH_CAUSE' // 01 - Demissão com justa causa
  | 'RESIGNATION' // 07 - Pedido de demissão
  | 'MUTUAL_AGREEMENT' // 33 - Acordo Art. 484-A CLT
  | 'CONTRACT_EXPIRATION' // 06 - Término contrato prazo determinado
  | 'EARLY_TERMINATION_EMPLOYER' // 04 - Antecipação pelo empregador (Art. 479 CLT)
  | 'EARLY_TERMINATION_EMPLOYEE' // 05 - Antecipação pelo empregado (Art. 480 CLT)
  | 'DEATH' // 10 - Falecimento do empregado
  | 'INDIRECT_DISMISSAL' // 03 - Rescisão indireta
  | 'RECIPROCAL_FAULT' // 14 - Culpa recíproca
  | 'COMPANY_EXTINCTION'; // 17 - Extinção da empresa / estabelecimento

export type UnifiedNoticeType = 'WORKED' | 'INDEMNIFIED' | 'WAIVED' | 'DISPENSED' | 'MIXED' | 'NONE';

export interface TerminationVacationPeriodInput {
  id?: string;
  acquisition_start: string;
  acquisition_end: string;
  concessive_end: string;
  days_remaining: number;
  absences_count?: number;
  lost_by_leave?: boolean;
  status?: string;
}

export interface UnifiedTerminationInput {
  contractId: string;
  baseSalary: number;
  fixedAdditionals?: number;
  admissionDate: string;
  resignationDate: string;
  noticeDate?: string;
  contractEndDate?: string | null; // Para Arts. 479/480
  dismissalType: UnifiedDismissalReason;
  noticeType: UnifiedNoticeType;
  mediasAdicionais?: number; // Override manual opcional; caso omitido usa historicalEntries
  historicalEntries?: HistoricalRubricEntry[];
  averageWindowMode?: AverageWindowMode;
  averageMonths?: number;
  divisor?: number;
  vacationPeriods?: TerminationVacationPeriodInput[];
  unionBaseMonth?: number | null; // 1..12 (mês da data-base para Art. 9º Lei 7.238/84)
  timeBankPositiveHours?: number;
  timeBankOvertimeFactor?: number; // padrão 1.5
  outrosDescontos?: number;
  dependentsCount?: number;
  dependents?: FamilyAllowanceDependentInput[];
  employeeRegime?: string | null;
  hasInssIncidence?: boolean;
  isApprentice?: boolean;
  fgtsBalancePrior?: number;
  inssParameters: InssBracket[];
  irrfParameters: IrrfBracket[];
  generalLegalParameters: GeneralLegalParameters;
  rubricsByCode?: Map<string, Rubric>;
  legalVersionId?: string;
  engineVersion?: string;
}

export interface UnifiedTerminationOutput {
  esocialReasonCode: string;
  proventos: {
    saldoSalario: { dias: number; valor: number };
    avisoIndenizado: { dias: number; valor: number };
    decimoTerceiro: { avos: number; valor: number };
    decimoTerceiroAviso: { avos: number; valor: number };
    feriasVencidas: { dias: number; valor: number };
    feriasDobro: { dias: number; valor: number };
    feriasProporcionais: { avos: number; valor: number };
    umTercoFerias: { valor: number };
    indenizacaoArt9: { aplicada: boolean; valor: number };
    quitacaoBancoHoras: { horas: number; valor: number };
    indenizacaoArt479: { diasRestantes: number; valor: number };
    salarioFamilia?: { valor: number; dependentes: number; proporcaoDias: number; totalDiasMes: number };
  };
  descontos: {
    inssSaldo: { valor: number };
    inssDecimo: { valor: number };
    irrf: { valor: number; baseLegal: number; redutor: number };
    irrfDecimo: { valor: number; baseLegal: number; redutor: number };
    avisoDescontado: { dias: number; valor: number };
    indenizacaoArt480: { valor: number };
    outros: { valor: number };
    tetoArt477Aplicado: boolean;
    excessoDescontoLimitado: number;
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
    diasAvisoTrabalhado: number;
    diasAvisoIndenizado: number;
    diasAvisoReal: number;
    dataProjetada: string;
    remuneracaoBase: number;
    mediasCalculadas: number;
    dependentesConsiderados: number;
    rubricBreakdown: Array<{ code: string; name: string; type: 'EARNING' | 'DEDUCTION' | 'NEUTRAL'; amount: number; reference?: string }>;
  };
  payslip: RawCalculatedPayslip;
}

const ESOCIAL_REASON_MAP: Record<UnifiedDismissalReason, string> = {
  WITH_CAUSE: '01',
  WITHOUT_CAUSE: '02',
  INDIRECT_DISMISSAL: '03',
  EARLY_TERMINATION_EMPLOYER: '04',
  EARLY_TERMINATION_EMPLOYEE: '05',
  CONTRACT_EXPIRATION: '06',
  RESIGNATION: '07',
  DEATH: '10',
  RECIPROCAL_FAULT: '14',
  COMPANY_EXTINCTION: '17',
  MUTUAL_AGREEMENT: '33',
};

const DEFAULT_RUBRIC_IDS: Record<string, string> = {
  '510': 'a0000000-0000-0000-0000-000000000510',
  '511': 'a0000000-0000-0000-0000-000000000511',
  '512': 'a0000000-0000-0000-0000-000000000512',
  '513': 'a0000000-0000-0000-0000-000000000513',
  '514': 'a0000000-0000-0000-0000-000000000514',
  '515': 'a0000000-0000-0000-0000-000000000515',
  '516': 'a0000000-0000-0000-0000-000000000516',
  '517': 'a0000000-0000-0000-0000-000000000517',
  '518': 'a0000000-0000-0000-0000-000000000518',
  '519': 'a0000000-0000-0000-0000-000000000519',
  '520': 'a0000000-0000-0000-0000-000000000520',
  '521': 'a0000000-0000-0000-0000-000000000521',
  '580': 'a0000000-0000-0000-0000-000000000580',
  '581': 'a0000000-0000-0000-0000-000000000581',
  '582': 'a0000000-0000-0000-0000-000000000582',
  '583': 'a0000000-0000-0000-0000-000000000583',
  '590': 'a0000000-0000-0000-0000-000000000590',
  '305': 'a0000000-0000-0000-0000-000000000305',
  '901': 'a0000000-0000-0000-0000-000000000901',
  '902': 'a0000000-0000-0000-0000-000000000902',
  '903': 'a0000000-0000-0000-0000-000000000903',
};

function addDaysUTC(dateStr: string, days: number): string {
  const parts = parseDateParts(dateStr);
  if (!parts) throw new Error(`Data inválida: '${dateStr}'`);
  const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function daysInCivilMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function countThirteenthAvosInRange(startStr: string, endStr: string, targetYear: number): number {
  let avos = 0;
  for (let m = 1; m <= 12; m++) {
    const mStart = formatDate(targetYear, m, 1);
    const mEnd = formatDate(targetYear, m, daysInCivilMonth(targetYear, m));
    const effStart = startStr > mStart ? startStr : mStart;
    const effEnd = endStr < mEnd ? endStr : mEnd;
    if (effEnd >= effStart && diffDaysInclusive(effStart, effEnd) >= 15) {
      avos++;
    }
  }
  return avos;
}

function calculateThirteenthAvosWithProjection(
  admissionDate: string,
  resignationDate: string,
  projectedEndDate: string
): { workedAvos: number; noticeProjectedAvos: number } {
  const termParts = parseDateParts(resignationDate);
  const projParts = parseDateParts(projectedEndDate);
  if (!termParts || !projParts) return { workedAvos: 0, noticeProjectedAvos: 0 };

  const termYearStart = formatDate(termParts.year, 1, 1);
  const effStartYear = admissionDate > termYearStart ? admissionDate : termYearStart;
  const workedAvos = countThirteenthAvosInRange(effStartYear, resignationDate, termParts.year);

  if (projectedEndDate <= resignationDate) {
    return { workedAvos, noticeProjectedAvos: 0 };
  }

  const totalSameYearWithProj = countThirteenthAvosInRange(effStartYear, projectedEndDate, termParts.year);
  let noticeProjectedAvos = Math.max(0, totalSameYearWithProj - workedAvos);

  if (projParts.year > termParts.year) {
    for (let y = termParts.year + 1; y <= projParts.year; y++) {
      const nextYearStart = formatDate(y, 1, 1);
      noticeProjectedAvos += countThirteenthAvosInRange(nextYearStart, projectedEndDate, y);
    }
  }

  return { workedAvos, noticeProjectedAvos };
}

/**
 * Calcula quantos avos proporcionais existem no período aquisitivo corrente (a partir do último aniversário).
 */
function calculateProportionalVacationAvos(admissionDate: string, projectedEndDate: string): number {
  const adm = parseDateParts(admissionDate);
  const proj = parseDateParts(projectedEndDate);
  if (!adm || !proj || projectedEndDate < admissionDate) return 0;

  let cycleStartYear = proj.year;
  const candidateSameYear = formatDate(
    proj.year,
    adm.month,
    Math.min(adm.day, daysInCivilMonth(proj.year, adm.month))
  );
  if (candidateSameYear > projectedEndDate) {
    cycleStartYear = proj.year - 1;
  }
  const cycleStart = formatDate(
    cycleStartYear,
    adm.month,
    Math.min(adm.day, daysInCivilMonth(cycleStartYear, adm.month))
  );

  // Avança mês a mês a partir de cycleStart
  let avos = 0;
  let curY = cycleStartYear;
  let curM = adm.month;
  for (let i = 0; i < 12; i++) {
    const startCur = formatDate(curY, curM, Math.min(adm.day, daysInCivilMonth(curY, curM)));
    const nextM = curM === 12 ? 1 : curM + 1;
    const nextY = curM === 12 ? curY + 1 : curY;
    const nextAnniv = formatDate(nextY, nextM, Math.min(adm.day, daysInCivilMonth(nextY, nextM)));
    const endCur = addDaysUTC(nextAnniv, -1);

    if (endCur <= projectedEndDate) {
      avos++;
    } else if (projectedEndDate >= startCur) {
      const days = diffDaysInclusive(startCur, projectedEndDate);
      if (days >= 15) avos++;
      break;
    } else {
      break;
    }
    curY = nextY;
    curM = nextM;
  }

  // Se o ciclo completou 12 meses exatamente na data projetada, ele já é período vencido, mas se não vier em vacationPeriods retorna 12
  return Math.min(12, avos);
}

/**
 * Art. 9º da Lei 7.238/84 (Súmula 182 TST):
 * O empregado dispensado sem justa causa no período de 30 dias que antecede a data de sua correção salarial (data-base)
 * terá direito à indenização adicional equivalente a 1 salário mensal, considerando a projeção do aviso prévio.
 */
function checkArt9Trintidio(projectedEndDate: string, unionBaseMonth?: number | null): boolean {
  if (!unionBaseMonth || unionBaseMonth < 1 || unionBaseMonth > 12) return false;
  const proj = parseDateParts(projectedEndDate);
  if (!proj) return false;

  // Verifica o próximo dia 1º do mês da data-base (no ano da projeção ou no ano seguinte se proj for dezembro e data-base janeiro)
  const candidates = [
    formatDate(proj.year, unionBaseMonth, 1),
    formatDate(proj.year + 1, unionBaseMonth, 1),
  ];

  for (const dataBase of candidates) {
    if (projectedEndDate < dataBase) {
      const trintidioStart = addDaysUTC(dataBase, -30);
      const trintidioEnd = addDaysUTC(dataBase, -1);
      if (projectedEndDate >= trintidioStart && projectedEndDate <= trintidioEnd) {
        return true;
      }
    }
  }
  return false;
}

export class TerminationOrchestrator {
  public static calculate(input: UnifiedTerminationInput): UnifiedTerminationOutput {
    const admParts = parseDateParts(input.admissionDate);
    const termParts = parseDateParts(input.resignationDate);
    if (!admParts || !termParts) {
      throw new Error('Datas de admissão e desligamento inválidas (esperado YYYY-MM-DD).');
    }

    const fixedAdd = Number(input.fixedAdditionals || 0);
    const hourlyBase = addMoney(input.baseSalary, fixedAdd);

    // 1. Médias automáticas (FOLHA-10) ou override manual
    let mediasCalculadas = Number(input.mediasAdicionais || 0);
    if (
      (input.mediasAdicionais === undefined || input.mediasAdicionais === 0) &&
      input.historicalEntries &&
      input.historicalEntries.length > 0
    ) {
      const avgRes = AveragesCalculator.calculate({
        target: 'NOTICE',
        referenceYear: termParts.year,
        referenceMonth: termParts.month,
        currentHourlyBase: hourlyBase,
        divisor: input.divisor || 220,
        windowMode: input.averageWindowMode || 'LAST_12M',
        windowMonths: input.averageMonths || 12,
        entries: input.historicalEntries,
      });
      mediasCalculadas = avgRes.totalAverage;
    }

    const remuneracaoBase = sumMoney([input.baseSalary, fixedAdd, mediasCalculadas]);
    const dependents = Math.max(0, Number(input.dependentsCount || 0));
    const isApprentice = Boolean(input.isApprentice);

    // 2. Direitos por motivo de desligamento (eSocial Tabela 19)
    let direitoAviso = false;
    let descontaAvisoNaoCumprido = false;
    let direitoFeriasProporcionais = true;
    let direitoDecimoProporcional = true;
    let direitoArt9 = false;
    let proportionalRightsFactor = 1.0; // 1.0 padrão, 0.5 em Acordo Art. 484-A (aviso) ou Culpa Recíproca (aviso/13º/férias prop.)
    let noticeFactor = 1.0;
    let percentualMultaFGTS = 0;

    switch (input.dismissalType) {
      case 'WITHOUT_CAUSE':
      case 'INDIRECT_DISMISSAL':
      case 'COMPANY_EXTINCTION':
        direitoAviso = true;
        direitoArt9 = true;
        percentualMultaFGTS = 0.4;
        break;
      case 'MUTUAL_AGREEMENT': // Art. 484-A CLT
        direitoAviso = true;
        noticeFactor = 0.5;
        percentualMultaFGTS = 0.2;
        break;
      case 'RECIPROCAL_FAULT': // Súmula 14 TST
        direitoAviso = true;
        noticeFactor = 0.5;
        proportionalRightsFactor = 0.5;
        percentualMultaFGTS = 0.2;
        break;
      case 'RESIGNATION':
        direitoAviso = false;
        descontaAvisoNaoCumprido = true;
        break;
      case 'WITH_CAUSE':
        direitoAviso = false;
        direitoFeriasProporcionais = false;
        direitoDecimoProporcional = false;
        break;
      case 'CONTRACT_EXPIRATION':
      case 'EARLY_TERMINATION_EMPLOYER':
      case 'EARLY_TERMINATION_EMPLOYEE':
      case 'DEATH':
        direitoAviso = false;
        break;
    }

    // 3. Saldo de Salário (apenas salário contratual + adicionais fixos; médias incidem sobre aviso, 13º e férias)
    let daysInTerminationMonth = Math.min(30, termParts.day);
    if (admParts.year === termParts.year && admParts.month === termParts.month) {
      daysInTerminationMonth = Math.min(30, diffDaysInclusive(input.admissionDate, input.resignationDate));
    }
    const saldoSalarioValor = multiplyMoney(divideMoney(hourlyBase, 30), daysInTerminationMonth);

    // 4. Aviso Prévio Lei 12.506/2011 + Nota Técnica 184/2012 MTE (WORKED / INDEMNIFIED / MIXED)
    const totalWorkedDays = diffDaysInclusive(input.admissionDate, input.resignationDate);
    const anosCompletos = Math.floor(Math.max(0, totalWorkedDays - 1) / 365);
    const totalAvisoLegalDias = Math.min(90, 30 + anosCompletos * 3);

    let diasAvisoTrabalhado = 0;
    let diasAvisoIndenizado = 0;
    let avisoIndenizadoValor = 0;
    let avisoDescontadoValor = 0;
    let avisoDescontadoDias = 0;

    if (direitoAviso) {
      if (input.noticeType === 'INDEMNIFIED') {
        diasAvisoIndenizado = totalAvisoLegalDias;
        avisoIndenizadoValor = round2((remuneracaoBase / 30) * diasAvisoIndenizado * noticeFactor);
      } else if (input.noticeType === 'MIXED') {
        // NT 184/2012 MTE: 30 dias trabalhados + 3 dias/ano indenizados (até 60d indenizados)
        diasAvisoTrabalhado = 30;
        diasAvisoIndenizado = Math.max(0, totalAvisoLegalDias - 30);
        avisoIndenizadoValor = round2((remuneracaoBase / 30) * diasAvisoIndenizado * noticeFactor);
      } else if (input.noticeType === 'WORKED') {
        diasAvisoTrabalhado = 30;
      }
    } else if (descontaAvisoNaoCumprido && input.noticeType === 'INDEMNIFIED') {
      avisoDescontadoDias = 30;
      avisoDescontadoValor = remuneracaoBase;
    }

    const dataProjetada =
      diasAvisoIndenizado > 0 ? addDaysUTC(input.resignationDate, diasAvisoIndenizado) : input.resignationDate;

    // 5. Indenização quebra antecipada prazo determinado (Arts. 479 / 480 CLT)
    let diasRestantesContrato = 0;
    let indenizacaoArt479Valor = 0;
    let indenizacaoArt480Valor = 0;
    if (
      (input.dismissalType === 'EARLY_TERMINATION_EMPLOYER' ||
        input.dismissalType === 'EARLY_TERMINATION_EMPLOYEE') &&
      input.contractEndDate &&
      input.contractEndDate > input.resignationDate
    ) {
      diasRestantesContrato = diffDaysInclusive(input.resignationDate, input.contractEndDate) - 1;
      const metadeDias = round2((remuneracaoBase / 30) * diasRestantesContrato * 0.5);
      if (input.dismissalType === 'EARLY_TERMINATION_EMPLOYER') {
        indenizacaoArt479Valor = metadeDias;
      } else {
        indenizacaoArt480Valor = metadeDias;
      }
    }

    // 6. 13º Salário Proporcional + 13º Projetado (inclusive Dez -> Jan)
    let decimoAvos = 0;
    let decimoAvisoAvos = 0;
    if (direitoDecimoProporcional) {
      const avosCalc = calculateThirteenthAvosWithProjection(
        input.admissionDate,
        input.resignationDate,
        dataProjetada
      );
      decimoAvos = avosCalc.workedAvos;
      decimoAvisoAvos = avosCalc.noticeProjectedAvos;
    }
    const decimoValor = round2((remuneracaoBase / 12) * decimoAvos * proportionalRightsFactor);
    const decimoAvisoValor = round2((remuneracaoBase / 12) * decimoAvisoAvos * proportionalRightsFactor);

    // 7. Férias Vencidas, em Dobro (Art. 137) e Proporcionais (via vacationPeriods)
    let feriasVencidasDias = 0;
    let feriasVencidasValor = 0;
    let feriasDobroDias = 0;
    let feriasDobroValor = 0;

    for (const vp of input.vacationPeriods || []) {
      if (vp.lost_by_leave || vp.status === 'FORFEITED' || vp.status === 'CLOSED') continue;
      if (vp.acquisition_end <= input.resignationDate && vp.days_remaining > 0) {
        const accruedByAbsences = VacationEnterpriseCalculator.calculateAccruedDaysByAbsences(
          vp.absences_count || 0
        );
        const effDays = Math.min(vp.days_remaining, accruedByAbsences);
        if (effDays <= 0) continue;

        feriasVencidasDias += effDays;
        const valNormal = round2((remuneracaoBase / 30) * effDays);
        feriasVencidasValor = addMoney(feriasVencidasValor, valNormal);

        // Se o período concessivo já venceu até a data do desligamento, soma parcela da dobra (Art. 137 CLT)
        if (vp.concessive_end && vp.concessive_end < input.resignationDate) {
          feriasDobroDias += effDays;
          feriasDobroValor = addMoney(feriasDobroValor, valNormal);
        }
      }
    }

    let feriasAvos = 0;
    if (direitoFeriasProporcionais) {
      feriasAvos = calculateProportionalVacationAvos(input.admissionDate, dataProjetada);
    }
    const feriasProporcionaisValor = round2((remuneracaoBase / 12) * feriasAvos * proportionalRightsFactor);
    const umTercoFeriasValor = divideMoney(
      sumMoney([feriasVencidasValor, feriasDobroValor, feriasProporcionaisValor]),
      3
    );

    // 8. Indenização Adicional Art. 9º Lei 7.238/84 (Trintídio da Data-Base)
    const art9Aplicada = direitoArt9 && checkArt9Trintidio(dataProjetada, input.unionBaseMonth);
    const indenizacaoArt9Valor = art9Aplicada ? remuneracaoBase : 0;

    // 9. Quitação de Saldo Positivo de Banco de Horas como HE (CLT Art. 59 §3º)
    const positiveBankHours = Math.max(0, Number(input.timeBankPositiveHours || 0));
    const bankFactor = Number(input.timeBankOvertimeFactor || 1.5);
    const divisor = input.divisor || 220;
    const quitacaoBancoHorasValor =
      positiveBankHours > 0
        ? round2((hourlyBase / divisor) * bankFactor * positiveBankHours)
        : 0;

    // 10. Salário-Família proporcional na demissão
    const familyCeiling = Number(
      input.generalLegalParameters.family_salary_ceiling ??
        input.generalLegalParameters.family_salary_limit ??
        0
    );
    const familyQuota = Number(
      input.generalLegalParameters.family_salary_value ??
        input.generalLegalParameters.family_salary_quota ??
        0
    );
    let salarioFamiliaValor = 0;
    let familyEvalRes: any = null;
    if (Array.isArray(input.dependents) && input.dependents.length > 0 && familyCeiling > 0 && familyQuota > 0) {
      familyEvalRes = FamilyAllowanceCalculator.calculate({
        dependents: input.dependents,
        competenceYear: termParts.year,
        competenceMonth: termParts.month,
        monthlyInssBase: addMoney(saldoSalarioValor, quitacaoBancoHorasValor),
        contractualSalary: remuneracaoBase,
        familySalaryCeiling: familyCeiling,
        quotaValue: familyQuota,
        admissionDate: input.admissionDate,
        terminationDate: input.resignationDate,
        employeeRegime: input.employeeRegime || (isApprentice ? 'APPRENTICE' : 'CLT'),
        hasInssIncidence: input.hasInssIncidence !== false,
      });
      salarioFamiliaValor = familyEvalRes.totalAmount;
    }

    // 11. Tributação (INSS e IRRF sem dupla dedução, 13º exclusivo)
    const baseInssSaldo = addMoney(saldoSalarioValor, quitacaoBancoHorasValor);
    const inssSaldoValor = INSSCalculator.calculate(baseInssSaldo, input.inssParameters).value;

    const totalDecimoTributavel = addMoney(decimoValor, decimoAvisoValor);
    const inssDecimoValor = INSSCalculator.calculate(totalDecimoTributavel, input.inssParameters).value;

    const irrfSaldoResult = IRRFCalculator.calculate(
      baseInssSaldo,
      inssSaldoValor,
      dependents,
      input.irrfParameters,
      input.generalLegalParameters
    );

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

    // 12. FGTS e Multa Rescisória (sobre saldo real)
    const fgtsStd = input.generalLegalParameters.fgts_standard_aliquot;
    const fgtsApp = input.generalLegalParameters.fgts_apprentice_aliquot;

    const fgtsMes = FGTSCalculator.calculate(baseInssSaldo, isApprentice, fgtsStd, fgtsApp).value;
    const fgtsAviso = FGTSCalculator.calculate(avisoIndenizadoValor, isApprentice, fgtsStd, fgtsApp).value;
    const fgtsDecimo = FGTSCalculator.calculate(totalDecimoTributavel, isApprentice, fgtsStd, fgtsApp).value;

    const saldoPriorReal =
      input.fgtsBalancePrior !== undefined
        ? Number(input.fgtsBalancePrior)
        : FGTSCalculator.calculate(
            round2(remuneracaoBase * (totalWorkedDays / 30)),
            isApprentice,
            fgtsStd,
            fgtsApp
          ).value;

    const baseMulta = sumMoney([saldoPriorReal, fgtsMes, fgtsAviso, fgtsDecimo]);
    const multaFGTS = multiplyMoney(baseMulta, percentualMultaFGTS);

    // 13. Teto de Descontos Não Tributários (CLT Art. 477 §5º: máx 1 remuneração mensal)
    const proventosTotal = sumMoney([
      saldoSalarioValor,
      avisoIndenizadoValor,
      decimoValor,
      decimoAvisoValor,
      feriasVencidasValor,
      feriasDobroValor,
      feriasProporcionaisValor,
      umTercoFeriasValor,
      indenizacaoArt9Valor,
      quitacaoBancoHorasValor,
      indenizacaoArt479Valor,
      salarioFamiliaValor,
    ]);

    const taxDeductions = sumMoney([
      inssSaldoValor,
      inssDecimoValor,
      irrfSaldoResult.value,
      irrfDecimoResult.value,
    ]);

    const rawOutros = Number(input.outrosDescontos || 0);
    const rawNonTaxDeductions = sumMoney([avisoDescontadoValor, indenizacaoArt480Valor, rawOutros]);
    const capLimit = remuneracaoBase;
    const tetoArt477Aplicado = rawNonTaxDeductions > capLimit;
    const cappedNonTaxTotal = tetoArt477Aplicado ? capLimit : rawNonTaxDeductions;
    const excessoDescontoLimitado = tetoArt477Aplicado
      ? subtractMoney(rawNonTaxDeductions, capLimit)
      : 0;

    // Rateia redução se excedeu teto Art. 477 §5º (priorizando aviso/Art.480 antes de outros)
    let effAvisoDescontado = avisoDescontadoValor;
    let effArt480 = indenizacaoArt480Valor;
    let effOutros = rawOutros;
    if (tetoArt477Aplicado) {
      let remCap = cappedNonTaxTotal;
      effAvisoDescontado = Math.min(avisoDescontadoValor, remCap);
      remCap = subtractMoney(remCap, effAvisoDescontado);
      effArt480 = Math.min(indenizacaoArt480Valor, remCap);
      remCap = subtractMoney(remCap, effArt480);
      effOutros = Math.min(rawOutros, remCap);
    }

    const descontosTotal = addMoney(taxDeductions, sumMoney([effAvisoDescontado, effArt480, effOutros]));
    const liquido = Math.max(0, subtractMoney(proventosTotal, descontosTotal));

    // 14. Monta breakdown de rubricas oficiais + RawCalculatedPayslip auditável
    const rubricBreakdown: Array<{
      code: string;
      name: string;
      type: 'EARNING' | 'DEDUCTION' | 'NEUTRAL';
      amount: number;
      reference?: string;
    }> = [];

    const pushRubric = (
      code: string,
      name: string,
      type: 'EARNING' | 'DEDUCTION' | 'NEUTRAL',
      amount: number,
      reference?: string
    ) => {
      if (amount > 0) {
        rubricBreakdown.push({ code, name, type, amount: round2(amount), reference });
      }
    };

    pushRubric('510', 'Saldo de Salário (Rescisão)', 'EARNING', saldoSalarioValor, String(daysInTerminationMonth));
    pushRubric('511', 'Aviso Prévio Indenizado', 'EARNING', avisoIndenizadoValor, String(diasAvisoIndenizado));
    pushRubric('512', '13º Salário Proporcional', 'EARNING', decimoValor, String(decimoAvos));
    pushRubric('513', '13º Salário Indenizado (Projeção Aviso)', 'EARNING', decimoAvisoValor, String(decimoAvisoAvos));
    pushRubric('514', 'Férias Vencidas', 'EARNING', feriasVencidasValor, String(feriasVencidasDias));
    pushRubric('515', 'Férias Vencidas em Dobro (Art. 137)', 'EARNING', feriasDobroValor, String(feriasDobroDias));
    pushRubric('516', 'Férias Proporcionais', 'EARNING', feriasProporcionaisValor, String(feriasAvos));
    pushRubric('517', '1/3 Constitucional sobre Férias', 'EARNING', umTercoFeriasValor, '1');
    pushRubric('518', 'Indenização Adicional Art. 9º Lei 7.238/84', 'EARNING', indenizacaoArt9Valor, '1');
    pushRubric('519', 'Quitação Banco de Horas Positivo', 'EARNING', quitacaoBancoHorasValor, String(positiveBankHours));
    pushRubric('520', 'Indenização Art. 479 CLT', 'EARNING', indenizacaoArt479Valor, String(diasRestantesContrato));
    pushRubric('305', 'Salário-Família Proporcional', 'EARNING', salarioFamiliaValor, String(familyEvalRes?.eligibleDependentsCount || 0));

    pushRubric('901', 'INSS Saldo de Salário / Verbas', 'DEDUCTION', inssSaldoValor, '1');
    pushRubric('582', 'INSS sobre 13º Salário Rescisório', 'DEDUCTION', inssDecimoValor, '1');
    pushRubric('902', 'IRRF Rescisório', 'DEDUCTION', irrfSaldoResult.value, '1');
    pushRubric('583', 'IRRF sobre 13º Salário Rescisório', 'DEDUCTION', irrfDecimoResult.value, '1');
    pushRubric('580', 'Desconto Aviso / Art. 480 CLT', 'DEDUCTION', addMoney(effAvisoDescontado, effArt480), '1');
    pushRubric('581', 'Outros Descontos Rescisórios', 'DEDUCTION', effOutros, '1');

    const totalFgtsRescisao = sumMoney([fgtsMes, fgtsAviso, fgtsDecimo]);
    pushRubric('903', 'FGTS Depósitos da Rescisão', 'NEUTRAL', totalFgtsRescisao, '1');
    pushRubric('590', 'Multa Rescisória FGTS', 'NEUTRAL', multaFGTS, String(round2(percentualMultaFGTS * 100)));

    const resolveRubricId = (code: string) =>
      input.rubricsByCode?.get(code)?.id || DEFAULT_RUBRIC_IDS[code] || DEFAULT_RUBRIC_IDS['510'];

    const items: RawPayslipItem[] = rubricBreakdown.map((rb) => ({
      rubric_id: resolveRubricId(rb.code),
      rubric_version_id: resolveRubricId(rb.code),
      reference: rb.reference || null,
      amount: rb.amount,
      type: rb.type,
    }));

    const memory: RawPayrollMemory[] = rubricBreakdown.map((rb) => ({
      rubric_id: resolveRubricId(rb.code),
      step_name: rb.name,
      base_value: remuneracaoBase,
      quantity_used: Number(rb.reference || 1),
      percentage_used: rb.code === '590' ? round2(percentualMultaFGTS * 100) : 0,
      parsed_formula: `TRCT [${ESOCIAL_REASON_MAP[input.dismissalType]}] ${rb.name}: R$ ${rb.amount.toFixed(2)}`,
      result_value: rb.amount,
      origin: 'TERMINATION_ORCHESTRATOR',
      engine_version: input.engineVersion || '2.2.0',
    }));

    const baseFgtsTotal = sumMoney([baseInssSaldo, avisoIndenizadoValor, totalDecimoTributavel]);
    const payslip: RawCalculatedPayslip = {
      contract_id: input.contractId,
      total_earnings: proventosTotal,
      total_deductions: descontosTotal,
      net_salary: liquido,
      base_inss: addMoney(baseInssSaldo, totalDecimoTributavel),
      base_irrf: irrfSaldoResult.legalBase,
      base_fgts: baseFgtsTotal,
      fgts_month: totalFgtsRescisao,
      inss_employee: addMoney(inssSaldoValor, inssDecimoValor),
      status: 'CALCULATED',
      legal_version_id: input.legalVersionId,
      engine_version: input.engineVersion || '2.2.0',
      items,
      memory,
    };

    return {
      esocialReasonCode: ESOCIAL_REASON_MAP[input.dismissalType],
      proventos: {
        saldoSalario: { dias: daysInTerminationMonth, valor: saldoSalarioValor },
        avisoIndenizado: { dias: diasAvisoIndenizado, valor: avisoIndenizadoValor },
        decimoTerceiro: { avos: decimoAvos, valor: decimoValor },
        decimoTerceiroAviso: { avos: decimoAvisoAvos, valor: decimoAvisoValor },
        feriasVencidas: { dias: feriasVencidasDias, valor: feriasVencidasValor },
        feriasDobro: { dias: feriasDobroDias, valor: feriasDobroValor },
        feriasProporcionais: { avos: feriasAvos, valor: feriasProporcionaisValor },
        umTercoFerias: { valor: umTercoFeriasValor },
        indenizacaoArt9: { aplicada: art9Aplicada, valor: indenizacaoArt9Valor },
        quitacaoBancoHoras: { horas: positiveBankHours, valor: quitacaoBancoHorasValor },
        indenizacaoArt479: { diasRestantes: diasRestantesContrato, valor: indenizacaoArt479Valor },
        salarioFamilia: familyEvalRes
          ? {
              valor: salarioFamiliaValor,
              dependentes: familyEvalRes.eligibleDependentsCount,
              proporcaoDias: familyEvalRes.proportionalDays,
              totalDiasMes: familyEvalRes.daysInMonth,
            }
          : undefined,
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
        avisoDescontado: { dias: avisoDescontadoDias, valor: effAvisoDescontado },
        indenizacaoArt480: { valor: effArt480 },
        outros: { valor: effOutros },
        tetoArt477Aplicado,
        excessoDescontoLimitado,
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
        diasAvisoTrabalhado,
        diasAvisoIndenizado,
        diasAvisoReal: diasAvisoIndenizado,
        dataProjetada,
        remuneracaoBase,
        mediasCalculadas,
        dependentesConsiderados: dependents,
        rubricBreakdown,
      },
      payslip,
    };
  }

  /**
   * Rescisão Complementar: recalcula o TRCT com os novos parâmetros (ex.: dissídio/diferença salarial/horas omitidas)
   * e apura estritamente as diferenças líquidas e tributárias devidas ao trabalhador.
   */
  public static calculateComplementary(params: {
    originalOutput: UnifiedTerminationOutput;
    updatedInput: UnifiedTerminationInput;
    reason: string;
  }): {
    recalculated: UnifiedTerminationOutput;
    diffGross: number;
    diffInss: number;
    diffIrrf: number;
    diffDeductions: number;
    diffFgtsDeposit: number;
    diffFgtsFine: number;
    diffNetPayable: number;
    payslip: RawCalculatedPayslip;
  } {
    const { originalOutput, updatedInput, reason } = params;
    const recalculated = this.calculate(updatedInput);

    const diffGross = Math.max(0, subtractMoney(recalculated.totais.bruto, originalOutput.totais.bruto));
    const diffInssSaldo = Math.max(
      0,
      subtractMoney(recalculated.descontos.inssSaldo.valor, originalOutput.descontos.inssSaldo.valor)
    );
    const diffInssDecimo = Math.max(
      0,
      subtractMoney(recalculated.descontos.inssDecimo.valor, originalOutput.descontos.inssDecimo.valor)
    );
    const diffIrrfSaldo = Math.max(
      0,
      subtractMoney(recalculated.descontos.irrf.valor, originalOutput.descontos.irrf.valor)
    );
    const diffIrrfDecimo = Math.max(
      0,
      subtractMoney(recalculated.descontos.irrfDecimo.valor, originalOutput.descontos.irrfDecimo.valor)
    );

    const diffInss = addMoney(diffInssSaldo, diffInssDecimo);
    const diffIrrf = addMoney(diffIrrfSaldo, diffIrrfDecimo);
    const diffDeductions = addMoney(diffInss, diffIrrf);
    const diffNetPayable = Math.max(0, subtractMoney(diffGross, diffDeductions));

    const origFgts = sumMoney([
      originalOutput.encargos.fgtsMes,
      originalOutput.encargos.fgtsAviso,
      originalOutput.encargos.fgtsDecimo,
    ]);
    const recFgts = sumMoney([
      recalculated.encargos.fgtsMes,
      recalculated.encargos.fgtsAviso,
      recalculated.encargos.fgtsDecimo,
    ]);
    const diffFgtsDeposit = Math.max(0, subtractMoney(recFgts, origFgts));
    const diffFgtsFine = Math.max(
      0,
      subtractMoney(recalculated.encargos.multaFGTS, originalOutput.encargos.multaFGTS)
    );

    const resolveRubricId = (code: string) =>
      updatedInput.rubricsByCode?.get(code)?.id || DEFAULT_RUBRIC_IDS[code];

    const items: RawPayslipItem[] = [];
    const memory: RawPayrollMemory[] = [];
    const pushItem = (code: string, name: string, type: 'EARNING' | 'DEDUCTION' | 'NEUTRAL', amount: number) => {
      if (amount <= 0) return;
      const rid = resolveRubricId(code);
      items.push({ rubric_id: rid, rubric_version_id: rid, reference: '1', amount, type });
      memory.push({
        rubric_id: rid,
        step_name: name,
        base_value: diffGross,
        quantity_used: 1,
        percentage_used: 0,
        parsed_formula: `Rescisão Complementar (${reason}): ${name} = R$ ${amount.toFixed(2)}`,
        result_value: amount,
        origin: 'TERMINATION_COMPLEMENTARY',
        engine_version: updatedInput.engineVersion || '2.2.0',
      });
    };

    pushItem('521', 'Diferença de Rescisão Complementar', 'EARNING', diffGross);
    pushItem('901', 'INSS Diferencial Rescisão Complementar', 'DEDUCTION', diffInssSaldo);
    pushItem('582', 'INSS 13º Diferencial Rescisão Complementar', 'DEDUCTION', diffInssDecimo);
    pushItem('902', 'IRRF Diferencial Rescisão Complementar', 'DEDUCTION', diffIrrfSaldo);
    pushItem('583', 'IRRF 13º Diferencial Rescisão Complementar', 'DEDUCTION', diffIrrfDecimo);
    pushItem('903', 'FGTS Diferencial Rescisão Complementar', 'NEUTRAL', diffFgtsDeposit);
    pushItem('590', 'Multa FGTS Diferencial Rescisão Complementar', 'NEUTRAL', diffFgtsFine);

    const diffBaseInss = Math.max(0, subtractMoney(recalculated.payslip.base_inss, originalOutput.payslip.base_inss));
    const diffBaseFgts = Math.max(0, subtractMoney(recalculated.payslip.base_fgts, originalOutput.payslip.base_fgts));

    return {
      recalculated,
      diffGross,
      diffInss,
      diffIrrf,
      diffDeductions,
      diffFgtsDeposit,
      diffFgtsFine,
      diffNetPayable,
      payslip: {
        contract_id: updatedInput.contractId,
        total_earnings: diffGross,
        total_deductions: diffDeductions,
        net_salary: diffNetPayable,
        base_inss: diffBaseInss,
        base_irrf: Math.max(0, subtractMoney(diffBaseInss, diffInss)),
        base_fgts: diffBaseFgts,
        fgts_month: diffFgtsDeposit,
        inss_employee: diffInss,
        status: 'CALCULATED',
        legal_version_id: updatedInput.legalVersionId,
        engine_version: updatedInput.engineVersion || '2.2.0',
        items,
        memory,
      },
    };
  }
}
