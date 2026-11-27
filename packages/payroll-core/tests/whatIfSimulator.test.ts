import { describe, it, expect } from 'vitest';
import {
  chunkArray,
  isContractEligibleForScenario,
  applyScenarioToBaseSalary,
  buildWhatIfComparisonSummary,
  type WhatIfScenarioParams,
  type WhatIfContractSnapshot,
} from '../src/engine/WhatIfSimulator.js';

describe('FOLHA-01: WhatIfSimulator & Processamento em Chunks (payroll-core)', () => {
  describe('chunkArray', () => {
    it('deve dividir arrays em lotes exatos de 50 elementos para 0, 1, 50, 51 e 1000 itens', () => {
      expect(chunkArray([], 50)).toEqual([]);
      expect(chunkArray([1], 50)).toEqual([[1]]);

      const exactly50 = Array.from({ length: 50 }, (_, i) => i + 1);
      const chunks50 = chunkArray(exactly50, 50);
      expect(chunks50).toHaveLength(1);
      expect(chunks50[0]).toHaveLength(50);

      const fiftyOne = Array.from({ length: 51 }, (_, i) => i + 1);
      const chunks51 = chunkArray(fiftyOne, 50);
      expect(chunks51).toHaveLength(2);
      expect(chunks51[0]).toHaveLength(50);
      expect(chunks51[1]).toHaveLength(1);

      const thousand = Array.from({ length: 1000 }, (_, i) => i + 1);
      const chunks1000 = chunkArray(thousand, 50);
      expect(chunks1000).toHaveLength(20);
      expect(chunks1000.every((c) => c.length === 50)).toBe(true);
    });
  });

  describe('isContractEligibleForScenario', () => {
    const contract = {
      id: 'c-1',
      department_id: 'dept-ti',
      position_id: 'pos-dev',
      cost_center_id: 'cc-01',
    };

    it('deve retornar true para todos os contratos quando não houver filtros', () => {
      expect(isContractEligibleForScenario(contract, {})).toBe(true);
    });

    it('deve filtrar corretamente por department_id, position_id, cost_center_id e contract_ids', () => {
      expect(isContractEligibleForScenario(contract, { department_id: 'dept-ti' })).toBe(true);
      expect(isContractEligibleForScenario(contract, { department_id: 'dept-rh' })).toBe(false);

      expect(isContractEligibleForScenario(contract, { position_id: 'pos-dev' })).toBe(true);
      expect(isContractEligibleForScenario(contract, { position_id: 'pos-dir' })).toBe(false);

      expect(isContractEligibleForScenario(contract, { cost_center_id: 'cc-01' })).toBe(true);
      expect(isContractEligibleForScenario(contract, { cost_center_id: 'cc-99' })).toBe(false);

      expect(isContractEligibleForScenario(contract, { contract_ids: ['c-1', 'c-2'] })).toBe(true);
      expect(isContractEligibleForScenario(contract, { contract_ids: ['c-2'] })).toBe(false);
    });
  });

  describe('applyScenarioToBaseSalary', () => {
    it('deve aplicar reajuste percentual de 6,5% com arredondamento HALF_UP em centavos', () => {
      // 3000 * 1.065 = 3195.00
      expect(applyScenarioToBaseSalary(3000, { salary_increase_pct: 6.5 })).toBe(3195);
      // 1518.15 * 1.065 = 1616.82975 -> HALF_UP = 1616.83
      expect(applyScenarioToBaseSalary(1518.15, { salary_increase_pct: 6.5 })).toBe(1616.83);
    });

    it('deve combinar percentual e acréscimo fixo sem permitir salário negativo', () => {
      const scenario: WhatIfScenarioParams = {
        salary_increase_pct: 10,
        salary_increase_fixed: 250.33,
      };
      expect(applyScenarioToBaseSalary(2000, scenario)).toBe(2450.33);

      // Proteção contra salário negativo
      expect(applyScenarioToBaseSalary(1000, { salary_increase_fixed: -1500 })).toBe(0);
    });
  });

  describe('buildWhatIfComparisonSummary', () => {
    it('deve consolidar comparativo financeiro baseline vs simulado, encargos, departamentos e maiores impactos', () => {
      const baselineContracts: WhatIfContractSnapshot[] = [
        {
          contract_id: 'c-1',
          company_id: 'comp-1',
          department_id: 'dept-1',
          worker_name: 'Ana Silva',
          affected: true,
          total_earnings: 3000,
          total_deductions: 400,
          net_salary: 2600,
          base_inss: 3000,
          inss_employee: 260,
          irrf_employee: 40,
          fgts_month: 240,
        },
        {
          contract_id: 'c-2',
          company_id: 'comp-1',
          department_id: 'dept-2',
          worker_name: 'Bruno Costa',
          affected: false,
          total_earnings: 2000,
          total_deductions: 200,
          net_salary: 1800,
          base_inss: 2000,
          inss_employee: 160,
          irrf_employee: 0,
          fgts_month: 160,
        },
      ];

      const simulatedContracts: WhatIfContractSnapshot[] = [
        {
          contract_id: 'c-1',
          company_id: 'comp-1',
          department_id: 'dept-1',
          worker_name: 'Ana Silva',
          affected: true,
          total_earnings: 3695,
          total_deductions: 520,
          net_salary: 3175,
          base_inss: 3695,
          inss_employee: 340,
          irrf_employee: 80,
          fgts_month: 295.6,
        },
        {
          contract_id: 'c-2',
          company_id: 'comp-1',
          department_id: 'dept-2',
          worker_name: 'Bruno Costa',
          affected: false,
          total_earnings: 2000,
          total_deductions: 200,
          net_salary: 1800,
          base_inss: 2000,
          inss_employee: 160,
          irrf_employee: 0,
          fgts_month: 160,
        },
      ];

      const summary = buildWhatIfComparisonSummary({
        scenario: {
          label: 'Dissídio TI 6,5% + Bônus 500',
          salary_increase_pct: 6.5,
          bonus_amount: 500,
          department_id: 'dept-1',
        },
        baselineContracts,
        simulatedContracts,
        baselineEmployerTaxes: {
          inss_patronal: 1000,
          rat_adjusted: 100,
          terceiros: 290,
          fgts_patronal: 400,
          total_taxes: 1790,
        },
        simulatedEmployerTaxes: {
          inss_patronal: 1139,
          rat_adjusted: 113.9,
          terceiros: 330.31,
          fgts_patronal: 455.6,
          total_taxes: 2038.81,
        },
        durationMs: 120,
        chunksProcessed: 1,
      });

      expect(summary.total_contracts).toBe(2);
      expect(summary.affected_contracts).toBe(1);
      expect(summary.baseline.total_earnings).toBe(5000);
      expect(summary.simulated.total_earnings).toBe(5695);
      expect(summary.delta.total_earnings).toBe(695);
      expect(summary.baseline.total_company_cost).toBe(6790);
      expect(summary.simulated.total_company_cost).toBe(7733.81);
      expect(summary.delta.total_company_cost).toBe(943.81);
      expect(summary.pct_company_cost_change).toBe(13.9);

      expect(summary.by_department).toHaveLength(2);
      const dept1 = summary.by_department.find((d) => d.department_id === 'dept-1');
      expect(dept1?.delta_earnings).toBe(695);
      expect(dept1?.affected_contracts).toBe(1);

      expect(summary.top_impacts).toHaveLength(1);
      expect(summary.top_impacts[0].contract_id).toBe('c-1');
      expect(summary.top_impacts[0].delta_earnings).toBe(695);
    });
  });
});
