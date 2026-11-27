/**
 * Cnab240Engine.ts
 * FASE V7 — CONT-04: Motor FEBRABAN CNAB 240 Completo Multi-Banco (Segmentos A e B, PIX/TED/CC,
 * Pensão Alimentícia integrada e Parser de Retorno .ret).
 *
 * Especificação rigorosa: todas as linhas possuem exatamente 240 caracteres ASCII sem acentuação.
 */

import { round2, sumMoney } from '../utils/money.js';

export interface SupportedBankSpec {
  code: string;
  name: string;
  layoutVersion: string;
  lotLayoutVersion: string;
}

export const SUPPORTED_CNAB_BANKS: SupportedBankSpec[] = [
  { code: '001', name: 'BANCO DO BRASIL S.A.', layoutVersion: '103', lotLayoutVersion: '046' },
  { code: '033', name: 'BANCO SANTANDER (BRASIL) S.A.', layoutVersion: '089', lotLayoutVersion: '045' },
  { code: '104', name: 'CAIXA ECONOMICA FEDERAL', layoutVersion: '080', lotLayoutVersion: '041' },
  { code: '237', name: 'BANCO BRADESCO S.A.', layoutVersion: '089', lotLayoutVersion: '045' },
  { code: '341', name: 'ITAU UNIBANCO S.A.', layoutVersion: '080', lotLayoutVersion: '040' },
  { code: '748', name: 'BANCO COOPERATIVO SICREDI S.A.', layoutVersion: '082', lotLayoutVersion: '042' },
  { code: '077', name: 'BANCO INTER S.A.', layoutVersion: '107', lotLayoutVersion: '046' },
];

export interface Cnab240CompanyHeader {
  corporateName: string;
  cnpj: string;
  bankCode: string;
  agency: string;
  agencyDigit?: string;
  accountNumber: string;
  accountDigit?: string;
  agreementCode?: string;
}

export interface Cnab240BeneficiaryItem {
  id: string;
  beneficiaryType: 'EMPLOYEE' | 'ALIMONY';
  payslipId?: string | null;
  contractId?: string | null;
  alimonySplitId?: string | null;
  name: string;
  cpf: string;
  paymentMethod: 'CC' | 'POUPANCA' | 'SALARIO' | 'TED' | 'PIX';
  bankCode?: string | null;
  agency?: string | null;
  agencyDigit?: string | null;
  accountNumber?: string | null;
  accountDigit?: string | null;
  pixKey?: string | null;
  pixKeyType?: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP' | string | null;
  amount: number;
  paymentDate: string; // YYYY-MM-DD
  yourNumber?: string;
}

export interface Cnab240RemittanceInput {
  company: Cnab240CompanyHeader;
  beneficiaries: Cnab240BeneficiaryItem[];
  generationDate?: string; // YYYY-MM-DD
  sequentialFileNumber?: number;
}

export interface Cnab240RemittanceOutput {
  bankCode: string;
  bankName: string;
  content: string;
  totalLines: number;
  totalLots: number;
  totalAmount: number;
  employeesCount: number;
  alimonyCount: number;
  items: Array<{
    itemId: string;
    beneficiaryType: 'EMPLOYEE' | 'ALIMONY';
    yourNumber: string;
    amount: number;
    paymentMethod: string;
  }>;
}

export interface Cnab240ReturnEntry {
  yourNumber: string;
  occurrenceRaw: string;
  occurrenceCodes: string[];
  status: 'PAID' | 'REJECTED';
  occurrenceMessage: string;
  paidAmount: number;
  paymentDate: string;
}

export interface Cnab240ReturnParseResult {
  bankCode: string;
  totalEntries: number;
  paidCount: number;
  rejectedCount: number;
  totalPaidAmount: number;
  entries: Cnab240ReturnEntry[];
}

const FEBRABAN_OCCURRENCE_MAP: Record<string, string> = {
  '00': 'Crédito ou Débito Efetivado',
  BD: 'Inclusão Efetuada com Sucesso',
  BE: 'Alteração Efetuada com Sucesso',
  AG: 'Agência/Conta Inválida',
  AH: 'Número do Lote Inválido',
  AI: 'Código de Segmento de Detalhe Inválido',
  AJ: 'Tipo de Movimento Inválido',
  AL: 'Código do Banco Favorecido Inválido',
  AM: 'Agência Mantenedora da Conta Corrente Inválida',
  AN: 'Conta Corrente / DV Inválido',
  AO: 'Nome do Favorecido Não Informado',
  AP: 'Data Lançamento Inválido',
  AR: 'Valor do Lançamento Inválido',
  AX: 'CEP/Logradouro Favorecido Inválido',
  BB: 'Seu Número Inválido',
  CA: 'Código de Barras / Chave PIX Inválida',
  HA: 'Lote Não Aceito',
  RJ: 'Pagamento Rejeitado pelo Banco / ISPBs Divergentes',
  TA: 'Lote Não Aceito - Totais do Lote com Diferença',
};

