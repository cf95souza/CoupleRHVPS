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
    leave_type: leave.leave_type,
    esocial_reason_code: leave.esocial_reason_code,
    start_date: leave.start_date,
    end_date: leave.end_date,
    return_date: leave.return_date,
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
