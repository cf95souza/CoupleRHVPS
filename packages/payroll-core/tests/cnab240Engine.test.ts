import { describe, expect, it } from 'vitest';
import { Cnab240Engine } from '../src/accounting/Cnab240Engine.js';

describe('CONT-04: Cnab240Engine (Multi-Banco, Segmentos A+B, PIX, Pensão e Retorno .ret)', () => {
  it('gera remessa CNAB 240 com exatamente 240 colunas por linha, lotes CC + PIX e inclusão de pensionista', () => {
    const out = Cnab240Engine.generateCnab240Remittance({
      company: {
        corporateName: 'CONSTRUTORA MODELO S.A.',
        cnpj: '12.345.678/0001-90',
        bankCode: '341', // Itaú
        agency: '1234',
        accountNumber: '567890',
        accountDigit: '1',
      },
      generationDate: '2026-08-31',
      sequentialFileNumber: 12,
      beneficiaries: [
        {
          id: 'emp-1',
          beneficiaryType: 'EMPLOYEE',
          name: 'João da Silva Ávila',
          cpf: '11122233344',
          paymentMethod: 'CC',
          bankCode: '341',
          agency: '1234',
          accountNumber: '111222',
          accountDigit: '3',
          amount: 3500.5,
          paymentDate: '2026-09-04',
          yourNumber: 'SAL001',
        },
        {
          id: 'pen-1',
          beneficiaryType: 'ALIMONY',
          name: 'Maria Pensionista Souza',
          cpf: '55566677788',
          paymentMethod: 'PIX',
          pixKey: '55566677788',
          pixKeyType: 'CPF',
          amount: 750.25,
          paymentDate: '2026-09-04',
          yourNumber: 'PEN001',
        },
      ],
    });

    expect(out.bankCode).toBe('341');
    expect(out.totalLots).toBe(2); // Lote 1 CC + Lote 2 PIX
    expect(out.employeesCount).toBe(1);
    expect(out.alimonyCount).toBe(1);
    expect(out.totalAmount).toBe(4250.75);

    const lines = out.content.split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(out.totalLines);
    for (const line of lines) {
      expect(line.length).toBe(240);
    }

    // Valida presença de Segmentos A e B com CPF e chave PIX sem acentos
    const segALines = lines.filter((l) => l[7] === '3' && l[13] === 'A');
    const segBLines = lines.filter((l) => l[7] === '3' && l[13] === 'B');
    expect(segALines).toHaveLength(2);
    expect(segBLines).toHaveLength(2);
    expect(segALines[0]).toContain('JOAO DA SILVA AVILA');
    expect(segBLines[1]).toContain('55566677788');
  });

  it('lê arquivo de retorno .ret conciliando pagamentos efetivados (00) e rejeitados (RJ)', () => {
    const generated = Cnab240Engine.generateCnab240Remittance({
      company: {
        corporateName: 'EMPRESA RETORNO LTDA',
        cnpj: '12345678000190',
        bankCode: '001',
        agency: '0001',
        accountNumber: '10000',
      },
      beneficiaries: [
        {
          id: 'e1',
          beneficiaryType: 'EMPLOYEE',
          name: 'Colaborador Pago',
          cpf: '11111111111',
          paymentMethod: 'CC',
          bankCode: '001',
          amount: 2000,
          paymentDate: '2026-09-04',
          yourNumber: 'EMP-OK-01',
        },
        {
          id: 'e2',
          beneficiaryType: 'ALIMONY',
          name: 'Pensionista Rejeitada',
          cpf: '22222222222',
          paymentMethod: 'TED',
          bankCode: '237',
          amount: 500,
          paymentDate: '2026-09-04',
          yourNumber: 'PEN-ERR-02',
        },
      ],
    });

    // Injeta códigos de ocorrência FEBRABAN nas posições 231..240 dos Segmentos A
    const mutatedLines = generated.content.split(/\r?\n/).filter(Boolean).map((line) => {
      if (line[7] === '3' && line[13] === 'A') {
        if (line.includes('EMP-OK-01')) return line.slice(0, 230) + '00        ';
        if (line.includes('PEN-ERR-02')) return line.slice(0, 230) + 'AN        '; // Conta inválida
      }
      return line;
    });

    const parsed = Cnab240Engine.parseCnab240Return(mutatedLines.join('\r\n'));
    expect(parsed.totalEntries).toBe(2);
    expect(parsed.paidCount).toBe(1);
    expect(parsed.rejectedCount).toBe(1);
    expect(parsed.totalPaidAmount).toBe(2000);
    expect(parsed.entries[0].status).toBe('PAID');
    expect(parsed.entries[1].status).toBe('REJECTED');
    expect(parsed.entries[1].occurrenceCodes).toContain('AN');
  });
});
