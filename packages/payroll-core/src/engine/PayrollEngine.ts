import { PayrollContext, CalculationResult, type IrrfCashLedgerSnapshot } from './PayrollContext.js';
import { DAGResolver } from '../rubrics/DAGResolver.js';
import { RubricFormulaParser } from '../rubrics/RubricFormulaParser.js';
import { INSSCalculator } from '../legal/INSSCalculator.js';
import {
  IRRFCalculator,
  resolveIrrfTaxationBucket,
  type IrrfCashConsolidatedResult,
  type IrrfTaxationBucket,
} from '../legal/IRRFCalculator.js';
import {
  AlimonySolver,
  type AlimonySplitResult,
  type AlimonySolverTraceStep,
} from '../legal/AlimonySolver.js';
import {
  FamilyAllowanceCalculator,
  type FamilyAllowanceCalculationResult,
} from '../legal/FamilyAllowanceCalculator.js';
import {
  MultipleEmploymentINSSCalculator,
  type IndMVCode,
} from '../legal/MultipleEmploymentINSSCalculator.js';
import { FGTSCalculator } from '../legal/FGTSCalculator.js';
import { MultiRegimeCalculator } from '../legal/MultiRegimeCalculator.js';
import { DiscountPriorityManager } from '../legal/DiscountPriorityManager.js';
import { round2, addMoney, subtractMoney, divideMoney } from '../utils/money.js';
import { calculateReducedNightHours } from '../legal/NightWorkCalculator.js';
import { normalizeFormulaVariables, normalizeVariableName } from '../variablesCatalog.js';

export class PayrollEngine {
  context: PayrollContext;

  constructor(context: PayrollContext) {
    this.context = context;
  }

