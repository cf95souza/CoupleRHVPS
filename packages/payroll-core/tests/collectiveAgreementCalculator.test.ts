import { describe, it, expect } from 'vitest';
import {
  CollectiveAgreementCalculator,
  type CollectiveAgreementData,
} from '../src/legal/CollectiveAgreementCalculator.js';

describe('CollectiveAgreementCalculator (FOLHA-09)', () => {
  it('1. Deve calcular corretamente os anos de serviço completos para a competência', () => {
    // Admissão em 15/03/2021 avaliada em 09/2026 (5 anos completos)
    const years1 = CollectiveAgreementCalculator.calculateCompletedYearsOfService('2021-03-15', 2026, 9);
    expect(years1).toBe(5);

    // Admissão em 20/11/2021 avaliada em 09/2026 (4 anos completos, aniversário em nov)
    const years2 = CollectiveAgreementCalculator.calculateCompletedYearsOfService('2021-11-20', 2026, 9);
    expect(years2).toBe(4);

    // Admissão no mesmo mês da competência (01/09/2021 avaliada em 09/2026 -> 5 anos)
    const years3 = CollectiveAgreementCalculator.calculateCompletedYearsOfService('2021-09-01', 2026, 9);
    expect(years3).toBe(5);

    // Admissão no mesmo ano (01/02/2026 avaliada em 09/2026 -> 0 anos completos)
    const years4 = CollectiveAgreementCalculator.calculateCompletedYearsOfService('2026-02-01', 2026, 9);
    expect(years4).toBe(0);
  });

  it('2. Deve calcular ATS (Anuênio, Biênio, Triênio, Quinquênio) e respeitar o teto percentual', () => {
    const baseSalary = 3000.0;

    // Anuênio: 1% ao ano, 5 anos = 5% -> R$ 150,00
    const cctAnuenio: CollectiveAgreementData = {
      ats_type: 'ANUENIO',
      ats_percentage_per_cycle: 1.0,
      ats_max_percentage: 10.0,
    };
    const resAnu = CollectiveAgreementCalculator.calculateServiceTimeAllowance(
      '2021-03-15',
      2026,
      9,
      baseSalary,
      cctAnuenio
    );
    expect(resAnu.cycles).toBe(5);
    expect(resAnu.percentage).toBe(5.0);
    expect(resAnu.amount).toBe(150.0);

    // Biênio: 2% a cada 2 anos, 5 anos = 2 ciclos = 4% -> R$ 120,00
    const cctBienio: CollectiveAgreementData = {
      ats_type: 'BIENIO',
      ats_percentage_per_cycle: 2.0,
    };
    const resBi = CollectiveAgreementCalculator.calculateServiceTimeAllowance(
      '2021-03-15',
      2026,
      9,
      baseSalary,
      cctBienio
    );
    expect(resBi.cycles).toBe(2);
    expect(resBi.percentage).toBe(4.0);
    expect(resBi.amount).toBe(120.0);

    // Triênio: 3% a cada 3 anos, 5 anos = 1 ciclo = 3% -> R$ 90,00
    const cctTrienio: CollectiveAgreementData = {
      ats_type: 'TRIENIO',
      ats_percentage_per_cycle: 3.0,
    };
    const resTri = CollectiveAgreementCalculator.calculateServiceTimeAllowance(
      '2021-03-15',
      2026,
      9,
      baseSalary,
      cctTrienio
    );
    expect(resTri.cycles).toBe(1);
    expect(resTri.percentage).toBe(3.0);
    expect(resTri.amount).toBe(90.0);

    // Quinquênio: 5% a cada 5 anos, 5 anos = 1 ciclo = 5% -> R$ 150,00
    const cctQuinquenio: CollectiveAgreementData = {
      ats_type: 'QUINQUENIO',
      ats_percentage_per_cycle: 5.0,
    };
    const resQuin = CollectiveAgreementCalculator.calculateServiceTimeAllowance(
      '2021-03-15',
      2026,
      9,
      baseSalary,
      cctQuinquenio
    );
    expect(resQuin.cycles).toBe(1);
    expect(resQuin.percentage).toBe(5.0);
    expect(resQuin.amount).toBe(150.0);

    // Teto Máximo: Anuênio de 10 anos a 2% (20%), mas teto é 15%
    const cctTeto: CollectiveAgreementData = {
      ats_type: 'ANUENIO',
      ats_percentage_per_cycle: 2.0,
      ats_max_percentage: 15.0,
    };
    const resTeto = CollectiveAgreementCalculator.calculateServiceTimeAllowance(
      '2016-03-15',
      2026,
      9,
      baseSalary,
      cctTeto
    );
    expect(resTeto.cycles).toBe(10);
    expect(resTeto.percentage).toBe(15.0); // travado no teto
    expect(resTeto.amount).toBe(450.0); // 15% de 3000
  });

  it('3. Deve validar piso salarial da categoria geral e por função (CBO)', () => {
    const cct: CollectiveAgreementData = {
      base_salary_floor: 2200.0,
      floor_positions: [
        { cbo: '252405', floor: 3500.0 }, // Analista de RH
        { cbo: '411010', floor: 2600.0 }, // Assistente Administrativo
      ],
    };

    // Colaborador geral com salário R$ 2.000 (abaixo do piso geral de R$ 2.200)
    const valGeral = CollectiveAgreementCalculator.validateCategoryFloor(2000.0, cct);
    expect(valGeral.isBelowFloor).toBe(true);
    expect(valGeral.effectiveFloor).toBe(2200.0);
    expect(valGeral.difference).toBe(200.0);

    // Analista de RH com salário R$ 3.000 (abaixo do piso da função de R$ 3.500)
    const valRh = CollectiveAgreementCalculator.validateCategoryFloor(3000.0, cct, { cbo: '252405' });
    expect(valRh.isBelowFloor).toBe(true);
    expect(valRh.effectiveFloor).toBe(3500.0);
    expect(valRh.difference).toBe(500.0);

    // Colaborador com salário compatível (R$ 4.000)
    const valOk = CollectiveAgreementCalculator.validateCategoryFloor(4000.0, cct, { cbo: '252405' });
    expect(valOk.isBelowFloor).toBe(false);
    expect(valOk.difference).toBe(0);
  });

  it('4. Deve resolver a base de cálculo de insalubridade de acordo com a CCT', () => {
    const salarioMinimo = 1621.0;
    const salarioBase = 4000.0;
    const pisoCategoria = 2500.0;

    // Padrão / MINIMUM_WAGE -> Salário Mínimo
    const bMin = CollectiveAgreementCalculator.resolveUnhealthinessBase(salarioMinimo, salarioBase, {
      unhealthiness_base_type: 'MINIMUM_WAGE',
    });
    expect(bMin).toBe(1621.0);

    // CATEGORY_FLOOR -> Piso da Categoria
    const bPiso = CollectiveAgreementCalculator.resolveUnhealthinessBase(salarioMinimo, salarioBase, {
      unhealthiness_base_type: 'CATEGORY_FLOOR',
      base_salary_floor: pisoCategoria,
    });
    expect(bPiso).toBe(2500.0);

    // BASE_SALARY -> Salário Contratual
    const bBase = CollectiveAgreementCalculator.resolveUnhealthinessBase(salarioMinimo, salarioBase, {
      unhealthiness_base_type: 'BASE_SALARY',
    });
    expect(bBase).toBe(4000.0);
  });

  it('5. Deve parametrizar horas extras escalonadas e adicional noturno da CCT', () => {
    const cct: CollectiveAgreementData = {
      overtime_percentage_tier1: 60.0, // 60% primeiras 2h
      overtime_percentage_tier2: 100.0,
      overtime_percentage_sunday_holiday: 120.0,
      night_shift_percentage: 30.0, // 30% noturno (acima dos 20% CLT)
      night_shift_start_time: '21:00:00',
      night_shift_end_time: '06:00:00',
    };

    const he = CollectiveAgreementCalculator.resolveOvertimeRates(cct);
    expect(he.tier1Percentage).toBe(60.0);
    expect(he.tier2Percentage).toBe(100.0);
    expect(he.sundayHolidayPercentage).toBe(120.0);

    const night = CollectiveAgreementCalculator.resolveNightShiftParams(cct);
    expect(night.percentage).toBe(30.0);
    expect(night.startTime).toBe('21:00:00');
    expect(night.endTime).toBe('06:00:00');
    expect(night.reducedHour).toBe(true);
  });

  it('6. Deve checar estabilidade provisória pós-retorno de férias prevista na CCT', () => {
    const cct: CollectiveAgreementData = {
      post_vacation_stability_days: 30,
    };

    // Férias terminaram em 2026-08-31 -> estabilidade até 2026-09-30
    const check1 = CollectiveAgreementCalculator.checkPostVacationStability('2026-08-31', '2026-09-15', cct);
    expect(check1.hasStability).toBe(true);
    expect(check1.stabilityUntil).toBe('2026-09-30');
    expect(check1.remainingDays).toBe(15);

    // Avaliação após o término da estabilidade (05/10/2026)
    const check2 = CollectiveAgreementCalculator.checkPostVacationStability('2026-08-31', '2026-10-05', cct);
    expect(check2.hasStability).toBe(false);
    expect(check2.remainingDays).toBe(0);
  });
});
