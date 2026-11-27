import { describe, expect, it } from 'vitest';
import {
  CostAllocationEngine,
  distributeAmountWithRounding,
  validateCostAllocations,
} from '../src/accounting/CostAllocationEngine.js';

describe('CONT-01: CostAllocationEngine (Multi-CC, Projetos, Tomadores e Obras CNO)', () => {
  it('rejeita rateios cuja soma difere de 100%', () => {
    const res = validateCostAllocations([
      { costCenterId: 'cc-1', percentage: 60 },
      { projectCode: 'PRJ-01', percentage: 35 },
    ]);
    expect(res.valid).toBe(false);
    expect(res.totalPercentage).toBe(95);
  });

  it('distribui R$ 100,00 em 33.33% / 33.33% / 33.34% sem perda de centavos e ajusta o maior rateio', () => {
    const slices = distributeAmountWithRounding(100, [
      { percentage: 33.33 },
      { percentage: 33.33 },
      { percentage: 33.34 },
    ]);
    expect(slices[0].amount).toBe(33.33);
    expect(slices[1].amount).toBe(33.33);
    expect(slices[2].amount).toBe(33.34);
    expect(slices[0].amount + slices[1].amount + slices[2].amount).toBe(100);
  });

  it('ajusta centavo residual de R$ 10,00 divididos em 33.33 / 33.33 / 33.34 e consolida custos', () => {
    const lines = CostAllocationEngine.allocatePayslipCosts({
      payslipId: 'ps-1',
      contractId: 'c-1',
      grossAmount: 1000,
      deductionsAmount: 150,
      netAmount: 850,
      inssEmployerAmount: 200,
      ratAmount: 20,
      terceirosAmount: 58,
      fgtsAmount: 80,
      vacationProvisionAmount: 111.11,
      thirteenthProvisionAmount: 83.33,
      allocations: [
        { costCenterId: 'cc-adm', cnoNumber: '900012345678', percentage: 33.33 },
        { costCenterId: 'cc-obra', tomadorCnpj: '11222333000144', percentage: 33.33 },
        { costCenterId: 'cc-proj', projectCode: 'OBRA-SUL', percentage: 33.34 },
      ],
    });

    expect(lines).toHaveLength(3);
    const sumGross = Number((lines[0].grossAmount + lines[1].grossAmount + lines[2].grossAmount).toFixed(2));
    const sumVacProv = Number(
      (lines[0].vacationProvisionAmount + lines[1].vacationProvisionAmount + lines[2].vacationProvisionAmount).toFixed(2)
    );
    expect(sumGross).toBe(1000);
    expect(sumVacProv).toBe(111.11);
    expect(lines[2].isRoundingAdjusted).toBe(true);
  });
});
