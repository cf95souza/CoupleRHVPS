import crypto from 'node:crypto';
import pg from 'pg';
import {
  generateEsocialEventXml,
  validateEsocialXml,
  type EsocialEnvironment,
  type EsocialLayoutVersion,
  type EsocialOutboundEventInput,
  type EsocialOutboundEventType,
} from '@couplerh/payroll-core';

export interface GenerateEsocialEventParams {
  tenantId: string;
  companyId: string;
  eventType: EsocialOutboundEventType;
  environment: EsocialEnvironment;
  layoutVersion: EsocialLayoutVersion;
  payrollPeriodId?: string;
  contractId?: string;
  rubricId?: string;
  leaveId?: string;
  terminationId?: string;
  costCenterId?: string;
  establishmentId?: string;
  overrides?: Record<string, any>;
}

function isoDate(val: any, fallback = '2026-01-01'): string {
  if (!val) return fallback;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val);
  return s.length >= 10 ? s.slice(0, 10) : fallback;
}

/**
 * Constroi o payload oficial e gera + valida XSD de qualquer um dos 17 eventos eSocial
 * diretamente a partir dos dados reais do PostgreSQL 17.
 */
export async function generateAndPersistEsocialEvent(
  client: pg.PoolClient,
  params: GenerateEsocialEventParams
) {
  const compRes = await client.query(
    `SELECT * FROM public.companies WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL`,
    [params.companyId, params.tenantId]
  );
  if (compRes.rows.length === 0) {
    const err: any = new Error('Empresa nao encontrada.');
    err.statusCode = 404;
    throw err;
  }
  const company = compRes.rows[0];
  const companyCnpj = String(company.cnpj || '').replace(/\D/g, '').padEnd(14, '0');
  const iniValidDefault = `${new Date().getUTCFullYear()}-01`;

  let referenceEntityType: string = 'COMPANY';
  let referenceEntityId: string = company.id;
  let contractId: string | null = params.contractId || null;
  let workerId: string | null = null;
  let payrollPeriodId: string | null = params.payrollPeriodId || null;
  let periodYear: number | null = null;
  let periodMonth: number | null = null;

  const base = {
    environment: params.environment,
    layoutVersion: params.layoutVersion,
    tpInsc: 1 as const,
    nrInsc: companyCnpj,
    indRetif: (params.overrides?.indRetif as 1 | 2) || 1,
    nrRecibo: params.overrides?.nrRecibo,
    sequence: params.overrides?.sequence ?? Math.floor(Math.random() * 90000) + 1,
  };

  let input: EsocialOutboundEventInput;

  switch (params.eventType) {
    case 'S-1000': {
      input = {
        ...base,
        eventType: 'S-1000',
        iniValid: params.overrides?.iniValid || iniValidDefault,
        classTrib: params.overrides?.classTrib || (company.tax_regime === 'SIMPLES_NACIONAL' ? '01' : '99'),
        indDesFolha: Number(company.cprb_gross_revenue_exempt || 0) > 0 ? 1 : 0,
      };
      break;
    }

    case 'S-1005': {
      const estRes = params.establishmentId
        ? await client.query(
            `SELECT * FROM public.establishments WHERE id = $1::uuid AND tenant_id = $2::uuid`,
            [params.establishmentId, params.tenantId]
          )
        : await client.query(
            `SELECT * FROM public.establishments WHERE company_id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL LIMIT 1`,
            [params.companyId, params.tenantId]
          );
      const est = estRes.rows[0];
      referenceEntityType = 'ESTABLISHMENT';
      referenceEntityId = est?.id || company.id;
      input = {
        ...base,
        eventType: 'S-1005',
        iniValid: params.overrides?.iniValid || iniValidDefault,
        tpInscEstab: 1,
        nrInscEstab: (est?.cnpj || companyCnpj).replace(/\D/g, '').padEnd(14, '0'),
        cnaePrep: (company.primary_cnae || '6201501').replace(/\D/g, '').padEnd(7, '0').slice(0, 7),
        aliqRat: (Number(params.overrides?.aliqRat) || 2) as 1 | 2 | 3,
        fap: Number(params.overrides?.fap ?? 1.0),
      };
      break;
    }

    case 'S-1010': {
      const rubRes = params.rubricId
        ? await client.query(`SELECT * FROM public.rubrics WHERE id = $1::uuid`, [params.rubricId])
        : await client.query(`SELECT * FROM public.rubrics WHERE code = '101' LIMIT 1`);
      const rub = rubRes.rows[0];
      if (!rub) {
        const err: any = new Error('Rubrica nao encontrada para geracao do evento S-1010.');
        err.statusCode = 404;
        throw err;
      }
      referenceEntityType = 'RUBRIC';
      referenceEntityId = rub.id;
      const inc = rub.incidencias || {};
      input = {
        ...base,
        eventType: 'S-1010',
        iniValid: params.overrides?.iniValid || iniValidDefault,
        codRubr: rub.code,
        ideTabRubr: params.overrides?.ideTabRubr || 'TAB1',
        dscRubr: rub.name,
        natRubr: (rub.esocial_nature || '1000').replace(/\D/g, '').padEnd(4, '0').slice(0, 4),
        tpRubr: rub.type === 'DEDUCTION' ? 2 : rub.type === 'NEUTRAL' ? 3 : 1,
        codIncCP: inc.inss ? '11' : '00',
        codIncIRRF: inc.irrf ? '11' : '00',
        codIncFGTS: inc.fgts ? '11' : '00',
      };
      break;
    }

    case 'S-1020': {
      const ccRes = params.costCenterId
        ? await client.query(`SELECT * FROM public.cost_centers WHERE id = $1::uuid AND tenant_id = $2::uuid`, [
            params.costCenterId,
            params.tenantId,
          ])
        : await client.query(
            `SELECT * FROM public.cost_centers WHERE tenant_id = $1::uuid AND company_id = $2::uuid AND deleted_at IS NULL LIMIT 1`,
            [params.tenantId, params.companyId]
          );
      const cc = ccRes.rows[0];
      referenceEntityType = 'COST_CENTER';
      referenceEntityId = cc?.id || company.id;
      input = {
        ...base,
        eventType: 'S-1020',
        iniValid: params.overrides?.iniValid || iniValidDefault,
        codLotacao: cc?.esocial_lotacao_code || cc?.code || 'LOT01',
        tpLotacao: cc?.esocial_tp_lotacao || '01',
        fpas: params.overrides?.fpas || '515',
        codTercs: params.overrides?.codTercs || '0079',
        tpInscTomador: cc?.tomador_cnpj ? 1 : undefined,
        nrInscTomador: cc?.tomador_cnpj || undefined,
      };
      break;
    }

    case 'S-2190':
    case 'S-2200':
    case 'S-2205':
    case 'S-2206':
    case 'S-2240':
    case 'S-2300':
    case 'S-2399': {
      const cRes = contractId
        ? await client.query(
            `SELECT c.*, w.full_name, w.cpf, w.birth_date, w.gender, w.race_ethnicity, w.marital_status,
                    p.cbo, p.title AS position_title, e.cnpj AS est_cnpj,
                    cc.esocial_lotacao_code
             FROM public.contracts c
             JOIN public.workers w ON w.id = c.worker_id
             JOIN public.positions p ON p.id = c.position_id
             JOIN public.establishments e ON e.id = c.establishment_id
             LEFT JOIN public.cost_centers cc ON cc.id = c.cost_center_id
             WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid`,
            [contractId, params.tenantId]
          )
        : await client.query(
            `SELECT c.*, w.full_name, w.cpf, w.birth_date, w.gender, w.race_ethnicity, w.marital_status,
                    p.cbo, p.title AS position_title, e.cnpj AS est_cnpj,
                    cc.esocial_lotacao_code
             FROM public.contracts c
             JOIN public.workers w ON w.id = c.worker_id
             JOIN public.positions p ON p.id = c.position_id
             JOIN public.establishments e ON e.id = c.establishment_id
             LEFT JOIN public.cost_centers cc ON cc.id = c.cost_center_id
             WHERE c.company_id = $1::uuid AND c.tenant_id = $2::uuid AND c.deleted_at IS NULL
             ORDER BY c.created_at ASC LIMIT 1`,
            [params.companyId, params.tenantId]
          );
      const c = cRes.rows[0];
      if (!c) {
        const err: any = new Error('Contrato nao encontrado para geracao do evento.');
        err.statusCode = 404;
        throw err;
      }
      contractId = c.id;
      workerId = c.worker_id;
      referenceEntityType = 'CONTRACT';
      referenceEntityId = c.id;
      const cbo = String(c.cbo || '252105').replace(/\D/g, '').padEnd(6, '0').slice(0, 6);
      const codCateg = String(c.esocial_category_code || (c.regime === 'AUTONOMOUS' ? '701' : '101'));

      if (params.eventType === 'S-2190') {
        input = {
          ...base,
          eventType: 'S-2190',
          cpfTrab: c.cpf,
          dtNascto: isoDate(c.birth_date, '1990-01-01'),
          dtAdm: isoDate(c.admission_date),
          matricula: c.registration_number,
          codCateg,
          natAtividade: 1,
          codCBO: cbo,
          vrSalFx: Number(c.base_salary || 0),
          undSalFixo: 5,
        };
      } else if (params.eventType === 'S-2200') {
        input = {
          ...base,
          eventType: 'S-2200',
          cpfTrab: c.cpf,
          nmTrab: c.full_name,
          sexo: c.gender === 'F' ? 'F' : 'M',
          racaCor: 1,
          grauInstr: '09',
          dtNascto: isoDate(c.birth_date, '1990-01-01'),
          matricula: c.registration_number,
          tpRegTrab: 1,
          tpRegPrev: 1,
          dtAdm: isoDate(c.admission_date),
          codCateg,
          codCBO: cbo,
          vrSalFx: Number(c.base_salary || 0),
          undSalFixo: 5,
          tpContr: 1,
          codLotacao: c.esocial_lotacao_code || 'LOT01',
          tpInscLocal: 1,
          nrInscLocal: c.est_cnpj || companyCnpj,
        };
      } else if (params.eventType === 'S-2205') {
        input = {
          ...base,
          eventType: 'S-2205',
          cpfTrab: c.cpf,
          dtAlteracao: params.overrides?.dtAlteracao || new Date().toISOString().slice(0, 10),
          nmTrab: c.full_name,
          sexo: c.gender === 'F' ? 'F' : 'M',
          racaCor: 1,
          grauInstr: '09',
        };
      } else if (params.eventType === 'S-2206') {
        input = {
          ...base,
          eventType: 'S-2206',
          cpfTrab: c.cpf,
          matricula: c.registration_number,
          dtAlteracao: params.overrides?.dtAlteracao || new Date().toISOString().slice(0, 10),
          vrSalFx: Number(c.base_salary || 0),
          undSalFixo: 5,
          codCBO: cbo,
          codCateg,
        };
      } else if (params.eventType === 'S-2240') {
        input = {
          ...base,
          eventType: 'S-2240',
          cpfTrab: c.cpf,
          matricula: c.registration_number,
          dtIniCondicao: isoDate(c.admission_date),
          codAmb: params.overrides?.codAmb || 'AMBIENTE_PADRAO',
          dscAtivDes: params.overrides?.dscAtivDes || `Atividades do cargo ${c.position_title || 'Administrativo'}`,
          codAgNoc: params.overrides?.codAgNoc || '09.01.001',
        };
      } else if (params.eventType === 'S-2300') {
        input = {
          ...base,
          eventType: 'S-2300',
          cpfTrab: c.cpf,
          nmTrab: c.full_name,
          dtNascto: isoDate(c.birth_date, '1990-01-01'),
          codCateg: codCateg === '101' ? '722' : codCateg,
          dtInicio: isoDate(c.admission_date),
          matricula: c.registration_number,
          codCBO: cbo,
          vrSalFx: Number(c.base_salary || 0),
          undSalFixo: 5,
        };
      } else {
        input = {
          ...base,
          eventType: 'S-2399',
          cpfTrab: c.cpf,
          codCateg: codCateg === '101' ? '722' : codCateg,
          dtInicio: isoDate(c.admission_date),
          dtTerm: isoDate(c.termination_date, new Date().toISOString().slice(0, 10)),
          mtvDesligTSV: '99',
        };
      }
      break;
    }

    case 'S-2230': {
      const lRes = params.leaveId
        ? await client.query(
            `SELECT l.*, c.registration_number, c.worker_id, w.cpf
             FROM public.leaves l
             JOIN public.contracts c ON c.id = l.contract_id
             JOIN public.workers w ON w.id = c.worker_id
             WHERE l.id = $1::uuid AND l.tenant_id = $2::uuid`,
            [params.leaveId, params.tenantId]
          )
        : await client.query(
            `SELECT l.*, c.registration_number, c.worker_id, w.cpf
             FROM public.leaves l
             JOIN public.contracts c ON c.id = l.contract_id
             JOIN public.workers w ON w.id = c.worker_id
             WHERE c.company_id = $1::uuid AND l.tenant_id = $2::uuid
             ORDER BY l.created_at DESC LIMIT 1`,
            [params.companyId, params.tenantId]
          );
      const l = lRes.rows[0];
      if (!l) {
        const err: any = new Error('Afastamento nao encontrado para S-2230.');
        err.statusCode = 404;
        throw err;
      }
      contractId = l.contract_id;
      workerId = l.worker_id;
      referenceEntityType = 'LEAVE';
      referenceEntityId = l.id;
      input = {
        ...base,
        eventType: 'S-2230',
        cpfTrab: l.cpf,
        matricula: l.registration_number,
        dtIniAfast: isoDate(l.start_date),
        codMotAfast: l.esocial_reason_code || '03',
        dtTermAfast: l.end_date ? isoDate(l.end_date) : undefined,
      };
      break;
    }

    case 'S-2299': {
      const tRes = params.terminationId
        ? await client.query(
            `SELECT t.*, c.registration_number, c.worker_id, w.cpf
             FROM public.terminations t
             JOIN public.contracts c ON c.id = t.contract_id
             JOIN public.workers w ON w.id = c.worker_id
             WHERE t.id = $1::uuid AND t.tenant_id = $2::uuid`,
            [params.terminationId, params.tenantId]
          )
        : await client.query(
            `SELECT t.*, c.registration_number, c.worker_id, w.cpf
             FROM public.terminations t
             JOIN public.contracts c ON c.id = t.contract_id
             JOIN public.workers w ON w.id = c.worker_id
             WHERE c.company_id = $1::uuid AND t.tenant_id = $2::uuid
             ORDER BY t.created_at DESC LIMIT 1`,
            [params.companyId, params.tenantId]
          );
      const t = tRes.rows[0];
      if (!t) {
        const err: any = new Error('Rescisao nao encontrada para S-2299.');
        err.statusCode = 404;
        throw err;
      }
      contractId = t.contract_id;
      workerId = t.worker_id;
      referenceEntityType = 'TERMINATION';
      referenceEntityId = t.id;
      input = {
        ...base,
        eventType: 'S-2299',
        cpfTrab: t.cpf,
        matricula: t.registration_number,
        mtvDeslig: t.esocial_reason_code || '02',
        dtDeslig: isoDate(t.dismissal_date),
        indPagtoAPI: t.notice_type === 'INDEMNIFIED' ? 'S' : 'N',
        verbas: [
          {
            ideDmDev: `RESC-${String(t.id).slice(0, 8)}`,
            codRubr: '510',
            ideTabRubr: 'TAB1',
            vrRubr: Number(t.gross_amount || 0),
          },
        ],
      };
      break;
    }

    case 'S-1200':
    case 'S-1210':
    case 'S-1298':
    case 'S-1299': {
      const pRes = payrollPeriodId
        ? await client.query(
            `SELECT * FROM public.payroll_periods WHERE id = $1::uuid AND tenant_id = $2::uuid`,
            [payrollPeriodId, params.tenantId]
          )
        : await client.query(
            `SELECT * FROM public.payroll_periods WHERE company_id = $1::uuid AND tenant_id = $2::uuid ORDER BY year DESC, month DESC LIMIT 1`,
            [params.companyId, params.tenantId]
          );
      const period = pRes.rows[0];
      if (!period) {
        const err: any = new Error('Competencia de folha nao encontrada para geracao do evento periodico.');
        err.statusCode = 404;
        throw err;
      }
      payrollPeriodId = period.id;
      periodYear = Number(period.year);
      periodMonth = Number(period.month);
      referenceEntityType = 'PAYROLL_PERIOD';
      referenceEntityId = period.id;
      const perApur = `${periodYear}-${String(periodMonth).padStart(2, '0')}`;
      const indApuracao: 1 | 2 = period.type.startsWith('THIRTEENTH') ? 2 : 1;

      if (params.eventType === 'S-1298') {
        input = { ...base, eventType: 'S-1298', indApuracao, perApur };
      } else if (params.eventType === 'S-1299') {
        input = {
          ...base,
          eventType: 'S-1299',
          indApuracao,
          perApur,
          evtRemun: 'S',
          evtPgtos: 'S',
        };
      } else {
        // S-1200 ou S-1210 exige holerite do contrato
        const slipRes = contractId
          ? await client.query(
              `SELECT ps.*, c.registration_number, c.esocial_category_code, w.cpf, e.cnpj AS est_cnpj, cc.esocial_lotacao_code
               FROM public.payslips ps
               JOIN public.contracts c ON c.id = ps.contract_id
               JOIN public.workers w ON w.id = ps.worker_id
               JOIN public.establishments e ON e.id = c.establishment_id
               LEFT JOIN public.cost_centers cc ON cc.id = c.cost_center_id
               WHERE ps.payroll_period_id = $1::uuid AND ps.contract_id = $2::uuid AND ps.tenant_id = $3::uuid`,
              [period.id, contractId, params.tenantId]
            )
          : await client.query(
              `SELECT ps.*, c.registration_number, c.esocial_category_code, w.cpf, e.cnpj AS est_cnpj, cc.esocial_lotacao_code
               FROM public.payslips ps
               JOIN public.contracts c ON c.id = ps.contract_id
               JOIN public.workers w ON w.id = ps.worker_id
               JOIN public.establishments e ON e.id = c.establishment_id
               LEFT JOIN public.cost_centers cc ON cc.id = c.cost_center_id
               WHERE ps.payroll_period_id = $1::uuid AND ps.tenant_id = $2::uuid
               ORDER BY ps.created_at ASC LIMIT 1`,
              [period.id, params.tenantId]
            );
        const slip = slipRes.rows[0];
        if (!slip) {
          const err: any = new Error('Nenhum holerite calculado na competencia para gerar S-1200/S-1210.');
          err.statusCode = 404;
          throw err;
        }
        contractId = slip.contract_id;
        workerId = slip.worker_id;

        if (params.eventType === 'S-1210') {
          input = {
            ...base,
            eventType: 'S-1210',
            perApur,
            cpfTrab: slip.cpf,
            dtPgto: isoDate(period.payment_date),
            tpPgto: 1,
            ideDmDev: `FOLHA-${perApur}-${String(slip.id).slice(0, 8)}`,
            vrLiq: Number(slip.net_salary || 0),
          };
        } else {
          const itemsRes = await client.query(
            `SELECT rubric_code, reference, amount FROM public.payslip_items WHERE payslip_id = $1::uuid ORDER BY created_at ASC`,
            [slip.id]
          );
          const itens =
            itemsRes.rows.length > 0
              ? itemsRes.rows.map((it) => ({
                  codRubr: it.rubric_code,
                  ideTabRubr: 'TAB1',
                  qtdRubr: it.reference !== null ? Number(it.reference) : undefined,
                  vrRubr: Number(it.amount),
                }))
              : [{ codRubr: '101', ideTabRubr: 'TAB1', vrRubr: Number(slip.gross_salary || 0) }];

          input = {
            ...base,
            eventType: 'S-1200',
            indApuracao,
            perApur,
            cpfTrab: slip.cpf,
            indMV: slip.ind_mv ? (Number(slip.ind_mv) as 1 | 2 | 3) : undefined,
            matricula: slip.registration_number,
            codCateg: String(slip.esocial_category_code || '101'),
            codLotacao: slip.esocial_lotacao_code || 'LOT01',
            tpInscEstab: 1,
            nrInscEstab: slip.est_cnpj || companyCnpj,
            ideDmDev: `FOLHA-${perApur}-${String(slip.id).slice(0, 8)}`,
            itens,
          };
        }
      }
      break;
    }
  }

  const generated = generateEsocialEventXml(input);
  const validation = validateEsocialXml(generated.xml, params.eventType, generated.layoutVersion);
  const xmlSha256 = crypto.createHash('sha256').update(generated.xml, 'utf8').digest('hex');

  const insRes = await client.query(
    `INSERT INTO public.esocial_events (
      tenant_id, company_id, event_type, event_id, environment,
      layout_version, payroll_period_id, contract_id, worker_id,
      reference_entity_type, reference_entity_id, period_year, period_month,
      xml_content, xml_sha256, xsd_valid, xsd_errors, status
    ) VALUES (
      $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
      $6::text, $7::uuid, $8::uuid, $9::uuid,
      $10::text, $11::uuid, $12::int, $13::int,
      $14::text, $15::text, $16::boolean, $17::jsonb, $18::text
    )
    RETURNING *;`,
    [
      params.tenantId,
      params.companyId,
      params.eventType,
      generated.eventId,
      params.environment,
      generated.layoutVersion,
      payrollPeriodId,
      contractId,
      workerId,
      referenceEntityType,
      referenceEntityId,
      periodYear,
      periodMonth,
      generated.xml,
      xmlSha256,
      validation.valid,
      JSON.stringify(validation.errors),
      validation.valid ? 'VALIDATED' : 'DRAFT',
    ]
  );

  return {
    event: insRes.rows[0],
    validation,
  };
}
