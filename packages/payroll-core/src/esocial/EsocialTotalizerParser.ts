import { fromCents, round2, subtractMoney, sumMoney, toCents } from '../utils/money.js';
import type {
  EsocialTotalizerEventType,
  MotorExpectedTotalizerValues,
  ParsedTotalizerResult,
  TotalizerDivergenceItem,
  TotalizerReconciliationResult,
} from './EsocialTypes.js';

function getTagNumber(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]+)</${tag}>`, 'g');
  let sumCents = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const val = Number(match[1].trim().replace(',', '.'));
    if (Number.isFinite(val)) {
      sumCents += toCents(val);
    }
  }
  return fromCents(sumCents);
}

function getFirstTagText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`);
  const match = re.exec(xml);
  return match ? match[1].trim() : null;
}

function detectTotalizerEventType(xml: string): EsocialTotalizerEventType {
  if (xml.includes('<evtBasesTrab')) return 'S-5001';
  if (xml.includes('<evtIrrfBenef')) return 'S-5002';
  if (xml.includes('<evtBasesFGTS')) return 'S-5003';
  if (xml.includes('<evtCS')) return 'S-5011';
  if (xml.includes('<evtIrrf')) return 'S-5012';
  if (xml.includes('<evtFGTS')) return 'S-5013';
  throw new Error('XML informado nao corresponde a nenhum evento totalizador eSocial (S-5001 a S-5013).');
}

/**
 * Faz o parse deterministico dos eventos de retorno/totalizadores do eSocial:
 * S-5001 (Bases INSS trabalhador), S-5002 (IRRF trabalhador), S-5003 (FGTS trabalhador),
 * S-5011 (INSS Consolidado Empresa), S-5012 (IRRF Consolidado Empresa), S-5013 (FGTS Consolidado Empresa).
 */
export function parseEsocialTotalizerXml(xml: string): ParsedTotalizerResult {
  const eventType = detectTotalizerEventType(xml);
  const idMatch = /Id="([^"]+)"/.exec(xml);
  const eventId = idMatch ? idMatch[1] : null;
  const receiptNumber = getFirstTagText(xml, 'nrRecArqBase') || getFirstTagText(xml, 'nrRecibo');
  const perApur = getFirstTagText(xml, 'perApur') || '';
  const [yearStr, monthStr] = perApur.split('-');
  const periodYear = Number(yearStr) || new Date().getUTCFullYear();
  const periodMonth = Number(monthStr) || 1;
  const cpfTrab = getFirstTagText(xml, 'cpfTrab') || getFirstTagText(xml, 'cpfBenef');
  const nrInsc = getFirstTagText(xml, 'nrInsc');

  let inssBase = 0;
  let inssSegurados = 0;
  let inssPatronal = 0;
  let inssRatAjustado = 0;
  let inssTerceiros = 0;
  let irrfRetido = 0;
  let fgtsBase = 0;
  let fgtsTotal = 0;
  let maternityDeduction = 0;
  let familySalaryDeduction = 0;

  switch (eventType) {
    case 'S-5001': {
      inssBase = sumMoney(getTagNumber(xml, 'vrBcCp00'), getTagNumber(xml, 'vrBcCp15'), getTagNumber(xml, 'vrBcCp20'), getTagNumber(xml, 'vrBcCp25'));
      inssSegurados = sumMoney(getTagNumber(xml, 'vrDescCP'), getTagNumber(xml, 'vrCpSeg'));
      break;
    }
    case 'S-5002': {
      irrfRetido = sumMoney(getTagNumber(xml, 'vrIrrfDesc'), getTagNumber(xml, 'vrCRMen'), getTagNumber(xml, 'vrCRDia'));
      break;
    }
    case 'S-5003': {
      fgtsBase = sumMoney(getTagNumber(xml, 'vrBcFGTS'), getTagNumber(xml, 'remFGTS'));
      fgtsTotal = sumMoney(getTagNumber(xml, 'vrFGTS'), getTagNumber(xml, 'dpsFGTS'));
      break;
    }
    case 'S-5011': {
      inssBase = sumMoney(getTagNumber(xml, 'vrBcCp00'), getTagNumber(xml, 'vrBcCp15'), getTagNumber(xml, 'vrBcCp20'), getTagNumber(xml, 'vrBcCp25'));
      inssSegurados = sumMoney(getTagNumber(xml, 'vrDescCP'), getTagNumber(xml, 'vrCpSeg'));
      const vrCP = getTagNumber(xml, 'vrCP');
      inssRatAjustado = getTagNumber(xml, 'vrRat');
      inssTerceiros = getTagNumber(xml, 'vrTercs');
      inssPatronal = sumMoney(vrCP, inssRatAjustado, inssTerceiros);
      if (inssPatronal === 0) {
        inssPatronal = getTagNumber(xml, 'vrCRContrib');
      }
      familySalaryDeduction = getTagNumber(xml, 'vrSalFam');
      maternityDeduction = getTagNumber(xml, 'vrSalMat');
      break;
    }
    case 'S-5012': {
      irrfRetido = sumMoney(getTagNumber(xml, 'vrCRMen'), getTagNumber(xml, 'vrCRDia'), getTagNumber(xml, 'vrIrrfDesc'));
      break;
    }
    case 'S-5013': {
      fgtsBase = sumMoney(getTagNumber(xml, 'vrBcFGTS'), getTagNumber(xml, 'remFGTS'));
      fgtsTotal = sumMoney(getTagNumber(xml, 'vrFGTS'), getTagNumber(xml, 'dpsFGTS'), getTagNumber(xml, 'vrFGTSGuia'));
      break;
    }
  }

  return {
    eventType,
    eventId,
    receiptNumber,
    perApur,
    periodYear,
    periodMonth,
    cpfTrab,
    nrInsc,
    inssBase,
    inssSegurados,
    inssPatronal,
    inssRatAjustado,
    inssTerceiros,
    irrfRetido,
    fgtsBase,
    fgtsTotal,
    maternityDeduction,
    familySalaryDeduction,
  };
}

