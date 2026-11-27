import { describe, expect, it } from 'vitest';
import { TerminationOrchestrator, type UnifiedTerminationInput } from '../src/engine/TerminationOrchestrator.js';

const inss2026 = [
  { bracket_number: 1, base_limit: 1518.0, aliquot: 7.5, deduction: 0 },
  { bracket_number: 2, base_limit: 2793.88, aliquot: 9.0, deduction: 0 },
  { bracket_number: 3, base_limit: 4190.83, aliquot: 12.0, deduction: 0 },
  { bracket_number: 4, base_limit: 8157.41, aliquot: 14.0, deduction: 0 },
];

const irrf2026 = [
  { bracket_number: 1, base_limit: 2259.2, aliquot: 0, deduction: 0 },
  { bracket_number: 2, base_limit: 2826.65, aliquot: 7.5, deduction: 169.44 },
  { bracket_number: 3, base_limit: 3751.05, aliquot: 15.0, deduction: 381.44 },
  { bracket_number: 4, base_limit: 4664.68, aliquot: 22.5, deduction: 662.77 },
  { bracket_number: 5, base_limit: null, aliquot: 27.5, deduction: 896.0 },
];

const params2026 = {
  minimum_wage: 1518.0,
  dependent_deduction: 189.59,
  simplified_discount: 564.8,
  fgts_standard_aliquot: 8.0,
  fgts_apprentice_aliquot: 2.0,
  irrf_exemption_limit: 5000.0,
  irrf_reduction_formula_limit: 7350.0,
  irrf_reduction_a: 978.62,
  irrf_reduction_b: 0.133145,
};

function baseInput(overrides: Partial<UnifiedTerminationInput> = {}): UnifiedTerminationInput {
  return {
    contractId: 'c-001',
    baseSalary: 3000,
    admissionDate: '2021-01-10',
    resignationDate: '2026-06-15',
    dismissalType: 'WITHOUT_CAUSE',
    noticeType: 'INDEMNIFIED',
    fgtsBalancePrior: 10000,
    inssParameters: inss2026,
    irrfParameters: irrf2026,
    generalLegalParameters: params2026,
    ...overrides,
  };
}

