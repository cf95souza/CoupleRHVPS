import { describe, it, expect } from 'vitest';
import {
  generateEsocialEventId,
  generateEsocialEventXml,
  validateEsocialXml,
  buildEsocialBatchEnvelopeXml,
  buildEsocialBatchQueryXml,
  type EsocialOutboundEventInput,
} from '../src/index.js';

const baseEmpregador = {
  environment: 'HOMOLOGATION' as const,
  tpInsc: 1 as const,
  nrInsc: '12345678000195',
  generatedAt: new Date('2026-11-27T12:00:00Z'),
  sequence: 1,
};

const ALL_17_EVENTS: EsocialOutboundEventInput[] = [
  { ...baseEmpregador, eventType: 'S-1000', iniValid: '2026-01', classTrib: '99' },
  {
    ...baseEmpregador,
    eventType: 'S-1005',
    iniValid: '2026-01',
    tpInscEstab: 1,
    nrInscEstab: '12345678000195',
    cnaePrep: '6201501',
    aliqRat: 2,
    fap: 1.0,
  },
  {
    ...baseEmpregador,
    eventType: 'S-1010',
    iniValid: '2026-01',
    codRubr: '101',
    ideTabRubr: 'TAB1',
    dscRubr: 'Salario Base Mensal',
    natRubr: '1000',
    tpRubr: 1,
    codIncCP: '11',
    codIncIRRF: '11',
    codIncFGTS: '11',
  },
  {
    ...baseEmpregador,
    eventType: 'S-1020',
    iniValid: '2026-01',
    codLotacao: 'LOT01',
    tpLotacao: '01',
    fpas: '515',
    codTercs: '0079',
  },
  {
    ...baseEmpregador,
    eventType: 'S-2190',
    cpfTrab: '11122233396',
    dtNascto: '1992-05-10',
    dtAdm: '2026-11-27',
    matricula: 'MAT001',
    codCateg: '101',
    natAtividade: 1,
    codCBO: '212405',
    vrSalFx: 5500,
    undSalFixo: 5,
  },
  {
    ...baseEmpregador,
    eventType: 'S-2200',
    cpfTrab: '11122233396',
    nmTrab: 'MARIA SILVA SOUZA',
    sexo: 'F',
    racaCor: 1,
    grauInstr: '09',
    dtNascto: '1992-05-10',
    matricula: 'MAT001',
    tpRegTrab: 1,
    tpRegPrev: 1,
    dtAdm: '2026-01-10',
    codCateg: '101',
    codCBO: '212405',
    vrSalFx: 5500,
    undSalFixo: 5,
    tpContr: 1,
    codLotacao: 'LOT01',
    tpInscLocal: 1,
    nrInscLocal: '12345678000195',
  },
  {
    ...baseEmpregador,
    eventType: 'S-2205',
    cpfTrab: '11122233396',
    dtAlteracao: '2026-11-20',
    nmTrab: 'MARIA SILVA SOUZA SANTOS',
    sexo: 'F',
    racaCor: 1,
    grauInstr: '09',
  },
  {
    ...baseEmpregador,
    eventType: 'S-2206',
    cpfTrab: '11122233396',
    matricula: 'MAT001',
    dtAlteracao: '2026-11-01',
    vrSalFx: 6200,
    undSalFixo: 5,
    codCBO: '212405',
    codCateg: '101',
  },
  {
    ...baseEmpregador,
    eventType: 'S-2230',
    cpfTrab: '11122233396',
    matricula: 'MAT001',
    dtIniAfast: '2026-11-10',
    codMotAfast: '03',
    dtTermAfast: '2026-11-25',
  },
  {
    ...baseEmpregador,
    eventType: 'S-2240',
    cpfTrab: '11122233396',
    matricula: 'MAT001',
    dtIniCondicao: '2026-01-10',
    codAmb: 'DESENVOLVIMENTO',
    dscAtivDes: 'Desenvolvimento de sistemas em escritorio.',
    codAgNoc: '09.01.001',
  },
  {
    ...baseEmpregador,
    eventType: 'S-2299',
    cpfTrab: '11122233396',
    matricula: 'MAT001',
    mtvDeslig: '02',
    dtDeslig: '2026-11-27',
    indPagtoAPI: 'N',
    verbas: [
      { ideDmDev: 'RESC001', codRubr: '510', ideTabRubr: 'TAB1', qtdRubr: 27, vrRubr: 4950 },
    ],
  },
  {
    ...baseEmpregador,
    eventType: 'S-2300',
    cpfTrab: '44455566677',
    nmTrab: 'CARLOS SOCIO ADMINISTRADOR',
    dtNascto: '1985-03-14',
    codCateg: '722',
    dtInicio: '2026-01-01',
    vrSalFx: 10000,
    undSalFixo: 5,
  },
  {
    ...baseEmpregador,
    eventType: 'S-2399',
    cpfTrab: '44455566677',
    codCateg: '722',
    dtInicio: '2026-01-01',
    dtTerm: '2026-11-27',
    mtvDesligTSV: '99',
  },
  {
    ...baseEmpregador,
    eventType: 'S-1200',
    indApuracao: 1,
    perApur: '2026-11',
    cpfTrab: '11122233396',
    matricula: 'MAT001',
    codCateg: '101',
    codLotacao: 'LOT01',
    tpInscEstab: 1,
    nrInscEstab: '12345678000195',
    ideDmDev: 'FOLHA-2026-11',
    itens: [
      { codRubr: '101', ideTabRubr: 'TAB1', vrRubr: 5500 },
      { codRubr: '901', ideTabRubr: 'TAB1', vrRubr: 583.22 },
    ],
  },
  {
    ...baseEmpregador,
    eventType: 'S-1210',
    perApur: '2026-11',
    cpfTrab: '11122233396',
    dtPgto: '2026-12-05',
    tpPgto: 1,
    ideDmDev: 'FOLHA-2026-11',
    vrLiq: 4350.15,
  },
  {
    ...baseEmpregador,
    eventType: 'S-1298',
    indApuracao: 1,
    perApur: '2026-11',
  },
  {
    ...baseEmpregador,
    eventType: 'S-1299',
    indApuracao: 1,
    perApur: '2026-11',
    evtRemun: 'S',
    evtPgtos: 'S',
  },
];

