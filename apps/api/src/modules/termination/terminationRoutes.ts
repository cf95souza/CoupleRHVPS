import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdminRole, requirePermission } from '../auth/authMiddleware.js';
import {
  TerminationCalculator,
  evaluateIRRFDependents,
  validateAllLegalTables,
  type DismissalType,
  type NoticeType,
} from '@couplerh/payroll-core';

const terminationPreviewSchema = z.object({
  contractId: z.string().uuid().optional(),
  contract_id: z.string().uuid().optional(),
  resignationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  terminationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dismissalType: z
    .enum(['WITHOUT_CAUSE', 'WITH_CAUSE', 'RESIGNATION', 'MUTUAL_AGREEMENT', 'CONTRACT_EXPIRATION'])
    .optional(),
  reason: z.string().optional(),
  noticeType: z.enum(['WORKED', 'INDEMNIFIED', 'WAIVED', 'MIXED', 'worked', 'indemnified', 'waived', 'mixed']).default('INDEMNIFIED'),
  mediasAdicionais: z.number().nonnegative().default(0),
  outrosDescontos: z.number().nonnegative().default(0),
  fgtsBalancePrior: z.number().nonnegative().optional(),
});

function mapDismissalReason(dismissalType?: string, reason?: string): DismissalType {
  if (dismissalType) return dismissalType as DismissalType;
  const map: Record<string, DismissalType> = {
    '1': 'WITHOUT_CAUSE',
    '2': 'RESIGNATION',
    '3': 'WITH_CAUSE',
    '4': 'CONTRACT_EXPIRATION',
    '5': 'MUTUAL_AGREEMENT',
  };
  return map[reason || '1'] || 'WITHOUT_CAUSE';
}

