/**
 * Tipos Oficiais eSocial — Layouts S-1.2 e S-1.3 (FASE V9)
 */

export type EsocialLayoutVersion = 'S-1.2' | 'S-1.3';
export type EsocialEnvironment = 'PRODUCTION' | 'HOMOLOGATION';

export type EsocialOutboundEventType =
  // Eventos de Tabela (Grupo 1)
  | 'S-1000'
  | 'S-1005'
  | 'S-1010'
  | 'S-1020'
  // Eventos Nao Periodicos (Grupo 2)
  | 'S-2190'
  | 'S-2200'
  | 'S-2205'
  | 'S-2206'
  | 'S-2230'
  | 'S-2240'
  | 'S-2299'
  | 'S-2300'
  | 'S-2399'
  // Eventos Periodicos (Grupo 3)
  | 'S-1200'
  | 'S-1210'
  | 'S-1298'
  | 'S-1299';

export type EsocialTotalizerEventType =
  | 'S-5001'
  | 'S-5002'
  | 'S-5003'
  | 'S-5011'
  | 'S-5012'
  | 'S-5013';

export type EsocialEventType = EsocialOutboundEventType | EsocialTotalizerEventType;

export interface EsocialBaseInput {
  eventId?: string;
  layoutVersion?: EsocialLayoutVersion;
  environment: EsocialEnvironment;
  tpInsc: 1 | 2;
  nrInsc: string; // CNPJ raiz (8 ou 14 digitos) ou CPF (11)
  indRetif?: 1 | 2;
  nrRecibo?: string;
  procEmi?: 1 | 2 | 3 | 4;
  verProc?: string;
  sequence?: number;
  generatedAt?: Date;
}

export interface EsocialS1000Input extends EsocialBaseInput {
  eventType: 'S-1000';
  iniValid: string; // YYYY-MM
  fimValid?: string;
  classTrib: string; // ex: '99'
  indCoop?: 0 | 1 | 2 | 3;
  indConstr?: 0 | 1;
  indDesFolha?: 0 | 1 | 2;
  indOptRegEletron?: 0 | 1;
}

export interface EsocialS1005Input extends EsocialBaseInput {
  eventType: 'S-1005';
  iniValid: string;
  tpInscEstab: 1 | 3 | 4;
  nrInscEstab: string;
  cnaePrep: string;
  aliqRat: 1 | 2 | 3;
  fap: number;
}

export interface EsocialS1010Input extends EsocialBaseInput {
  eventType: 'S-1010';
  iniValid: string;
  codRubr: string;
  ideTabRubr: string;
  dscRubr: string;
  natRubr: string; // 4 digitos
  tpRubr: 1 | 2 | 3 | 4;
  codIncCP: string;
  codIncIRRF: string;
  codIncFGTS: string;
}

export interface EsocialS1020Input extends EsocialBaseInput {
  eventType: 'S-1020';
  iniValid: string;
  codLotacao: string;
  tpLotacao: string;
  fpas: string;
  codTercs: string;
  tpInscTomador?: 1 | 2;
  nrInscTomador?: string;
}

