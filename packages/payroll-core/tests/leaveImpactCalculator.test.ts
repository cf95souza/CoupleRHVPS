import { describe, it, expect } from 'vitest';
import {
  LeaveImpactCalculator,
  calculateThirteenthAvos,
  aggregateCompanyBases,
  calculateConsolidatedEmployerTaxes,
  computeWorkAccidentStabilityDate,
  resolveCanonicalLeaveCategory,
} from '../src/index.js';

describe('FOLHA-04: Integração Completa de Afastamentos (Tabela 18 eSocial)', () => {
  it('1. Auxílio-Doença (03): aplica 15d empresa + soma automática de atestados com mesma CID em 60 dias + INSS a partir do 16º dia', () => {
    const impact = LeaveImpactCalculator.calculatePeriodImpact({
      leaves: [
        {
          id: 'l-1',
          leave_type: 'SICK_LEAVE',
          esocial_reason_code: '03',
          cid10_code: 'M54',
          start_date: '2026-11-01',
          end_date: '2026-11-10', // 10 dias pagos pela empresa
          status: 'ACTIVE',
        },
        {
          id: 'l-2',
          leave_type: 'SICK_LEAVE',
          esocial_reason_code: '03',
          cid10_code: 'm54 ', // mesma CID com retorno dentro de 60 dias!
          start_date: '2026-11-20',
          end_date: '2026-11-29', // 10 dias -> só 5 restantes empresa + 5 INSS!
          status: 'ACTIVE',
        },
      ],
      periodYear: 2026,
      periodMonth: 11,
      baseEligibleDays: 30,
      baseSalary: 6000,
    });

    expect(impact.sameCidAggregatedCount).toBe(1);
    expect(impact.companyPaidSickDays).toBe(15); // 10 + 5 = 15 dias empresa
    expect(impact.inssPaidDays).toBe(5);         // 5 dias pelo INSS (>= 16º dia)
    expect(impact.workedSalaryDays).toBe(10);    // 30 - 15 - 5 = 10 dias trabalhados
    expect(impact.fgtsCompulsoryLeaveDays).toBe(0); // Auxílio-doença comum NÃO mantém FGTS após 15º dia
  });

  it('2. Acidente de Trabalho (01/B91): mantém FGTS obrigatório durante TODO o afastamento INSS e apura estabilidade de 12 meses (Art. 118 Lei 8.213/91)', () => {
    const accidentLeave = {
      id: 'l-b91',
      leave_type: 'WORK_ACCIDENT',
      esocial_reason_code: '01',
      cid10_code: 'S62',
      start_date: '2026-10-01',
      end_date: '2026-11-30', // 61 dias (>15d), Novembro 100% pelo INSS
      return_date: '2026-12-01',
      status: 'ACTIVE',
    };

    const impactNov = LeaveImpactCalculator.calculatePeriodImpact({
      leaves: [accidentLeave],
      periodYear: 2026,
      periodMonth: 11,
      baseEligibleDays: 30,
      baseSalary: 4500,
    });

    expect(impactNov.workedSalaryDays).toBe(0);
    expect(impactNov.companyPaidSickDays).toBe(0);
    expect(impactNov.inssPaidDays).toBe(30);
    expect(impactNov.fgtsCompulsoryLeaveDays).toBe(30); // FGTS 100% mantido!
    expect(impactNov.stabilityUntil).toBe('2027-12-01');
    expect(impactNov.hasActiveWorkAccidentStability).toBe(true);
    expect(computeWorkAccidentStabilityDate(accidentLeave)).toBe('2027-12-01');
  });

  it('3. Licença-Maternidade (17): 120d dedutíveis automaticamente na DCTFWeb vs prorrogação Empresa Cidadã 121-180d sem abatimento DCTFWeb', () => {
    // Mês dentro dos primeiros 120 dias (ex: início 01/11, 30 dias em Novembro)
    const impact120 = LeaveImpactCalculator.calculatePeriodImpact({
      leaves: [
        {
          id: 'l-mat',
          leave_type: 'MATERNITY',
          esocial_reason_code: '17',
          start_date: '2026-11-01',
          end_date: '2027-04-29', // 180 dias (Empresa Cidadã)
          is_extended_maternity: true,
          status: 'ACTIVE',
        },
      ],
      periodYear: 2026,
      periodMonth: 11,
      baseEligibleDays: 30,
      baseSalary: 5000,
    });

    expect(impact120.workedSalaryDays).toBe(0);
    expect(impact120.maternityDeductibleDays).toBe(30);
    expect(impact120.maternityExtendedDays).toBe(0);
    expect(impact120.maternityDctfWebDeductibleAmount).toBe(5000);

    // Mês 100% na prorrogação (Abril/2027: dias 152..180)
    const impactExt = LeaveImpactCalculator.calculatePeriodImpact({
      leaves: [
        {
          id: 'l-mat',
          leave_type: 'MATERNITY',
          esocial_reason_code: '17',
          start_date: '2026-11-01',
          end_date: '2027-04-29',
          is_extended_maternity: true,
          status: 'ACTIVE',
        },
      ],
      periodYear: 2027,
      periodMonth: 4,
      baseEligibleDays: 30,
      baseSalary: 5000,
    });

    expect(impactExt.maternityDeductibleDays).toBe(0);
    expect(impactExt.maternityExtendedDays).toBe(29);
    expect(impactExt.maternityDctfWebDeductibleAmount).toBe(0);

    // Agrega DCTFWeb em CompanyTaxesAggregator
    const totals = aggregateCompanyBases({
      calculatedPayslips: [
        {
          contract_id: 'c1',
          base_inss: 5000,
          base_fgts: 5000,
          fgts_month: 400,
          inss_employee: 511.82,
          maternity_deduction: impact120.maternityDctfWebDeductibleAmount,
        },
      ],
      contractCompanyMap: { c1: 'comp-1' },
    });

    const compTaxes = calculateConsolidatedEmployerTaxes({
      tenant_id: 't1',
      period_id: 'p1',
      companyTotals: totals,
      companies: [{ id: 'comp-1', tax_regime: 'LUCRO_REAL' }],
    });

    // Patronal 20% (1000) + RAT 2% (100) + Terceiros 5.8% (290) + Segurados (511.82) = 1901.82 - 5000 = 0 líquido na DCTFWeb!
    expect(compTaxes[0].maternity_deduction).toBe(5000);
    expect(compTaxes[0].net_inss_due).toBe(0);
  });

  it('4. Serviço Militar (19) mantém FGTS obrigatório e Licença sem Vencimentos (21) suspende remuneração e avos de 13º', () => {
    const milImpact = LeaveImpactCalculator.calculatePeriodImpact({
      leaves: [
        {
          id: 'l-mil',
          leave_type: 'MILITARY_SERVICE',
          esocial_reason_code: '19',
          start_date: '2026-11-01',
          end_date: '2026-11-30',
          status: 'ACTIVE',
        },
      ],
      periodYear: 2026,
      periodMonth: 11,
      baseEligibleDays: 30,
      baseSalary: 3000,
    });
    expect(milImpact.workedSalaryDays).toBe(0);
    expect(milImpact.unpaidLeaveDays).toBe(30);
    expect(milImpact.fgtsCompulsoryLeaveDays).toBe(30);

    const unpaidImpact = LeaveImpactCalculator.calculatePeriodImpact({
      leaves: [
        {
          id: 'l-unp',
          leave_type: 'UNPAID_LEAVE',
          esocial_reason_code: '21',
          start_date: '2026-11-01',
          end_date: '2026-11-20',
          status: 'ACTIVE',
        },
      ],
      periodYear: 2026,
      periodMonth: 11,
      baseEligibleDays: 30,
      baseSalary: 3000,
    });
    expect(unpaidImpact.workedSalaryDays).toBe(10);
    expect(unpaidImpact.unpaidLeaveDays).toBe(20);
    expect(unpaidImpact.fgtsCompulsoryLeaveDays).toBe(0);
  });

  it('5. Reflexo em 13º Salário: Auxílio-Doença INSS reduz avos (<15d no mês), enquanto Licença-Maternidade preserva 12/12 avos', () => {
    // Caso A: Auxílio-Doença de 01/05 a 31/08 (Maio: 15d empresa + 16d INSS = 15d empresa -> mantém Maio; Jun/Jul/Ago: INSS integral -> perde 3 avos = 9/12!)
    const sickLeaves = [
      {
        id: 'l-sick-year',
        leave_type: 'SICK_LEAVE',
        esocial_reason_code: '03',
        start_date: '2026-05-01',
        end_date: '2026-08-31',
        status: 'ACTIVE',
      },
    ];
    const nonCreditedSick = LeaveImpactCalculator.getMonthlyLeaveNonCreditedDaysForThirteenth(sickLeaves, 2026, 12);
    const avosSick = calculateThirteenthAvos('2024-01-10', 2026, 12, {}, nonCreditedSick);
    expect(avosSick.totalAvos).toBe(9);

    // Caso B: Licença-Maternidade de 01/05 a 28/08 (120d) preserva integralmente 12/12 avos
    const matLeaves = [
      {
        id: 'l-mat-year',
        leave_type: 'MATERNITY',
        esocial_reason_code: '17',
        start_date: '2026-05-01',
        end_date: '2026-08-28',
        status: 'ACTIVE',
      },
    ];
    const nonCreditedMat = LeaveImpactCalculator.getMonthlyLeaveNonCreditedDaysForThirteenth(matLeaves, 2026, 12);
    const avosMat = calculateThirteenthAvos('2024-01-10', 2026, 12, {}, nonCreditedMat);
    expect(avosMat.totalAvos).toBe(12);
  });

  it('6. Perda de período aquisitivo de férias (> 180 dias INSS — CLT Art. 133 IV) ignorando Licença-Maternidade', () => {
    const lossEval = LeaveImpactCalculator.evaluateVacationAcquisitionLoss({
      acquisitionStart: '2025-01-10',
      acquisitionEnd: '2026-01-09',
      leaves: [
        {
          id: 'l-long',
          leave_type: 'SICK_LEAVE',
          esocial_reason_code: '03',
          start_date: '2025-03-01',
          end_date: '2025-09-20', // 204 dias totais -> 15d empresa + 189d INSS (> 180!)
          status: 'ACTIVE',
        },
      ],
    });
    expect(lossEval.inssBenefitDays).toBe(189);
    expect(lossEval.lostByLeave).toBe(true);
    expect(lossEval.lossReason).toContain('CLT Art. 133 IV');

    // Licença-maternidade de 180 dias + 30 dias auxílio-doença (15 INSS) NÃO gera perda!
    const matOkEval = LeaveImpactCalculator.evaluateVacationAcquisitionLoss({
      acquisitionStart: '2025-01-10',
      acquisitionEnd: '2026-01-09',
      leaves: [
        {
          id: 'l-mat-ok',
          leave_type: 'MATERNITY',
          esocial_reason_code: '17',
          start_date: '2025-02-01',
          end_date: '2025-07-30',
          status: 'ACTIVE',
        },
      ],
    });
    expect(matOkEval.inssBenefitDays).toBe(0);
    expect(matOkEval.maternityDaysIgnored).toBe(180);
    expect(matOkEval.lostByLeave).toBe(false);
    expect(resolveCanonicalLeaveCategory('MILITARY_SERVICE', '19')).toBe('MILITARY_SERVICE');
  });
});