describe('ESOC-02: Gerador XML Layouts S-1.2 / S-1.3 & Validador XSD', () => {
  it('deve gerar Id eSocial com exatamente 36 caracteres no padrao oficial', () => {
    const id = generateEsocialEventId(1, '12.345.678/0001-95', new Date('2026-11-27T10:15:30Z'), 42);
    expect(id).toBe('ID1123456780000002026112710153000042');
    expect(id).toHaveLength(36);
  });

  it('deve gerar e validar nos layouts S-1.2 e S-1.3 todos os 17 eventos oficiais (tabela, nao periodicos e periodicos)', () => {
    expect(ALL_17_EVENTS).toHaveLength(17);

    for (const layout of ['S-1.2', 'S-1.3'] as const) {
      for (const evt of ALL_17_EVENTS) {
        const generated = generateEsocialEventXml({ ...evt, layoutVersion: layout });
        const check = validateEsocialXml(generated.xml, evt.eventType, layout);

        expect(check.valid, `Falha em ${evt.eventType} (${layout}): ${JSON.stringify(check.errors)}`).toBe(true);
        expect(check.eventId).toHaveLength(36);
      }
    }
  });

  it('deve rejeitar XML adulterado, namespace divergente, CPF invalido e tag mal fechada no validador XSD', () => {
    const { xml } = generateEsocialEventXml(ALL_17_EVENTS[5]); // S-2200
    const badNs = validateEsocialXml(xml, 'S-2200', 'S-1.2');
    expect(badNs.valid).toBe(false);
    expect(badNs.errors.some((e) => e.code === 'XSD_NAMESPACE')).toBe(true);

    const badCpf = xml.replace('<cpfTrab>11122233396</cpfTrab>', '<cpfTrab>123</cpfTrab>');
    const resCpf = validateEsocialXml(badCpf, 'S-2200', 'S-1.3');
    expect(resCpf.valid).toBe(false);
    expect(resCpf.errors.some((e) => e.code === 'XSD_PATTERN' && e.field === 'cpfTrab')).toBe(true);

    const brokenXml = xml.replace('</trabalhador>', '');
    const resSyntax = validateEsocialXml(brokenXml, 'S-2200', 'S-1.3');
    expect(resSyntax.valid).toBe(false);
    expect(resSyntax.errors.some((e) => e.code === 'XSD_SYNTAX')).toBe(true);
  });

  it('deve construir envelopes SOAP de envio e consulta de lote eSocial v1_1_1', () => {
    const ev = generateEsocialEventXml(ALL_17_EVENTS[0]);
    const sendEnvelope = buildEsocialBatchEnvelopeXml({
      tpInscEmpregador: 1,
      nrInscEmpregador: '12345678000195',
      grupo: 1,
      events: [{ eventId: ev.eventId, signedXml: ev.xml }],
    });
    expect(sendEnvelope).toContain('http://www.esocial.gov.br/schema/lote/eventos/envio/v1_1_1');
    expect(sendEnvelope).toContain(`evento Id="${ev.eventId}"`);

    const queryEnvelope = buildEsocialBatchQueryXml('1.2.202611.000000000012345');
    expect(queryEnvelope).toContain('<protocoloEnvio>1.2.202611.000000000012345</protocoloEnvio>');
  });
});
