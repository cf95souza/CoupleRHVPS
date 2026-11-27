import { describe, expect, it } from 'vitest';
import { IncomeReportEngine } from '../src/accounting/IncomeReportEngine.js';

describe('CONT-05: IncomeReportEngine (Informe de Rendimentos RFB Quadros 1 a 7)', () => {
  it('consolida Quadros 1 a 7 RFB com 13º líquido, RRA Art. 12-A, pensão por beneficiário e saúde ANS', () => {
    const report = IncomeReportEngine.buildAnnualIncomeReport({
      calendarYear: 2026,
      company: { cnpj: '12.345.678/0001-90', corporateName: 'Empresa Enterprise S.A.' },
      worker: { cpf: '111.222.333-44', fullName: 'Carlos Alberto Nogueira' },
      monthlyTaxableEarnings: 72000,
      officialSocialSecurityInss: 7800,
      privatePension: 1200,
      alimonyTotal: 9600,
      irrfMonthlyWithheld: 4500,
      exemptVacationAbono: 2000,
      exemptDoubleVacation: 0,
      exemptFamilySalary: 360,
      thirteenthGrossTaxable: 6000,
      thirteenthInss: 650,
      thirteenthAlimony: 800,
      thirteenthIrrf: 350,
      plrTotal: 4000,
      plrIrrf: 150,
      rraProcessNumber: 'ACT-2026-TST',
      rraMonthsCount: 12,
      rraTaxableAmount: 18000,
      rraInssDeduction: 1500,
      rraAlimonyDeduction: 0,
      rraIrrfWithheld: 220,
      alimonyDetails: [
        {
          beneficiaryName: 'Ana Clara Nogueira',
          beneficiaryCpf: '99988877766',
          beneficiaryBirthDate: '2015-04-10',
          totalAmount: 9600,
        },
      ],
      healthPlanDetails: [
        {
          operatorName: 'Unimed Nacional',
          operatorCnpj: '02812468000106',
          ansCode: '339679',
          beneficiaryType: 'HOLDER',
          beneficiaryName: 'Carlos Alberto Nogueira',
          beneficiaryCpf: '11122233344',
          totalAmount: 2400,
        },
        {
          operatorName: 'Unimed Nacional',
          operatorCnpj: '02812468000106',
          ansCode: '339679',
          beneficiaryType: 'DEPENDENT',
          beneficiaryName: 'Ana Clara Nogueira',
          beneficiaryCpf: '99988877766',
          totalAmount: 1200,
        },
      ],
    });

    expect(report.quadro3Tributaveis.totalRendimentos).toBe(72000);
    // Quadro 5 linha 01: 6000 - 650 - 800 - 350 = 4200
    expect(report.quadro5Exclusiva.decimoTerceiroLiquidoQuadro).toBe(4200);
    expect(report.quadro4Isentos.totalIsentos).toBe(2360);
    expect(report.quadro6Rra.quantidadeMeses).toBe(12);
    expect(report.quadro6Rra.impostoRetidoFonte).toBe(220);
    expect(report.quadro7Complementares.textoComplementar).toHaveLength(3);

    const html = IncomeReportEngine.renderIncomeReportHtml(report);
    expect(html).toContain('6. RENDIMENTOS RECEBIDOS ACUMULADAMENTE - RRA');
    expect(html).toContain('Ana Clara Nogueira');
    expect(html).toContain('ANS 339679');
  });
});