export interface EsocialS2190Input extends EsocialBaseInput {
  eventType: 'S-2190';
  cpfTrab: string;
  dtNascto: string; // YYYY-MM-DD
  dtAdm: string; // YYYY-MM-DD
  matricula: string;
  codCateg: string; // ex: '101'
  natAtividade: 1 | 2;
  codCBO: string;
  vrSalFx: number;
  undSalFixo: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export interface EsocialS2200Input extends EsocialBaseInput {
  eventType: 'S-2200';
  cpfTrab: string;
  nmTrab: string;
  sexo: 'M' | 'F';
  racaCor: 1 | 2 | 3 | 4 | 5 | 6;
  estCiv?: 1 | 2 | 3 | 4 | 5;
  grauInstr: string;
  dtNascto: string;
  paisNac?: string;
  matricula: string;
  tpRegTrab: 1 | 2;
  tpRegPrev: 1 | 2 | 3;
  dtAdm: string;
  codCateg: string;
  nmCargo?: string;
  codCBO: string;
  vrSalFx: number;
  undSalFixo: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  tpContr: 1 | 2 | 3;
  codLotacao: string;
  tpInscLocal: 1 | 3 | 4;
  nrInscLocal: string;
}

export interface EsocialS2205Input extends EsocialBaseInput {
  eventType: 'S-2205';
  cpfTrab: string;
  dtAlteracao: string;
  nmTrab: string;
  sexo: 'M' | 'F';
  racaCor: 1 | 2 | 3 | 4 | 5 | 6;
  grauInstr: string;
  estCiv?: 1 | 2 | 3 | 4 | 5;
}

export interface EsocialS2206Input extends EsocialBaseInput {
  eventType: 'S-2206';
  cpfTrab: string;
  matricula: string;
  dtAlteracao: string;
  vrSalFx: number;
  undSalFixo: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  codCBO: string;
  codCateg: string;
}

export interface EsocialS2230Input extends EsocialBaseInput {
  eventType: 'S-2230';
  cpfTrab: string;
  matricula: string;
  dtIniAfast: string;
  codMotAfast: string; // Tabela 18
  dtTermAfast?: string;
  indMesmoMotivo?: 'S' | 'N';
}

export interface EsocialS2240Input extends EsocialBaseInput {
  eventType: 'S-2240';
  cpfTrab: string;
  matricula: string;
  dtIniCondicao: string;
  codAmb: string;
  dscAtivDes: string;
  codAgNoc: string; // Tabela 24 (ex: '09.01.001' ausencia)
  tpAval?: 1 | 2;
}

export interface EsocialS2299Input extends EsocialBaseInput {
  eventType: 'S-2299';
  cpfTrab: string;
  matricula: string;
  mtvDeslig: string; // Tabela 19
  dtDeslig: string;
  indPagtoAPI: 'S' | 'N';
  dtProjFimAPI?: string;
  pensAlim?: 0 | 1 | 2 | 3;
  verbas: Array<{
    ideDmDev: string;
    codRubr: string;
    ideTabRubr: string;
    qtdRubr?: number;
    vrRubr: number;
  }>;
}

export interface EsocialS2300Input extends EsocialBaseInput {
  eventType: 'S-2300';
  cpfTrab: string;
  nmTrab: string;
  dtNascto: string;
  codCateg: string; // ex: '701', '722', '901'
  dtInicio: string;
  matricula?: string;
  codCBO?: string;
  vrSalFx?: number;
  undSalFixo?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export interface EsocialS2399Input extends EsocialBaseInput {
  eventType: 'S-2399';
  cpfTrab: string;
  codCateg: string;
  dtInicio: string;
  dtTerm: string;
  mtvDesligTSV?: string;
}

export interface EsocialS1200ItemInput {
  codRubr: string;
  ideTabRubr: string;
  qtdRubr?: number;
  fatorRubr?: number;
  vrRubr: number;
  indApurIR?: 0 | 1;
}

export interface EsocialS1200Input extends EsocialBaseInput {
  eventType: 'S-1200';
  indApuracao: 1 | 2; // 1 mensal, 2 anual (13o)
  perApur: string; // YYYY-MM ou YYYY
  cpfTrab: string;
  indMV?: 1 | 2 | 3;
  matricula?: string;
  codCateg: string;
  codLotacao: string;
  tpInscEstab: 1 | 3 | 4;
  nrInscEstab: string;
  ideDmDev: string;
  itens: EsocialS1200ItemInput[];
}

export interface EsocialS1210Input extends EsocialBaseInput {
  eventType: 'S-1210';
  perApur: string; // YYYY-MM
  cpfTrab: string;
  dtPgto: string; // YYYY-MM-DD
  tpPgto: 1 | 2 | 3 | 4 | 5;
  ideDmDev: string;
  vrLiq: number;
}

export interface EsocialS1298Input extends EsocialBaseInput {
  eventType: 'S-1298';
  indApuracao: 1 | 2;
  perApur: string;
}

export interface EsocialS1299Input extends EsocialBaseInput {
  eventType: 'S-1299';
  indApuracao: 1 | 2;
  perApur: string;
  evtRemun: 'S' | 'N';
  evtPgtos: 'S' | 'N';
  evtComProd?: 'S' | 'N';
  evtContratAvNP?: 'S' | 'N';
  evtInfoComplPer?: 'S' | 'N';
}

export type EsocialOutboundEventInput =
  | EsocialS1000Input
  | EsocialS1005Input
  | EsocialS1010Input
  | EsocialS1020Input
  | EsocialS2190Input
  | EsocialS2200Input
  | EsocialS2205Input
  | EsocialS2206Input
  | EsocialS2230Input
  | EsocialS2240Input
  | EsocialS2299Input
  | EsocialS2300Input
  | EsocialS2399Input
  | EsocialS1200Input
  | EsocialS1210Input
  | EsocialS1298Input
  | EsocialS1299Input;

export interface EsocialValidationError {
  code: string;
  field: string;
  message: string;
}

export interface EsocialValidationResult {
  valid: boolean;
  eventType: EsocialOutboundEventType;
  layoutVersion: EsocialLayoutVersion;
  eventId: string | null;
  errors: EsocialValidationError[];
}

export interface ParsedTotalizerResult {
  eventType: EsocialTotalizerEventType;
  eventId: string | null;
  receiptNumber: string | null;
  perApur: string;
  periodYear: number;
  periodMonth: number;
  cpfTrab: string | null;
  nrInsc: string | null;
  inssBase: number;
  inssSegurados: number;
  inssPatronal: number;
  inssRatAjustado: number;
  inssTerceiros: number;
  irrfRetido: number;
  fgtsBase: number;
  fgtsTotal: number;
  maternityDeduction: number;
  familySalaryDeduction: number;
}

export interface MotorExpectedTotalizerValues {
  inssSegurados: number;
  inssPatronal: number;
  irrfRetido: number;
  fgtsTotal: number;
  maternityDeduction?: number;
  familySalaryDeduction?: number;
}

export interface TotalizerDivergenceItem {
  field: string;
  label: string;
  governmentAmount: number;
  motorAmount: number;
  diffAmount: number;
}

export interface TotalizerReconciliationResult {
  reconciliationStatus: 'MATCHED' | 'DIVERGENT';
  diffInssSegurados: number;
  diffInssPatronal: number;
  diffIrrfRetido: number;
  diffFgtsTotal: number;
  maxAbsDiff: number;
  divergences: TotalizerDivergenceItem[];
}
