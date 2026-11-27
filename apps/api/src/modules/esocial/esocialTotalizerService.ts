import pg from 'pg';
import {
  parseEsocialTotalizerXml,
  reconcileTotalizerWithMotor,
  sumMoney,
  type MotorExpectedTotalizerValues,
} from '@couplerh/payroll-core';

export interface IngestTotalizerInput {
  tenantId: string;
  companyId: string;
  payrollPeriodId?: string | null;
  environment: 'PRODUCTION' | 'HOMOLOGATION';
  rawXml: string;
}

async function resolveMotorExpectedValues(
  client: pg.PoolClient,
  params: {
    tenantId: string;
    companyId: string;
    payrollPeriodId?: string | null;
    periodYear: number;
    periodMonth: number;
    cpfTrab: string | null;
  }
): Promise<{
  payrollPeriodId: string | null;
  workerId: string | null;
  contractId: string | null;
  motor: MotorExpectedTotalizerValues;
}> {
  let payrollPeriodId = params.payrollPeriodId || null;

  if (!payrollPeriodId) {
    const periodRes = await client.query<{ id: string }>(
      `SELECT id FROM public.payroll_periods
       WHERE tenant_id = $1::uuid AND company_id = $2::uuid AND year = $3::int AND month = $4::int
       ORDER BY CASE WHEN type = 'MONTHLY' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1;`,
      [params.tenantId, params.companyId, params.periodYear, params.periodMonth]
    );
    payrollPeriodId = periodRes.rows[0]?.id ?? null;
  }

  let workerId: string | null = null;
  let contractId: string | null = null;

  if (params.cpfTrab) {
    const wRes = await client.query<{ worker_id: string; contract_id: string }>(
      `SELECT w.id AS worker_id, c.id AS contract_id
       FROM public.workers w
       LEFT JOIN public.contracts c ON c.worker_id = w.id AND c.company_id = $2::uuid AND c.deleted_at IS NULL
       WHERE w.tenant_id = $1::uuid AND w.cpf = $3::text AND w.deleted_at IS NULL
       ORDER BY c.created_at DESC
       LIMIT 1;`,
      [params.tenantId, params.companyId, params.cpfTrab.replace(/\D/g, '')]
    );
    workerId = wRes.rows[0]?.worker_id ?? null;
    contractId = wRes.rows[0]?.contract_id ?? null;
  }

  if (!payrollPeriodId) {
    return {
      payrollPeriodId: null,
      workerId,
      contractId,
      motor: { inssSegurados: 0, inssPatronal: 0, irrfRetido: 0, fgtsTotal: 0, maternityDeduction: 0, familySalaryDeduction: 0 },
    };
  }

  // Valores por trabalhador (S-5001/5002/5003) vs empresa (S-5011/5012/5013)
  const slipFilter = workerId ? 'AND p.worker_id = $2::uuid' : '';
  const slipParams = workerId ? [payrollPeriodId, workerId] : [payrollPeriodId];

  const slipRes = await client.query<{
    fgts_total: string;
    inss_segurados: string;
    irrf_retido: string;
  }>(
    `SELECT
       COALESCE(SUM(p.fgts_month), 0)::text AS fgts_total,
       COALESCE(SUM(CASE WHEN pi.rubric_code IN ('901', '916') THEN pi.amount ELSE 0 END), 0)::text AS inss_segurados,
       COALESCE(SUM(CASE WHEN pi.rubric_code IN ('902', '915') THEN pi.amount ELSE 0 END), 0)::text AS irrf_retido
     FROM public.payslips p
     LEFT JOIN public.payslip_items pi ON pi.payslip_id = p.id
     WHERE p.payroll_period_id = $1::uuid ${slipFilter};`,
    slipParams
  );

  // Atenção: se houver múltiplos itens no LEFT JOIN, fgts_month se repetiria por item. Calcular fgts separado!
  const fgtsRes = await client.query<{ fgts_total: string }>(
    `SELECT COALESCE(SUM(p.fgts_month), 0)::text AS fgts_total
     FROM public.payslips p
     WHERE p.payroll_period_id = $1::uuid ${slipFilter};`,
    slipParams
  );

  const taxRes = await client.query<{
    inss_patronal: string;
    rat_amount: string;
    rat_special_retirement_amount: string;
    other_entities_amount: string;
    inss_patronal_pro_labore: string;
    maternity_deduction: string;
    family_salary_deduction: string;
  }>(
    `SELECT
       COALESCE(SUM(inss_patronal), 0)::text AS inss_patronal,
       COALESCE(SUM(rat_amount), 0)::text AS rat_amount,
       COALESCE(SUM(rat_special_retirement_amount), 0)::text AS rat_special_retirement_amount,
       COALESCE(SUM(other_entities_amount), 0)::text AS other_entities_amount,
       COALESCE(SUM(inss_patronal_pro_labore), 0)::text AS inss_patronal_pro_labore,
       COALESCE(SUM(maternity_deduction), 0)::text AS maternity_deduction,
       COALESCE(SUM(family_salary_deduction), 0)::text AS family_salary_deduction
     FROM public.payroll_company_taxes
     WHERE payroll_period_id = $1::uuid AND company_id = $2::uuid;`,
    [payrollPeriodId, params.companyId]
  );

  const taxRow = taxRes.rows[0];
  const inssPatronal = taxRow
    ? sumMoney(
        Number(taxRow.inss_patronal),
        Number(taxRow.rat_amount),
        Number(taxRow.rat_special_retirement_amount),
        Number(taxRow.other_entities_amount),
        Number(taxRow.inss_patronal_pro_labore)
      )
    : 0;

  return {
    payrollPeriodId,
    workerId,
    contractId,
    motor: {
      inssSegurados: Number(slipRes.rows[0]?.inss_segurados ?? 0),
      inssPatronal,
      irrfRetido: Number(slipRes.rows[0]?.irrf_retido ?? 0),
      fgtsTotal: Number(fgtsRes.rows[0]?.fgts_total ?? 0),
      maternityDeduction: Number(taxRow?.maternity_deduction ?? 0),
      familySalaryDeduction: Number(taxRow?.family_salary_deduction ?? 0),
    },
  };
}

