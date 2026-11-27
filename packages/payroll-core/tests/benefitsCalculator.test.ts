import { describe, it, expect } from 'vitest';
import { BenefitsCalculator } from '../src/legal/BenefitsCalculator';

describe('BenefitsCalculator - Benefícios Enterprise (FOLHA-08)', () => {
  describe('Vale-Transporte (Lei 7.418/1985 e Decreto 10.854/2021)', () => {
    it('deve limitar o desconto ao teto de 6% do salário quando o custo efetivo for superior', () => {
      // Salário R$ 2.000, 22 dias úteis, 2 passes/dia a R$ 4,50 = 44 * 4.5 = R$ 198,00 custo VT
      // 6% de R$ 2.000 = R$ 120,00
      const result = BenefitsCalculator.calculateTransportationVoucher({
        baseSalary: 2000,
        workingDaysInMonth: 22,
        dailyPasses: 2,
        passUnitValue: 4.5,
      });

      expect(result.effectivePresentialDays).toBe(22);
      expect(result.totalConcededCost).toBe(198);
      expect(result.legalCap6Percent).toBe(120);
      expect(result.vtDiscount).toBe(120);
      expect(result.companySubsidy).toBe(78);
      expect(result.isCapApplied).toBe(true);
      expect(result.formulaDescription).toContain('TETO 6% APLICADO');
    });

    it('deve descontar apenas o custo efetivo dos passes quando for menor que o teto de 6%', () => {
      // Salário R$ 5.000, 20 dias úteis, 2 passes/dia a R$ 4,00 = 40 * 4 = R$ 160,00
      // 6% de R$ 5.000 = R$ 300,00
      const result = BenefitsCalculator.calculateTransportationVoucher({
        baseSalary: 5000,
        workingDaysInMonth: 20,
        dailyPasses: 2,
        passUnitValue: 4.0,
      });

      expect(result.totalConcededCost).toBe(160);
      expect(result.legalCap6Percent).toBe(300);
      expect(result.vtDiscount).toBe(160);
      expect(result.companySubsidy).toBe(0);
      expect(result.isCapApplied).toBe(false);
      expect(result.formulaDescription).toContain('CUSTO EFETIVO CONCEDIDO MENOR QUE O TETO 6%');
    });

    it('deve aplicar proporcionalidade exata em caso de férias, faltas e regime híbrido de trabalho', () => {
      // 22 dias úteis no mês, 10 dias de férias e 2 dias de falta/licença -> 10 dias úteis disponíveis
      // Regime HYBRID com 2 dias remotos por semana: ratio presencial = (5 - 2) / 5 = 0.6
      // Dias presenciais = 10 * 0.6 = 6 dias presenciais
      // Passes = 6 * 2 * R$ 5,00 = R$ 60,00
      // Salário R$ 3.000 -> 6% = R$ 180,00 -> Desconto deve ser R$ 60,00
      const result = BenefitsCalculator.calculateTransportationVoucher({
        baseSalary: 3000,
        workingDaysInMonth: 22,
        vacationDays: 10,
        absenceOrLeaveDays: 2,
        workRegime: 'HYBRID',
        weeklyRemoteDays: 2,
        dailyPasses: 2,
        passUnitValue: 5.0,
      });

      expect(result.effectivePresentialDays).toBe(6);
      expect(result.totalConcededCost).toBe(60);
      expect(result.legalCap6Percent).toBe(180);
      expect(result.vtDiscount).toBe(60);
      expect(result.companySubsidy).toBe(0);
    });

    it('deve zerar concessão e desconto se o colaborador renunciou (opt-out) ou trabalha em regime 100% remoto', () => {
      const optOut = BenefitsCalculator.calculateTransportationVoucher({
        baseSalary: 4000,
        workingDaysInMonth: 22,
        passUnitValue: 5.0,
        optIn: false,
      });
      expect(optOut.vtDiscount).toBe(0);
      expect(optOut.totalConcededCost).toBe(0);
      expect(optOut.formulaDescription).toContain('VT_OPT_OUT');

      const remote = BenefitsCalculator.calculateTransportationVoucher({
        baseSalary: 4000,
        workingDaysInMonth: 22,
        workRegime: 'REMOTE',
        passUnitValue: 5.0,
      });
      expect(remote.vtDiscount).toBe(0);
      expect(remote.totalConcededCost).toBe(0);
      expect(remote.formulaDescription).toContain('VT_REMOTE');
    });
  });

  describe('Planos de Saúde e Odontológico (ANS / Lei 9.656/1998)', () => {
    it('deve ratear o custo entre titular e dependentes com código ANS e subsídios', () => {
      const result = BenefitsCalculator.calculateHealthOrDentalPlan({
        ansCode: '417892',
        holderMonthlyCost: 650,
        holderSubsidyAmount: 400, // Empresa paga R$ 400, colaborador paga R$ 250
        dependents: [
          {
            dependentName: 'Lucas Silva',
            relationship: 'CHILD',
            monthlyCost: 320,
            companySubsidy: 120, // Colaborador paga R$ 200
          },
          {
            dependentName: 'Juliana Silva',
            relationship: 'SPOUSE',
            monthlyCost: 480,
            employeeDiscount: 480, // Colaborador paga 100%
          },
        ],
      });

      expect(result.ansCode).toBe('417892');
      expect(result.holderDiscount).toBe(250);
      expect(result.holderSubsidy).toBe(400);
      expect(result.dependentsDiscount).toBe(680); // 200 + 480
      expect(result.dependentsSubsidy).toBe(120);
      expect(result.totalEmployeeDiscount).toBe(930); // 250 + 680
      expect(result.totalCompanySubsidy).toBe(520); // 400 + 120
      expect(result.dependentsBreakdown).toHaveLength(2);
    });
  });

  describe('Coparticipação em Consultas/Exames (Importação CSV de Faturas)', () => {
    it('deve consolidar coparticipações por tipo de benefício separando saúde e odonto', () => {
      const summary = BenefitsCalculator.aggregateCopayments([
        {
          id: '1',
          benefitType: 'HEALTH_PLAN',
          patientType: 'HOLDER',
          patientName: 'Carlos Ferreira',
          procedureDate: '2026-08-05',
          procedureDescription: 'Consulta Médica Especializada',
          copayAmount: 45.0,
        },
        {
          id: '2',
          benefitType: 'HEALTH_PLAN',
          patientType: 'DEPENDENT',
          patientName: 'Lucas Ferreira',
          procedureDate: '2026-08-10',
          procedureDescription: 'Hemograma Completo com Plaquetas',
          copayAmount: 35.5,
        },
        {
          id: '3',
          benefitType: 'DENTAL_PLAN',
          patientType: 'HOLDER',
          patientName: 'Carlos Ferreira',
          procedureDate: '2026-08-15',
          procedureDescription: 'Profilaxia e Aplicação de Flúor',
          copayAmount: 60.0,
        },
      ]);

      expect(summary.itemsCount).toBe(3);
      expect(summary.healthCopayTotal).toBe(80.5); // 45 + 35.5
      expect(summary.dentalCopayTotal).toBe(60.0);
      expect(summary.otherCopayTotal).toBe(0);
      expect(summary.totalCopayDiscount).toBe(140.5);
    });
  });
});