  public async run(): Promise<CalculationResult> {
    try {
      // 1. Validar e ordenar rubricas (DAG)
      const sortedRubrics = DAGResolver.resolve(this.context.rubricas);

      // T14: Resolução de Não Cumulatividade entre Insalubridade e Periculosidade (CLT art. 193 §2º)
      let electedHazardKind: 'INSALUBRIDADE' | 'PERICULOSIDADE' | null = null;
      let nonElectedReason = '';

      if (!this.context.allow_cumulative_hazard_allowances) {
        const insalubridadeRubric = sortedRubrics.find(r =>
          (r.rubric_kind === 'INSALUBRIDADE' || r.code === '302' || (r.name || '').toUpperCase().includes('INSALUBRIDADE')) && r.type === 'EARNING'
        );
        const periculosidadeRubric = sortedRubrics.find(r =>
          (r.rubric_kind === 'PERICULOSIDADE' || r.code === '303' || (r.name || '').toUpperCase().includes('PERICULOSIDADE')) && r.type === 'EARNING'
        );

        if (insalubridadeRubric && periculosidadeRubric) {
          const evIns = this.context.eventos.find(e => e.rubric_id === insalubridadeRubric.id);
          const evPer = this.context.eventos.find(e => e.rubric_id === periculosidadeRubric.id);

          // A regra de não cumulatividade (CLT art. 193 §2º) só se aplica se o colaborador possuir ambos os adicionais no mês
          if (evIns && evPer) {
            // Insalubridade estimada
            let percIns = insalubridadeRubric.percentage || 20;
            if (evIns.value_type === 'PERCENT' || evIns.percentage !== undefined) {
              percIns = evIns.percentage ?? evIns.manual_value ?? percIns;
            } else if (evIns.manual_value !== undefined && evIns.manual_value !== null && evIns.manual_value <= 100) {
              percIns = evIns.manual_value;
            }
            const baseIns = this.context.salario_minimo;
            const valorIns = evIns.value_type === 'AMOUNT' ? (evIns.manual_value || 0) : round2(baseIns * (percIns / 100));

            // Periculosidade estimada
            let percPer = periculosidadeRubric.percentage || 30;
            if (evPer.value_type === 'PERCENT' || evPer.percentage !== undefined) {
              percPer = evPer.percentage ?? evPer.manual_value ?? percPer;
            } else if (evPer.manual_value !== undefined && evPer.manual_value !== null && evPer.manual_value <= 100) {
              percPer = evPer.manual_value;
            }
            const basePer = this.context.salario_base || 0;
            const valorPer = evPer.value_type === 'AMOUNT' ? (evPer.manual_value || 0) : round2(basePer * (percPer / 100));

            if (valorPer >= valorIns) {
              electedHazardKind = 'PERICULOSIDADE';
              nonElectedReason = `Insalubridade não cumulativa com Periculosidade (CLT art. 193 §2º). Aplicado o adicional mais vantajoso (Periculosidade: R$ ${valorPer.toFixed(2)} vs Insalubridade: R$ ${valorIns.toFixed(2)}).`;
            } else {
              electedHazardKind = 'INSALUBRIDADE';
              nonElectedReason = `Periculosidade não cumulativa com Insalubridade (CLT art. 193 §2º). Aplicado o adicional mais vantajoso (Insalubridade: R$ ${valorIns.toFixed(2)} vs Periculosidade: R$ ${valorPer.toFixed(2)}).`;
            }
          }
        }
      }

      let hasManualFamilySalaryOverride = false;
      let familySalaryTotal = 0;
      let familySalaryEvaluation: FamilyAllowanceCalculationResult | null = null;

      // 2 & 3. Processar eventos manuais, automáticos e fórmulas em ordem DAG
      for (const rubric of sortedRubrics) {
        try {
          // Encontra eventos associados à rubrica, se existirem (MANUAIS)
          const eventos = this.context.eventos.filter(e => e.rubric_id === rubric.id);

          let valorCalculado = 0;
          let quantidade = rubric.quantity || 0;
          let formulaUsada = rubric.formula || '';
          let calcForm = rubric.calculation_form;
          let calcBaseName = rubric.calculation_base;
          let factor = rubric.factor;
          let percentage = rubric.percentage;
          let divisor = rubric.divisor;
          let hasManualValue = false;

          const kind = rubric.rubric_kind ?? (rubric as any).kind;

          let isSalaryBase: boolean;
          let isOvertime: boolean;
          let isDsr: boolean;
          let isDsrNoturno: boolean;
          let isAdicionalNoturno: boolean;
          let isInsalubridade: boolean;
          let isPericulosidade: boolean;
          let isAbsence: boolean;
          let isLate: boolean;
          let isCommission: boolean;
          let isAlimony: boolean;
          let isFamilySalary: boolean;

          if (kind) {
            // MOTOR ORIENTADO A DADOS (T22: kind explícito com tipagem estrita de type)
            isSalaryBase = kind === 'SALARY_BASE' && rubric.type === 'EARNING';
            isOvertime = kind === 'OVERTIME' && rubric.type === 'EARNING';
            isDsr = kind === 'DSR' && rubric.type === 'EARNING';
            isDsrNoturno = kind === 'DSR_NOTURNO' && rubric.type === 'EARNING';
            isAdicionalNoturno = kind === 'ADIC_NOTURNO' && rubric.type === 'EARNING';
            isInsalubridade = kind === 'INSALUBRIDADE' && rubric.type === 'EARNING';
            isPericulosidade = kind === 'PERICULOSIDADE' && rubric.type === 'EARNING';
            isAbsence = kind === 'ABSENCE' && rubric.type === 'DEDUCTION';
            isLate = kind === 'LATE' && rubric.type === 'DEDUCTION';
            isCommission = kind === 'COMMISSION' && rubric.type === 'EARNING';
            isAlimony = (kind === 'ALIMONY' || rubric.code === '804') && rubric.type === 'DEDUCTION';
            isFamilySalary = (kind === 'FAMILY_SALARY' || rubric.code === '305') && rubric.type === 'EARNING';
          } else {
            // HEURÍSTICAS LEGADAS (Fallback temporário com console.warn conforme Doc §4 T22)
            console.warn(`[Rubrica ${rubric.code || 'S/C'} - ${rubric.name || 'Sem Nome'}] rubric_kind não definido; acionando heurística legada.`);

            isSalaryBase = (rubric.category === 'SALARY' || rubric.code === '101' || rubric.code === '1001' || (rubric.name || '').toLowerCase().includes('salário base') || (rubric.name || '').toLowerCase().includes('salario base')) && rubric.type === 'EARNING';
            isOvertime = (rubric.category === 'OVERTIME' || rubric.category === 'HORA_EXTRA' || (rubric.name || '').toUpperCase().includes('HORA EXTRA')) && rubric.type === 'EARNING';
            isDsrNoturno = (rubric.code === '171' || (rubric.name || '').toUpperCase().includes('NOTURNO DSR') || (rubric.name || '').toUpperCase().includes('DSR SOBRE ADICIONAL NOTURNO')) && rubric.type === 'EARNING';
            isDsr = (rubric.category === 'DSR' || rubric.code === '1011' || rubric.code === '170' || rubric.code === '104' || ((rubric.name || '').toUpperCase().includes('DSR') && !isDsrNoturno)) && rubric.type === 'EARNING';
            // Precedência corrigida: descarta DSR noturno e exige EARNING
            isAdicionalNoturno = (rubric.code === '301' || ((rubric.name || '').toUpperCase().includes('NOTURNO') && !isDsrNoturno)) && rubric.type === 'EARNING';
            isInsalubridade = (rubric.code === '302' || (rubric.name || '').toUpperCase().includes('INSALUBRIDADE')) && rubric.type === 'EARNING';
            isPericulosidade = (rubric.code === '303' || (rubric.name || '').toUpperCase().includes('PERICULOSIDADE')) && rubric.type === 'EARNING';
            isAbsence = (rubric.code === '801' || (rubric.name || '').toUpperCase().includes('FALTA')) && rubric.type === 'DEDUCTION';
            isLate = (rubric.code === '802' || rubric.code === '803' || (rubric.name || '').toUpperCase().includes('ATRASO')) && rubric.type === 'DEDUCTION';
            isCommission = (rubric.category === 'COMMISSION' || (rubric.name || '').toUpperCase().includes('COMISSAO') || (rubric.name || '').toUpperCase().includes('COMISSÃO')) && rubric.type === 'EARNING';
            isAlimony = (rubric.code === '804' || (rubric.name || '').toLowerCase().includes('pensão') || (rubric.name || '').toLowerCase().includes('pensao')) && rubric.type === 'DEDUCTION';
            isFamilySalary = (rubric.code === '305' || rubric.category === 'FAMILY_SALARY') && rubric.type === 'EARNING';
          }

          // FOLHA-05: Salário-Família automático aguarda apuração final da base INSS no Passo 3.5, salvo override manual explícito
          if (isFamilySalary && eventos.length === 0) {
            continue;
          }

          let isNonElectedHazard = false;
          // T14: Se houver não cumulatividade ativa para insalubridade ou periculosidade (CLT art. 193 §2º)
          if (isInsalubridade && electedHazardKind === 'PERICULOSIDADE') {
            valorCalculado = 0;
            formulaUsada = nonElectedReason;
            hasManualValue = true;
            isNonElectedHazard = true;
          } else if (isPericulosidade && electedHazardKind === 'INSALUBRIDADE') {
            valorCalculado = 0;
            formulaUsada = nonElectedReason;
            hasManualValue = true;
            isNonElectedHazard = true;
          }

          // Se tiver evento lançado para esta rubrica, pega a quantidade ou valor manual
          if (!isNonElectedHazard && eventos.length > 0) {
            quantidade = eventos.reduce((acc, ev) => acc + (ev.quantity || 0), 0) || quantidade;

            // T14: Se houver evento com valor percentual (value_type === 'PERCENT' ou percentage informado)
            const percentEvents = eventos.filter(ev =>
              ev.value_type === 'PERCENT' ||
              (ev.percentage !== undefined && ev.percentage !== null)
            );
            if (percentEvents.length > 0) {
              percentage = percentEvents[0].percentage ?? percentEvents[0].manual_value ?? percentage;
            }

            // Eventos com valor monetário em R$ (BUG-04: amount 0/null não bloqueia cálculo por quantidade sem force_zero_override)
            const amountEvents = eventos.filter(ev => {
              if (ev.value_type === 'PERCENT') return false;
              if (ev.manual_value === undefined || ev.manual_value === null) return false;
              if (ev.manual_value === 0) {
                return ev.force_zero_override === true;
              }
              if (ev.value_type === 'AMOUNT') {
                return true;
              }
              // Sem value_type definido: se rubric for percentual, não trata como AMOUNT se <= 100
              if (!ev.value_type && (calcForm === 'PERCENTUAL' || isInsalubridade || isPericulosidade || isAlimony)) {
                if (ev.manual_value > 0 && ev.manual_value <= 100) {
                  percentage = ev.manual_value;
                  return false;
                }
              }
              return true;
            });

            if (amountEvents.length > 0) {
              hasManualValue = true;
              valorCalculado = amountEvents.reduce((acc, ev) => acc + (ev.manual_value || 0), 0);
              formulaUsada = valorCalculado === 0 ? 'MANUAL_VALUE_ZERO' : 'MANUAL_VALUE';
            }
          }

          // Configuração inteligente de base/fatores para rubricas com cálculo automatizado
          if (isSalaryBase) {
            if (!calcBaseName) calcBaseName = 'SALARIO_BASE';
          } else if (isOvertime) {
            if (!factor && rubric.percentage) {
              factor = 1 + (rubric.percentage / 100);
            }
            if (factor && factor > 0) {
              calcForm = 'HORAS';
              if (!calcBaseName || calcBaseName === 'SALARIO_BASE') calcBaseName = 'BASE_HORA_EXTRA';
            } else if (rubric.formula && rubric.formula.trim() !== '') {
              calcForm = 'FORMULA';
            } else {
              throw new Error(`Fator multiplicador obrigatório não configurado para a rubrica de Hora Extra [${rubric.code || 'S/C'} - ${rubric.name || 'Sem Nome'}].`);
            }
          } else if (isDsrNoturno) {
            calcForm = 'PERCENTUAL';
            if (!calcBaseName) calcBaseName = 'BASE_DSR_NOTURNO';
            if (!percentage) {
              if (this.context.dias_uteis > 0) {
                percentage = (this.context.dias_inuteis / this.context.dias_uteis) * 100;
              } else {
                throw new Error("Calendário da competência inválido para apuração do DSR Noturno: dias úteis devem ser maiores que zero.");
              }
            }
          } else if (isDsr) {
            calcForm = 'PERCENTUAL';
            if (!calcBaseName) calcBaseName = 'BASE_DSR';
            if (!percentage) {
              if (this.context.dias_uteis > 0) {
                percentage = (this.context.dias_inuteis / this.context.dias_uteis) * 100;
              } else {
                throw new Error("Calendário da competência inválido para apuração do DSR: dias úteis devem ser maiores que zero.");
              }
            }
          } else if (isInsalubridade) {
            calcForm = 'PERCENTUAL';
            if (!calcBaseName) {
              const cctBase = this.context.collective_agreement?.unhealthiness_base_type;
              if (cctBase === 'CATEGORY_FLOOR' && (this.context.collective_agreement?.base_salary_floor || 0) > 0) {
                calcBaseName = 'PISO_SALARIAL_CCT';
              } else if (cctBase === 'BASE_SALARY') {
                calcBaseName = 'SALARIO_BASE';
              } else {
                calcBaseName = 'SALARIO_MINIMO';
              }
            }
            if (!percentage) percentage = 20; // 20% por padrão (grau médio)
          } else if (isPericulosidade) {
            calcForm = 'PERCENTUAL';
            if (!calcBaseName) calcBaseName = 'SALARIO_BASE';
            if (!percentage) percentage = 30; // 30% padrão
          } else if (isAdicionalNoturno) {
            calcForm = 'HORAS';
            if (!calcBaseName) calcBaseName = 'SALARIO_BASE';
            const cctNightPct = this.context.collective_agreement?.night_shift_percentage;
            if (!factor) factor = (cctNightPct !== undefined && cctNightPct !== null && cctNightPct > 0) ? (cctNightPct / 100) : 0.20;

            // T18: Suporte a hora noturna reduzida (Art. 73 § 1º CLT: 52min30s)
            const shouldApplyNightReduction = (rubric as any).apply_night_reduction === true || eventos.some(ev => (ev as any).apply_night_reduction === true || (ev as any).reduced_hours === true);
            if (shouldApplyNightReduction && quantidade > 0) {
              quantidade = calculateReducedNightHours(quantidade);
            }
          } else if (rubric.code === '502' || rubric.code === '504' || rubric.code === '702' || rubric.code === '704') {
            calcForm = 'UM_TERCO';
            const targetBaseMap: Record<string, string> = {
              '502': 'R501',
              '504': 'R503',
              '702': 'R701',
              '704': 'R703',
            };
            if (!calcBaseName) calcBaseName = targetBaseMap[rubric.code];
          } else if ((isAbsence || rubric.code === '801' || rubric.code === '210') && rubric.type === 'DEDUCTION') {
            if (!calcForm) calcForm = 'DIAS';
            if (!calcBaseName) calcBaseName = 'SALARIO_BASE';
          } else if ((isLate || rubric.code === '802' || rubric.code === '211') && rubric.type === 'DEDUCTION') {
            if (!calcForm) calcForm = 'HORAS';
            if (!calcBaseName) calcBaseName = 'SALARIO_BASE';
            if (!factor) factor = 1.0;
          } else if (
            kind === 'MATERNITY_LEAVE' ||
            kind === 'SICK_LEAVE_COMPANY' ||
            kind === 'FGTS_COMPULSORY_BASE' ||
            rubric.code === '104' ||
            rubric.code === '105' ||
            rubric.code === '906'
          ) {
            if (!calcForm) calcForm = 'DIAS';
            if (!calcBaseName) calcBaseName = 'SALARIO_BASE';
          } else if (isAlimony) {
            if (!calcForm || calcForm === 'MANUAL') calcForm = 'PERCENTUAL';
            if (!calcBaseName) calcBaseName = 'SALARIO_BASE';
          }

          // Se o valorCalculado ainda não foi definido manualmente, calcula!
          if (!hasManualValue) {
            if (calcForm === 'UM_TERCO' && calcBaseName) {
              const baseVal = this.context.getVariable(calcBaseName);
              valorCalculado = divideMoney(baseVal, 3);
              formulaUsada = `${calcBaseName} / 3`;
              if (baseVal > 0 && quantidade === 0) quantidade = 1;
            } else if (calcForm === 'FORMULA' && rubric.formula) {
              // Rubricas de fórmula que não são salário base nem DSR nem possuem evento lançado no mês só calculam se houver evento/quantidade
              const isAutomaticFormulaKind = isSalaryBase || isDsr || isDsrNoturno;
              if (eventos.length === 0 && !isAutomaticFormulaKind && !rubric.manual_value && !(rubric.quantity && rubric.quantity > 0)) {
                valorCalculado = 0;
                formulaUsada = 'SEM_EVENTO_NO_PERIODO';
              } else {
                const knownCodes = new Set(Array.from(this.context.rubricas.values()).map(r => r.code));
                const effDivisor = divisor || this.context.getVariable('DIVISOR') || 220;
                const evalVars: Record<string, number> = {
                  ...this.context.variables,
                  DIVISOR: effDivisor,
                  FATOR: factor ?? 1,
                  QUANTIDADE: quantidade,
                  PERCENTUAL: percentage ?? 0,
                };
                const normalizedFormula = normalizeFormulaVariables(rubric.formula);
                const currentParser = new RubricFormulaParser(evalVars, knownCodes);
                valorCalculado = currentParser.evaluate(normalizedFormula);
                formulaUsada = normalizedFormula;
              }
            }
            else if ((calcForm === 'HORAS' || calcForm === 'HOURS') && calcBaseName) {
              if (quantidade > 0) {
                const normBaseName = normalizeVariableName(calcBaseName);
                const rawBaseVal = this.context.getVariable(normBaseName);
                const baseVal = ((normBaseName === 'BASE_HORA_EXTRA' || normBaseName === 'BASE_HORA_EXTRA_NOTURNA') && rawBaseVal === 0)
                  ? this.context.salario_base
                  : rawBaseVal;
                const effFactor = factor;
                if (isOvertime && (!effFactor || effFactor <= 0)) {
                  throw new Error(`Fator multiplicador obrigatório não configurado para a rubrica de Hora Extra [${rubric.code || 'S/C'} - ${rubric.name || 'Sem Nome'}].`);
                }
                const effDivisor = divisor || this.context.getVariable('DIVISOR') || 220;
                const valorHora = baseVal / effDivisor;
                valorCalculado = (valorHora * (effFactor || 1.0)) * quantidade;
                formulaUsada = `(${baseVal} / ${effDivisor}) * ${effFactor || 1.0} * ${quantidade}`;
              } else {
                valorCalculado = 0;
                formulaUsada = `HORAS_ZERADAS`;
              }
            }
            else if (calcForm === 'PERCENTUAL' || calcForm === 'PERCENTAGE' || calcForm === 'PERCENTAGE_OF_BASE') {
              if (calcBaseName) {
                const normBaseName = normalizeVariableName(calcBaseName);
                const baseVal = this.context.getVariable(normBaseName);
                let perc = percentage;

                if (!perc && (isDsr || isDsrNoturno)) {
                  if (this.context.dias_uteis > 0) {
                    perc = (this.context.dias_inuteis / this.context.dias_uteis) * 100;
                  } else {
                    throw new Error("Calendário da competência inválido para apuração do DSR: dias úteis devem ser maiores que zero.");
                  }
                }

                perc = perc || 0;
                percentage = perc;

                if (quantidade > 0) {
                  valorCalculado = baseVal * (perc / 100) * quantidade;
                  formulaUsada = `PERCENTUAL(${calcBaseName} * ${perc}% * ${quantidade})`;
                } else if (isDsr || isDsrNoturno) {
                  if (baseVal > 0) {
                    valorCalculado = baseVal * (perc / 100);
                    formulaUsada = `PERCENTUAL(${calcBaseName} * ${perc}%)`;
                    quantidade = 1;
                  }
                }
              }
            }
            else if (calcForm === 'AVOS' && calcBaseName) {
              const baseVal = this.context.getVariable(calcBaseName);
              const effDivisor = divisor || 12;
              valorCalculado = (baseVal / effDivisor) * quantidade;
              formulaUsada = `AVOS(${calcBaseName} / ${effDivisor} * ${quantidade})`;
            }
            else if ((calcForm === 'DIAS' || calcForm === 'DAYS') && calcBaseName) {
              const baseVal = this.context.getVariable(calcBaseName);
              const perc = percentage || 100;
              valorCalculado = (baseVal / 30) * quantidade * (perc / 100);
              formulaUsada = `DIAS(${calcBaseName} / 30 * ${quantidade})`;
            }
            else if (calcForm === 'FIXO' || calcForm === 'FIXED') {
              const effectiveBase = calcBaseName || (isSalaryBase ? 'SALARIO_BASE' : null);

              if (
                effectiveBase &&
                isSalaryBase &&
                (eventos.length > 0 ||
                  (['CLT', 'APPRENTICE'].includes(this.context.calculation_regime) &&
                    !['107', '110', '111', '112', '115', '116', '117', '119', '123', '124', '125'].includes(rubric.code)))
              ) {
                const val = this.context.getVariable(effectiveBase);
                // Proporcionaliza o salário base se admissão/rescisão ocorreu no mês (T22: orientado a kind)
                if (this.context.dias_trabalhados < 30) {
                  valorCalculado = (val / 30) * this.context.dias_trabalhados;
                } else {
                  valorCalculado = val;
                }
                formulaUsada = `FIXO(${effectiveBase})`;
              } else if (rubric.manual_value || quantidade > 0) {
                // Se não tem base mas tem um valor/quantidade passada, usa como fallback de valor fixo
                valorCalculado = rubric.manual_value || quantidade;
              } else {
                // Evita pagar a base integral se a quantidade e valor são zerados
                valorCalculado = 0;
                formulaUsada = 'SEM_VALOR_MANUAL';
              }
            }
          }

          valorCalculado = round2(valorCalculado);

          if (valorCalculado !== 0) {
            // Adiciona memória
            this.context.addMemory({
              rubric_id: rubric.id,
              step_name: rubric.name,
              base_value: calcBaseName && this.context.hasVariable(calcBaseName) ? this.context.getVariable(calcBaseName) : 0,
              quantity_used: quantidade,
              percentage_used: percentage || 0,
              parsed_formula: formulaUsada,
              result_value: valorCalculado,
              origin: rubric.calculation_form
            });

            // Atualiza totais
            if (rubric.type === 'EARNING') {
              this.context.total_proventos = addMoney(this.context.total_proventos, valorCalculado);
            } else if (rubric.type === 'DEDUCTION') {
              this.context.total_descontos = addMoney(this.context.total_descontos, valorCalculado);
            }

            // T17: Registra total de Pensão Alimentícia judicial
            if (isAlimony) {
              this.context.total_alimony = addMoney(this.context.total_alimony, valorCalculado);
            }
            if (isFamilySalary && hasManualValue) {
              hasManualFamilySalaryOverride = true;
              familySalaryTotal = addMoney(familySalaryTotal, valorCalculado);
            }

            // BUG-06 fix: Atualiza Bases Legais com clamping >= 0 — Descontos SUBTRAEM das bases
            // 1ª Parcela do 13º (THIRTEENTH_1) não gera base de INSS nem de IRRF (Lei 4.090/62 e Lei 4.749/65)
            if (rubric.incidencias.gera_base_inss && this.context.tipo_folha !== 'THIRTEENTH_1') {
              const delta = rubric.type === 'DEDUCTION' ? -valorCalculado : valorCalculado;
              this.context.base_inss = Math.max(0, round2(this.context.base_inss + delta));
            }
            if (rubric.incidencias.gera_base_irrf && this.context.tipo_folha !== 'THIRTEENTH_1') {
              const delta = rubric.type === 'EARNING' ? valorCalculado : -valorCalculado;
              this.context.base_irrf = Math.max(0, round2(this.context.base_irrf + delta));
            }
            if (rubric.incidencias.gera_base_fgts) {
              const delta = rubric.type === 'DEDUCTION' ? -valorCalculado : valorCalculado;
              this.context.base_fgts = Math.max(0, round2(this.context.base_fgts + delta));
            }

            // Acumula bases dinâmicas (BUG-07: Súmula 264 TST + OJ 97 SDI-1 TST)
            // BASE_HORA_EXTRA inicia com salário contratual integral (no PayrollContext) e soma adicionais habituais (SEM noturno).
            // BASE_HORA_EXTRA_NOTURNA soma adicionais habituais + adicional noturno.
            if (isInsalubridade || isPericulosidade || (rubric.category === 'ALLOWANCE' && !isAdicionalNoturno)) {
              const currentBaseHE = this.context.getVariable('BASE_HORA_EXTRA') || this.context.salario_base;
              this.context.setVariable('BASE_HORA_EXTRA', addMoney(currentBaseHE, valorCalculado));

              const currentBaseHENot = this.context.getVariable('BASE_HORA_EXTRA_NOTURNA') || this.context.salario_base;
              this.context.setVariable('BASE_HORA_EXTRA_NOTURNA', addMoney(currentBaseHENot, valorCalculado));
            }
            if (isAdicionalNoturno) {
              const currentBaseHENot = this.context.getVariable('BASE_HORA_EXTRA_NOTURNA') || this.context.salario_base;
              this.context.setVariable('BASE_HORA_EXTRA_NOTURNA', addMoney(currentBaseHENot, valorCalculado));
            }

            // BASE_DSR inclui horas extras, comissões e demais variáveis habituais com flag integra_dsr
            const integraDsr = (rubric.incidencias as any)?.integra_dsr === true || (rubric as any).integra_dsr === true;
            if (isOvertime || isCommission || integraDsr) {
              const currentBaseDSR = this.context.getVariable('BASE_DSR') || 0;
              this.context.setVariable('BASE_DSR', addMoney(currentBaseDSR, valorCalculado));
            }
            if (isAdicionalNoturno) {
              const currentBaseDSRNoturno = this.context.getVariable('BASE_DSR_NOTURNO') || 0;
              this.context.setVariable('BASE_DSR_NOTURNO', addMoney(currentBaseDSRNoturno, valorCalculado));

              // Se a empresa não possui rubrica específica de DSR_NOTURNO no catálogo, o noturno integra o DSR geral (quando não já somado por integra_dsr)
              const hasSpecificDsrNoturno = Array.from(this.context.rubricas.values()).some(
                r => r.rubric_kind === 'DSR_NOTURNO' || r.code === '171' || r.code === '402' || (r.name || '').toUpperCase().includes('DSR SOBRE ADICIONAL NOTURNO')
              );
              if (!hasSpecificDsrNoturno && !integraDsr) {
                const currentBaseDSR = this.context.getVariable('BASE_DSR') || 0;
                this.context.setVariable('BASE_DSR', addMoney(currentBaseDSR, valorCalculado));
              }
            }

          } else if (hasManualValue) {
            // Registro explícito na memória de cálculo quando um evento manual for lançado com valor 0
            this.context.addMemory({
              rubric_id: rubric.id,
              step_name: rubric.name,
              base_value: calcBaseName && this.context.hasVariable(calcBaseName) ? this.context.getVariable(calcBaseName) : 0,
              quantity_used: quantidade,
              percentage_used: percentage || 0,
              parsed_formula: formulaUsada,
              result_value: 0,
              origin: rubric.calculation_form
            });
          }

          // T24: Atualiza a variável com o código da rubrica (sempre com prefixo R{code})
          // Não salvar rubric.code puro para não colidir com constantes numéricas (ex: 220, 30)
          if (rubric.code) {
            this.context.setVariable(`R${rubric.code}`, valorCalculado);
          }
        } catch (err: any) {
          throw new Error(`[Rubrica ${rubric.code || 'S/C'} - ${rubric.name || 'Sem Nome'}] ${err.message}`);
        }
      }

      // 3.5. Salário-Família Automático (FOLHA-05 — Lei 8.213/91 / Decreto 3.048/99 / Rubrica 305)
      // Executado após todas as verbas de remuneração para avaliar base_inss real vs teto legal.
      if (
        !hasManualFamilySalaryOverride &&
        ['MONTHLY', 'COMPLEMENTARY', 'TERMINATION'].includes(this.context.tipo_folha) &&
        this.context.family_salary_dependents.length > 0
      ) {
        const [compMonthRaw, compYearRaw] = String(this.context.competencia || '').split('/');
        const compMonth = Number(compMonthRaw) || 1;
        const compYear = Number(compYearRaw) || 2026;
        const familyCeiling = Number(
          this.context.general_legal_parameters?.family_salary_ceiling ??
          this.context.general_legal_parameters?.family_salary_limit ??
          0
        );
        const familyQuota = Number(
          this.context.general_legal_parameters?.family_salary_value ??
          this.context.general_legal_parameters?.family_salary_quota ??
          0
        );

        if (familyCeiling > 0 && familyQuota > 0) {
          const combinedMonthlyInssBase = addMoney(
            this.context.base_inss,
            this.context.base_inss_already_taxed
          );

          familySalaryEvaluation = FamilyAllowanceCalculator.calculate({
            dependents: this.context.family_salary_dependents,
            competenceYear: compYear,
            competenceMonth: compMonth,
            monthlyInssBase: combinedMonthlyInssBase,
            contractualSalary: this.context.salario_base,
            familySalaryCeiling: familyCeiling,
            quotaValue: familyQuota,
            admissionDate: this.context.admission_date,
            terminationDate: this.context.termination_date,
            employeeRegime: this.context.employee_regime,
            hasInssIncidence: this.context.contract_incidences?.has_inss !== false,
            isFullMonthUnpaidOrInssBenefit: this.context.has_unpaid_or_inss_only_month,
          });

          this.context.setVariable('NUM_DEPENDENTES_SF', familySalaryEvaluation.eligibleDependentsCount);
          this.context.setVariable('PROPORCAO_SF', familySalaryEvaluation.proportionalFactor);

          const allRubrics = Array.from(this.context.rubricas.values());
          const rubricFamilySalary =
            allRubrics.find((r) => r.code === '305' && r.type === 'EARNING') ||
            allRubrics.find((r) => r.rubric_kind === 'FAMILY_SALARY' && r.type === 'EARNING');

          if (familySalaryEvaluation.totalAmount > 0) {
            if (!rubricFamilySalary) {
              throw new Error('Rubrica de sistema obrigatória ausente no catálogo: [305 - Salário-Família]');
            }

            familySalaryTotal = familySalaryEvaluation.totalAmount;
            this.context.total_proventos = addMoney(this.context.total_proventos, familySalaryTotal);
            this.context.setVariable(`R${rubricFamilySalary.code}`, familySalaryTotal);

            this.context.addMemory({
              rubric_id: rubricFamilySalary.id,
              step_name: rubricFamilySalary.name,
              base_value: familySalaryEvaluation.referenceRemunerationForCeiling,
              quantity_used: familySalaryEvaluation.eligibleDependentsCount,
              percentage_used: round2(familySalaryEvaluation.proportionalFactor * 100),
              parsed_formula: familySalaryEvaluation.formulaDescription,
              result_value: familySalaryTotal,
              origin: 'AUTOMATICA',
            });
          }

          if (familySalaryEvaluation.complianceAlerts.length > 0 && familySalaryEvaluation.eligibleByRegime && familySalaryEvaluation.eligibleByCeiling) {
            this.context.addMemory({
              rubric_id: 'VALIDACAO',
              step_name: 'ALERTA: Salário-Família (Vacina/Escola)',
              base_value: familySalaryEvaluation.referenceRemunerationForCeiling,
              quantity_used: familySalaryEvaluation.complianceAlerts.length,
              percentage_used: 0,
              parsed_formula: familySalaryEvaluation.complianceAlerts
                .map((a) => `${a.name}: ${a.reason}`)
                .join(' | '),
              result_value: 0,
              origin: 'COMPLIANCE_ALERT',
            });
          }
        }
      }

      // 4. Cálculos Legais
      let inssResult: { value: number; breakdown: any[]; totalCalculated?: number; alreadyTaxedValue?: number } = { value: 0, breakdown: [] };
      let irrfResult: {
        value: number;
        legalBase: number;
        usedSimplified: boolean;
        reductionAmount?: number;
      } = { value: 0, legalBase: 0, usedSimplified: false, reductionAmount: 0 };
      let fgtsResult: { value: number; rate: number } = { value: 0, rate: 8.0 };
      let effectiveFgtsBase = 0;
      let irrfCashLedgerEntry: IrrfCashLedgerSnapshot | null = null;
      let alimonySplits: AlimonySplitResult[] = [];
      let alimonySolverTrace: AlimonySolverTraceStep[] = [];
      let resolvedIndMv: IndMVCode | null = null;
      let otherEmploymentsBase = 0;
      let otherEmploymentsInss = 0;

      const applyAlimonyAndIrrf = (params: {
        baseIrrfBruta: number;
        inssValue: number;
        bucket: IrrfTaxationBucket;
        skipIrrfCalculation?: boolean;
      }): IrrfCashConsolidatedResult | null => {
        const dependentes = this.context.getVariable('DEPENDENTES') || 0;
        const manualAlimony = this.context.total_alimony || 0;
        const beneficiaries = this.context.alimony_beneficiaries || [];

        if (beneficiaries.length === 0) {
          if (params.skipIrrfCalculation) {
            return null;
          }
          if (this.context.irrf_regime === 'CASH') {
            const cashRes = IRRFCalculator.calculateCashConsolidated({
              current: {
                grossIncome: params.baseIrrfBruta,
                inss: params.inssValue,
                dependents: dependentes,
                alimony: manualAlimony,
              },
              priorEntries: this.context.prior_cash_irrf_entries,
              bucket: params.bucket,
              brackets: this.context.irrf_parameters,
              params: this.context.general_legal_parameters,
            });
            irrfResult = cashRes;
            return cashRes;
          }

          irrfResult = IRRFCalculator.calculate(
            params.baseIrrfBruta,
            params.inssValue,
            dependentes,
            this.context.irrf_parameters,
            this.context.general_legal_parameters,
            manualAlimony
          );
          return null;
        }

        const solved = AlimonySolver.solve({
          beneficiaries,
          grossForAlimony: this.context.total_proventos,
          baseSalary: this.context.salario_base,
          minimumWage: this.context.salario_minimo,
          inss: params.inssValue,
          manualNonSolverAlimony: manualAlimony,
          grossForIrrf: params.baseIrrfBruta,
          dependents: dependentes,
          irrfRegime: this.context.irrf_regime,
          irrfBucket: params.bucket,
          priorCashIrrfEntries: this.context.prior_cash_irrf_entries,
          irrfBrackets: this.context.irrf_parameters,
          generalLegalParameters: this.context.general_legal_parameters,
          skipIrrfCalculation: params.skipIrrfCalculation,
        });

        irrfResult = solved.irrfResult;
        alimonySplits = solved.splits;
        alimonySolverTrace = solved.trace;

        if (solved.solvedAlimonyTotal > 0) {
          this.context.total_alimony = addMoney(this.context.total_alimony, solved.solvedAlimonyTotal);
          this.context.total_descontos = addMoney(this.context.total_descontos, solved.solvedAlimonyTotal);

          const allRubrics = Array.from(this.context.rubricas.values());
          const defaultAlimonyRubric =
            allRubrics.find((r) => r.code === '904' && r.type === 'DEDUCTION') ||
            allRubrics.find((r) => r.code === '804' && r.type === 'DEDUCTION') ||
            allRubrics.find((r) => r.rubric_kind === 'ALIMONY' && r.type === 'DEDUCTION');

          const groupedByRubric = new Map<
            string,
            { rubric: typeof defaultAlimonyRubric; total: number; baseMax: number; pctSum: number; names: string[] }
          >();

          for (const split of solved.splits) {
            if (split.amount <= 0) continue;
            const targetRubric =
              (split.rubric_id ? this.context.rubricas.get(split.rubric_id) : undefined) ||
              defaultAlimonyRubric;
            if (!targetRubric) {
              throw new Error('Rubrica de sistema obrigatória ausente no catálogo: [904 - Pensão Alimentícia Judicial]');
            }
            const prev = groupedByRubric.get(targetRubric.id) || {
              rubric: targetRubric,
              total: 0,
              baseMax: 0,
              pctSum: 0,
              names: [],
            };
            prev.total = addMoney(prev.total, split.amount);
            prev.baseMax = Math.max(prev.baseMax, split.base_amount);
            prev.pctSum = addMoney(prev.pctSum, split.percentage_applied);
            prev.names.push(
              `${split.beneficiary_name}: R$ ${split.amount.toFixed(2)} (${split.calculation_basis})`
            );
            groupedByRubric.set(targetRubric.id, prev);
          }

          for (const grp of groupedByRubric.values()) {
            if (!grp.rubric) continue;
            this.context.addMemory({
              rubric_id: grp.rubric.id,
              step_name: grp.rubric.name,
              base_value: round2(grp.baseMax),
              quantity_used: solved.splits.filter((s) => s.amount > 0).length,
              percentage_used: round2(grp.pctSum),
              parsed_formula: `${grp.names.join(' + ')} [IRRF Conv: R$ ${irrfResult.value.toFixed(2)}]`,
              result_value: round2(grp.total),
              origin: 'ALIMONY_SOLVER',
            });
          }
        }

        if (solved.splits.length > 0) {
          this.context.addMemory({
            rubric_id: 'SOLVER_PENSAO',
            step_name: 'Solver Circular Pensão ↔ IRRF',
            base_value: solved.finalNetBase,
            quantity_used: solved.iterations,
            percentage_used: solved.netPercentageSum,
            parsed_formula: solved.traceSummary,
            result_value: solved.solvedAlimonyTotal,
            origin: 'SOLVER_TRACE',
          });
        }

        return solved.cashIrrfResult;
      };

      // Valida Incidências Baseadas no Contrato (Pró-Labore, Estágio, CLT)
      if (this.context.contract_incidences) {
        if (this.context.contract_incidences.has_inss === false) this.context.base_inss = 0;
        if (this.context.contract_incidences.has_fgts === false) this.context.base_fgts = 0;
      }

      const resolveCashYearMonth = (): { cashYear: number; cashMonth: number; paymentDate: string } => {
        if (this.context.payment_date && /^\d{4}-\d{2}-\d{2}/.test(this.context.payment_date)) {
          const iso = this.context.payment_date.slice(0, 10);
          return {
            cashYear: Number(iso.slice(0, 4)),
            cashMonth: Number(iso.slice(5, 7)),
            paymentDate: iso,
          };
        }
        const [compMonthStr, compYearStr] = String(this.context.competencia || '').split('/');
        const compMonth = Number(compMonthStr) || 1;
        const compYear = Number(compYearStr) || 2026;
        return {
          cashYear: compYear,
          cashMonth: compMonth,
          paymentDate: `${compYear}-${String(compMonth).padStart(2, '0')}-20`,
        };
      };

      const buildIrrfMemoryDesc = (
        res: IrrfCashConsolidatedResult | null,
        baseIrrfBruta: number,
        totalAlimony: number
      ): string => {
        if (res && this.context.irrf_regime === 'CASH') {
          const regimeLabel = res.usedSimplified ? 'Simplificada' : 'Deduções Legais';
          const priorInfo =
            res.priorEntriesCount > 0 || res.priorIrrfWithheld > 0
              ? ` | Acumulado Caixa: R$ ${res.accumulatedGross.toFixed(2)} (INSS Acum: R$ ${res.accumulatedInss.toFixed(2)}, IRRF Total Caixa: R$ ${res.totalCashIrrf.toFixed(2)}, Já Retido: R$ ${res.priorIrrfWithheld.toFixed(2)})`
              : '';
          return `Regime Caixa [${res.bucket}] ${regimeLabel} (Bruto Atual: R$ ${baseIrrfBruta.toFixed(2)}, Redutor: ${res.reductionAmount ?? 0}${totalAlimony > 0 ? `, Pensão: R$ ${totalAlimony.toFixed(2)}` : ''}${priorInfo})`;
        }
        return totalAlimony > 0
          ? `${irrfResult.usedSimplified ? 'Simplificada' : 'Deduções Legais'} (Bruto: ${baseIrrfBruta}, Redutor: ${irrfResult.reductionAmount ?? 0}, Pensão Alimentícia: R$ ${totalAlimony.toFixed(2)})`
          : `${irrfResult.usedSimplified ? 'Simplificada' : 'Deduções Legais'} (Bruto: ${baseIrrfBruta}, Redutor: ${irrfResult.reductionAmount ?? 0})`;
      };

      if (this.context.tipo_folha === 'ADVANCE') {
        const shouldWithholdAdvanceIrrf =
          this.context.withhold_irrf_on_advance && this.context.irrf_regime === 'CASH';
        const hasAlimonyBeneficiaries = this.context.alimony_beneficiaries.length > 0;

        // FOLHA-02 + FOLHA-03: Adiantamento retém IRRF em Regime de Caixa (se habilitado) e/ou Pensão (se apply_on_advance=true)
        if (shouldWithholdAdvanceIrrf || hasAlimonyBeneficiaries) {
          const baseAdvBruta =
            this.context.base_irrf > 0 ? this.context.base_irrf : this.context.total_proventos;
          const dependentes = this.context.getVariable('DEPENDENTES') || 0;
          const cashRes = applyAlimonyAndIrrf({
            baseIrrfBruta: baseAdvBruta,
            inssValue: 0,
            bucket: 'MONTHLY_CASH',
            skipIrrfCalculation: !shouldWithholdAdvanceIrrf,
          });
          const totalAlimony = this.context.total_alimony || 0;

          if (shouldWithholdAdvanceIrrf) {
            this.context.base_irrf = round2(irrfResult.legalBase);

            if (irrfResult.value > 0) {
              this.context.total_descontos = addMoney(this.context.total_descontos, irrfResult.value);
            }

            const rubricIrrf = Array.from(this.context.rubricas.values()).find((r) => r.code === '902');
            if (irrfResult.value > 0 && !rubricIrrf) {
              throw new Error('Rubrica de sistema obrigatória ausente no catálogo: [902 - IRRF Mensal]');
            }

            if (rubricIrrf && (baseAdvBruta > 0 || irrfResult.value > 0)) {
              this.context.addMemory({
                rubric_id: rubricIrrf.id,
                step_name: 'IRRF',
                base_value: irrfResult.legalBase,
                quantity_used: 1,
                percentage_used: 0,
                parsed_formula: buildIrrfMemoryDesc(cashRes, baseAdvBruta, totalAlimony),
                result_value: irrfResult.value,
                origin: 'AUTOMATICA',
              });
            }

            const { cashYear, cashMonth, paymentDate } = resolveCashYearMonth();
            const depDed = round2(
              dependentes * Number(this.context.general_legal_parameters?.dependent_deduction || 0)
            );
            irrfCashLedgerEntry = {
              cash_year: cashYear,
              cash_month: cashMonth,
              payment_date: paymentDate,
              taxation_bucket: 'MONTHLY_CASH',
              gross_taxable: round2(baseAdvBruta),
              inss_deducted: 0,
              alimony_deducted: round2(totalAlimony),
              dependents_deducted: depDed,
              simplified_used: irrfResult.usedSimplified,
              irrf_withheld: irrfResult.value,
            };
          }
        }
      } else {
        // T1: Guarda base bruta de IRRF ANTES de processar o INSS
        const baseIrrfBruta = this.context.base_irrf;

        // FOLHA-11: Férias partidas entre dois meses — rateio de INSS/FGTS por competência, IRRF integral no caixa
        if (
          this.context.tipo_folha === 'VACATION' &&
          this.context.vacation_inss_base_override !== undefined &&
          this.context.vacation_inss_base_override !== null &&
          this.context.vacation_inss_base_override >= 0
        ) {
          this.context.base_inss = round2(this.context.vacation_inss_base_override);
        }
        if (
          this.context.tipo_folha === 'VACATION' &&
          this.context.vacation_fgts_base_override !== undefined &&
          this.context.vacation_fgts_base_override !== null &&
          this.context.vacation_fgts_base_override >= 0
        ) {
          this.context.base_fgts = round2(this.context.vacation_fgts_base_override);
        }

        // INSS (T16 + FOLHA-06 + FOLHA-15 Multi-Regime)
        let baseIrrfBrutaRegime = baseIrrfBruta;
        const isSpecialFixedInssRegime = ['PRO_LABORE', 'AUTONOMOUS_RPA', 'INTERN'].includes(
          this.context.calculation_regime
        );

        if (isSpecialFixedInssRegime) {
          // Lê teto real da última faixa do INSS quando disponível
          const maxBracketLimit =
            (this.context.inss_parameters || []).reduce(
              (mx, b) => (b.base_limit !== null && b.base_limit > mx ? b.base_limit : mx),
              0
            ) || 8157.41;

          const specialExact = MultiRegimeCalculator.calculateTaxesByRegime({
            regime: this.context.calculation_regime,
            grossRemuneration:
              this.context.calculation_regime === 'INTERN'
                ? this.context.total_proventos
                : this.context.base_inss > 0
                  ? this.context.base_inss
                  : this.context.total_proventos,
            inssCeiling: maxBracketLimit,
            minimumWage: this.context.salario_minimo,
            autonomousServiceType: this.context.autonomous_service_type,
            issRate: this.context.iss_rate,
            priorInssBaseInMonth: this.context.base_inss_already_taxed,
            dependentsCount: this.context.getVariable('DEPENDENTES') || 0,
            alimony: this.context.total_alimony || 0,
            inssParameters: this.context.inss_parameters || [],
            irrfParameters: this.context.irrf_parameters || [],
            generalLegalParameters: this.context.general_legal_parameters || {},
          });

          this.context.base_inss = specialExact.baseInss;
          this.context.base_fgts = 0;
          baseIrrfBrutaRegime = specialExact.baseIrrfGross;

          inssResult = {
            value: specialExact.inssEmployee,
            breakdown: [],
          };

          if (inssResult.value > 0) {
            this.context.total_descontos = addMoney(this.context.total_descontos, inssResult.value);
            const rubricInss = Array.from(this.context.rubricas.values()).find((r) => r.code === '901');
            if (rubricInss) {
              this.context.addMemory({
                rubric_id: rubricInss.id,
                step_name: 'INSS',
                base_value: specialExact.baseInss,
                quantity_used: 1,
                percentage_used: 11,
                parsed_formula: specialExact.notes[0] || `INSS ${this.context.calculation_regime} 11%`,
                result_value: inssResult.value,
                origin: 'MULTI_REGIME',
              });
            }
          }

          if (specialExact.sestSenatDeduction > 0) {
            this.context.total_descontos = addMoney(this.context.total_descontos, specialExact.sestSenatDeduction);
            const r916 = Array.from(this.context.rubricas.values()).find((r) => r.code === '916');
            if (r916) {
              this.context.addMemory({
                rubric_id: r916.id,
                step_name: r916.name,
                base_value: specialExact.baseInss,
                quantity_used: 1,
                percentage_used: 2.5,
                parsed_formula: `SEST 1.5% + SENAT 1.0% sobre base reduzida R$ ${specialExact.baseInss.toFixed(2)}`,
                result_value: specialExact.sestSenatDeduction,
                origin: 'MULTI_REGIME',
              });
            }
          }

          if (specialExact.issDeduction > 0) {
            this.context.total_descontos = addMoney(this.context.total_descontos, specialExact.issDeduction);
            const r917 = Array.from(this.context.rubricas.values()).find((r) => r.code === '917');
            if (r917) {
              this.context.addMemory({
                rubric_id: r917.id,
                step_name: r917.name,
                base_value: this.context.total_proventos,
                quantity_used: 1,
                percentage_used: this.context.iss_rate,
                parsed_formula: `ISS ${this.context.iss_rate}% sobre R$ ${this.context.total_proventos.toFixed(2)}`,
                result_value: specialExact.issDeduction,
                origin: 'MULTI_REGIME',
              });
            }
          }
        } else {
          const mvInssResult = MultipleEmploymentINSSCalculator.calculate({
            currentBaseInss: this.context.base_inss,
            priorSameContractBaseInss: this.context.base_inss_already_taxed,
            otherEmployments: this.context.other_employments,
            inssBrackets: this.context.inss_parameters || [],
          });
          inssResult = {
            value: mvInssResult.value,
            breakdown: mvInssResult.breakdown,
          };
          resolvedIndMv = mvInssResult.indMv;
          otherEmploymentsBase = mvInssResult.externalBaseTotal;
          otherEmploymentsInss = mvInssResult.externalInssWithheldTotal;

          if (
            inssResult.value > 0 ||
            this.context.base_inss_already_taxed > 0 ||
            mvInssResult.hasMultipleEmployments
          ) {
            if (inssResult.value > 0) {
              this.context.total_descontos = addMoney(this.context.total_descontos, inssResult.value);
            }

            const rubricInss = Array.from(this.context.rubricas.values()).find((r) => r.code === '901');
            if (!rubricInss) {
              throw new Error('Rubrica de sistema obrigatória ausente no catálogo: [901 - Contribuição INSS]');
            }

            this.context.addMemory({
              rubric_id: rubricInss.id,
              step_name: 'INSS',
              base_value: this.context.base_inss,
              quantity_used: 1,
              percentage_used: 0,
              parsed_formula: mvInssResult.formulaDescription,
              result_value: inssResult.value,
              origin: mvInssResult.hasMultipleEmployments ? 'MULTIPLOS_VINCULOS' : 'AUTOMATICA',
            });
          }

          // Alerta DARF Complementação INSS para Intermitente abaixo do salário mínimo (EC 103/2019)
          if (
            this.context.calculation_regime === 'INTERMITTENT' &&
            this.context.base_inss > 0 &&
            this.context.base_inss < this.context.salario_minimo
          ) {
            const minRate = ((this.context.inss_parameters || [])[0]?.aliquot || 7.5) / 100;
            const compDarf = round2(subtractMoney(this.context.salario_minimo, this.context.base_inss) * minRate);
            this.context.addMemory({
              rubric_id: 'VALIDACAO',
              step_name: 'ALERTA: DARF Complementação INSS (Intermitente)',
              base_value: this.context.base_inss,
              quantity_used: 1,
              percentage_used: round2(minRate * 100),
              parsed_formula: `Remuneração R$ ${this.context.base_inss.toFixed(2)} < Mínimo R$ ${this.context.salario_minimo.toFixed(2)}. DARF Cód 1872 estimada: R$ ${compDarf.toFixed(2)}`,
              result_value: 0,
              origin: 'INTERMITTENT_INSS_ALERT',
            });
          }
        }

        // IRRF + Pensão Alimentícia (FOLHA-02 Regime Caixa + FOLHA-03 Solver Circular Pensão ↔ IRRF + FOLHA-12 13º Complementar)
        const dependentes = this.context.getVariable('DEPENDENTES') || 0;
        const bucket = resolveIrrfTaxationBucket(this.context.tipo_folha);
        let cashRes: IrrfCashConsolidatedResult | null = null;
        if (
          this.context.tipo_folha === 'THIRTEENTH_COMPLEMENTARY' &&
          this.context.prior_thirteenth_irrf_entry
        ) {
          const prior = this.context.prior_thirteenth_irrf_entry;
          const accGross = addMoney(prior.gross_taxable, baseIrrfBruta);
          const accInss = addMoney(prior.inss_deducted, inssResult.value);
          const accAlimony = addMoney(prior.alimony_deducted, this.context.total_alimony || 0);
          const full13Irrf = IRRFCalculator.calculate(
            accGross,
            accInss,
            dependentes,
            this.context.irrf_parameters,
            this.context.general_legal_parameters,
            accAlimony
          );
          const diffIrrf = Math.max(0, subtractMoney(full13Irrf.value, prior.irrf_withheld));
          irrfResult = {
            value: diffIrrf,
            legalBase: full13Irrf.legalBase,
            usedSimplified: full13Irrf.usedSimplified,
            reductionAmount: full13Irrf.reductionAmount,
          };
        } else {
          cashRes = applyAlimonyAndIrrf({
            baseIrrfBruta: baseIrrfBrutaRegime,
            inssValue: inssResult.value,
            bucket,
            skipIrrfCalculation: this.context.tipo_folha === 'THIRTEENTH_1',
          });
        }
        const totalAlimony = this.context.total_alimony || 0;

        if (irrfResult.value > 0) {
          this.context.total_descontos = addMoney(this.context.total_descontos, irrfResult.value);
        }

        const rubricIrrf = Array.from(this.context.rubricas.values()).find((r) => r.code === '902');
        if (irrfResult.value > 0 && !rubricIrrf) {
          throw new Error('Rubrica de sistema obrigatória ausente no catálogo: [902 - IRRF Mensal]');
        }

        if (rubricIrrf && (baseIrrfBrutaRegime > 0 || irrfResult.value > 0)) {
          this.context.addMemory({
            rubric_id: rubricIrrf.id,
            step_name: 'IRRF',
            base_value: irrfResult.legalBase,
            quantity_used: 1,
            percentage_used: 0,
            parsed_formula: buildIrrfMemoryDesc(cashRes, baseIrrfBrutaRegime, totalAlimony),
            result_value: irrfResult.value,
            origin: 'AUTOMATICA',
          });
        }

        if (this.context.irrf_regime === 'CASH' && this.context.tipo_folha !== 'THIRTEENTH_1') {
          const { cashYear, cashMonth, paymentDate } = resolveCashYearMonth();
          const depDed = round2(
            dependentes * Number(this.context.general_legal_parameters?.dependent_deduction || 0)
          );
          irrfCashLedgerEntry = {
            cash_year: cashYear,
            cash_month: cashMonth,
            payment_date: paymentDate,
            taxation_bucket: bucket,
            gross_taxable: round2(baseIrrfBrutaRegime),
            inss_deducted: round2(inssResult.value),
            alimony_deducted: round2(totalAlimony),
            dependents_deducted: depDed,
            simplified_used: irrfResult.usedSimplified,
            irrf_withheld: irrfResult.value,
          };
        }

        // FGTS (T19 + BUG-03 + FOLHA-15: zero FGTS em Pró-Labore/RPA/Estágio)
        effectiveFgtsBase = isSpecialFixedInssRegime
          ? 0
          : Math.max(0, subtractMoney(this.context.base_fgts, this.context.fgts_base_already_taxed));
        fgtsResult = FGTSCalculator.calculate(
          effectiveFgtsBase,
          this.context.is_apprentice,
          this.context.general_legal_parameters?.fgts_standard_aliquot,
          this.context.general_legal_parameters?.fgts_apprentice_aliquot
        );
        if (fgtsResult.value > 0) {
          const rubricFgts = Array.from(this.context.rubricas.values()).find((r) => r.code === '903');
          if (!rubricFgts) {
            throw new Error('Rubrica de sistema obrigatória ausente no catálogo: [903 - FGTS Mensal]');
          }

          this.context.addMemory({
            rubric_id: rubricFgts.id,
            step_name: 'FGTS',
            base_value: effectiveFgtsBase,
            quantity_used: 1,
            percentage_used: fgtsResult.rate,
            parsed_formula: `${effectiveFgtsBase} * ${(fgtsResult.rate / 100).toFixed(2)}${this.context.fgts_base_already_taxed > 0 ? ` (Diferencial 13º: Bruto ${this.context.base_fgts} - 1ª Parc ${this.context.fgts_base_already_taxed})` : ''}${this.context.is_apprentice ? ' [MENOR APRENDIZ]' : ''}`,
            result_value: fgtsResult.value,
            origin: 'AUTOMATICA',
          });
        }
      }

      // 5. FOLHA-07: Prioridade de Descontos, Trava de Margem Consignável (35%) e Insuficiência de Saldo (499/899)
      const allRubrics = Array.from(this.context.rubricas.values());
      let consignableMargin = 0;
      let consignableLoanCapped = false;

      // 5.1 Trava de Consignados (Lei 10.820/2003: Margem Máxima de 35% da Remuneração Disponível)
      const loanMemIndex = this.context.memoria.findIndex((m) => {
        if (!m.rubric_id) return false;
        const rub = this.context.rubricas.get(m.rubric_id);
        if (!rub) return false;
        return (String(rub.code) === '805' || String(rub.rubric_kind).toUpperCase() === 'LOAN') && rub.type === 'DEDUCTION';
      });

      if (loanMemIndex !== -1 && this.context.memoria[loanMemIndex].result_value > 0) {
        const rubricLoan = this.context.rubricas.get(this.context.memoria[loanMemIndex].rubric_id!)!;
        const originalLoanAmount = this.context.memoria[loanMemIndex].result_value;

        // Descontos compulsórios legais com prioridade < 40 (INSS, IRRF, Pensão, Faltas/DSR, Adiantamento, Débito Anterior)
        let compulsoryDeductions = 0;

        for (const m of this.context.memoria) {
          if (m.rubric_id === rubricLoan.id || m.rubric_id === 'VALIDACAO' || m.rubric_id === 'SOLVER_PENSAO' || m.rubric_id === 'TRAVA_CONSIGNADO') continue;
          const targetRubric = this.context.rubricas.get(m.rubric_id);
          if (targetRubric && targetRubric.type === 'DEDUCTION') {
            const prio = DiscountPriorityManager.resolvePriority(targetRubric);
            if (prio < 40) {
              compulsoryDeductions = addMoney(compulsoryDeductions, m.result_value);
            }
          }
        }

        const marginEval = DiscountPriorityManager.evaluateConsignableMargin({
          grossEarnings: this.context.total_proventos,
          compulsoryDeductions,
          requestedLoanAmount: originalLoanAmount,
        });

        consignableMargin = marginEval.maxConsignableLimit;

        if (marginEval.isCapped) {
          consignableLoanCapped = true;
          const deltaLoan = subtractMoney(originalLoanAmount, marginEval.effectiveLoanAmount);
          this.context.total_descontos = subtractMoney(this.context.total_descontos, deltaLoan);
          this.context.memoria[loanMemIndex].result_value = marginEval.effectiveLoanAmount;
          this.context.memoria[loanMemIndex].parsed_formula = `${this.context.memoria[loanMemIndex].parsed_formula || ''} [LIMITADO MARGEM 35%: Solicitado R$ ${originalLoanAmount.toFixed(2)}, Teto R$ ${marginEval.maxConsignableLimit.toFixed(2)}]`;

          this.context.addMemory({
            rubric_id: 'TRAVA_CONSIGNADO',
            step_name: 'Trava Margem Consignável (Lei 10.820/2003)',
            base_value: marginEval.availableNetForMargin,
            quantity_used: 1,
            percentage_used: 35.0,
            parsed_formula: `Base Disponível R$ ${marginEval.availableNetForMargin.toFixed(2)} * 35% = Margem R$ ${marginEval.maxConsignableLimit.toFixed(2)}. Parcela cortada de R$ ${originalLoanAmount.toFixed(2)} para R$ ${marginEval.effectiveLoanAmount.toFixed(2)}`,
            result_value: marginEval.effectiveLoanAmount,
            origin: 'LEI_10820_MARGIN_CAP',
          });
        }
      }

      // 5.2 Resolução de Saldo Negativo e Insuficiência de Saldo (CLT Art. 462 / Rubrica 499)
      let liquido = subtractMoney(this.context.total_proventos, this.context.total_descontos);
      let hasInsufficiency = false;
      let insufficiencyCredit = 0;

      if (liquido < 0) {
        const negativeAmount = round2(Math.abs(liquido));

        if (this.context.negative_net_policy === 'INSUFFICIENCY_CARRYOVER') {
          insufficiencyCredit = negativeAmount;
          hasInsufficiency = true;
          this.context.total_proventos = addMoney(this.context.total_proventos, insufficiencyCredit);
          liquido = 0.0;

          const rubric499 =
            allRubrics.find((r) => r.code === '499') ||
            allRubrics.find((r) => r.rubric_kind === 'INSUFFICIENCY_CREDIT') ||
            allRubrics.find((r) => r.code === '999');

          const rubric499Id = rubric499?.id || 'a0000000-0000-0000-0000-000000000499';
          const rubric499Name = rubric499?.name || 'Insuficiência de Saldo';

          this.context.setVariable('R499', insufficiencyCredit);

          this.context.addMemory({
            rubric_id: rubric499Id,
            step_name: rubric499Name,
            base_value: insufficiencyCredit,
            quantity_used: 1,
            percentage_used: 0,
            parsed_formula: `Insuficiência de Saldo (R$ 499) gerada: R$ ${insufficiencyCredit.toFixed(2)} para cobrir descontos excedentes e manter líquido CLT Art. 462 em R$ 0,00`,
            result_value: insufficiencyCredit,
            origin: 'INSUFFICIENCY_CARRYOVER',
          });
        } else if (this.context.negative_net_policy === 'CAP_OPTIONAL_DISCOUNTS') {
          let neededReduction = negativeAmount;
          // Reduz descontos de menor prioridade (prioridade >= 40)
          for (let i = this.context.memoria.length - 1; i >= 0 && neededReduction > 0; i--) {
            const memItem = this.context.memoria[i];
            const targetRubric = this.context.rubricas.get(memItem.rubric_id);
            if (targetRubric && targetRubric.type === 'DEDUCTION') {
              const prio = DiscountPriorityManager.resolvePriority(targetRubric);
              if (prio >= 40 && memItem.result_value > 0) {
                const cut = Math.min(memItem.result_value, neededReduction);
                memItem.result_value = subtractMoney(memItem.result_value, cut);
                this.context.total_descontos = subtractMoney(this.context.total_descontos, cut);
                neededReduction = subtractMoney(neededReduction, cut);
              }
            }
          }
          liquido = Math.max(0, subtractMoney(this.context.total_proventos, this.context.total_descontos));
        } else {
          // BLOCK
          this.context.addMemory({
            rubric_id: 'VALIDACAO',
            step_name: 'ALERTA: Líquido Negativo (Bloqueio CLT Art. 462)',
            base_value: this.context.total_proventos,
            quantity_used: 0,
            percentage_used: 0,
            parsed_formula: `Proventos ${this.context.total_proventos} - Descontos ${this.context.total_descontos} = ${liquido}`,
            result_value: liquido,
            origin: 'VALIDACAO',
          });
        }
      }

      return {
        total_proventos: round2(this.context.total_proventos),
        total_descontos: round2(this.context.total_descontos),
        total_inss: inssResult.value,
        total_irrf: irrfResult.value,
        total_fgts: fgtsResult.value,
        total_encargos_patronais: 0, // Outro escopo
        liquido: liquido,
        bases: {
          inss: round2(this.context.base_inss),
          irrf: round2(irrfResult.legalBase),
          fgts: round2(effectiveFgtsBase)
        },
        memoria_calculo: this.context.memoria,
        irrf_cash_ledger_entry: irrfCashLedgerEntry,
        alimony_splits: alimonySplits,
        alimony_solver_trace: alimonySolverTrace,
        total_family_salary: round2(familySalaryTotal),
        family_salary_evaluation: familySalaryEvaluation,
        ind_mv: resolvedIndMv,
        other_employments_base: round2(otherEmploymentsBase),
        other_employments_inss: round2(otherEmploymentsInss),
        has_insufficiency: hasInsufficiency,
        insufficiency_credit: round2(insufficiencyCredit),
        consignable_margin: round2(consignableMargin),
        consignable_loan_capped: consignableLoanCapped,
        status: liquido < 0 ? 'ALERTA_LIQUIDO_NEGATIVO' : 'CALCULADA'
      };

    } catch (e: any) {
      return {
        total_proventos: 0, total_descontos: 0, total_inss: 0, total_irrf: 0, total_fgts: 0, total_encargos_patronais: 0, liquido: 0,
        bases: { inss: 0, irrf: 0, fgts: 0 },
        memoria_calculo: [],
        status: `ERRO_CALCULO: ${e.message}`
      };
    }
  }
}