/**
 * Confronta os valores totalizados pelo Governo (S-5001 a S-5013) com o motor CoupleRH.
 * Opera estritamente em centavos inteiros; qualquer diferenca >= R$ 0,01 sinaliza DIVERGENT.
 */
export function reconcileTotalizerWithMotor(
  parsed: ParsedTotalizerResult,
  motor: MotorExpectedTotalizerValues
): TotalizerReconciliationResult {
  const divergences: TotalizerDivergenceItem[] = [];

  const checkField = (field: string, label: string, gov: number, expected: number): number => {
    const diff = subtractMoney(gov, expected);
    if (toCents(diff) !== 0) {
      divergences.push({
        field,
        label,
        governmentAmount: round2(gov),
        motorAmount: round2(expected),
        diffAmount: diff,
      });
    }
    return diff;
  };

  let diffInssSegurados = 0;
  let diffInssPatronal = 0;
  let diffIrrfRetido = 0;
  let diffFgtsTotal = 0;

  if (parsed.eventType === 'S-5001') {
    diffInssSegurados = checkField('inss_segurados', 'INSS Segurados (S-5001)', parsed.inssSegurados, motor.inssSegurados);
  } else if (parsed.eventType === 'S-5002' || parsed.eventType === 'S-5012') {
    diffIrrfRetido = checkField('irrf_retido', `IRRF Retido (${parsed.eventType})`, parsed.irrfRetido, motor.irrfRetido);
  } else if (parsed.eventType === 'S-5003' || parsed.eventType === 'S-5013') {
    diffFgtsTotal = checkField('fgts_total', `FGTS Total (${parsed.eventType})`, parsed.fgtsTotal, motor.fgtsTotal);
  } else if (parsed.eventType === 'S-5011') {
    diffInssSegurados = checkField('inss_segurados', 'INSS Segurados (S-5011)', parsed.inssSegurados, motor.inssSegurados);
    diffInssPatronal = checkField('inss_patronal', 'INSS Patronal + RAT + Terceiros (S-5011)', parsed.inssPatronal, motor.inssPatronal);
    if (motor.maternityDeduction !== undefined) {
      checkField('maternity_deduction', 'Deducao Salario-Maternidade (S-5011)', parsed.maternityDeduction, motor.maternityDeduction);
    }
    if (motor.familySalaryDeduction !== undefined) {
      checkField('family_salary_deduction', 'Deducao Salario-Familia (S-5011)', parsed.familySalaryDeduction, motor.familySalaryDeduction);
    }
  }

  const maxAbsCents = divergences.reduce((max, item) => Math.max(max, Math.abs(toCents(item.diffAmount))), 0);

  return {
    reconciliationStatus: divergences.length === 0 ? 'MATCHED' : 'DIVERGENT',
    diffInssSegurados,
    diffInssPatronal,
    diffIrrfRetido,
    diffFgtsTotal,
    maxAbsDiff: fromCents(maxAbsCents),
    divergences,
  };
}

/**
 * Helper para gerar XML totalizador oficial sintetico para testes de homologacao e confronto.
 */
