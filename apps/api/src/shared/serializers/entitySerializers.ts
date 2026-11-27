import { maskCpf, maskPis, maskPixKey, maskBankData, maskMedicalCid } from '../security/lgpdMasker.js';

export interface UserPermissionContext {
  hasPermission(slug: string): boolean;
}

/**
 * Serializa dados de um Colaborador / Trabalhador aplicando regras LGPD e Sigilo Salarial.
 */
export function serializeWorker(
  worker: any,
  ctx: UserPermissionContext
): any {
  if (!worker) return null;

  const canViewPii = ctx.hasPermission('view_pii_unmasked');
  const bank = maskBankData(worker.bank_account, worker.bank_agency);

  return {
    id: worker.id,
    tenant_id: worker.tenant_id,
    user_id: worker.user_id,
    full_name: worker.full_name,
    cpf: canViewPii ? worker.cpf : maskCpf(worker.cpf),
    rg: canViewPii ? worker.rg : '***',
    pis: canViewPii ? worker.pis : maskPis(worker.pis),
    birth_date: worker.birth_date,
    gender: worker.gender,
    marital_status: worker.marital_status,
    email: worker.email,
    phone: canViewPii ? worker.phone : (worker.phone ? `(**) *****-${worker.phone.slice(-4)}` : null),
    bank_code: worker.bank_code,
    bank_agency: canViewPii ? worker.bank_agency : bank.agency,
    bank_account: canViewPii ? worker.bank_account : bank.account,
    bank_account_type: worker.bank_account_type,
    pix_key: canViewPii ? worker.pix_key : maskPixKey(worker.pix_key),
    pix_key_type: worker.pix_key_type,
    is_apprentice: worker.is_apprentice,
    is_active: worker.is_active,
    created_at: worker.created_at,
    updated_at: worker.updated_at,
  };
}

/**
 * Serializa um Contrato de Trabalho com Sigilo Salarial e Folha Confidencial da Diretoria.
 */
export function serializeContract(
  contract: any,
  ctx: UserPermissionContext
): any {
  if (!contract) return null;

  // 1. Folha Confidencial (Diretoria / Sócios)
  const isConfidential = contract.is_confidential_payroll === true;
  const canViewExecutive = ctx.hasPermission('view_executive_payroll');
  if (isConfidential && !canViewExecutive) {
    return null; // Oculta integralmente o contrato de diretores para quem não possui a permissão
  }

  // 2. Sigilo Salarial
  const canViewSalary = ctx.hasPermission('view_salaries');

  const serialized: any = {
    id: contract.id,
    tenant_id: contract.tenant_id,
    company_id: contract.company_id,
    establishment_id: contract.establishment_id,
    department_id: contract.department_id,
    sector_id: contract.sector_id,
    position_id: contract.position_id,
    union_id: contract.union_id,
    collective_agreement_id: contract.collective_agreement_id,
    worker_id: contract.worker_id,
    manager_worker_id: contract.manager_worker_id,
    registration_number: contract.registration_number,
    admission_date: contract.admission_date,
    resignation_date: contract.resignation_date,
    status: contract.status,
    is_confidential_payroll: isConfidential,
    base_salary: canViewSalary ? Number(contract.base_salary) : null,
    created_at: contract.created_at,
    updated_at: contract.updated_at,
  };

  // Se vier com joins populados
  if (contract.worker) {
    serialized.worker = serializeWorker(contract.worker, ctx);
  }

  return serialized;
}

/**
 * Serializa Atestados Médicos e Afastamentos (Resolução CFM 1.851/2008 & LGPD Art. 11).
 */
export function serializeMedicalLeave(
  leave: any,
  ctx: UserPermissionContext
): any {
  if (!leave) return null;

  const canViewCid = ctx.hasPermission('view_medical_cid');

  return {
    id: leave.id,
    tenant_id: leave.tenant_id,
    contract_id: leave.contract_id,
    company_id: leave.company_id ?? undefined,
    worker_name: leave.worker_name ?? undefined,
    leave_type: leave.leave_type,
    esocial_reason_code: leave.esocial_reason_code,
    start_date: leave.start_date,
    end_date: leave.end_date,
    return_date: leave.return_date,
    company_paid_days: leave.company_paid_days !== undefined ? Number(leave.company_paid_days) : 0,
    is_same_cid_relapse: Boolean(leave.is_same_cid_relapse),
    parent_leave_id: leave.parent_leave_id ?? null,
    stability_until: leave.stability_until ?? null,
    is_extended_maternity: Boolean(leave.is_extended_maternity),
    notes: leave.notes ?? null,
    status: leave.status,
    is_inss_responsible: leave.is_inss_responsible,
    // CID e dados do médico restritos à medicina do trabalho / SST
    cid10_code: canViewCid ? leave.cid10_code : maskMedicalCid(),
    doctor_crm: canViewCid ? leave.doctor_crm : null,
    doctor_state: canViewCid ? leave.doctor_state : null,
    certificate_file_id: canViewCid ? leave.certificate_file_id : null,
    created_at: leave.created_at,
    updated_at: leave.updated_at,
  };
}

/**
 * Serializa Holerites (Payslips) com Sigilo Salarial.
 */