/**
 * Processa um XML totalizador (S-5001 a S-5013), confronta em centavos com o motor CoupleRH
 * e persiste em public.esocial_totalizers.
 */
export async function ingestAndReconcileTotalizer(
  client: pg.PoolClient,
  input: IngestTotalizerInput
) {
  const parsed = parseEsocialTotalizerXml(input.rawXml);
  const { payrollPeriodId, workerId, contractId, motor } = await resolveMotorExpectedValues(client, {
    tenantId: input.tenantId,
    companyId: input.companyId,
    payrollPeriodId: input.payrollPeriodId,
    periodYear: parsed.periodYear,
    periodMonth: parsed.periodMonth,
    cpfTrab: parsed.cpfTrab,
  });

  const reconciliation = reconcileTotalizerWithMotor(parsed, motor);

  const insertRes = await client.query(
    `INSERT INTO public.esocial_totalizers (
      tenant_id, company_id, payroll_period_id, worker_id, contract_id,
      event_type, period_year, period_month, cpf, receipt_number, environment,
      raw_response, raw_xml,
      inss_base, inss_segurados, inss_patronal, inss_rat_ajustado, inss_terceiros,
      irrf_retido, fgts_base, fgts_total, maternity_deduction, family_salary_deduction,
      couple_inss_segurados, couple_inss_patronal, couple_irrf_retido, couple_fgts_total,
      diff_inss_segurados, diff_inss_patronal, diff_irrf_retido, diff_fgts_total,
      reconciliation_status, divergences_json, updated_at
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
      $6::text, $7::int, $8::int, $9::text, $10::text, $11::text,
      $12::jsonb, $13::text,
      $14::numeric, $15::numeric, $16::numeric, $17::numeric, $18::numeric,
      $19::numeric, $20::numeric, $21::numeric, $22::numeric, $23::numeric,
      $24::numeric, $25::numeric, $26::numeric, $27::numeric,
      $28::numeric, $29::numeric, $30::numeric, $31::numeric,
      $32::text, $33::jsonb, NOW()
    )
    RETURNING *;`,
    [
      input.tenantId,
      input.companyId,
      payrollPeriodId,
      workerId,
      contractId,
      parsed.eventType,
      parsed.periodYear,
      parsed.periodMonth,
      parsed.cpfTrab,
      parsed.receiptNumber,
      input.environment,
      JSON.stringify(parsed),
      input.rawXml,
      parsed.inssBase,
      parsed.inssSegurados,
      parsed.inssPatronal,
      parsed.inssRatAjustado,
      parsed.inssTerceiros,
      parsed.irrfRetido,
      parsed.fgtsBase,
      parsed.fgtsTotal,
      parsed.maternityDeduction,
      parsed.familySalaryDeduction,
      motor.inssSegurados,
      motor.inssPatronal,
      motor.irrfRetido,
      motor.fgtsTotal,
      reconciliation.diffInssSegurados,
      reconciliation.diffInssPatronal,
      reconciliation.diffIrrfRetido,
      reconciliation.diffFgtsTotal,
      reconciliation.reconciliationStatus,
      JSON.stringify(reconciliation.divergences),
    ]
  );

  return {
    record: insertRes.rows[0],
    parsed,
    motor,
    reconciliation,
  };
}
