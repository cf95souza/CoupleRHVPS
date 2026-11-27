import pg from 'pg';

export interface LaborRiskItem {
  id: string;
  contract_id: string;
  worker_name: string;
  cpf: string;
  article: 'Art. 137 CLT' | 'Art. 66 CLT' | 'Art. 71 CLT' | 'Art. 59 CLT' | 'Banco Excedente';
  severity: 'DANGER' | 'WARNING';
  description: string;
  details: string;
  suggested_action: string;
}

export interface ExecutiveDashboardData {
  stats: {
    activeEmployees: number;
    vacationEmployees: number;
    suspendedEmployees: number;
    companiesCount: number;
    turnoverRateAnnual: number;
    absenteeismRateMonth: number;
  };
  costs: {
    grossPayrollCents: number;
    netPayrollCents: number;
    employerTaxesCents: number;
    provisionsCents: number;
    benefitsCents: number;
    totalCompanyCostCents: number;
  };
  overtimeVsTimeBank: {
    overtimeHoursMonth: number;
    timeBankCompensatedHours: number;
    totalActiveTimeBankBalanceHours: number;
  };
  payrollHistory12m: Array<{
    periodKey: string;
    grossAmount: number;
    netAmount: number;
    employerTaxes: number;
    totalCost: number;
    headcount: number;
  }>;
  laborRiskRadar: {
    totalRisksCount: number;
    dangerCount: number;
    warningCount: number;
    vacationRiskCount: number;
    interjornadaCount: number;
    intrajornadaCount: number;
    overtimeExcessCount: number;
    timeBankExcessCount: number;
    risks: LaborRiskItem[];
  };
}

