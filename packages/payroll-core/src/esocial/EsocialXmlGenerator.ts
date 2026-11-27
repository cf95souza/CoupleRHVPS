import { round2 } from '../utils/money.js';
import type {
  EsocialEnvironment,
  EsocialLayoutVersion,
  EsocialOutboundEventInput,
  EsocialOutboundEventType,
} from './EsocialTypes.js';

const LAYOUT_TAG_MAP: Record<EsocialLayoutVersion, string> = {
  'S-1.2': 'v_S_01_02_00',
  'S-1.3': 'v_S_01_03_00',
};

const EVENT_NS_SLUG: Record<EsocialOutboundEventType, { slug: string; rootTag: string }> = {
  'S-1000': { slug: 'evtInfoEmpregador', rootTag: 'evtInfoEmpregador' },
  'S-1005': { slug: 'evtTabEstab', rootTag: 'evtTabEstab' },
  'S-1010': { slug: 'evtTabRubrica', rootTag: 'evtTabRubrica' },
  'S-1020': { slug: 'evtTabLotacao', rootTag: 'evtTabLotacao' },
  'S-2190': { slug: 'evtAdmPrelim', rootTag: 'evtAdmPrelim' },
  'S-2200': { slug: 'evtAdmissao', rootTag: 'evtAdmissao' },
  'S-2205': { slug: 'evtAltCadastral', rootTag: 'evtAltCadastral' },
  'S-2206': { slug: 'evtAltContratual', rootTag: 'evtAltContratual' },
  'S-2230': { slug: 'evtAfastTemp', rootTag: 'evtAfastTemp' },
  'S-2240': { slug: 'evtExpRisco', rootTag: 'evtExpRisco' },
  'S-2299': { slug: 'evtDeslig', rootTag: 'evtDeslig' },
  'S-2300': { slug: 'evtTSVInicio', rootTag: 'evtTSVInicio' },
  'S-2399': { slug: 'evtTSVTermino', rootTag: 'evtTSVTermino' },
  'S-1200': { slug: 'evtRemun', rootTag: 'evtRemun' },
  'S-1210': { slug: 'evtPgtos', rootTag: 'evtPgtos' },
  'S-1298': { slug: 'evtReabreEvPer', rootTag: 'evtReabreEvPer' },
  'S-1299': { slug: 'evtFechaEvPer', rootTag: 'evtFechaEvPer' },
};

export function getEsocialNamespace(
  eventType: EsocialOutboundEventType,
  layoutVersion: EsocialLayoutVersion = 'S-1.3'
): string {
  const layoutTag = LAYOUT_TAG_MAP[layoutVersion];
  const { slug } = EVENT_NS_SLUG[eventType];
  return `http://www.esocial.gov.br/schema/evt/${slug}/${layoutTag}`;
}

export function getEsocialRootTag(eventType: EsocialOutboundEventType): string {
  return EVENT_NS_SLUG[eventType].rootTag;
}

export function getEsocialEventGroup(eventType: EsocialOutboundEventType): 1 | 2 | 3 {
  if (eventType.startsWith('S-10')) return 1;
  if (eventType.startsWith('S-2')) return 2;
  return 3;
}