function sanitizeAscii(input: string): string {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .toUpperCase();
}

function padField(str: string | number, length: number, char = ' '): string {
  const s = sanitizeAscii(String(str ?? ''));
  if (s.length >= length) return s.substring(0, length);
  return char === '0' ? s.padStart(length, '0') : s.padEnd(length, ' ');
}

function cleanDigits(str?: string | number | null): string {
  return String(str ?? '').replace(/\D/g, '');
}

function formatYyyymmddToDdmmyyyy(isoDate?: string): string {
  const digits = cleanDigits(isoDate);
  if (digits.length >= 8) {
    return `${digits.slice(6, 8)}${digits.slice(4, 6)}${digits.slice(0, 4)}`;
  }
  const now = new Date();
  const d = String(now.getUTCDate()).padStart(2, '0');
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const y = String(now.getUTCFullYear());
  return `${d}${m}${y}`;
}

function resolveBankSpec(bankCode: string): SupportedBankSpec {
  const code = padField(cleanDigits(bankCode) || '001', 3, '0');
  return (
    SUPPORTED_CNAB_BANKS.find((b) => b.code === code) || {
      code,
      name: 'BANCO CONVENIADO',
      layoutVersion: '089',
      lotLayoutVersion: '045',
    }
  );
}

function resolvePixInitiationForm(pixKeyType?: string | null): string {
  switch (String(pixKeyType || '').toUpperCase()) {
    case 'PHONE':
      return '01';
    case 'EMAIL':
      return '02';
    case 'CPF':
    case 'CNPJ':
      return '03';
    case 'EVP':
      return '04';
    default:
      return '03';
  }
}

function resolveLaunchFormCode(method: Cnab240BeneficiaryItem['paymentMethod'], empBank: string, compBank: string): string {
  if (method === 'PIX') return '45'; // PIX Transferência
  if (method === 'POUPANCA') return '05';
  if (method === 'TED' || empBank !== compBank) return '41'; // TED outra titularidade
  return '01'; // Crédito em Conta Corrente/Salário mesmo banco
}