export function buildSampleTotalizerXml(params: {
  eventType: EsocialTotalizerEventType;
  eventId?: string;
  receiptNumber?: string;
  perApur: string;
  nrInsc: string;
  cpfTrab?: string;
  inssBase?: number;
  inssSegurados?: number;
  inssPatronal?: number;
  inssRat?: number;
  inssTerceiros?: number;
  irrfRetido?: number;
  fgtsBase?: number;
  fgtsTotal?: number;
  maternityDeduction?: number;
  familySalaryDeduction?: number;
}): string {
  const id = params.eventId ?? `ID1${params.nrInsc.replace(/\D/g, '').slice(0, 8).padEnd(14, '0')}2026112709000000001`;
  const rec = params.receiptNumber ?? '1.1.0000000000000000001';
  const f = (v?: number) => round2(v ?? 0).toFixed(2);

  switch (params.eventType) {
    case 'S-5001':
      return `<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtBasesTrab/v_S_01_03_00"><evtBasesTrab Id="${id}"><ideEvento><nrRecArqBase>${rec}</nrRecArqBase><perApur>${params.perApur}</perApur></ideEvento><ideEmpregador><tpInsc>1</tpInsc><nrInsc>${params.nrInsc}</nrInsc></ideEmpregador><ideTrabalhador><cpfTrab>${params.cpfTrab ?? '00000000000'}</cpfTrab></ideTrabalhador><infoCpCalc><vrCpSeg>${f(params.inssSegurados)}</vrCpSeg></infoCpCalc><infoCp><ideEstabLot><infoCategIncid><infoBaseCS><vrBcCp00>${f(params.inssBase)}</vrBcCp00></infoBaseCS></infoCategIncid></ideEstabLot></infoCp></evtBasesTrab></eSocial>`;
    case 'S-5002':
      return `<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtIrrfBenef/v_S_01_03_00"><evtIrrfBenef Id="${id}"><ideEvento><nrRecArqBase>${rec}</nrRecArqBase><perApur>${params.perApur}</perApur></ideEvento><ideEmpregador><tpInsc>1</tpInsc><nrInsc>${params.nrInsc}</nrInsc></ideEmpregador><ideTrabalhador><cpfBenef>${params.cpfTrab ?? '00000000000'}</cpfBenef><dmDev><infoIR><vrIrrfDesc>${f(params.irrfRetido)}</vrIrrfDesc></infoIR></dmDev></ideTrabalhador></evtIrrfBenef></eSocial>`;
    case 'S-5003':
      return `<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtBasesFGTS/v_S_01_03_00"><evtBasesFGTS Id="${id}"><ideEvento><nrRecArqBase>${rec}</nrRecArqBase><perApur>${params.perApur}</perApur></ideEvento><ideEmpregador><tpInsc>1</tpInsc><nrInsc>${params.nrInsc}</nrInsc></ideEmpregador><ideTrabalhador><cpfTrab>${params.cpfTrab ?? '00000000000'}</cpfTrab></ideTrabalhador><infoFGTS><ideEstab><infoBaseFGTS><basePerApur><vrBcFGTS>${f(params.fgtsBase)}</vrBcFGTS></basePerApur></infoBaseFGTS><infoDpsFGTS><dpsPerApur><vrFGTS>${f(params.fgtsTotal)}</vrFGTS></dpsPerApur></infoDpsFGTS></ideEstab></infoFGTS></evtBasesFGTS></eSocial>`;
    case 'S-5011': {
      const patronalBaseOnly = subtractMoney(params.inssPatronal ?? 0, sumMoney(params.inssRat ?? 0, params.inssTerceiros ?? 0));
      return `<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtCS/v_S_01_03_00"><evtCS Id="${id}"><ideEvento><nrRecArqBase>${rec}</nrRecArqBase><perApur>${params.perApur}</perApur></ideEvento><ideEmpregador><tpInsc>1</tpInsc><nrInsc>${params.nrInsc}</nrInsc></ideEmpregador><infoCS><infoContrib><infoAtConc><fatorMes>1.0000</fatorMes></infoAtConc></infoContrib><infoEstab><infoComplObra/><basesCp><vrBcCp00>${f(params.inssBase)}</vrBcCp00><vrDescCP>${f(params.inssSegurados)}</vrDescCP><vrSalFam>${f(params.familySalaryDeduction)}</vrSalFam><vrSalMat>${f(params.maternityDeduction)}</vrSalMat></basesCp></infoEstab><infoCRContrib><vrCP>${f(patronalBaseOnly)}</vrCP><vrRat>${f(params.inssRat)}</vrRat><vrTercs>${f(params.inssTerceiros)}</vrTercs></infoCRContrib></infoCS></evtCS></eSocial>`;
    }
    case 'S-5012':
      return `<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtIrrf/v_S_01_03_00"><evtIrrf Id="${id}"><ideEvento><nrRecArqBase>${rec}</nrRecArqBase><perApur>${params.perApur}</perApur></ideEvento><ideEmpregador><tpInsc>1</tpInsc><nrInsc>${params.nrInsc}</nrInsc></ideEmpregador><infoIRRF><infoCRMen><vrCRMen>${f(params.irrfRetido)}</vrCRMen></infoCRMen></infoIRRF></evtIrrf></eSocial>`;
    case 'S-5013':
      return `<eSocial xmlns="http://www.esocial.gov.br/schema/evt/evtFGTS/v_S_01_03_00"><evtFGTS Id="${id}"><ideEvento><nrRecArqBase>${rec}</nrRecArqBase><perApur>${params.perApur}</perApur></ideEvento><ideEmpregador><tpInsc>1</tpInsc><nrInsc>${params.nrInsc}</nrInsc></ideEmpregador><infoFGTS><ideEstab><vrBcFGTS>${f(params.fgtsBase)}</vrBcFGTS><vrFGTSGuia>${f(params.fgtsTotal)}</vrFGTSGuia></ideEstab></infoFGTS></evtFGTS></eSocial>`;
  }
}
