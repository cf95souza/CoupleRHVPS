import pg from 'pg';
import { dbPool } from '../../shared/db/pool.js';
import { withReadOnlyTenantContext, withTenantContext } from '../../shared/db/context.js';
import { QueueService, type PayrollJobQueuePayload } from '../../shared/queue/QueueService.js';
import { AlertService } from '../../shared/observability/AlertService.js';
import {
  aggregateCompanyBases,
  buildAtomicPayrollPayload,
  buildWhatIfComparisonSummary,
  calculateConsolidatedEmployerTaxes,
  chunkArray,
  isContractEligibleForScenario,
  sumMoney,
  validatePeriodStatusForCalculation,
  type ExistingPayslipBase,
  type OtherEmploymentInput,
  type RawCalculatedPayslip,
  type WhatIfContractSnapshot,
  type WhatIfEmployerTotals,
  type WhatIfScenarioParams,
} from '@couplerh/payroll-core';
import {
  calculateSingleContract,
  loadPeriodCalculationData,
  persistAlimonySplits,
  persistIrrfCashLedger,
  type PersistedAlimonySplit,
  type PersistedIrrfCashEntry,
} from './payrollCalculationService.js';

export const DEFAULT_PAYROLL_CHUNK_SIZE = 50;

export type PayrollJobMode = 'REAL' | 'SIMULATION';

export interface CreatePayrollJobInput {
  tenantId: string;
  periodId: string;
  userId: string | null;
  mode: PayrollJobMode;
  scenarioParams?: WhatIfScenarioParams | null;
  contractIdFilter?: string | null;
}

export interface CreatePayrollJobResult {
  success: boolean;
  httpStatus: number;
  error?: string;
  job?: any;
}

/**
 * Cria o registro de job em `payroll_calculation_jobs` respeitando a trava atômica
 * no modo REAL e mantendo `payslips` / `payroll_periods` intocados no modo SIMULATION.
 */
export async function createPayrollCalculationJob(
  client: pg.PoolClient,
  input: CreatePayrollJobInput
): Promise<CreatePayrollJobResult> {
  const {
    tenantId,
    periodId,
    userId,
    mode,
    scenarioParams = {},
    contractIdFilter = null,
  } = input;

  const { rows: periodRows } = await client.query(
    `SELECT id, company_id, month, year, type, status
     FROM public.payroll_periods
     WHERE id = $1::uuid AND tenant_id = $2::uuid;`,
    [periodId, tenantId]
  );

  if (periodRows.length === 0) {
    return { success: false, httpStatus: 404, error: 'Período de folha não encontrado.' };
  }

  const period = periodRows[0];
  let restorePeriodStatus = period.status;

  if (mode === 'REAL') {
    const effectiveStatus = period.status === 'OPEN' ? 'DRAFT' : period.status;
    const statusValidation = validatePeriodStatusForCalculation(effectiveStatus);
    if (!statusValidation.canCalculate) {
      return {
        success: false,
        httpStatus: statusValidation.httpStatus || 400,
        error: statusValidation.error,
      };
    }

    const { rows: lockRows } = await client.query(
      `UPDATE public.payroll_periods
       SET status = 'CALCULATING',
           locked_at = NOW(),
           heartbeat_at = NOW(),
           updated_at = NOW()
       WHERE id = $1::uuid AND tenant_id = $2::uuid
         AND status NOT IN ('CALCULATING', 'CLOSED')
       RETURNING id;`,
      [periodId, tenantId]
    );

    if (lockRows.length === 0) {
      return {
        success: false,
        httpStatus: 409,
        error: 'Cálculo concorrente detectado: o período de folha já está sendo processado.',
      };
    }

    restorePeriodStatus = period.status;
  }

  // Contagem rápida de contratos ativos da empresa para barra de progresso inicial
  let countSql = `
    SELECT COUNT(*)::int AS total
    FROM public.contracts c
    WHERE c.tenant_id = $1::uuid
      AND c.company_id = $2::uuid
      AND c.deleted_at IS NULL
      AND c.status = 'ACTIVE'
  `;
  const countParams: any[] = [tenantId, period.company_id];
  if (contractIdFilter) {
    countSql += ` AND c.id = $3::uuid`;
    countParams.push(contractIdFilter);
  }
  const { rows: countRows } = await client.query(countSql, countParams);
  const totalContracts = Number(countRows[0]?.total || 0);

  try {
    const { rows: jobRows } = await client.query(
      `INSERT INTO public.payroll_calculation_jobs (
        tenant_id, company_id, period_id, mode, scenario_params, status,
        total_contracts, processed_contracts, error_count, errors_json, summary_json,
        started_by, contract_id_filter, restore_period_status, locked_at, heartbeat_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'QUEUED',
        $6, 0, 0, '[]'::jsonb, '{}'::jsonb,
        $7::uuid, $8::uuid, $9, NOW(), NOW()
      )
      RETURNING *;`,
      [
        tenantId,
        period.company_id,
        periodId,
        mode,
        JSON.stringify(scenarioParams || {}),
        totalContracts,
        userId || null,
        contractIdFilter || null,
        restorePeriodStatus,
      ]
    );

    return {
      success: true,
      httpStatus: 202,
      job: jobRows[0],
    };
  } catch (err: any) {
    if (mode === 'REAL') {
      await client.query(
        `UPDATE public.payroll_periods
         SET status = $1, locked_at = NULL, heartbeat_at = NULL, updated_at = NOW()
         WHERE id = $2::uuid AND status = 'CALCULATING';`,
        [restorePeriodStatus, periodId]
      );
    }

    if (err?.code === '23505') {
      return {
        success: false,
        httpStatus: 409,
        error: 'Já existe um lote de cálculo em andamento para esta competência.',
      };
    }
    throw err;
  }
}