export class Cnab240Engine {
  /**
   * Gera remessa CNAB 240 completa com Lotes separados (CC/TED vs PIX), Segmento A + Segmento B
   * e inclusão automática de pensionistas judiciais (`ALIMONY`).
   */
  public static generateCnab240Remittance(input: Cnab240RemittanceInput): Cnab240RemittanceOutput {
    const spec = resolveBankSpec(input.company.bankCode);
    const bankCode = spec.code;
    const cnpj = padField(cleanDigits(input.company.cnpj), 14, '0');
    const companyName = padField(input.company.corporateName, 30);
    const agreement = padField(input.company.agreementCode || '', 20);
    const agency = padField(cleanDigits(input.company.agency) || '00001', 5, '0');
    const agencyDigit = padField(input.company.agencyDigit || ' ', 1);
    const account = padField(cleanDigits(input.company.accountNumber) || '000000000001', 12, '0');
    const accountDigit = padField(input.company.accountDigit || ' ', 1);
    const dateDdMmYyyy = formatYyyymmddToDdmmyyyy(input.generationDate);
    const seqFile = padField(input.sequentialFileNumber || 1, 6, '0');

    const validBeneficiaries = input.beneficiaries.filter((b) => round2(b.amount) > 0);
    const lines: string[] = [];

    // 1. Header de Arquivo (Registro 0 - exatos 240 chars)
    const headerArquivo =
      bankCode +
      '0000' +
      '0' +
      padField('', 9) +
      '2' +
      cnpj +
      agreement +
      agency +
      agencyDigit +
      account +
      accountDigit +
      ' ' +
      companyName +
      padField(spec.name, 30) +
      padField('', 10) +
      '1' +
      dateDdMmYyyy +
      '120000' +
      seqFile +
      spec.layoutVersion +
      '01600' +
      padField('', 69);
    lines.push(padField(headerArquivo, 240));

    // Agrupa beneficiários por Forma de Lançamento para montar lotes FEBRABAN homogêneos
    const lotsMap = new Map<string, Cnab240BeneficiaryItem[]>();
    for (const item of validBeneficiaries) {
      const empBank = padField(cleanDigits(item.bankCode) || bankCode, 3, '0');
      const launchForm = resolveLaunchFormCode(item.paymentMethod, empBank, bankCode);
      const bucket = lotsMap.get(launchForm) || [];
      bucket.push(item);
      lotsMap.set(launchForm, bucket);
    }

    let lotNumber = 0;
    const outputItems: Cnab240RemittanceOutput['items'] = [];

    for (const [launchForm, lotItems] of lotsMap.entries()) {
      lotNumber += 1;
      const lotStr = padField(lotNumber, 4, '0');

      // 2. Header de Lote (Registro 1)
      const headerLote =
        bankCode +
        lotStr +
        '1' +
        'C' +
        '30' + // Pagamento de Salários
        launchForm +
        spec.lotLayoutVersion +
        ' ' +
        '2' +
        cnpj +
        agreement +
        agency +
        agencyDigit +
        account +
        accountDigit +
        ' ' +
        companyName +
        padField('', 40) +
        padField('', 30) + // Logradouro empresa
        padField('0', 5, '0') +
        padField('', 15) +
        padField('', 20) +
        padField('0', 5, '0') +
        padField('', 3) +
        padField('', 2) +
        '01' + // Forma de pagamento
        padField('', 16);
      lines.push(padField(headerLote, 240));

      let seqInLot = 0;
      let sumLotAmount = 0;

      for (let i = 0; i < lotItems.length; i++) {
        const b = lotItems[i];
        const empBank = padField(cleanDigits(b.bankCode) || bankCode, 3, '0');
        const empAgency = padField(cleanDigits(b.agency) || '00001', 5, '0');
        const empAgencyDigit = padField(b.agencyDigit || ' ', 1);
        const empAccount = padField(cleanDigits(b.accountNumber) || '000000000001', 12, '0');
        const empAccountDigit = padField(b.accountDigit || ' ', 1);
        const payDateStr = formatYyyymmddToDdmmyyyy(b.paymentDate);
        const roundedVal = round2(b.amount);
        sumLotAmount = sumMoney([sumLotAmount, roundedVal]);
        const amountCentsStr = padField(Math.round(roundedVal * 100), 15, '0');
        const yourNumberRaw =
          b.yourNumber || `${b.beneficiaryType === 'ALIMONY' ? 'PEN' : 'SAL'}${lotStr}${String(i + 1).padStart(6, '0')}`;
        const yourNumber = padField(yourNumberRaw, 20);

        outputItems.push({
          itemId: b.id,
          beneficiaryType: b.beneficiaryType,
          yourNumber: yourNumber.trim(),
          amount: roundedVal,
          paymentMethod: b.paymentMethod,
        });

        // 3A. Segmento A (Dados Bancários e Valor)
        seqInLot += 1;
        const segA =
          bankCode +
          lotStr +
          '3' +
          padField(seqInLot, 5, '0') +
          'A' +
          '0' +
          '00' +
          (launchForm === '45' ? '009' : launchForm === '41' ? '018' : '000') +
          empBank +
          empAgency +
          empAgencyDigit +
          empAccount +
          empAccountDigit +
          ' ' +
          padField(b.name, 30) +
          yourNumber +
          payDateStr +
          'BRL' +
          padField('0', 15, '0') +
          amountCentsStr +
          padField('', 20) +
          payDateStr +
          amountCentsStr +
          padField(b.beneficiaryType === 'ALIMONY' ? 'PENSAO JUDICIAL' : 'PAGAMENTO FOLHA', 40) +
          padField(b.paymentMethod === 'SALARIO' ? '01' : '00', 2) +
          padField('00004', 5) + // Finalidade TED/DOC: 00004 Pagamento de Salários
          padField('', 16);
        lines.push(padField(segA, 240));

        // 3B. Segmento B (Obrigatório para TED/PIX/CPF do Favorecido)
        seqInLot += 1;
        const cleanCpf = padField(cleanDigits(b.cpf), 14, '0');
        const isPix = b.paymentMethod === 'PIX';
        const subType = isPix ? resolvePixInitiationForm(b.pixKeyType) : '   ';
        const segB =
          bankCode +
          lotStr +
          '3' +
          padField(seqInLot, 5, '0') +
          'B' +
          subType +
          '1' + // 1 = CPF
          cleanCpf +
          (isPix
            ? padField(b.pixKey || cleanDigits(b.cpf), 99) + padField('', 85)
            : padField('', 35) +
              padField('', 30) +
              padField('0', 5, '0') +
              padField('', 15) +
              padField('', 15) +
              padField('', 20) +
              padField('0', 8, '0') +
              padField('', 2) +
              padField('', 44));
        lines.push(padField(segB, 240));
      }

      // 4. Trailer de Lote (Registro 5)
      const recordsInLot = seqInLot + 2; // Header Lote + Segmentos + Trailer Lote
      const sumLotCentsStr = padField(Math.round(sumLotAmount * 100), 18, '0');
      const trailerLote =
        bankCode +
        lotStr +
        '5' +
        padField('', 9) +
        padField(recordsInLot, 6, '0') +
        sumLotCentsStr +
        padField('0', 18, '0') +
        padField('0', 6, '0') +
        padField('', 175);
      lines.push(padField(trailerLote, 240));
    }

    // 5. Trailer de Arquivo (Registro 9)
    const totalLines = lines.length + 1;
    const trailerArquivo =
      bankCode +
      '9999' +
      '9' +
      padField('', 9) +
      padField(lotNumber, 6, '0') +
      padField(totalLines, 6, '0') +
      padField('0', 6, '0') +
      padField('', 205);
    lines.push(padField(trailerArquivo, 240));

    return {
      bankCode,
      bankName: spec.name,
      content: lines.join('\r\n') + '\r\n',
      totalLines,
      totalLots: lotNumber,
      totalAmount: sumMoney(validBeneficiaries.map((b) => round2(b.amount))),
      employeesCount: validBeneficiaries.filter((b) => b.beneficiaryType === 'EMPLOYEE').length,
      alimonyCount: validBeneficiaries.filter((b) => b.beneficiaryType === 'ALIMONY').length,
      items: outputItems,
    };
  }