describe('FOLHA-13: TerminationOrchestrator (10 Cenários Dourados de TRCT + Complementar)', () => {
  it('Cenário 1: Demissão Sem Justa Causa com Aviso Misto (NT 184/2012 MTE: 30d trab + anos*3 indenizados)', () => {
    const res = TerminationOrchestrator.calculate(
      baseInput({
        admissionDate: '2021-01-10',
        resignationDate: '2026-06-15', // 5 anos completos -> 30 + 15 = 45d (30 trabalhados + 15 indenizados)
        noticeType: 'MIXED',
      })
    );

    expect(res.esocialReasonCode).toBe('02');
    expect(res.metadados.diasAvisoTrabalhado).toBe(30);
    expect(res.metadados.diasAvisoIndenizado).toBe(15);
    expect(res.proventos.avisoIndenizado.valor).toBe(1500);
    expect(res.metadados.dataProjetada).toBe('2026-06-30');
    expect(res.encargos.percentualMulta).toBe(0.4);
    expect(res.payslip.items.some((i) => i.amount === 1500)).toBe(true);
  });

  it('Cenário 2: Pedido de Demissão com Aviso Indenizado desconta 30 dias e 0% multa FGTS', () => {
    const res = TerminationOrchestrator.calculate(
      baseInput({
        dismissalType: 'RESIGNATION',
        noticeType: 'INDEMNIFIED',
      })
    );

    expect(res.esocialReasonCode).toBe('07');
    expect(res.descontos.avisoDescontado.dias).toBe(30);
    expect(res.descontos.avisoDescontado.valor).toBe(3000);
    expect(res.encargos.multaFGTS).toBe(0);
  });

  it('Cenário 3: Acordo Trabalhista Art. 484-A (50% aviso indenizado + 20% multa FGTS)', () => {
    const res = TerminationOrchestrator.calculate(
      baseInput({
        admissionDate: '2024-01-10',
        resignationDate: '2026-06-15', // 2 anos completos -> 36d * 50% = R$ 1.800,00
        dismissalType: 'MUTUAL_AGREEMENT',
        noticeType: 'INDEMNIFIED',
      })
    );

    expect(res.esocialReasonCode).toBe('33');
    expect(res.proventos.avisoIndenizado.dias).toBe(36);
    expect(res.proventos.avisoIndenizado.valor).toBe(1800);
    expect(res.encargos.percentualMulta).toBe(0.2);
  });

  it('Cenário 4: Justa Causa zera férias proporcionais e 13º proporcional, mas mantém férias vencidas e dobro Art. 137', () => {
    const res = TerminationOrchestrator.calculate(
      baseInput({
        dismissalType: 'WITH_CAUSE',
        noticeType: 'NONE',
        vacationPeriods: [
          {
            acquisition_start: '2024-01-10',
            acquisition_end: '2025-01-09',
            concessive_end: '2026-01-09', // já vencido antes de 2026-06-15 -> dobro!
            days_remaining: 30,
            status: 'OPEN',
          },
        ],
      })
    );

    expect(res.esocialReasonCode).toBe('01');
    expect(res.proventos.decimoTerceiro.valor).toBe(0);
    expect(res.proventos.feriasProporcionais.valor).toBe(0);
    expect(res.proventos.feriasVencidas.valor).toBe(3000);
    expect(res.proventos.feriasDobro.valor).toBe(3000);
    expect(res.proventos.umTercoFerias.valor).toBe(2000); // 1/3 de (3000 + 3000)
  });

  it('Cenário 5: Quebra Antecipada de Contrato de Experiência pelo Empregador (Art. 479 CLT: 50% dias restantes)', () => {
    const res = TerminationOrchestrator.calculate(
      baseInput({
        admissionDate: '2026-05-01',
        resignationDate: '2026-06-10',
        contractEndDate: '2026-07-30', // 50 dias restantes -> metade = 25 dias = R$ 2.500,00
        dismissalType: 'EARLY_TERMINATION_EMPLOYER',
        noticeType: 'NONE',
      })
    );

    expect(res.esocialReasonCode).toBe('04');
    expect(res.proventos.indenizacaoArt479.diasRestantes).toBe(50);
    expect(res.proventos.indenizacaoArt479.valor).toBe(2500);
  });

  it('Cenário 6: Falecimento do Empregado (Código 10 eSocial: férias e 13º proporcionais sem aviso nem multa)', () => {
    const res = TerminationOrchestrator.calculate(
      baseInput({
        dismissalType: 'DEATH',
        noticeType: 'NONE',
      })
    );

    expect(res.esocialReasonCode).toBe('10');
    expect(res.proventos.decimoTerceiro.avos).toBe(6);
    expect(res.proventos.decimoTerceiro.valor).toBe(1500);
    expect(res.proventos.avisoIndenizado.valor).toBe(0);
    expect(res.encargos.multaFGTS).toBe(0);
  });

  it('Cenário 7: Culpa Recíproca (Código 14: 50% aviso, 50% 13º prop., 50% férias prop. + 20% multa FGTS)', () => {
    const res = TerminationOrchestrator.calculate(
      baseInput({
        admissionDate: '2026-01-01',
        resignationDate: '2026-06-15',
        dismissalType: 'RECIPROCAL_FAULT',
        noticeType: 'INDEMNIFIED',
      })
    );

    expect(res.esocialReasonCode).toBe('14');
    expect(res.proventos.avisoIndenizado.valor).toBe(1500); // 50% de 3000
    expect(res.encargos.percentualMulta).toBe(0.2);
  });

  it('Cenário 8: Indenização Adicional Art. 9º Lei 7.238/84 quando projeção do aviso cai nos 30d antes da data-base', () => {
    // Data-base Outubro (01/10/2026) -> Trintídio: 01/09/2026..30/09/2026.
    // Demissão em 25/08/2026 com aviso de 30d -> projeção 24/09/2026 (dentro do trintídio!)
    const res = TerminationOrchestrator.calculate(
      baseInput({
        admissionDate: '2025-10-10',
        resignationDate: '2026-08-25',
        unionBaseMonth: 10,
      })
    );

    expect(res.metadados.dataProjetada).toBe('2026-09-24');
    expect(res.proventos.indenizacaoArt9.aplicada).toBe(true);
    expect(res.proventos.indenizacaoArt9.valor).toBe(3000);
  });

  it('Cenário 9: Quitação de Banco de Horas Positivo (50%) + Teto de Descontos Art. 477 §5º CLT (máx 1 remuneração)', () => {
    const res = TerminationOrchestrator.calculate(
      baseInput({
        baseSalary: 2200, // R$ 10/h * 1.5 = R$ 15/h
        timeBankPositiveHours: 20, // 20h * 15 = R$ 300,00
        dismissalType: 'RESIGNATION',
        noticeType: 'INDEMNIFIED', // desconta 2200
        outrosDescontos: 1500, // soma não tributária = 3700 > teto 2200!
      })
    );

    expect(res.proventos.quitacaoBancoHoras.valor).toBe(300);
    expect(res.descontos.tetoArt477Aplicado).toBe(true);
    expect(res.descontos.excessoDescontoLimitado).toBe(1500);
    expect(res.descontos.avisoDescontado.valor + res.descontos.outros.valor).toBe(2200);
  });

  it('Cenário 10: Rescisão Complementar apura diferença exata de dissídio pós-desligamento sem dupla cobrança', () => {
    const origInput = baseInput({ baseSalary: 3000 });
    const orig = TerminationOrchestrator.calculate(origInput);

    const comp = TerminationOrchestrator.calculateComplementary({
      originalOutput: orig,
      updatedInput: baseInput({ baseSalary: 3300 }), // +10% dissídio retroativo
      reason: 'Dissídio Coletivo 10%',
    });

    expect(comp.diffGross).toBeGreaterThan(0);
    expect(comp.diffNetPayable).toBeGreaterThan(0);
    expect(comp.diffFgtsDeposit).toBeGreaterThan(0);
    expect(comp.diffFgtsFine).toBeGreaterThan(0);
    expect(comp.payslip.total_earnings).toBe(comp.diffGross);
    expect(comp.payslip.net_salary).toBe(comp.diffNetPayable);
  });
});
