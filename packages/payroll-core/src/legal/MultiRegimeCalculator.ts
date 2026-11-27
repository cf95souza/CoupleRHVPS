/**
 * MultiRegimeCalculator.ts
 * FASE V6 — FOLHA-15: Categorias Especiais de Vínculos (Multi-Regime eSocial).
 *
 * Regimes implementados:
 * 1. Pró-Labore (eSocial 722/723): INSS 11% fixo limitado ao teto, FGTS 0%, Patronal 20% sem RAT/Terceiros.
 * 2. Autônomo / RPA (eSocial 701/711): INSS 11% até teto, transporte carga (INSS 20%, IRRF 10%) ou passageiros
 *    (INSS 20%, IRRF 60%), SEST 1,5% + SENAT 1,0% sobre base reduzida, ISS municipal.
 * 3. Estagiário (eSocial 901 — Lei 11.788/2008): sem INSS/FGTS, IRRF normal, Recesso Remunerado 30d/12m sem 1/3.
 * 4. Intermitente (eSocial 111 — CLT Art. 452-A): convocações com Salário + Férias 1/12 + 1/3 + 13º 1/12 + DSR
 *    + alerta DARF complementação INSS quando remuneração mensal < salário mínimo vigente.
 * 5. Horista / Diarista / Comissionista Puro: separação Horas/Dias Normais × DSR + Complemento de Garantia Mínima.
 */

import { INSSCalculator } from './INSSCalculator.js';
import { IRRFCalculator } from './IRRFCalculator.js';
import { FGTSCalculator } from './FGTSCalculator.js';
import type { GeneralLegalParameters, InssBracket, IrrfBracket } from '../engine/PayrollContext.js';
import { addMoney, divideMoney, multiplyMoney, round2, subtractMoney, sumMoney } from '../utils/money.js';

export type CalculationRegimeType =
  | 'CLT'
  | 'APPRENTICE'
  | 'PRO_LABORE'
  | 'AUTONOMOUS_RPA'
  | 'INTERN'
  | 'INTERMITTENT'
  | 'HOURLY'
  | 'DAILY'
  | 'COMMISSION_ONLY';

export type AutonomousServiceType = 'GENERAL' | 'FREIGHT_TRANSPORT' | 'PASSENGER_TRANSPORT';

export interface IntermittentCallInput {
  hoursWorked: number;
  hourlyRate: number;
  diasUteis?: number;
  diasInuteis?: number;
}

export interface MultiRegimeTaxInput {
  regime: CalculationRegimeType;
  grossRemuneration: number;
  inssCeiling: number;
  minimumWage: number;
  autonomousServiceType?: AutonomousServiceType;
  issRate?: number; // ex: 2 ou 5 (%)
  priorInssBaseInMonth?: number;
  dependentsCount?: number;
  alimony?: number;
  inssParameters: InssBracket[];
  irrfParameters: IrrfBracket[];
  generalLegalParameters: GeneralLegalParameters;
}

export interface MultiRegimeTaxOutput {
  regime: CalculationRegimeType;
  esocialCategoryCode: string;
  baseInss: number;
  inssEmployee: number;
  baseIrrfGross: number;
  irrfEmployee: number;
  sestSenatDeduction: number;
  issDeduction: number;
  baseFgts: number;
  fgtsAmount: number;
  inssComplementationAlert: boolean;
  inssComplementationDarfEstimate: number;
  employerCategory: 'EMPLOYEE' | 'INDIVIDUAL_CONTRIBUTOR' | 'EXEMPT';
  notes: string[];
}

export class MultiRegimeCalculator {
  /**
   * 1. Apura férias/recesso remunerado de Estagiário (Lei 11.788/2008 Art. 13):
   * 30 dias a cada 12 meses de estágio (ou proporcional), SEM 1/3 constitucional.
   */
  public static calculateInternRecess(stipendMonthly: number, monthsWorked: number): {
    recessDays: number;
    recessAmount: number;
  } {
    const months = Math.max(0, Math.min(12, Number(monthsWorked || 0)));
    const recessDays = Math.round((months / 12) * 30);
    const recessAmount = round2((stipendMonthly / 30) * recessDays);
    return { recessDays, recessAmount };
  }

  /**
   * 2. Apura verbas imediatas de Trabalho Intermitente (CLT Art. 452-A §6º):
   * Salário das horas + DSR + Férias Proporcionais (1/12) + 1/3 sobre férias + 13º Proporcional (1/12).
   */
  public static calculateIntermittentCall(call: IntermittentCallInput): {
    grossWorked: number;
    dsrAmount: number;
    vacationProportional: number;
    vacationThird: number;
    thirteenthProportional: number;
    totalGross: number;
  } {
    const diasUteis = call.diasUteis && call.diasUteis > 0 ? call.diasUteis : 25;
    const diasInuteis = call.diasInuteis !== undefined && call.diasInuteis >= 0 ? call.diasInuteis : 5;
    const grossWorked = round2(call.hoursWorked * call.hourlyRate);
    const dsrAmount = multiplyMoney(divideMoney(grossWorked, diasUteis), diasInuteis);
    const baseComDsr = addMoney(grossWorked, dsrAmount);
    const vacationProportional = divideMoney(baseComDsr, 12);
    const vacationThird = divideMoney(vacationProportional, 3);
    const thirteenthProportional = divideMoney(baseComDsr, 12);
    const totalGross = sumMoney([
      grossWorked,
      dsrAmount,
      vacationProportional,
      vacationThird,
      thirteenthProportional,
    ]);

    return {
      grossWorked,
      dsrAmount,
      vacationProportional,
      vacationThird,
      thirteenthProportional,
      totalGross,
    };
  }

