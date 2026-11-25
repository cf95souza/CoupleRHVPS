import { Rubric } from '../engine/PayrollContext.js';

export class CircularDependencyException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircularDependencyException';
  }
}

export class DAGResolver {
  /**
   * Ordena as rubricas topologicamente resolvendo dependências de (BUG-07):
   * 1. calculation_base explícita (ID ou código com/sem prefixo R)
   * 2. Bases dinâmicas orientadas estritamente por rubric_kind e incidências
   *    (BASE_DSR, BASE_DSR_NOTURNO, BASE_HORA_EXTRA, BASE_HORA_EXTRA_NOTURNA)
   * 3. Referências explícitas R\d+ em fórmulas (sem regex numérica solta)
   * 4. Desempate determinístico por calculation_order (fallback 100) e código.
   */
  public static resolve(rubrics: Map<string, Rubric>): Rubric[] {
    const sorted: Rubric[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const currentPath: string[] = [];

    const graph = new Map<string, string[]>();
    const allRubrics = Array.from(rubrics.values());

    const compareRubrics = (a: Rubric, b: Rubric): number => {
      const orderA = a.calculation_order ?? 100;
      const orderB = b.calculation_order ?? 100;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return (a.code || '').localeCompare(b.code || '');
    };

    const upperName = (r: Rubric) => (r.name || '').toUpperCase();

    const isOvertime = (r: Rubric): boolean => {
      if (r.type !== 'EARNING') return false;
      if (r.rubric_kind) return r.rubric_kind === 'OVERTIME';
      return r.category === 'OVERTIME' || upperName(r).includes('HORA EXTRA');
    };

    const isCommission = (r: Rubric): boolean => {
      if (r.type !== 'EARNING') return false;
      if (r.rubric_kind) return r.rubric_kind === 'COMMISSION';
      const u = upperName(r);
      return r.category === 'COMMISSION' || u.includes('COMISSAO') || u.includes('COMISSÃO');
    };

    const isAdicNoturno = (r: Rubric): boolean => {
      if (r.type !== 'EARNING') return false;
      if (r.rubric_kind) return r.rubric_kind === 'ADIC_NOTURNO' || r.rubric_kind === 'NIGHT_SHIFT';
      const u = upperName(r);
      return u.includes('NOTURNO') && !u.includes('DSR');
    };

    const isInsalubridade = (r: Rubric): boolean => {
      if (r.type !== 'EARNING') return false;
      if (r.rubric_kind) return r.rubric_kind === 'INSALUBRIDADE' || r.rubric_kind === 'UNHEALTHY';
      return upperName(r).includes('INSALUBRIDADE');
    };

    const isPericulosidade = (r: Rubric): boolean => {
      if (r.type !== 'EARNING') return false;
      if (r.rubric_kind) return r.rubric_kind === 'PERICULOSIDADE' || r.rubric_kind === 'HAZARD';
      return upperName(r).includes('PERICULOSIDADE');
    };

    const isDsrNoturno = (r: Rubric): boolean => {
      if (r.type !== 'EARNING') return false;
      if (r.rubric_kind) return r.rubric_kind === 'DSR_NOTURNO';
      const u = upperName(r);
      return u.includes('DSR') && u.includes('NOTURNO');
    };

    const isDsr = (r: Rubric): boolean => {
      if (r.type !== 'EARNING') return false;
      if (r.rubric_kind) return r.rubric_kind === 'DSR';
      const u = upperName(r);
      return (r.category === 'DSR' || u.includes('DSR')) && !u.includes('NOTURNO') && !u.includes('FALTA');
    };

    const isAllowanceOther = (r: Rubric): boolean => {
      if (r.type !== 'EARNING') return false;
      return r.category === 'ALLOWANCE' && !isAdicNoturno(r) && !isDsr(r) && !isDsrNoturno(r);
    };

    // Montagem do grafo de dependências
    for (const rubric of allRubrics) {
      const depsSet = new Set<string>();

      // 1. Dependência por calculation_base explícita
      if (rubric.calculation_base) {
        if (rubrics.has(rubric.calculation_base) && rubric.calculation_base !== rubric.id) {
          depsSet.add(rubric.calculation_base);
        } else {
          const directCodeDep = allRubrics.find(
            other =>
              other.id !== rubric.id &&
              (other.code === rubric.calculation_base || `R${other.code}` === rubric.calculation_base)
          );
          if (directCodeDep) {
            depsSet.add(directCodeDep.id);
          }
        }
      }

      // 2. Bases dinâmicas orientadas a rubric_kind e incidências
      // 2.1 BASE_DSR: depende de OVERTIME, COMMISSION, ADIC_NOTURNO (quando aplicável) e qualquer rubrica com integra_dsr = true
      if (rubric.calculation_base === 'BASE_DSR' || isDsr(rubric)) {
        for (const other of allRubrics) {
          if (other.id === rubric.id || other.type !== 'EARNING') continue;
          const integraDsr = other.incidencias?.integra_dsr === true;
          if (isOvertime(other) || isCommission(other) || isAdicNoturno(other) || integraDsr) {
            depsSet.add(other.id);
          }
        }
      }

      // 2.2 BASE_DSR_NOTURNO: depende de ADIC_NOTURNO
      if (rubric.calculation_base === 'BASE_DSR_NOTURNO' || isDsrNoturno(rubric)) {
        for (const other of allRubrics) {
          if (other.id !== rubric.id && isAdicNoturno(other)) {
            depsSet.add(other.id);
          }
        }
      }

      // 2.3 BASE_HORA_EXTRA (HE diurna): depende de adicionais habituais (insalubridade, periculosidade, etc.), SEM adicional noturno
      if (rubric.calculation_base === 'BASE_HORA_EXTRA') {
        for (const other of allRubrics) {
          if (
            other.id !== rubric.id &&
            (isInsalubridade(other) || isPericulosidade(other) || isAllowanceOther(other))
          ) {
            depsSet.add(other.id);
          }
        }
      }

      // 2.4 BASE_HORA_EXTRA_NOTURNA (OJ 97 SDI-1 TST): inclui insalubridade, periculosidade e adicional noturno
      if (rubric.calculation_base === 'BASE_HORA_EXTRA_NOTURNA') {
        for (const other of allRubrics) {
          if (
            other.id !== rubric.id &&
            (isInsalubridade(other) || isPericulosidade(other) || isAdicNoturno(other) || isAllowanceOther(other))
          ) {
            depsSet.add(other.id);
          }
        }
      }

      // 2.5 1/3 Constitucional de Férias e Abono (legado 502/504 e seed 702/704)
      if (rubric.code === '502' || rubric.code === '504' || rubric.code === '702' || rubric.code === '704') {
        const targetMap: Record<string, string> = {
          '502': '501',
          '504': '503',
          '702': '701',
          '704': '703',
        };
        const baseRubric = allRubrics.find(o => o.code === targetMap[rubric.code]);
        if (baseRubric && baseRubric.id !== rubric.id) {
          depsSet.add(baseRubric.id);
        }
      }

      // 3. Dependências extraídas da fórmula (estritamente identificadores R\d+, evitando falsos ciclos com constantes numéricas)
      if (rubric.formula && rubric.formula.trim() !== '') {
        const rMatches = rubric.formula.matchAll(/\bR(\d+)\b/gi);
        for (const match of rMatches) {
          const code = match[1];
          const matchedRubric = allRubrics.find(o => o.code === code);
          if (matchedRubric && matchedRubric.id !== rubric.id) {
            depsSet.add(matchedRubric.id);
          }
        }

        if (rubric.formula.includes('BASE_DSR_NOTURNO')) {
          for (const other of allRubrics) {
            if (other.id !== rubric.id && isAdicNoturno(other)) depsSet.add(other.id);
          }
        } else if (rubric.formula.includes('BASE_DSR')) {
          for (const other of allRubrics) {
            if (other.id === rubric.id || other.type !== 'EARNING') continue;
            if (isOvertime(other) || isCommission(other) || isAdicNoturno(other) || other.incidencias?.integra_dsr) {
              depsSet.add(other.id);
            }
          }
        }

        if (rubric.formula.includes('BASE_HORA_EXTRA_NOTURNA')) {
          for (const other of allRubrics) {
            if (
              other.id !== rubric.id &&
              (isInsalubridade(other) || isPericulosidade(other) || isAdicNoturno(other) || isAllowanceOther(other))
            ) {
              depsSet.add(other.id);
            }
          }
        } else if (rubric.formula.includes('BASE_HORA_EXTRA')) {
          for (const other of allRubrics) {
            if (
              other.id !== rubric.id &&
              (isInsalubridade(other) || isPericulosidade(other) || isAllowanceOther(other))
            ) {
              depsSet.add(other.id);
            }
          }
        }
      }

      const sortedDeps = Array.from(depsSet)
        .map(id => rubrics.get(id)!)
        .filter(Boolean)
        .sort(compareRubrics)
        .map(r => r.id);

      graph.set(rubric.id, sortedDeps);
    }

    const visit = (rubricId: string) => {
      if (recursionStack.has(rubricId)) {
        const cycleStartIndex = currentPath.indexOf(rubricId);
        const cycleIds = [...currentPath.slice(cycleStartIndex), rubricId];
        const cycleDescription = cycleIds
          .map(id => {
            const r = rubrics.get(id);
            return r ? `[${r.code}] ${r.name}` : id;
          })
          .join(' -> ');

        throw new CircularDependencyException(
          `Dependência circular detectada no cálculo de rubricas: ${cycleDescription}`
        );
      }

      if (visited.has(rubricId)) return;

      recursionStack.add(rubricId);
      currentPath.push(rubricId);

      const deps = graph.get(rubricId) || [];
      for (const depId of deps) {
        visit(depId);
      }

      currentPath.pop();
      recursionStack.delete(rubricId);
      visited.add(rubricId);

      const r = rubrics.get(rubricId);
      if (r) sorted.push(r);
    };

    allRubrics.sort(compareRubrics);

    for (const rubric of allRubrics) {
      if (!visited.has(rubric.id)) {
        visit(rubric.id);
      }
    }

    return sorted;
  }
}