export function serializePayslip(
  payslip: any,
  ctx: UserPermissionContext,
  isOwner: boolean = false
): any {
  if (!payslip) return null;

  // Titular sempre pode ver seu próprio holerite; gestores/analistas precisam de view_salaries ou view_payslips
  const canViewSalary = isOwner || ctx.hasPermission('view_salaries') || ctx.hasPermission('view_payslips');

  return {
    id: payslip.id,
    tenant_id: payslip.tenant_id,
    payroll_period_id: payslip.payroll_period_id,
    contract_id: payslip.contract_id,
    worker_id: payslip.worker_id,
    status: payslip.status,
    gross_salary: canViewSalary ? Number(payslip.gross_salary) : null,
    net_salary: canViewSalary ? Number(payslip.net_salary) : null,
    total_earnings: canViewSalary ? Number(payslip.total_earnings) : null,
    total_deductions: canViewSalary ? Number(payslip.total_deductions) : null,
    created_at: payslip.created_at,
    updated_at: payslip.updated_at,
    items: canViewSalary ? (payslip.items || []) : [],
  };
}

/**
 * Serializa Beneficiário de Pensão Alimentícia aplicando mascaramento LGPD (CPF, Banco, PIX).
 */
export function serializeAlimonyBeneficiary(
  beneficiary: any,
  ctx: UserPermissionContext
): any {
  if (!beneficiary) return null;

  const canViewPii = ctx.hasPermission('view_pii_unmasked');
  const bank = maskBankData(beneficiary.bank_account, beneficiary.bank_agency);

  return {
    id: beneficiary.id,
    tenant_id: beneficiary.tenant_id,
    contract_id: beneficiary.contract_id,
    rubric_id: beneficiary.rubric_id,
    beneficiary_name: beneficiary.beneficiary_name,
    beneficiary_cpf: canViewPii ? beneficiary.beneficiary_cpf : maskCpf(beneficiary.beneficiary_cpf),
    beneficiary_birth_date: beneficiary.beneficiary_birth_date,
    relationship: beneficiary.relationship,
    court_process_number: beneficiary.court_process_number,
    court_name: beneficiary.court_name,
    calculation_basis: beneficiary.calculation_basis,
    percentage: beneficiary.percentage !== null && beneficiary.percentage !== undefined ? Number(beneficiary.percentage) : null,
    fixed_amount: beneficiary.fixed_amount !== null && beneficiary.fixed_amount !== undefined ? Number(beneficiary.fixed_amount) : null,
    min_amount: beneficiary.min_amount !== null && beneficiary.min_amount !== undefined ? Number(beneficiary.min_amount) : null,
    max_amount: beneficiary.max_amount !== null && beneficiary.max_amount !== undefined ? Number(beneficiary.max_amount) : null,
    payment_method: beneficiary.payment_method,
    pix_key_type: beneficiary.pix_key_type,
    pix_key: canViewPii ? beneficiary.pix_key : maskPixKey(beneficiary.pix_key),
    bank_code: beneficiary.bank_code,
    bank_name: beneficiary.bank_name,
    bank_agency: canViewPii ? beneficiary.bank_agency : bank.agency,
    bank_account: canViewPii ? beneficiary.bank_account : bank.account,
    bank_account_type: beneficiary.bank_account_type,
    apply_on_monthly: Boolean(beneficiary.apply_on_monthly),
    apply_on_advance: Boolean(beneficiary.apply_on_advance),
    apply_on_vacation: Boolean(beneficiary.apply_on_vacation),
    apply_on_thirteenth: Boolean(beneficiary.apply_on_thirteenth),
    apply_on_termination: Boolean(beneficiary.apply_on_termination),
    apply_on_complementary: Boolean(beneficiary.apply_on_complementary),
    start_date: beneficiary.start_date,
    end_date: beneficiary.end_date,
    is_active: Boolean(beneficiary.is_active),
    notes: beneficiary.notes,
    created_at: beneficiary.created_at,
    updated_at: beneficiary.updated_at,
  };
}

/**
 * Serializa Split de Pensão Alimentícia em Holerite respeitando mascaramento LGPD.
 */
export function serializeAlimonySplit(
  split: any,
  ctx: UserPermissionContext
): any {
  if (!split) return null;

  const canViewPii = ctx.hasPermission('view_pii_unmasked');
  const rawDetails = split.payment_details || {};
  const bank = maskBankData(rawDetails.bank_account, rawDetails.bank_agency);

  return {
    id: split.id,
    tenant_id: split.tenant_id,
    payroll_period_id: split.payroll_period_id,
    payslip_id: split.payslip_id,
    contract_id: split.contract_id,
    beneficiary_id: split.beneficiary_id,
    worker_name: split.worker_name ?? undefined,
    beneficiary_name: split.beneficiary_name,
    beneficiary_cpf: canViewPii ? split.beneficiary_cpf : maskCpf(split.beneficiary_cpf),
    court_process_number: split.court_process_number,
    calculation_basis: split.calculation_basis,
    percentage_applied: split.percentage_applied !== null && split.percentage_applied !== undefined ? Number(split.percentage_applied) : null,
    base_amount: Number(split.base_amount || 0),
    amount: Number(split.amount || 0),
    irrf_converged: Number(split.irrf_converged || 0),
    solver_iterations: Number(split.solver_iterations || 0),
    payment_method: split.payment_method,
    payment_details: canViewPii
      ? rawDetails
      : {
          ...rawDetails,
          pix_key: maskPixKey(rawDetails.pix_key),
          bank_agency: bank.agency,
          bank_account: bank.account,
        },
    created_at: split.created_at,
  };
}