export const terminationRoutes: FastifyPluginAsync = async (app) => {
  // Cálculo Oficial de Rescisão Trabalhista (TRCT - BUG-08)
  app.post(
    '/calculate',
    { preHandler: [authenticate, requireAdminRole, requirePermission('manage_terminations')] },
    async (request, reply) => {
      const parseResult = terminationPreviewSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: 'Parâmetros de rescisão inválidos.',
          details: parseResult.error.format(),
        });
      }

      const d = parseResult.data;
      const contractId = d.contractId || d.contract_id;
      const resignationDate = d.resignationDate || d.terminationDate;

      if (!contractId || !resignationDate) {
        return reply.status(400).send({
          success: false,
          error: 'contractId e resignationDate são obrigatórios.',
        });
      }

      if (!request.withContext) {
        return reply.status(500).send({ success: false, error: 'Contexto de banco não inicializado.' });
      }

      try {
        const result = await request.withContext(async (client) => {
          const { rows: contractRows } = await client.query<{
            id: string;
            base_salary: string;
            admission_date: any;
            worker_id: string;
            is_apprentice: boolean;
            regime: string;
          }>(
            `SELECT c.id, c.base_salary, c.admission_date, c.worker_id, c.regime, w.is_apprentice
             FROM public.contracts c
             JOIN public.workers w ON w.id = c.worker_id
             WHERE c.id = $1::uuid AND c.status = 'ACTIVE' AND c.deleted_at IS NULL;`,
            [contractId]
          );

          if (contractRows.length === 0) {
            throw new Error('CONTRACT_NOT_FOUND');
          }

          const contract = contractRows[0];
          const admissionDate =
            typeof contract.admission_date === 'string'
              ? contract.admission_date.slice(0, 10)
              : `${contract.admission_date.getUTCFullYear()}-${String(contract.admission_date.getUTCMonth() + 1).padStart(2, '0')}-${String(contract.admission_date.getUTCDate()).padStart(2, '0')}`;

          const [termYearStr, termMonthStr] = resignationDate.split('-');
          const termYear = parseInt(termYearStr, 10);
          const termMonth = parseInt(termMonthStr, 10);
          const periodStartDate = `${termYearStr}-${termMonthStr}-01`;

          // Carregar versão legal vigente na data da rescisão
          const { rows: versions } = await client.query(
            `SELECT id, code, valid_from, valid_to
             FROM public.legal_versions
             WHERE is_active = TRUE
               AND valid_from <= $1::date
               AND (valid_to IS NULL OR valid_to >= $1::date)
             ORDER BY valid_from DESC
             LIMIT 1;`,
            [periodStartDate]
          );

          if (versions.length === 0) {
            throw new Error(`Nenhuma versão legal vigente encontrada para ${termMonth}/${termYear}.`);
          }

          const version = versions[0];
          const { rows: inssRows } = await client.query(
            `SELECT bracket_number, base_limit, aliquot FROM public.inss_parameters WHERE legal_version_id = $1::uuid ORDER BY bracket_number ASC;`,
            [version.id]
          );
          const { rows: irrfRows } = await client.query(
            `SELECT bracket_number, base_limit, aliquot, deduction FROM public.irrf_parameters WHERE legal_version_id = $1::uuid ORDER BY bracket_number ASC;`,
            [version.id]
          );
          const { rows: genRows } = await client.query(
            `SELECT * FROM public.general_legal_parameters WHERE legal_version_id = $1::uuid LIMIT 1;`,
            [version.id]
          );

          const inssParameters = inssRows.map((r: any) => ({
            bracket_number: Number(r.bracket_number),
            base_limit: Number(r.base_limit),
            aliquot: Number(r.aliquot),
            deduction: 0,
          }));
          const irrfParameters = irrfRows.map((r: any) => ({
            bracket_number: Number(r.bracket_number),
            base_limit: r.base_limit !== null ? Number(r.base_limit) : null,
            aliquot: Number(r.aliquot),
            deduction: Number(r.deduction),
          }));
          const rawGen = genRows[0] || null;
          const generalLegalParameters = rawGen
            ? {
                minimum_wage: Number(rawGen.minimum_wage),
                inss_ceiling: Number(rawGen.inss_ceiling),
                dependent_deduction: Number(rawGen.dependent_deduction),
                simplified_discount: Number(rawGen.simplified_discount),
                family_salary_ceiling: Number(rawGen.family_salary_ceiling),
                family_salary_value: Number(rawGen.family_salary_value),
                fgts_standard_aliquot: Number(rawGen.fgts_standard_aliquot),
                fgts_apprentice_aliquot: Number(rawGen.fgts_apprentice_aliquot),
                irrf_exemption_limit:
                  rawGen.irrf_exemption_limit !== null && rawGen.irrf_exemption_limit !== undefined
                    ? Number(rawGen.irrf_exemption_limit)
                    : undefined,
                irrf_reduction_formula_limit:
                  rawGen.irrf_reduction_formula_limit !== null && rawGen.irrf_reduction_formula_limit !== undefined
                    ? Number(rawGen.irrf_reduction_formula_limit)
                    : undefined,
                irrf_reduction_a:
                  rawGen.irrf_reduction_a !== null && rawGen.irrf_reduction_a !== undefined
                    ? Number(rawGen.irrf_reduction_a)
                    : undefined,
                irrf_reduction_b:
                  rawGen.irrf_reduction_b !== null && rawGen.irrf_reduction_b !== undefined
                    ? Number(rawGen.irrf_reduction_b)
                    : undefined,
              }
            : null;

          validateAllLegalTables({
            version: { ...version, version_name: version.code },
            inssBrackets: inssParameters,
            irrfBrackets: irrfParameters,
            generalParams: generalLegalParameters,
            periodMonth: termMonth,
            periodYear: termYear,
          });

          // Dependentes elegíveis do colaborador
          const { rows: depRows } = await client.query(
            `SELECT id, cpf, birth_date, relationship, is_irrf_dependent, is_incapacitated
             FROM public.dependents
             WHERE worker_id = $1::uuid AND deleted_at IS NULL AND is_irrf_dependent = TRUE;`,
            [contract.worker_id]
          );
          const depEval = evaluateIRRFDependents(
            depRows.map((dep: any) => ({
              id: dep.id,
              cpf: dep.cpf,
              birth_date:
                typeof dep.birth_date === 'string'
                  ? dep.birth_date.slice(0, 10)
                  : `${dep.birth_date.getUTCFullYear()}-${String(dep.birth_date.getUTCMonth() + 1).padStart(2, '0')}-${String(dep.birth_date.getUTCDate()).padStart(2, '0')}`,
              relationship: dep.relationship,
              is_irrf_dependent: dep.is_irrf_dependent,
              is_incapacitated: dep.is_incapacitated,
            })),
            termYear,
            termMonth
          );

          const trct = TerminationCalculator.calculate({
            baseSalary: Number(contract.base_salary),
            admissionDate,
            resignationDate,
            noticeDate: d.noticeDate,
            dismissalType: mapDismissalReason(d.dismissalType, d.reason),
            noticeType: d.noticeType.toUpperCase() as NoticeType,
            mediasAdicionais: d.mediasAdicionais,
            outrosDescontos: d.outrosDescontos,
            dependentsCount: depEval.eligibleCount,
            isApprentice: Boolean(contract.is_apprentice || contract.regime === 'APPRENTICE'),
            fgtsBalancePrior: d.fgtsBalancePrior,
            inssParameters,
            irrfParameters,
            generalLegalParameters: generalLegalParameters!,
          });

          return {
            contractId: contract.id,
            ...trct,
          };
        });

        return reply.send({
          success: true,
          data: result,
        });
      } catch (err: any) {
        if (err.message === 'CONTRACT_NOT_FOUND') {
          return reply.status(404).send({ success: false, error: 'Contrato ativo não localizado.' });
        }
        request.log.error(err, '[TERMINATION_CALCULATE] Erro ao calcular rescisão');
        return reply.status(400).send({ success: false, error: err.message || 'Erro ao calcular rescisão.' });
      }
    }
  );
};