export class BiService {
  /**
   * Coleta métricas analíticas e consolida o radar de passivos trabalhistas sob escopo seguro RLS
   */
  async getExecutiveDashboard(
    client: pg.PoolClient | pg.Pool,
    tenantId: string,
    companyId?: string
  ): Promise<ExecutiveDashboardData> {
    // 1. Contratos Ativos e Status
    let contractWhere = 'WHERE c.tenant_id = $1';
    const params: any[] = [tenantId];
    if (companyId) {
      params.push(companyId);
      contractWhere += ' AND c.company_id = $2';
    }

    const { rows: contractStats } = await client.query(
      `
      SELECT 
        count(*) FILTER (WHERE c.status = 'ACTIVE') AS active_count,
        count(*) FILTER (WHERE c.status = 'VACATION') AS vacation_count,
        count(*) FILTER (WHERE c.status = 'SUSPENDED') AS suspended_count,
        COALESCE(sum(c.base_salary) FILTER (WHERE c.status = 'ACTIVE'), 0) AS total_base_salary
      FROM public.contracts c
      ${contractWhere}
    `,
      params
    );

    const { rows: companyCountRes } = await client.query(
      `SELECT count(*) as comp_count FROM public.companies WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    );

    const activeEmployees = parseInt(contractStats[0]?.active_count || '0', 10);
    const vacationEmployees = parseInt(contractStats[0]?.vacation_count || '0', 10);
    const suspendedEmployees = parseInt(contractStats[0]?.suspended_count || '0', 10);
    const companiesCount = parseInt(companyCountRes[0]?.comp_count || '0', 10);

    // 2. Última Folha e Custos Reais (Proventos + Encargos Patronais + Provisões)
    const { rows: latestPayroll } = await client.query(
      `
      SELECT 
        COALESCE(sum(p.gross_earnings), 0) as gross_cents,
        COALESCE(sum(p.net_amount), 0) as net_cents,
        COALESCE(sum(p.inss_employer), 0) + COALESCE(sum(p.fgts_amount), 0) as taxes_cents
      FROM public.payslips p
      JOIN public.payroll_periods pp ON pp.id = p.period_id
      WHERE pp.tenant_id = $1
        AND pp.type = 'MONTHLY'
        AND pp.reference_month = (
          SELECT MAX(reference_month) FROM public.payroll_periods WHERE tenant_id = $1 AND type = 'MONTHLY'
        )
    `,
      [tenantId]
    );

    const grossPayrollCents = parseInt(latestPayroll[0]?.gross_cents || '0', 10);
    const netPayrollCents = parseInt(latestPayroll[0]?.net_cents || '0', 10);
    const employerTaxesCents = parseInt(latestPayroll[0]?.taxes_cents || '0', 10);
    // Provisões mensais aproximadas (1/12 Férias + 1/3 + 1/12 13º + 28% encargos): aprox 24.3% do bruto
    const provisionsCents = Math.round(grossPayrollCents * 0.243);
    const benefitsCents = Math.round(activeEmployees * 35000); // Média de R$ 350,00 de benefícios/colaborador
    const totalCompanyCostCents = grossPayrollCents + employerTaxesCents + provisionsCents + benefitsCents;

    // 3. Histórico dos Últimos 12 Meses
    const { rows: history12m } = await client.query(
      `
      SELECT 
        to_char(pp.reference_month, 'YYYY-MM') as period_key,
        COALESCE(sum(p.gross_earnings), 0) as gross_amount,
        COALESCE(sum(p.net_amount), 0) as net_amount,
        COALESCE(sum(p.inss_employer), 0) + COALESCE(sum(p.fgts_amount), 0) as employer_taxes,
        count(DISTINCT p.contract_id) as headcount
      FROM public.payroll_periods pp
      LEFT JOIN public.payslips p ON p.period_id = pp.id
      WHERE pp.tenant_id = $1
        AND pp.type = 'MONTHLY'
        AND pp.reference_month >= (CURRENT_DATE - INTERVAL '12 months')
      GROUP BY pp.reference_month
      ORDER BY pp.reference_month ASC
    `,
      [tenantId]
    );

    const payrollHistory12m = history12m.map((h: any) => {
      const gross = parseInt(h.gross_amount || '0', 10) / 100;
      const net = parseInt(h.net_amount || '0', 10) / 100;
      const taxes = parseInt(h.employer_taxes || '0', 10) / 100;
      return {
        periodKey: h.period_key,
        grossAmount: gross,
        netAmount: net,
        employerTaxes: taxes,
        totalCost: Math.round(gross * 1.35 + taxes),
        headcount: parseInt(h.headcount || '0', 10),
      };
    });

    // 4. Turnover dos Últimos 12 Meses
    const { rows: turnoverRes } = await client.query(
      `
      SELECT 
        count(*) FILTER (WHERE c.start_date >= (CURRENT_DATE - INTERVAL '12 months')) AS admissions,
        count(*) FILTER (WHERE c.end_date >= (CURRENT_DATE - INTERVAL '12 months') AND c.status = 'INACTIVE') AS terminations
      FROM public.contracts c
      WHERE c.tenant_id = $1
    `,
      [tenantId]
    );

    const admissions = parseInt(turnoverRes[0]?.admissions || '0', 10);
    const terminations = parseInt(turnoverRes[0]?.terminations || '0', 10);
    const avgHeadcount = Math.max(1, activeEmployees);
    const turnoverRateAnnual = parseFloat((((admissions + terminations) / 2 / avgHeadcount) * 100).toFixed(1));

    // 5. Horas Extras vs Banco de Horas no Mês Corrente
    const { rows: otStats } = await client.query(
      `
      SELECT 
        COALESCE(sum(total_overtime_hours), 0) as ot_hours
      FROM public.timesheet_summaries
      WHERE tenant_id = $1
        AND period_month = date_trunc('month', CURRENT_DATE);
    `,
      [tenantId]
    );

    const { rows: tbStats } = await client.query(
      `
      SELECT 
        COALESCE(sum(CASE WHEN minutes_amount < 0 THEN abs(minutes_amount) ELSE 0 END), 0) as comp_minutes,
        COALESCE(sum(current_balance_minutes), 0) as total_balance_minutes
      FROM public.time_bank_accounts
      WHERE tenant_id = $1 AND is_active = true;
    `,
      [tenantId]
    );

    const overtimeHoursMonth = parseFloat(otStats[0]?.ot_hours || '0');
    const timeBankCompensatedHours = Math.round(parseInt(tbStats[0]?.comp_minutes || '0', 10) / 60);
    const totalActiveTimeBankBalanceHours = Math.round(parseInt(tbStats[0]?.total_balance_minutes || '0', 10) / 60);

    // 6. Absenteísmo (Faltas e Atestados sobre Jornada Prevista)
    const { rows: absStats } = await client.query(
      `
      SELECT 
        COALESCE(sum(total_absence_hours), 0) as absence_hours,
        COALESCE(sum(total_regular_hours), 0) as regular_hours
      FROM public.timesheet_summaries
      WHERE tenant_id = $1
        AND period_month = date_trunc('month', CURRENT_DATE);
    `,
      [tenantId]
    );
    const absenceHours = parseFloat(absStats[0]?.absence_hours || '0');
    const regularHours = Math.max(1, parseFloat(absStats[0]?.regular_hours || '0'));
    const absenteeismRateMonth = parseFloat(((absenceHours / (regularHours + absenceHours)) * 100).toFixed(1));

    // 7. RADAR DE RISCO TRABALHISTA (PASSIVOS CLT)
    const risks: LaborRiskItem[] = [];

    // 7.1 Art. 137 CLT: Risco de Pagamento de Férias em Dobro
    const { rows: vacationRisks } = await client.query(
      `
      SELECT 
        vp.id,
        vp.contract_id,
        w.name AS worker_name,
        w.cpf,
        vp.concessive_period_end,
        (vp.concessive_period_end - CURRENT_DATE) AS days_left
      FROM public.vacation_periods vp
      JOIN public.contracts c ON c.id = vp.contract_id
      JOIN public.workers w ON w.id = c.worker_id
      WHERE c.tenant_id = $1
        AND c.status = 'ACTIVE'
        AND vp.remaining_days > 0
        AND vp.concessive_period_end <= (CURRENT_DATE + INTERVAL '60 days')
      ORDER BY vp.concessive_period_end ASC
      LIMIT 10;
    `,
      [tenantId]
    );

    for (const v of vacationRisks) {
      const daysLeft = parseInt(v.days_left || '0', 10);
      const isExpired = daysLeft < 0;
      risks.push({
        id: `vacation-${v.id}`,
        contract_id: v.contract_id,
        worker_name: v.worker_name,
        cpf: v.cpf,
        article: 'Art. 137 CLT',
        severity: isExpired ? 'DANGER' : 'WARNING',
        description: isExpired
          ? `Período concessivo vencido há ${Math.abs(daysLeft)} dias. Pagamento em dobro obrigatório.`
          : `Período concessivo vence em ${daysLeft} dias. Risco iminente de dobra legal.`,
        details: `Concessivo limite: ${v.concessive_period_end}. Saldo restante de dias de férias pendente.`,
        suggested_action: isExpired
          ? 'Programar gozo imediato e lançar rubrica de férias em dobro no cálculo da folha.'
          : 'Emitir aviso prévio de férias (30 dias de antecedência) e agendar o gozo urgente.',
      });
    }

    // 7.2 Art. 66 CLT: Violação do Intervalo Interjornada (< 11 Horas)
    const { rows: interjornadaRisks } = await client.query(
      `
      WITH daily_punches AS (
        SELECT 
          contract_id,
          date_trunc('day', punched_at) as punch_date,
          min(punched_at) as first_punch,
          max(punched_at) as last_punch
        FROM public.time_punch_records
        WHERE tenant_id = $1
          AND punched_at >= (CURRENT_DATE - INTERVAL '30 days')
        GROUP BY contract_id, date_trunc('day', punched_at)
      ),
      consecutive_shifts AS (
        SELECT 
          d1.contract_id,
          d1.punch_date as day1_date,
          d1.last_punch as exit_time,
          d2.punch_date as day2_date,
          d2.first_punch as entry_time,
          EXTRACT(EPOCH FROM (d2.first_punch - d1.last_punch)) / 3600 AS rest_hours
        FROM daily_punches d1
        JOIN daily_punches d2 ON d1.contract_id = d2.contract_id AND d2.punch_date = (d1.punch_date + INTERVAL '1 day')
        WHERE EXTRACT(EPOCH FROM (d2.first_punch - d1.last_punch)) / 3600 < 11
          AND EXTRACT(EPOCH FROM (d2.first_punch - d1.last_punch)) / 3600 > 0
      )
      SELECT 
        cs.contract_id,
        w.name AS worker_name,
        w.cpf,
        cs.exit_time,
        cs.entry_time,
        round(cs.rest_hours::numeric, 1) as rest_hours
      FROM consecutive_shifts cs
      JOIN public.contracts c ON c.id = cs.contract_id
      JOIN public.workers w ON w.id = c.worker_id
      ORDER BY cs.entry_time DESC
      LIMIT 10;
    `,
      [tenantId]
    );

    for (const ij of interjornadaRisks) {
      risks.push({
        id: `interjornada-${ij.contract_id}-${ij.entry_time}`,
        contract_id: ij.contract_id,
        worker_name: ij.worker_name,
        cpf: ij.cpf,
        article: 'Art. 66 CLT',
        severity: 'DANGER',
        description: `Intervalo interjornada suprimido (${ij.rest_hours}h de descanso entre saídas/entradas, mínimo legal 11h).`,
        details: `Saída: ${ij.exit_time} → Entrada seguinte: ${ij.entry_time}. Horas suprimidas devidas como HE + 50% (Súmula 110 TST).`,
        suggested_action: 'Ajustar escala para respeitar as 11 horas de descanso e pagar o adicional das horas suprimidas.',
      });
    }

    // 7.3 Art. 71 CLT: Intrajornada Suprimida (< 1 Hora em Jornadas > 6 Horas)
    const { rows: intrajornadaRisks } = await client.query(
      `
      SELECT 
        ts.id,
        ts.contract_id,
        w.name AS worker_name,
        w.cpf,
        ts.date,
        ts.total_worked_hours,
        ts.meal_break_minutes
      FROM public.time_entries ts
      JOIN public.contracts c ON c.id = ts.contract_id
      JOIN public.workers w ON w.id = c.worker_id
      WHERE c.tenant_id = $1
        AND ts.date >= (CURRENT_DATE - INTERVAL '30 days')
        AND ts.total_worked_hours > 6
        AND ts.meal_break_minutes < 60
      ORDER BY ts.date DESC
      LIMIT 10;
    `,
      [tenantId]
    ).catch(() => ({ rows: [] })); // Trata caso tabela opcional tenha outro esquema de batidas

    for (const it of intrajornadaRisks) {
      risks.push({
        id: `intrajornada-${it.id}`,
        contract_id: it.contract_id,
        worker_name: it.worker_name,
        cpf: it.cpf,
        article: 'Art. 71 CLT',
        severity: 'WARNING',
        description: `Intervalo de refeição de apenas ${it.meal_break_minutes} min em jornada de ${it.total_worked_hours}h (mínimo legal 60 min).`,
        details: `Data: ${it.date}. Indenização devida sobre o tempo suprimido com acréscimo de 50% (§4º Art. 71 CLT).`,
        suggested_action: 'Alertar gestor da equipe e lançar indenização de intrajornada se não houver acordo de redução.',
      });
    }

    // 7.4 Art. 59 CLT: Excesso de Horas Extras (> 2h por dia)
    const { rows: overtimeExcessRisks } = await client.query(
      `
      SELECT 
        tp.contract_id,
        w.name AS worker_name,
        w.cpf,
        date_trunc('day', tp.punched_at) AS day_worked,
        count(*) AS total_punches
      FROM public.time_punch_records tp
      JOIN public.contracts c ON c.id = tp.contract_id
      JOIN public.workers w ON w.id = c.worker_id
      WHERE tp.tenant_id = $1
        AND tp.punched_at >= (CURRENT_DATE - INTERVAL '15 days')
      GROUP BY tp.contract_id, w.name, w.cpf, date_trunc('day', tp.punched_at)
      HAVING count(*) >= 6 -- Múltiplas batidas extras indicando sobrejornada extrema
      LIMIT 10;
    `,
      [tenantId]
    );

    for (const ot of overtimeExcessRisks) {
      risks.push({
        id: `overtime-${ot.contract_id}-${ot.day_worked}`,
        contract_id: ot.contract_id,
        worker_name: ot.worker_name,
        cpf: ot.cpf,
        article: 'Art. 59 CLT',
        severity: 'WARNING',
        description: `Sobrejornada intensa detectada no dia (${ot.total_punches} registros no ponto). Limite legal: 2 horas extras/dia.`,
        details: `Data da ocorrência: ${ot.day_worked}. Risco de autuação do MTE por extrapolação habitual do limite diário.`,
        suggested_action: 'Redistribuir demandas ou contratar apoio temporário para cessar a habitualidade.',
      });
    }

    // 7.5 Banco de Horas Excedente (> 30 Horas Positivas Acumuladas)
    const { rows: tbExcess } = await client.query(
      `
      SELECT 
        tb.id,
        tb.contract_id,
        w.name AS worker_name,
        w.cpf,
        round(tb.current_balance_minutes / 60::numeric, 1) AS balance_hours
      FROM public.time_bank_accounts tb
      JOIN public.contracts c ON c.id = tb.contract_id
      JOIN public.workers w ON w.id = c.worker_id
      WHERE tb.tenant_id = $1
        AND tb.is_active = true
        AND tb.current_balance_minutes >= (30 * 60)
      ORDER BY tb.current_balance_minutes DESC
      LIMIT 10;
    `,
      [tenantId]
    );

    for (const tb of tbExcess) {
      risks.push({
        id: `timebank-${tb.id}`,
        contract_id: tb.contract_id,
        worker_name: tb.worker_name,
        cpf: tb.cpf,
        article: 'Banco Excedente',
        severity: 'WARNING',
        description: `Saldo positivo elevado de banco de horas (${tb.balance_hours} horas acumuladas).`,
        details: 'Acúmulo superior a 30 horas. Risco de vencimento do prazo do acordo sem compensação em folgas.',
        suggested_action: 'Programar folgas compensatórias nos próximos 30 dias ou realizar o pagamento em folha.',
      });
    }

    const dangerCount = risks.filter((r) => r.severity === 'DANGER').length;
    const warningCount = risks.filter((r) => r.severity === 'WARNING').length;

    return {
      stats: {
        activeEmployees,
        vacationEmployees,
        suspendedEmployees,
        companiesCount,
        turnoverRateAnnual,
        absenteeismRateMonth,
      },
      costs: {
        grossPayrollCents,
        netPayrollCents,
        employerTaxesCents,
        provisionsCents,
        benefitsCents,
        totalCompanyCostCents,
      },
      overtimeVsTimeBank: {
        overtimeHoursMonth,
        timeBankCompensatedHours,
        totalActiveTimeBankBalanceHours,
      },
      payrollHistory12m,
      laborRiskRadar: {
        totalRisksCount: risks.length,
        dangerCount,
        warningCount,
        vacationRiskCount: vacationRisks.length,
        interjornadaCount: interjornadaRisks.length,
        intrajornadaCount: intrajornadaRisks.length,
        overtimeExcessCount: overtimeExcessRisks.length,
        timeBankExcessCount: tbExcess.length,
        risks,
      },
    };
  }
}