  /**
   * Processa arquivo de retorno CNAB 240 (.ret), lendo registros de detalhe Segmento A
   * e devolvendo conciliação linha a linha por `yourNumber` e código de ocorrência FEBRABAN.
   */
  public static parseCnab240Return(content: string): Cnab240ReturnParseResult {
    const rawLines = String(content || '')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);

    let bankCode = '001';
    const entries: Cnab240ReturnEntry[] = [];

    for (const rawLine of rawLines) {
      const line = padField(rawLine, 240);
      const recType = line.slice(7, 8);
      if (recType === '0') {
        bankCode = line.slice(0, 3);
        continue;
      }
      if (recType !== '3') continue;
      const segment = line.slice(13, 14);
      if (segment !== 'A') continue;

      const yourNumber = line.slice(73, 93).trim();
      const rawDate = line.slice(154, 162).trim();
      const paymentDate =
        rawDate.length === 8
          ? `${rawDate.slice(4, 8)}-${rawDate.slice(2, 4)}-${rawDate.slice(0, 2)}`
          : '';
      const rawAmountCents = Number(line.slice(162, 177)) || Number(line.slice(119, 134)) || 0;
      const paidAmount = round2(rawAmountCents / 100);
      const occurrenceRaw = line.slice(230, 240).trim();

      const occurrenceCodes: string[] = [];
      for (let i = 0; i < occurrenceRaw.length; i += 2) {
        const code = occurrenceRaw.slice(i, i + 2).trim();
        if (code) occurrenceCodes.push(code);
      }

      const isPaid =
        occurrenceCodes.length === 0 ||
        occurrenceCodes.some((c) => c === '00' || c === 'BD' || c === 'BE');

      const messages = occurrenceCodes.map(
        (c) => `${c}: ${FEBRABAN_OCCURRENCE_MAP[c] || 'Ocorrência bancária'}`
      );

      entries.push({
        yourNumber,
        occurrenceRaw,
        occurrenceCodes,
        status: isPaid ? 'PAID' : 'REJECTED',
        occurrenceMessage: messages.join(' | ') || 'Processado sem ocorrências',
        paidAmount,
        paymentDate,
      });
    }

    const paidEntries = entries.filter((e) => e.status === 'PAID');
    return {
      bankCode,
      totalEntries: entries.length,
      paidCount: paidEntries.length,
      rejectedCount: entries.length - paidEntries.length,
      totalPaidAmount: sumMoney(paidEntries.map((e) => e.paidAmount)),
      entries,
    };
  }
}