function summarizeCompanyTaxes(taxes: Array<any>): WhatIfEmployerTotals {
  return {
    inss_patronal: sumMoney(taxes.map((t) => Number(t.inss_patronal || 0))),
    rat_adjusted: sumMoney(taxes.map((t) => Number(t.rat_adjusted || 0))),
    terceiros: sumMoney(taxes.map((t) => Number(t.terceiros || 0))),
    fgts_patronal: sumMoney(taxes.map((t) => Number(t.fgts_patronal || 0))),
    total_taxes: sumMoney(taxes.map((t) => Number(t.total_taxes || 0))),
  };
}

/**
 * Executa o processamento em lotes de 50 contratos para um job REAL ou SIMULATION.
 * Atualiza `processed_contracts` e `heartbeat_at` ao fim de cada chunk.
 */
export async function processPayrollCalculationJob(
  payload: PayrollJobQueuePayload,
  options?: { chunkSize?: number; pool?: pg.Pool }
): Promise<any> {
  const pool = options?.pool || dbPool;
  const chunkSize = options?.chunkSize || DEFAULT_PAYROLL_CHUNK_SIZE;
  const startedAt = Date.now();
  const ctx = {
    tenantId: payload.tenantId,
    userId: payload.userId,
    role: payload.role,
  };

  try {
    // 1. Reivindica o job para RUNNING e lê metadados iniciais
    const job = await withTenantContext(
      ctx,
      async (client) => {
        const { rows } = await client.query(
          `UPDATE public.payroll_calculation_jobs
           SET status = CASE WHEN status = 'QUEUED' THEN 'RUNNING' ELSE status END,
               locked_at = COALESCE(locked_at, NOW()),
               heartbeat_at = NOW(),
               updated_at = NOW()
           WHERE id = $1::uuid AND tenant_id = $2::uuid
           RETURNING *;`,
          [payload.jobId, payload.tenantId]
        );
        return rows[0] || null;
      },
      pool
    );

    if (!job || job.status === 'CANCELLED' || job.status === 'COMPLETED' || job.status === 'FAILED') {
      return job;
    }

    // 2. Carrega catálogo, tabelas legais, feriados, contratos e eventos 1 única vez
    const loadedData = await withReadOnlyTenantContext(
      ctx,
      async (client) => {
        return loadPeriodCalculationData(client, {
          tenantId: payload.tenantId,
          periodId: job.period_id,
          contractIdFilter: job.contract_id_filter || null,
        });
      },
      pool
    );

    const totalContracts = loadedData.contracts.length;
    await withTenantContext(
      ctx,
      async (client) => {
        await client.query(
          `UPDATE public.payroll_calculation_jobs
           SET total_contracts = $2, heartbeat_at = NOW(), updated_at = NOW()
           WHERE id = $1::uuid;`,
          [job.id, totalContracts]
        );
      },
      pool
    );

    const mode: PayrollJobMode = job.mode;
    const scenario: WhatIfScenarioParams = job.scenario_params || {};
    const chunks = chunkArray(loadedData.contracts, chunkSize);

    const calculatedPayslips: RawCalculatedPayslip[] = [];
    const irrfCashEntries: PersistedIrrfCashEntry[] = [];
    const alimonySplits: PersistedAlimonySplit[] = [];
    const baselinePayslipsForTax: RawCalculatedPayslip[] = [];
    const simulatedPayslipsForTax: RawCalculatedPayslip[] = [];
    const baselineSnapshots: WhatIfContractSnapshot[] = [];
    const simulatedSnapshots: WhatIfContractSnapshot[] = [];
    const errors: Array<{ contract_id: string; worker_id: string; error: string }> = [];
    const intraBatchRealByCpf = new Map<string, OtherEmploymentInput[]>();
    const intraBatchBaseByCpf = new Map<string, OtherEmploymentInput[]>();
    const intraBatchSimByCpf = new Map<string, OtherEmploymentInput[]>();

    let processedCount = 0;
    let chunksProcessed = 0;

    const appendIntraBatch = (
      map: Map<string, OtherEmploymentInput[]>,
      contract: any,
      payslip: RawCalculatedPayslip
    ) => {
      const cleanCpf = String(contract.worker_cpf || '').replace(/\D/g, '');
      if (!cleanCpf || payslip.base_inss <= 0) return;
      const list = map.get(cleanCpf) || [];
      list.push({
        id: contract.id,
        employer_cnpj: contract.company_cnpj || undefined,
        employer_name: `${contract.company_name || 'Grupo'} (Mat. ${contract.registration_number || ''})`.trim(),
        esocial_category_code: '101',
        ind_mv: 1,
        remuneration_amount: payslip.base_inss,
        inss_withheld: payslip.inss_employee || 0,
        source: 'INTERNAL_GROUP_CONTRACT',
      });
      map.set(cleanCpf, list);
    };

    // 3. Processamento chunk a chunk (50 contratos por lote)
    for (const chunk of chunks) {
      // Verifica se houve cancelamento externo antes do próximo lote
      const currentStatus = await withReadOnlyTenantContext(
        ctx,
        async (client) => {
          const { rows } = await client.query(
            `SELECT status FROM public.payroll_calculation_jobs WHERE id = $1::uuid;`,
            [job.id]
          );
          return rows[0]?.status;
        },
        pool
      );

      if (currentStatus === 'CANCELLED') {
        if (mode === 'REAL') {
          await withTenantContext(
            ctx,
            async (client) => {
              await client.query(
                `UPDATE public.payroll_periods
                 SET status = $1, locked_at = NULL, heartbeat_at = NULL, updated_at = NOW()
                 WHERE id = $2::uuid AND status = 'CALCULATING';`,
                [job.restore_period_status || 'DRAFT', job.period_id]
              );
            },
            pool
          );
        }
        return { id: job.id, status: 'CANCELLED' };
      }

      for (const contract of chunk) {
        if (mode === 'REAL') {
          const outcome = await calculateSingleContract(loadedData, contract, null, intraBatchRealByCpf);
          processedCount++;
          if (outcome.skipped) continue;
          if (outcome.error) {
            errors.push(outcome.error);
          } else if (outcome.payslip) {
            calculatedPayslips.push(outcome.payslip);
            appendIntraBatch(intraBatchRealByCpf, contract, outcome.payslip);
            if (outcome.irrfCashEntry) {
              irrfCashEntries.push(outcome.irrfCashEntry);
            }
            if (outcome.alimonySplits && outcome.alimonySplits.length > 0) {
              alimonySplits.push(...outcome.alimonySplits);
            }
          }
        } else {
          // Modo SIMULATION (What-If): calcula baseline e, se afetado, calcula cenário
          const baseOutcome = await calculateSingleContract(loadedData, contract, null, intraBatchBaseByCpf);
          processedCount++;
          if (baseOutcome.skipped) continue;
          if (baseOutcome.error) {
            errors.push(baseOutcome.error);
            continue;
          }
          if (baseOutcome.payslip && baseOutcome.snapshot) {
            baselinePayslipsForTax.push(baseOutcome.payslip);
            baselineSnapshots.push(baseOutcome.snapshot);
            appendIntraBatch(intraBatchBaseByCpf, contract, baseOutcome.payslip);

            if (isContractEligibleForScenario(contract, scenario)) {
              const simOutcome = await calculateSingleContract(loadedData, contract, scenario, intraBatchSimByCpf);
              if (simOutcome.error) {
                errors.push(simOutcome.error);
              } else if (simOutcome.payslip && simOutcome.snapshot) {
                simulatedPayslipsForTax.push(simOutcome.payslip);
                simulatedSnapshots.push(simOutcome.snapshot);
                appendIntraBatch(intraBatchSimByCpf, contract, simOutcome.payslip);
              }
            } else {
              simulatedPayslipsForTax.push(baseOutcome.payslip);
              simulatedSnapshots.push({ ...baseOutcome.snapshot, affected: false });
              appendIntraBatch(intraBatchSimByCpf, contract, baseOutcome.payslip);
            }
          }
        }
      }

      chunksProcessed++;

      // Atualiza progresso e heartbeat após cada chunk
      await withTenantContext(
        ctx,
        async (client) => {
          await client.query(
            `UPDATE public.payroll_calculation_jobs
             SET processed_contracts = $2,
                 error_count = $3,
                 heartbeat_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1::uuid;`,
            [job.id, processedCount, errors.length]
          );

          if (mode === 'REAL') {
            await client.query(
              `UPDATE public.payroll_periods
               SET heartbeat_at = NOW(), updated_at = NOW()
               WHERE id = $1::uuid AND status = 'CALCULATING';`,
              [job.period_id]
            );
          }
        },
        pool
      );
    }

    const durationMs = Date.now() - startedAt;

    // 4. Finalização por modo
    if (mode === 'REAL') {
      if (errors.length > 0) {
        return await withTenantContext(
          ctx,
          async (client) => {
            await client.query(
              `UPDATE public.payroll_periods
               SET status = $1, locked_at = NULL, heartbeat_at = NULL, updated_at = NOW()
               WHERE id = $2::uuid AND status = 'CALCULATING';`,
              [job.restore_period_status || 'DRAFT', job.period_id]
            );

            const { rows } = await client.query(
              `UPDATE public.payroll_calculation_jobs
               SET status = 'FAILED',
                   processed_contracts = $2,
                   error_count = $3,
                   errors_json = $4::jsonb,
                   summary_json = $5::jsonb,
                   finished_at = NOW(),
                   updated_at = NOW()
               WHERE id = $1::uuid
               RETURNING *;`,
              [
                job.id,
                processedCount,
                errors.length,
                JSON.stringify(errors),
                JSON.stringify({
                  mode: 'REAL',
                  chunks_processed: chunksProcessed,
                  duration_ms: durationMs,
                }),
              ]
            );
            return rows[0];
          },
          pool
        );
      }

      // Persistência em transação única (BEGIN ... COMMIT via withTenantContext)
      return await withTenantContext(
        ctx,
        async (client) => {
          let existingPayslipsForTaxes: ExistingPayslipBase[] = [];
          if (job.contract_id_filter) {
            const { rows: otherSlips } = await client.query(
              `SELECT ps.contract_id, c.company_id, ps.base_inss, ps.base_fgts, ps.fgts_month,
                      COALESCE(c.calculation_regime, 'CLT') AS calculation_regime,
                      COALESCE(c.special_retirement_exposure_code, '01') AS special_retirement_exposure_code,
                      COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '901'), 0) AS inss_employee,
                      COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '104'), 0) AS maternity_deduction,
                      COALESCE((SELECT SUM(pi.amount) FROM public.payslip_items pi WHERE pi.payslip_id = ps.id AND pi.rubric_code = '305'), 0) AS family_salary_deduction
               FROM public.payslips ps
               JOIN public.contracts c ON c.id = ps.contract_id
               WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id <> $2::uuid;`,
              [job.period_id, job.contract_id_filter]
            );
            existingPayslipsForTaxes = otherSlips.map((p: any) => ({
              contract_id: p.contract_id,
              company_id: p.company_id,
              base_inss: Number(p.base_inss || 0),
              base_fgts: Number(p.base_fgts || 0),
              fgts_month: Number(p.fgts_month || 0),
              inss_employee: Number(p.inss_employee || 0),
              maternity_deduction: Number(p.maternity_deduction || 0),
              family_salary_deduction: Number(p.family_salary_deduction || 0),
              calculation_regime: p.calculation_regime,
              special_retirement_exposure_code: p.special_retirement_exposure_code,
            }));
          }

          const consolidatedCompanyTotals = aggregateCompanyBases({
            calculatedPayslips: calculatedPayslips.map((p) => ({
              contract_id: p.contract_id,
              base_inss: p.base_inss,
              base_fgts: p.base_fgts,
              fgts_month: p.fgts_month,
              inss_employee: p.inss_employee,
              maternity_deduction: p.maternity_deduction,
              family_salary_deduction: p.family_salary_deduction,
              calculation_regime: p.calculation_regime,
              special_retirement_exposure_code: p.special_retirement_exposure_code,
            })),
            existingPayslips: existingPayslipsForTaxes,
            contractCompanyMap: loadedData.contractCompanyMap,
          });

          const companyTaxes = calculateConsolidatedEmployerTaxes({
            tenant_id: payload.tenantId,
            period_id: job.period_id,
            competence_year: loadedData.period.year,
            companyTotals: consolidatedCompanyTotals,
            companies: loadedData.companies,
          });

          const atomicPayload = buildAtomicPayrollPayload({
            tenant_id: payload.tenantId,
            period_id: job.period_id,
            contract_id_filter: job.contract_id_filter || null,
            payslips: calculatedPayslips,
            company_taxes: companyTaxes,
          });

          const { rows: saveRows } = await client.query(
            `SELECT public.save_payroll_period($1::uuid, $2::jsonb) AS res;`,
            [job.period_id, JSON.stringify(atomicPayload)]
          );

          await persistIrrfCashLedger(client, {
            tenantId: payload.tenantId,
            periodId: job.period_id,
            contractIdFilter: job.contract_id_filter || null,
            entries: irrfCashEntries,
          });

          await persistAlimonySplits(client, {
            tenantId: payload.tenantId,
            periodId: job.period_id,
            contractIdFilter: job.contract_id_filter || null,
            splits: alimonySplits,
          });

          await client.query(
            `UPDATE public.payroll_periods
             SET locked_at = NULL, heartbeat_at = NULL, updated_at = NOW()
             WHERE id = $1::uuid;`,
            [job.period_id]
          );

          const saveRes = saveRows[0]?.res || {};
          const summary = {
            mode: 'REAL',
            total_contracts: totalContracts,
            processed_contracts: processedCount,
            saved_payslips: calculatedPayslips.length,
            chunks_processed: chunksProcessed,
            duration_ms: durationMs,
            total_earnings: Number(saveRes.total_earnings ?? 0),
            total_deductions: Number(saveRes.total_deductions ?? 0),
            total_net: Number(saveRes.total_net ?? 0),
          };

          const { rows: jobDone } = await client.query(
            `UPDATE public.payroll_calculation_jobs
             SET status = 'COMPLETED',
                 processed_contracts = $2,
                 error_count = 0,
                 errors_json = '[]'::jsonb,
                 summary_json = $3::jsonb,
                 finished_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1::uuid
             RETURNING *;`,
            [job.id, processedCount, JSON.stringify(summary)]
          );

          return jobDone[0];
        },
        pool
      );
    }

    // Modo SIMULATION (What-If): nunca altera payslips ou payroll_periods
    const baseTotals = aggregateCompanyBases({
      calculatedPayslips: baselinePayslipsForTax.map((p) => ({
        contract_id: p.contract_id,
        base_inss: p.base_inss,
        base_fgts: p.base_fgts,
        fgts_month: p.fgts_month,
        inss_employee: p.inss_employee,
        maternity_deduction: p.maternity_deduction,
        family_salary_deduction: p.family_salary_deduction,
      })),
      contractCompanyMap: loadedData.contractCompanyMap,
    });
    const simTotals = aggregateCompanyBases({
      calculatedPayslips: simulatedPayslipsForTax.map((p) => ({
        contract_id: p.contract_id,
        base_inss: p.base_inss,
        base_fgts: p.base_fgts,
        fgts_month: p.fgts_month,
        inss_employee: p.inss_employee,
        maternity_deduction: p.maternity_deduction,
        family_salary_deduction: p.family_salary_deduction,
      })),
      contractCompanyMap: loadedData.contractCompanyMap,
    });

    const baseTaxes = calculateConsolidatedEmployerTaxes({
      tenant_id: payload.tenantId,
      period_id: job.period_id,
      companyTotals: baseTotals,
      companies: loadedData.companies,
    });
    const simTaxes = calculateConsolidatedEmployerTaxes({
      tenant_id: payload.tenantId,
      period_id: job.period_id,
      companyTotals: simTotals,
      companies: loadedData.companies,
    });

    const comparisonSummary = buildWhatIfComparisonSummary({
      scenario,
      baselineContracts: baselineSnapshots,
      simulatedContracts: simulatedSnapshots,
      baselineEmployerTaxes: summarizeCompanyTaxes(baseTaxes),
      simulatedEmployerTaxes: summarizeCompanyTaxes(simTaxes),
      durationMs,
      chunksProcessed,
    });

    return await withTenantContext(
      ctx,
      async (client) => {
        const finalStatus = errors.length > 0 && baselineSnapshots.length === 0 ? 'FAILED' : 'COMPLETED';
        const { rows: jobDone } = await client.query(
          `UPDATE public.payroll_calculation_jobs
           SET status = $2,
               processed_contracts = $3,
               error_count = $4,
               errors_json = $5::jsonb,
               summary_json = $6::jsonb,
               finished_at = NOW(),
               updated_at = NOW()
           WHERE id = $1::uuid
           RETURNING *;`,
          [
            job.id,
            finalStatus,
            processedCount,
            errors.length,
            JSON.stringify(errors),
            JSON.stringify(comparisonSummary),
          ]
        );
        return jobDone[0];
      },
      pool
    );
  } catch (err: any) {
    try {
      await pool.query(`SELECT public.worker_fail_payroll_job($1::uuid, $2::text);`, [
        payload.jobId,
        err?.message || 'Erro inesperado no worker de cálculo.',
      ]);
    } catch (failErr) {
      console.error('[PAYROLL WORKER] Erro ao marcar falha do job:', failErr);
    }
    throw err;
  }
}