  /**
   * 3. Apura Horista / Diarista / Comissionista Puro com DSR separado e Garantia Mínima (Piso/Salário Mínimo).
   */
  public static calculateVariableBaseRemuneration(input: {
    regime: 'HOURLY' | 'DAILY' | 'COMMISSION_ONLY';
    unitsWorked: number; // horas ou dias (para HOURLY/DAILY)
    unitRate: number;
    commissionsTotal?: number;
    diasUteis: number;
    diasInuteis: number;
    minimumGuaranteeAmount?: number; // piso CCT ou salário mínimo
  }): {
    baseProduced: number;
    dsrAmount: number;
    minimumGuaranteeSupplement: number;
    totalGross: number;
  } {
    const diasUteis = input.diasUteis > 0 ? input.diasUteis : 25;
    const diasInuteis = input.diasInuteis >= 0 ? input.diasInuteis : 5;

    const baseProduced =
      input.regime === 'COMMISSION_ONLY'
        ? round2(Number(input.commissionsTotal || 0))
        : round2(input.unitsWorked * input.unitRate);

    const dsrAmount =
      baseProduced > 0 ? multiplyMoney(divideMoney(baseProduced, diasUteis), diasInuteis) : 0;

    const subtotal = addMoney(baseProduced, dsrAmount);
    const guarantee = Number(input.minimumGuaranteeAmount || 0);
    const minimumGuaranteeSupplement =
      guarantee > 0 && subtotal < guarantee ? subtractMoney(guarantee, subtotal) : 0;

    return {
      baseProduced,
      dsrAmount,
      minimumGuaranteeSupplement,
      totalGross: addMoney(subtotal, minimumGuaranteeSupplement),
    };
  }