export function digitsOnly(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

export function normalizeNrInscEmpregador(tpInsc: 1 | 2, nrInsc: string): string {
  const digits = digitsOnly(nrInsc);
  if (tpInsc === 1) {
    // CNPJ raiz de 8 digitos (padrao eSocial S-1000/eventos do empregador)
    return digits.slice(0, 8).padStart(8, '0');
  }
  return digits.slice(0, 11).padStart(11, '0');
}

export function escapeXml(value: string | number | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmtMoney(value: number | undefined): string {
  return round2(value ?? 0).toFixed(2);
}

function fmtRate(value: number | undefined, decimals = 4): string {
  const num = Number.isFinite(value) ? Number(value) : 0;
  return num.toFixed(decimals);
}

/**
 * Gera Id oficial do evento eSocial com exatamente 36 caracteres:
 * ID + T (1) + NNNNNNNNNNNNNN (14) + AAAAMMDDHHMMSS (14) + QQQQQ (5)
 */
export function generateEsocialEventId(
  tpInsc: 1 | 2,
  nrInsc: string,
  date: Date = new Date(),
  sequence = 1
): string {
  const digits = digitsOnly(nrInsc);
  const nr14 = (tpInsc === 1 ? digits.slice(0, 8) : digits.slice(0, 11)).padEnd(14, '0');
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const stamp = [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
  ].join('');
  const seq5 = String(Math.abs(Math.floor(sequence)) % 100000).padStart(5, '0');
  return `ID${tpInsc}${nr14}${stamp}${seq5}`;
}

function buildIdeEvento(
  input: EsocialOutboundEventInput,
  options?: { includeIndRetif?: boolean; indApuracao?: 1 | 2; perApur?: string }
): string {
  const tpAmb = input.environment === 'PRODUCTION' ? 1 : 2;
  const procEmi = input.procEmi ?? 1;
  const verProc = escapeXml(input.verProc ?? 'CoupleRH-2.0');
  const lines: string[] = ['<ideEvento>'];

  if (options?.includeIndRetif !== false) {
    const indRetif = input.indRetif ?? 1;
    lines.push(`<indRetif>${indRetif}</indRetif>`);
    if (indRetif === 2 && input.nrRecibo) {
      lines.push(`<nrRecibo>${escapeXml(input.nrRecibo)}</nrRecibo>`);
    }
  }
  if (options?.indApuracao) {
    lines.push(`<indApuracao>${options.indApuracao}</indApuracao>`);
  }
  if (options?.perApur) {
    lines.push(`<perApur>${escapeXml(options.perApur)}</perApur>`);
  }

  lines.push(`<tpAmb>${tpAmb}</tpAmb>`);
  lines.push(`<procEmi>${procEmi}</procEmi>`);
  lines.push(`<verProc>${verProc}</verProc>`);
  lines.push('</ideEvento>');
  return lines.join('');
}

function buildIdeEmpregador(tpInsc: 1 | 2, nrInsc: string): string {
  const normalized = normalizeNrInscEmpregador(tpInsc, nrInsc);
  return `<ideEmpregador><tpInsc>${tpInsc}</tpInsc><nrInsc>${normalized}</nrInsc></ideEmpregador>`;
}

export function generateEsocialEventXml(input: EsocialOutboundEventInput): {
  eventId: string;
  layoutVersion: EsocialLayoutVersion;
  namespace: string;
  xml: string;
} {
  const layoutVersion: EsocialLayoutVersion = input.layoutVersion ?? 'S-1.3';
  const namespace = getEsocialNamespace(input.eventType, layoutVersion);
  const rootTag = getEsocialRootTag(input.eventType);
  const eventId =
    input.eventId ||
    generateEsocialEventId(input.tpInsc, input.nrInsc, input.generatedAt ?? new Date(), input.sequence ?? 1);

  const ideEmpregador = buildIdeEmpregador(input.tpInsc, input.nrInsc);
  let body = '';

  switch (input.eventType) {
    case 'S-1000': {
      const ideEvento = buildIdeEvento(input, { includeIndRetif: false });
      const fimTag = input.fimValid ? `<fimValid>${escapeXml(input.fimValid)}</fimValid>` : '';
      body = `${ideEvento}${ideEmpregador}<infoEmpregador><inclusao><idePeriodo><iniValid>${escapeXml(
        input.iniValid
      )}</iniValid>${fimTag}</idePeriodo><infoCadastro><classTrib>${escapeXml(
        input.classTrib
      )}</classTrib><indCoop>${input.indCoop ?? 0}</indCoop><indConstr>${
        input.indConstr ?? 0
      }</indConstr><indDesFolha>${input.indDesFolha ?? 0}</indDesFolha><indOptRegEletron>${
        input.indOptRegEletron ?? 1
      }</indOptRegEletron></infoCadastro></inclusao></infoEmpregador>`;
      break;
    }

    case 'S-1005': {
      const ideEvento = buildIdeEvento(input, { includeIndRetif: false });
      body = `${ideEvento}${ideEmpregador}<infoEstab><inclusao><ideEstab><tpInsc>${
        input.tpInscEstab
      }</tpInsc><nrInsc>${digitsOnly(input.nrInscEstab)}</nrInsc><iniValid>${escapeXml(
        input.iniValid
      )}</iniValid></ideEstab><dadosEstab><cnaePrep>${digitsOnly(
        input.cnaePrep
      )}</cnaePrep><aliqGilrat><aliqRat>${input.aliqRat}</aliqRat><fap>${fmtRate(
        input.fap,
        4
      )}</fap></aliqGilrat></dadosEstab></inclusao></infoEstab>`;
      break;
    }

    case 'S-1010': {
      const ideEvento = buildIdeEvento(input, { includeIndRetif: false });
      body = `${ideEvento}${ideEmpregador}<infoRubrica><inclusao><ideRubrica><codRubr>${escapeXml(
        input.codRubr
      )}</codRubr><ideTabRubr>${escapeXml(input.ideTabRubr)}</ideTabRubr><iniValid>${escapeXml(
        input.iniValid
      )}</iniValid></ideRubrica><dadosRubrica><dscRubr>${escapeXml(
        input.dscRubr
      )}</dscRubr><natRubr>${escapeXml(input.natRubr)}</natRubr><tpRubr>${
        input.tpRubr
      }</tpRubr><codIncCP>${escapeXml(input.codIncCP)}</codIncCP><codIncIRRF>${escapeXml(
        input.codIncIRRF
      )}</codIncIRRF><codIncFGTS>${escapeXml(
        input.codIncFGTS
      )}</codIncFGTS></dadosRubrica></inclusao></infoRubrica>`;
      break;
    }

    case 'S-1020': {
      const ideEvento = buildIdeEvento(input, { includeIndRetif: false });
      const tomadorXml =
        input.tpInscTomador && input.nrInscTomador
          ? `<infoEmprParcial><tpInscContrat>${input.tpInscTomador}</tpInscContrat><nrInscContrat>${digitsOnly(
              input.nrInscTomador
            )}</nrInscContrat></infoEmprParcial>`
          : '';
      body = `${ideEvento}${ideEmpregador}<infoLotacao><inclusao><ideLotacao><codLotacao>${escapeXml(
        input.codLotacao
      )}</codLotacao><iniValid>${escapeXml(input.iniValid)}</iniValid></ideLotacao><dadosLotacao><tpLotacao>${escapeXml(
        input.tpLotacao
      )}</tpLotacao><fpasLotacao><fpas>${escapeXml(input.fpas)}</fpas><codTercs>${escapeXml(
        input.codTercs
      )}</codTercs></fpasLotacao>${tomadorXml}</dadosLotacao></inclusao></infoLotacao>`;
      break;
    }

    case 'S-2190': {
      const ideEvento = buildIdeEvento(input);
      body = `${ideEvento}${ideEmpregador}<infoRegPrelim><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab><dtNascto>${escapeXml(input.dtNascto)}</dtNascto><dtAdm>${escapeXml(
        input.dtAdm
      )}</dtAdm><matricula>${escapeXml(input.matricula)}</matricula><codCateg>${escapeXml(
        input.codCateg
      )}</codCateg><natAtividade>${input.natAtividade}</natAtividade><infoRegCTPS><CBOCargo>${digitsOnly(
        input.codCBO
      )}</CBOCargo><vrSalFx>${fmtMoney(input.vrSalFx)}</vrSalFx><undSalFixo>${
        input.undSalFixo
      }</undSalFixo></infoRegCTPS></infoRegPrelim>`;
      break;
    }

    case 'S-2200': {
      const ideEvento = buildIdeEvento(input);
      body = `${ideEvento}${ideEmpregador}<trabalhador><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab><nmTrab>${escapeXml(input.nmTrab)}</nmTrab><sexo>${input.sexo}</sexo><racaCor>${
        input.racaCor
      }</racaCor><estCiv>${input.estCiv ?? 1}</estCiv><grauInstr>${escapeXml(
        input.grauInstr
      )}</grauInstr><nascimento><dtNascto>${escapeXml(input.dtNascto)}</dtNascto><paisNac>${escapeXml(
        input.paisNac ?? '105'
      )}</paisNac></nascimento></trabalhador><vinculo><matricula>${escapeXml(
        input.matricula
      )}</matricula><tpRegTrab>${input.tpRegTrab}</tpRegTrab><tpRegPrev>${
        input.tpRegPrev
      }</tpRegPrev><infoRegimeTrab><infoCeletista><dtAdm>${escapeXml(
        input.dtAdm
      )}</dtAdm><tpAdmissao>1</tpAdmissao><indAdmissao>1</indAdmissao><tpRegJor>1</tpRegJor><natAtividade>1</natAtividade><cnpjSindCategProf>${digitsOnly(
        input.nrInsc
      ).padEnd(14, '0').slice(0, 14)}</cnpjSindCategProf></infoCeletista></infoRegimeTrab><infoContrato><codCateg>${escapeXml(
        input.codCateg
      )}</codCateg><CBOCargo>${digitsOnly(input.codCBO)}</CBOCargo><remuneracao><vrSalFx>${fmtMoney(
        input.vrSalFx
      )}</vrSalFx><undSalFixo>${input.undSalFixo}</undSalFixo></remuneracao><duracao><tpContr>${
        input.tpContr
      }</tpContr></duracao><localTrabalho><localTrabGeral><tpInsc>${
        input.tpInscLocal
      }</tpInsc><nrInsc>${digitsOnly(input.nrInscLocal)}</nrInsc></localTrabGeral></localTrabalho></infoContrato></vinculo>`;
      break;
    }

    case 'S-2205': {
      const ideEvento = buildIdeEvento(input);
      body = `${ideEvento}${ideEmpregador}<ideTrabalhador><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab></ideTrabalhador><alteracao><dtAlteracao>${escapeXml(
        input.dtAlteracao
      )}</dtAlteracao><dadosTrabalhador><nmTrab>${escapeXml(input.nmTrab)}</nmTrab><sexo>${
        input.sexo
      }</sexo><racaCor>${input.racaCor}</racaCor><estCiv>${
        input.estCiv ?? 1
      }</estCiv><grauInstr>${escapeXml(input.grauInstr)}</grauInstr></dadosTrabalhador></alteracao>`;
      break;
    }

    case 'S-2206': {
      const ideEvento = buildIdeEvento(input);
      body = `${ideEvento}${ideEmpregador}<ideVinculo><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab><matricula>${escapeXml(
        input.matricula
      )}</matricula></ideVinculo><altContratual><dtAlteracao>${escapeXml(
        input.dtAlteracao
      )}</dtAlteracao><vinculo><tpRegPrev>1</tpRegPrev><infoContrato><codCateg>${escapeXml(
        input.codCateg
      )}</codCateg><CBOCargo>${digitsOnly(input.codCBO)}</CBOCargo><remuneracao><vrSalFx>${fmtMoney(
        input.vrSalFx
      )}</vrSalFx><undSalFixo>${input.undSalFixo}</undSalFixo></remuneracao></infoContrato></vinculo></altContratual>`;
      break;
    }

    case 'S-2230': {
      const ideEvento = buildIdeEvento(input);
      const fimXml = input.dtTermAfast
        ? `<fimAfastamento><dtTermAfast>${escapeXml(input.dtTermAfast)}</dtTermAfast></fimAfastamento>`
        : '';
      const mesmoMotivo = input.indMesmoMotivo
        ? `<indMesmoMtv>${input.indMesmoMotivo}</indMesmoMtv>`
        : '';
      body = `${ideEvento}${ideEmpregador}<ideVinculo><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab><matricula>${escapeXml(
        input.matricula
      )}</matricula></ideVinculo><infoAfastamento><iniAfastamento><dtIniAfast>${escapeXml(
        input.dtIniAfast
      )}</dtIniAfast><codMotAfast>${escapeXml(
        input.codMotAfast
      )}</codMotAfast>${mesmoMotivo}</iniAfastamento>${fimXml}</infoAfastamento>`;
      break;
    }

    case 'S-2240': {
      const ideEvento = buildIdeEvento(input);
      body = `${ideEvento}${ideEmpregador}<ideVinculo><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab><matricula>${escapeXml(
        input.matricula
      )}</matricula></ideVinculo><infoExpRisco><dtIniCondicao>${escapeXml(
        input.dtIniCondicao
      )}</dtIniCondicao><infoAmb><localAmb>1</localAmb><dscSetor>${escapeXml(
        input.codAmb
      )}</dscSetor><tpInsc>1</tpInsc><nrInsc>${digitsOnly(input.nrInsc).padEnd(14, '0').slice(0, 14)}</nrInsc></infoAmb><infoAtiv><dscAtivDes>${escapeXml(
        input.dscAtivDes
      )}</dscAtivDes></infoAtiv><agNoc><codAgNoc>${escapeXml(input.codAgNoc)}</codAgNoc><tpAval>${
        input.tpAval ?? 2
      }</tpAval></agNoc></infoExpRisco>`;
      break;
    }

    case 'S-2299': {
      const ideEvento = buildIdeEvento(input);
      const projXml = input.dtProjFimAPI
        ? `<dtProjFimAPI>${escapeXml(input.dtProjFimAPI)}</dtProjFimAPI>`
        : '';
      const verbasXml = input.verbas
        .map(
          (v) =>
            `<dmDev><ideDmDev>${escapeXml(
              v.ideDmDev
            )}</ideDmDev><infoPerApur><ideEstabLot><tpInsc>1</tpInsc><nrInsc>${digitsOnly(
              input.nrInsc
            ).padEnd(14, '0').slice(0, 14)}</nrInsc><codLotacao>PADRAO</codLotacao><detVerbas><codRubr>${escapeXml(
              v.codRubr
            )}</codRubr><ideTabRubr>${escapeXml(v.ideTabRubr)}</ideTabRubr>${
              v.qtdRubr !== undefined ? `<qtdRubr>${fmtRate(v.qtdRubr, 2)}</qtdRubr>` : ''
            }<vrRubr>${fmtMoney(v.vrRubr)}</vrRubr></detVerbas></ideEstabLot></infoPerApur></dmDev>`
        )
        .join('');
      body = `${ideEvento}${ideEmpregador}<ideVinculo><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab><matricula>${escapeXml(
        input.matricula
      )}</matricula></ideVinculo><infoDeslig><mtvDeslig>${escapeXml(
        input.mtvDeslig
      )}</mtvDeslig><dtDeslig>${escapeXml(input.dtDeslig)}</dtDeslig><indPagtoAPI>${
        input.indPagtoAPI
      }</indPagtoAPI>${projXml}<pensAlim>${input.pensAlim ?? 0}</pensAlim><verbasResc>${verbasXml}</verbasResc></infoDeslig>`;
      break;
    }

    case 'S-2300': {
      const ideEvento = buildIdeEvento(input);
      const matXml = input.matricula ? `<matricula>${escapeXml(input.matricula)}</matricula>` : '';
      const infoCompl =
        input.codCBO || input.vrSalFx !== undefined
          ? `<infoComplementares><cargoFuncao><CBOCargo>${digitsOnly(
              input.codCBO ?? '252105'
            )}</CBOCargo></cargoFuncao>${
              input.vrSalFx !== undefined
                ? `<remuneracao><vrSalFx>${fmtMoney(input.vrSalFx)}</vrSalFx><undSalFixo>${
                    input.undSalFixo ?? 5
                  }</undSalFixo></remuneracao>`
                : ''
            }</infoComplementares>`
          : '';
      body = `${ideEvento}${ideEmpregador}<trabalhador><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab><nmTrab>${escapeXml(input.nmTrab)}</nmTrab><nascimento><dtNascto>${escapeXml(
        input.dtNascto
      )}</dtNascto></nascimento></trabalhador><infoTSVInicio><cadIni>N</cadIni>${matXml}<codCateg>${escapeXml(
        input.codCateg
      )}</codCateg><dtInicio>${escapeXml(input.dtInicio)}</dtInicio>${infoCompl}</infoTSVInicio>`;
      break;
    }

    case 'S-2399': {
      const ideEvento = buildIdeEvento(input);
      const mtvXml = input.mtvDesligTSV
        ? `<mtvDesligTSV>${escapeXml(input.mtvDesligTSV)}</mtvDesligTSV>`
        : '';
      body = `${ideEvento}${ideEmpregador}<ideTrabSemVinculo><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab><codCateg>${escapeXml(
        input.codCateg
      )}</codCateg></ideTrabSemVinculo><infoTSVTermino><dtTerm>${escapeXml(
        input.dtTerm
      )}</dtTerm>${mtvXml}</infoTSVTermino>`;
      break;
    }

    case 'S-1200': {
      const ideEvento = buildIdeEvento(input, {
        indApuracao: input.indApuracao,
        perApur: input.perApur,
      });
      const indMVXml = input.indMV ? `<infoMV><indMV>${input.indMV}</indMV></infoMV>` : '';
      const matXml = input.matricula ? `<matricula>${escapeXml(input.matricula)}</matricula>` : '';
      const itensXml = input.itens
        .map(
          (item) =>
            `<itensRemun><codRubr>${escapeXml(item.codRubr)}</codRubr><ideTabRubr>${escapeXml(
              item.ideTabRubr
            )}</ideTabRubr>${
              item.qtdRubr !== undefined ? `<qtdRubr>${fmtRate(item.qtdRubr, 2)}</qtdRubr>` : ''
            }${
              item.fatorRubr !== undefined
                ? `<fatorRubr>${fmtRate(item.fatorRubr, 2)}</fatorRubr>`
                : ''
            }<vrRubr>${fmtMoney(item.vrRubr)}</vrRubr><indApurIR>${
              item.indApurIR ?? 0
            }</indApurIR></itensRemun>`
        )
        .join('');
      body = `${ideEvento}${ideEmpregador}<ideTrabalhador><cpfTrab>${digitsOnly(
        input.cpfTrab
      )}</cpfTrab>${indMVXml}</ideTrabalhador><dmDev><ideDmDev>${escapeXml(
        input.ideDmDev
      )}</ideDmDev><codCateg>${escapeXml(
        input.codCateg
      )}</codCateg><infoPerApur><ideEstabLot><tpInsc>${
        input.tpInscEstab
      }</tpInsc><nrInsc>${digitsOnly(input.nrInscEstab)}</nrInsc><codLotacao>${escapeXml(
        input.codLotacao
      )}</codLotacao><remunPerApur>${matXml}${itensXml}</remunPerApur></ideEstabLot></infoPerApur></dmDev>`;
      break;
    }

    case 'S-1210': {
      const ideEvento = buildIdeEvento(input, {
        indApuracao: 1,
        perApur: input.perApur,
      });
      body = `${ideEvento}${ideEmpregador}<ideBenef><cpfBenef>${digitsOnly(
        input.cpfTrab
      )}</cpfBenef><infoPgto><dtPgto>${escapeXml(input.dtPgto)}</dtPgto><tpPgto>${
        input.tpPgto
      }</tpPgto><perRef>${escapeXml(input.perApur)}</perRef><ideDmDev>${escapeXml(
        input.ideDmDev
      )}</ideDmDev><vrLiq>${fmtMoney(input.vrLiq)}</vrLiq></infoPgto></ideBenef>`;
      break;
    }

    case 'S-1298': {
      const ideEvento = buildIdeEvento(input, {
        includeIndRetif: false,
        indApuracao: input.indApuracao,
        perApur: input.perApur,
      });
      body = `${ideEvento}${ideEmpregador}`;
      break;
    }

    case 'S-1299': {
      const ideEvento = buildIdeEvento(input, {
        includeIndRetif: false,
        indApuracao: input.indApuracao,
        perApur: input.perApur,
      });
      body = `${ideEvento}${ideEmpregador}<infoFech><evtRemun>${input.evtRemun}</evtRemun><evtPgtos>${
        input.evtPgtos
      }</evtPgtos><evtComProd>${input.evtComProd ?? 'N'}</evtComProd><evtContratAvNP>${
        input.evtContratAvNP ?? 'N'
      }</evtContratAvNP><evtInfoComplPer>${
        input.evtInfoComplPer ?? 'N'
      }</evtInfoComplPer></infoFech>`;
      break;
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?><eSocial xmlns="${namespace}"><${rootTag} Id="${eventId}">${body}</${rootTag}></eSocial>`;

  return {
    eventId,
    layoutVersion,
    namespace,
    xml,
  };
}

/**
 * Envelope oficial SOAP/XML de Envio de Lote de Eventos eSocial (v1_1_1)
 */
export function buildEsocialBatchEnvelopeXml(params: {
  tpInscEmpregador: 1 | 2;
  nrInscEmpregador: string;
  tpInscTransmissor?: 1 | 2;
  nrInscTransmissor?: string;
  grupo: 1 | 2 | 3;
  events: Array<{ eventId: string; signedXml: string }>;
}): string {
  const empNr = normalizeNrInscEmpregador(params.tpInscEmpregador, params.nrInscEmpregador);
  const transTp = params.tpInscTransmissor ?? params.tpInscEmpregador;
  const transNr = digitsOnly(params.nrInscTransmissor ?? params.nrInscEmpregador)
    .padEnd(14, '0')
    .slice(0, 14);

  const eventosXml = params.events
    .map((ev) => {
      const stripped = ev.signedXml.replace(/^<\?xml[^>]*\?>\s*/i, '');
      return `<evento Id="${escapeXml(ev.eventId)}">${stripped}</evento>`;
    })
    .join('');

  const loteXml = `<eSocial xmlns="http://www.esocial.gov.br/schema/lote/eventos/envio/v1_1_1"><envioLoteEventos grupo="${params.grupo}"><ideEmpregador><tpInsc>${params.tpInscEmpregador}</tpInsc><nrInsc>${empNr}</nrInsc></ideEmpregador><ideTransmissor><tpInsc>${transTp}</tpInsc><nrInsc>${transNr}</nrInsc></ideTransmissor><eventos>${eventosXml}</eventos></envioLoteEventos></eSocial>`;

  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="http://www.esocial.gov.br/servicos/empregador/lote/eventos/envio/v1_1_0"><soapenv:Header/><soapenv:Body><v1:EnviarLoteEventos><v1:loteEventos>${loteXml}</v1:loteEventos></v1:EnviarLoteEventos></soapenv:Body></soapenv:Envelope>`;
}

/**
 * Envelope oficial SOAP/XML de Consulta de Lote de Eventos eSocial (v1_1_1)
 */
export function buildEsocialBatchQueryXml(protocolNumber: string): string {
  const consultaXml = `<eSocial xmlns="http://www.esocial.gov.br/schema/lote/eventos/consulta/v1_1_1"><consultaLoteEventos><protocoloEnvio>${escapeXml(
    protocolNumber
  )}</protocoloEnvio></consultaLoteEventos></eSocial>`;

  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="http://www.esocial.gov.br/servicos/empregador/lote/eventos/consulta/v1_1_0"><soapenv:Header/><soapenv:Body><v1:ConsultarLoteEventos><v1:consulta>${consultaXml}</v1:ConsultarLoteEventos></soapenv:Body></soapenv:Envelope>`;
}