/**
 * Despacha o job para o pg-boss (quando ativo) ou para execução imediata em background.
 */
export async function dispatchPayrollJob(payload: PayrollJobQueuePayload): Promise<{ via: 'pg-boss' | 'background' }> {
  const queue = QueueService.getInstance();
  if (queue.isRunning) {
    await queue.enqueuePayrollJob(payload);
    return { via: 'pg-boss' };
  }

  setImmediate(() => {
    processPayrollCalculationJob(payload).catch((err) => {
      console.error('[PAYROLL JOB BACKGROUND ERROR]', err);
    });
  });

  return { via: 'background' };
}

/**
 * Executa o Watchdog anti-deadlock para destravar jobs/períodos em CALCULATING
 * com heartbeat expirado (> staleMinutes) e emitir alerta operacional CRITICAL.
 */
export async function runPayrollWatchdog(
  pool: pg.Pool = dbPool,
  staleMinutes = 5
): Promise<{
  recovered_jobs: any[];
  recovered_periods: any[];
  alerts_created: number;
}> {
  const { rows } = await pool.query<{ res: { recovered_jobs: any[]; recovered_periods: any[] } }>(
    `SELECT public.recover_stuck_payroll_calculations($1::int) AS res;`,
    [staleMinutes]
  );

  const res = rows[0]?.res || { recovered_jobs: [], recovered_periods: [] };
  const recoveredJobs = Array.isArray(res.recovered_jobs) ? res.recovered_jobs : [];
  const recoveredPeriods = Array.isArray(res.recovered_periods) ? res.recovered_periods : [];

  let alertsCreated = 0;
  if (recoveredJobs.length > 0 || recoveredPeriods.length > 0) {
    const alertService = new AlertService(pool);

    for (const item of recoveredJobs) {
      await alertService.createAlert({
        severity: 'CRITICAL',
        category: 'QUEUE',
        title: 'Watchdog: lote de folha destravado por timeout',
        message: `O job de cálculo ${item.job_id} (${item.mode}) permaneceu sem heartbeat além de ${staleMinutes} min e foi encerrado automaticamente.`,
        metadata: item,
      });
      alertsCreated++;
    }

    for (const p of recoveredPeriods) {
      if (p.reason === 'ORPHAN_CALCULATING_LOCK') {
        await alertService.createAlert({
          severity: 'CRITICAL',
          category: 'QUEUE',
          title: 'Watchdog: competência destravada de CALCULATING',
          message: `A competência ${p.period_id} estava presa em CALCULATING sem worker ativo e foi restaurada para ${p.restored_status}.`,
          metadata: p,
        });
        alertsCreated++;
      }
    }
  }

  return {
    recovered_jobs: recoveredJobs,
    recovered_periods: recoveredPeriods,
    alerts_created: alertsCreated,
  };
}