  /**
   * 4. Aplica regras tributárias e previdenciárias específicas por regime eSocial.
   */
  public static calculateTaxesByRegime(input: MultiRegimeTaxInput): MultiRegimeTaxOutput {
    const gross = round2(Math.max(0, input.grossRemuneration));
    const ceiling = input.inssCeiling > 0 ? input.inssCeiling : 8157.41;
    const priorBase = Math.max(0, Number(input.priorInssBaseInMonth || 0));
    const remainingCeiling = Math.max(0, subtractMoney(ceiling, priorBase));
    const deps = input.dependentsCount || 0;
    const alimony = input.alimony || 0;
    const notes: string[] = [];

    if (input.regime === 'PRO_LABORE') {
      // Sócio / Diretor Não Empregado (722/723): INSS 11% até teto, FGTS 0%, Patronal 20% sem RAT/Terceiros
      const baseInss = Math.min(gross, remainingCeiling);
      const inssEmployee = round2(baseInss * 0.11);
      const irrf = IRRFCalculator.calculate(
        gross,
        inssEmployee,
        deps,
        input.irrfParameters,
        input.generalLegalParameters,
        alimony
      );
      notes.push(`Pró-Labore (722): INSS 11% sobre R$ ${baseInss.toFixed(2)} (Teto R$ ${ceiling.toFixed(2)}), isento de FGTS.`);
      return {
        regime: 'PRO_LABORE',
        esocialCategoryCode: '722',
        baseInss: gross,
        inssEmployee,
        baseIrrfGross: gross,
        irrfEmployee: irrf.value,
        sestSenatDeduction: 0,
        issDeduction: 0,
        baseFgts: 0,
        fgtsAmount: 0,
        inssComplementationAlert: false,
        inssComplementationDarfEstimate: 0,
        employerCategory: 'INDIVIDUAL_CONTRIBUTOR',
        notes,
      };
    }

    if (input.regime === 'AUTONOMOUS_RPA') {
      const serviceType = input.autonomousServiceType || 'GENERAL';
      const isFreight = serviceType === 'FREIGHT_TRANSPORT';
      const isPassenger = serviceType === 'PASSENGER_TRANSPORT';
      const isTransport = isFreight || isPassenger;

      // Transporte: base reduzida INSS 20% (Art. 55 §2º IN RFB 2.110/2022) + SEST 1,5% + SENAT 1,0%
      const inssBaseFactor = isTransport ? 0.2 : 1.0;
      const reducedInssBase = round2(gross * inssBaseFactor);
      const cappedInssBase = Math.min(reducedInssBase, remainingCeiling);
      const inssEmployee = round2(cappedInssBase * 0.11);
      const sestSenatDeduction = isTransport ? round2(reducedInssBase * 0.025) : 0;
      const issDeduction = input.issRate && input.issRate > 0 ? round2(gross * (input.issRate / 100)) : 0;

      // IRRF Transportador (Lei 7.713/88 art. 9º): Carga = 10% tributável; Passageiros = 60% tributável
      const irrfBaseFactor = isFreight ? 0.1 : isPassenger ? 0.6 : 1.0;
      const baseIrrfGross = round2(gross * irrfBaseFactor);
      const irrf = IRRFCalculator.calculate(
        baseIrrfGross,
        inssEmployee,
        deps,
        input.irrfParameters,
        input.generalLegalParameters,
        alimony
      );

      notes.push(
        `RPA (${isTransport ? '711 Transporte' : '701 Geral'}): Base INSS ${(inssBaseFactor * 100).toFixed(0)}% = R$ ${reducedInssBase.toFixed(2)}, Base IRRF ${(irrfBaseFactor * 100).toFixed(0)}% = R$ ${baseIrrfGross.toFixed(2)}.`
      );

      return {
        regime: 'AUTONOMOUS_RPA',
        esocialCategoryCode: isTransport ? '711' : '701',
        baseInss: reducedInssBase,
        inssEmployee,
        baseIrrfGross,
        irrfEmployee: irrf.value,
        sestSenatDeduction,
        issDeduction,
        baseFgts: 0,
        fgtsAmount: 0,
        inssComplementationAlert: false,
        inssComplementationDarfEstimate: 0,
        employerCategory: 'INDIVIDUAL_CONTRIBUTOR',
        notes,
      };
    }

    if (input.regime === 'INTERN') {
      // Estagiário (901 — Lei 11.788): isento de INSS e FGTS; sujeito apenas a IRRF na fonte
      const irrf = IRRFCalculator.calculate(
        gross,
        0,
        deps,
        input.irrfParameters,
        input.generalLegalParameters,
        alimony
      );
      notes.push('Estagiário (901 - Lei 11.788/2008): isento de INSS e FGTS.');
      return {
        regime: 'INTERN',
        esocialCategoryCode: '901',
        baseInss: 0,
        inssEmployee: 0,
        baseIrrfGross: gross,
        irrfEmployee: irrf.value,
        sestSenatDeduction: 0,
        issDeduction: 0,
        baseFgts: 0,
        fgtsAmount: 0,
        inssComplementationAlert: false,
        inssComplementationDarfEstimate: 0,
        employerCategory: 'EXEMPT',
        notes,
      };
    }

    // INTERMITTENT (111), APPRENTICE (103), HOURLY/DAILY/COMMISSION_ONLY/CLT (101)
    const inssRes = INSSCalculator.calculate(gross, input.inssParameters);
    const irrfRes = IRRFCalculator.calculate(
      gross,
      inssRes.value,
      deps,
      input.irrfParameters,
      input.generalLegalParameters,
      alimony
    );
    const isApprentice = input.regime === 'APPRENTICE';
    const fgtsRes = FGTSCalculator.calculate(
      gross,
      isApprentice,
      input.generalLegalParameters.fgts_standard_aliquot,
      input.generalLegalParameters.fgts_apprentice_aliquot
    );

    const isIntermittent = input.regime === 'INTERMITTENT';
    const belowMin = isIntermittent && gross > 0 && gross < input.minimumWage;
    const minRate = (input.inssParameters[0]?.aliquot || 7.5) / 100;
    const complementDarf = belowMin
      ? round2(subtractMoney(input.minimumWage, gross) * minRate)
      : 0;

    if (belowMin) {
      notes.push(
        `EC 103/2019 Art. 29: Remuneração do intermitente (R$ ${gross.toFixed(2)}) inferior ao salário mínimo (R$ ${input.minimumWage.toFixed(2)}). Colaborador deve recolher DARF complementar (cód. 1872) estimado em R$ ${complementDarf.toFixed(2)}.`
      );
    }

    const catMap: Record<CalculationRegimeType, string> = {
      CLT: '101',
      APPRENTICE: '103',
      INTERMITTENT: '111',
      HOURLY: '101',
      DAILY: '101',
      COMMISSION_ONLY: '101',
      PRO_LABORE: '722',
      AUTONOMOUS_RPA: '701',
      INTERN: '901',
    };

    return {
      regime: input.regime,
      esocialCategoryCode: catMap[input.regime],
      baseInss: gross,
      inssEmployee: inssRes.value,
      baseIrrfGross: gross,
      irrfEmployee: irrfRes.value,
      sestSenatDeduction: 0,
      issDeduction: 0,
      baseFgts: gross,
      fgtsAmount: fgtsRes.value,
      inssComplementationAlert: belowMin,
      inssComplementationDarfEstimate: complementDarf,
      employerCategory: 'EMPLOYEE',
      notes,
    };
  }
}
