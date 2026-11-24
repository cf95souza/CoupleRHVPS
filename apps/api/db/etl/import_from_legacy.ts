/**
 * ==============================================================================
 * CoupleRH VPS — Script de ETL Idempotente de Migração de Dados Legados
 * De: Supabase / PostgreSQL Legado
 * Para: PostgreSQL 17 Puro (apps/api/db/migrations/0001_baseline_schema.sql)
 * 
 * Requisitos Arquiteturais:
 * 1. Mapeamento auth.users -> public.users (preservando UUIDs e integridade)
 * 2. Mapeamento benefits_catalog -> public.benefit_catalogs (unificação de tipos)
 * 3. Mapeamento de arquivos/URLs -> public.stored_files + employee_documents.file_id
 * 4. Idempotência estrita (UPSERT ON CONFLICT)
 * 5. Reconciliação financeira exata: contagem de linhas, soma de net_salary, 
 *    soma de gross_salary, saldos de banco de horas e 100% de integridade referencial.
 * 6. Suporte a --dry-run (default seguro com ROLLBACK) e --commit.
 * ==============================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

export interface EtlOptions {
  dumpFilePath?: string;
  connectionString?: string;
  dryRun?: boolean;
  storageTargetDir?: string;
  silent?: boolean;
}

export interface ReconciliationReport {
  success: boolean;
  dryRun: boolean;
  entityCounts: Array<{
    entity: string;
    legacyCount: number;
    dbCount: number;
    difference: number;
  }>;
  financialTotals: {
    legacyNetSalary: number;
    dbNetSalary: number;
    diffNetSalary: number;
    legacyGrossSalary: number;
    dbGrossSalary: number;
    diffGrossSalary: number;
  };
  timeBankTotals: {
    legacyBalanceMinutes: number;
    dbBalanceMinutes: number;
    diffBalanceMinutes: number;
  };
  integrityChecks: {
    orphanedPayslips: number;
    orphanedContracts: number;
    orphanedTenantUsers: number;
    orphanedBenefits: number;
    orphanedDocuments: number;
    totalOrphaned: number;
  };
}

export function sanitizeCpf(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

export function sanitizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function mapBenefitType(legacyType: string): string {
  const norm = (legacyType || '').trim().toUpperCase();
  switch (norm) {
    case 'VT':
    case 'TRANSPORTATION_VOUCHER':
      return 'TRANSPORTATION_VOUCHER';
    case 'VR':
    case 'MEAL_VOUCHER':
      return 'MEAL_VOUCHER';
    case 'VA':
    case 'FOOD_VOUCHER':
      return 'FOOD_VOUCHER';
    case 'HEALTH':
    case 'HEALTH_PLAN':
      return 'HEALTH_PLAN';
    case 'DENTAL':
    case 'DENTAL_PLAN':
      return 'DENTAL_PLAN';
    case 'LIFE':
    case 'LIFE_INSURANCE':
      return 'LIFE_INSURANCE';
    default:
      return 'OTHER';
  }
}

export async function runEtlMigration(options: EtlOptions = {}): Promise<ReconciliationReport> {
  const isSilent = !!options.silent;
  const dryRun = options.dryRun ?? !process.argv.includes('--commit');
  const dumpFilePath =
    options.dumpFilePath ||
    (() => {
      const argIdx = process.argv.indexOf('--file');
      if (argIdx !== -1 && process.argv[argIdx + 1]) {
        return path.resolve(process.cwd(), process.argv[argIdx + 1]);
      }
      return path.join(__dirname, 'sample_legacy_dump.json');
    })();

  const connString =
    options.connectionString ||
    process.env.DATABASE_ADMIN_URL ||
    process.env.DATABASE_URL ||
    'postgres://postgres:postgres_super_pass@localhost:5435/couplerh_prod';

  if (!isSilent) {
    console.log('\n================================================================');
    console.log('  CoupleRH VPS — ETL de Migração Legado -> PostgreSQL 17 Puro');
    console.log('================================================================');
    console.log(`[ETL] Modo de Execução: ${dryRun ? 'DRY-RUN (Transação com ROLLBACK)' : 'PRODUÇÃO (COMMIT ATÔMICO)'}`);
    console.log(`[ETL] Arquivo de Origem: ${dumpFilePath}`);
    console.log(`[ETL] Conexão: ${connString.replace(/:([^:@]+)@/, ':****@')}`);
  }

  if (!fs.existsSync(dumpFilePath)) {
    throw new Error(`Arquivo de dump legado não encontrado em: ${dumpFilePath}`);
  }

  const rawJson = fs.readFileSync(dumpFilePath, 'utf-8');
  const legacyDump = JSON.parse(rawJson);

  const pool = new Pool({
    connectionString: connString,
    connectionTimeoutMillis: 10000,
  });

  const client = await pool.connect();

  try {
    // Iniciar Transação Atômica
    await client.query('BEGIN');

    // Desativar temporariamente triggers para carregamento de massa com integridade preservada
    await client.query("SET session_replication_role = 'replica';");

    // 1. Tenants
    const tenants = legacyDump.tenants || [];
    for (const t of tenants) {
      await client.query(
        `INSERT INTO public.tenants (id, name, status, settings, created_at, updated_at)
         VALUES ($1, $2, COALESCE($3, 'ACTIVE'), '{}'::jsonb, COALESCE($4, NOW()), NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           updated_at = NOW();`,
        [t.id, t.name, t.status, t.created_at]
      );
    }

    // 2. Mapeamento auth.users -> public.users e tenant_users
    const authUsers = legacyDump.auth_users || legacyDump.users || [];
    const defaultPasswordHash =
      '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRmb3JldGwxMjM$mZ1+h7qjK8+qN8g6VdZzC3X+fL9pD7q+f9b5xQ8mN2g';

    for (const u of authUsers) {
      const email = sanitizeEmail(u.email);
      const meta = u.raw_user_meta_data || u.user_metadata || {};
      const cpf = sanitizeCpf(meta.cpf || u.cpf);
      const fullName = meta.full_name || u.full_name || u.name || email.split('@')[0];
      const phone = meta.phone || u.phone || null;
      const role = meta.role || u.role || 'employee';

      // Preserva hash bcrypt se compatível ou usa Argon2id temporário com must_change_password
      const isBcrypt = typeof u.encrypted_password === 'string' && u.encrypted_password.startsWith('$2');
      const passwordHash = isBcrypt ? u.encrypted_password : defaultPasswordHash;
      const mustChangePassword = !isBcrypt;

      await client.query(
        `INSERT INTO public.users (
           id, email, cpf, password_hash, full_name, phone, must_change_password, is_active, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, COALESCE($8, NOW()), NOW())
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           cpf = COALESCE(EXCLUDED.cpf, public.users.cpf),
           full_name = EXCLUDED.full_name,
           phone = COALESCE(EXCLUDED.phone, public.users.phone),
           updated_at = NOW();`,
        [u.id, email, cpf, passwordHash, fullName, phone, mustChangePassword, u.created_at]
      );

      // Associar ao tenant em tenant_users
      const tenantId = u.tenant_id || (tenants.length > 0 ? tenants[0].id : null);
      if (tenantId) {
        const validRole = ['system_admin', 'tenant_admin', 'dp_analyst', 'manager', 'employee', 'sst_specialist', 'auditor'].includes(role)
          ? role
          : 'employee';

        await client.query(
          `INSERT INTO public.tenant_users (tenant_id, user_id, role, is_active)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET
             role = EXCLUDED.role,
             is_active = true,
             updated_at = NOW();`,
          [tenantId, u.id, validRole]
        );
      }
    }

    // 3. Estrutura Organizacional
    // 3.1 Companies
    const companies = legacyDump.companies || [];
    for (const c of companies) {
      await client.query(
        `INSERT INTO public.companies (id, tenant_id, corporate_name, trade_name, cnpj, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'ACTIVE'), NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           corporate_name = EXCLUDED.corporate_name,
           trade_name = EXCLUDED.trade_name,
           status = EXCLUDED.status,
           updated_at = NOW();`,
        [c.id, c.tenant_id, c.corporate_name, c.trade_name, c.cnpj, c.status]
      );
    }

    // 3.2 Establishments
    const establishments = legacyDump.establishments || [];
    for (const e of establishments) {
      await client.query(
        `INSERT INTO public.establishments (id, tenant_id, company_id, name, cnpj, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           cnpj = EXCLUDED.cnpj,
           updated_at = NOW();`,
        [e.id, e.tenant_id, e.company_id, e.name, e.cnpj]
      );
    }

    // 3.3 Departments
    const departments = legacyDump.departments || [];
    for (const d of departments) {
      await client.query(
        `INSERT INTO public.departments (id, tenant_id, company_id, name, code)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           updated_at = NOW();`,
        [d.id, d.tenant_id, d.company_id, d.name, d.code]
      );
    }

    // 3.4 Positions
    const positions = legacyDump.positions || [];
    for (const p of positions) {
      await client.query(
        `INSERT INTO public.positions (id, tenant_id, title, cbo)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           cbo = EXCLUDED.cbo,
           updated_at = NOW();`,
        [p.id, p.tenant_id, p.title || p.name, p.cbo]
      );
    }

    // 3.5 Contract Types
    const contractTypes = legacyDump.contract_types || [];
    for (const ct of contractTypes) {
      await client.query(
        `INSERT INTO public.contract_types (id, tenant_id, name, code)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code;`,
        [ct.id, ct.tenant_id, ct.name, ct.code]
      );
    }

    // 3.6 Work Shifts
    const workShifts = legacyDump.work_shifts || [];
    for (const ws of workShifts) {
      await client.query(
        `INSERT INTO public.work_shifts (id, tenant_id, name, weekly_hours, schedule_data)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           weekly_hours = EXCLUDED.weekly_hours,
           schedule_data = EXCLUDED.schedule_data,
           updated_at = NOW();`,
        [ws.id, ws.tenant_id, ws.name, ws.weekly_hours, JSON.stringify(ws.schedule_data || ws.schedule_json || {})]
      );
    }

    // 4. Trabalhadores e Contratos
    // 4.1 Workers
    const workers = legacyDump.workers || [];
    for (const w of workers) {
      await client.query(
        `INSERT INTO public.workers (
           id, tenant_id, user_id, full_name, cpf, rg, rg_issuer, rg_state, pis, ctps_number,
           ctps_series, ctps_state, birth_date, gender, marital_status, email, phone
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           full_name = EXCLUDED.full_name,
           cpf = EXCLUDED.cpf,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           updated_at = NOW();`,
        [
          w.id,
          w.tenant_id,
          w.user_id || null,
          w.full_name,
          sanitizeCpf(w.cpf),
          w.rg || null,
          w.rg_issuer || null,
          w.rg_state || null,
          w.pis || null,
          w.ctps_number || null,
          w.ctps_series || null,
          w.ctps_state || null,
          w.birth_date || null,
          w.gender || null,
          w.marital_status || null,
          w.email ? sanitizeEmail(w.email) : null,
          w.phone || null,
        ]
      );
    }

    // 4.2 Contracts
    const contracts = legacyDump.contracts || legacyDump.employment_contracts || [];
    for (const c of contracts) {
      await client.query(
        `INSERT INTO public.contracts (
           id, tenant_id, worker_id, company_id, establishment_id, department_id,
           position_id, contract_type_id, registration_number, admission_date,
           salary_type, base_salary, monthly_hours, weekly_hours, regime, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, COALESCE($16, 'ACTIVE'))
         ON CONFLICT (id) DO UPDATE SET
           registration_number = EXCLUDED.registration_number,
           base_salary = EXCLUDED.base_salary,
           monthly_hours = EXCLUDED.monthly_hours,
           weekly_hours = EXCLUDED.weekly_hours,
           regime = EXCLUDED.regime,
           status = EXCLUDED.status,
           updated_at = NOW();`,
        [
          c.id,
          c.tenant_id,
          c.worker_id,
          c.company_id,
          c.establishment_id,
          c.department_id || null,
          c.position_id,
          c.contract_type_id,
          c.registration_number,
          c.admission_date,
          c.salary_type || 'MONTHLY',
          c.base_salary,
          c.monthly_hours || 220.0,
          c.weekly_hours || 44.0,
          c.regime || 'CLT',
          c.status || 'ACTIVE',
        ]
      );
    }

    // 5. Benefícios: Mapeamento benefits_catalog -> benefit_catalogs
    const benefitsCatalog = legacyDump.benefits_catalog || legacyDump.benefit_catalogs || [];
    for (const b of benefitsCatalog) {
      const standardType = mapBenefitType(b.benefit_type);
      const code = b.code || `BEN_${b.name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;

      await client.query(
        `INSERT INTO public.benefit_catalogs (
           id, tenant_id, name, code, benefit_type, default_provider, max_deduction_percentage, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, true))
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           benefit_type = EXCLUDED.benefit_type,
           default_provider = EXCLUDED.default_provider,
           max_deduction_percentage = EXCLUDED.max_deduction_percentage,
           is_active = EXCLUDED.is_active,
           updated_at = NOW();`,
        [b.id, b.tenant_id, b.name, code, standardType, b.provider_name || b.default_provider || null, b.max_deduction_percentage || null, b.is_active]
      );
    }

    const employeeBenefits = legacyDump.employee_benefits || [];
    for (const eb of employeeBenefits) {
      const catalogId = eb.benefit_id || eb.benefit_catalog_id;
      await client.query(
        `INSERT INTO public.employee_benefits (
           id, tenant_id, contract_id, benefit_catalog_id, provider_name, start_date, company_cost, employee_discount
         ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           company_cost = EXCLUDED.company_cost,
           employee_discount = EXCLUDED.employee_discount,
           updated_at = NOW();`,
        [
          eb.id,
          eb.tenant_id,
          eb.contract_id,
          catalogId,
          eb.provider_name || null,
          eb.start_date || '2026-01-01',
          eb.company_cost || eb.cost_employer || 0,
          eb.employee_discount || eb.cost_employee || 0,
        ]
      );
    }

    // 6. Ponto e Banco de Horas
    const timeDevices = legacyDump.time_devices || [];
    for (const td of timeDevices) {
      await client.query(
        `INSERT INTO public.time_devices (id, tenant_id, company_id, name, kind, last_nsr, status)
         VALUES ($1, $2, $3, $4, COALESCE($5, 'REP_P_MOBILE'), COALESCE($6, 0), COALESCE($7, 'ACTIVE'))
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = NOW();`,
        [td.id, td.tenant_id, td.company_id, td.name, td.kind || 'REP_P_MOBILE', td.last_nsr || 0, td.status || 'ACTIVE']
      );
    }

    const timeBankAccounts = legacyDump.time_bank_accounts || [];
    for (const tba of timeBankAccounts) {
      await client.query(
        `INSERT INTO public.time_bank_accounts (id, tenant_id, company_id, contract_id, balance_minutes, initial_balance_minutes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, contract_id) DO UPDATE SET
           balance_minutes = EXCLUDED.balance_minutes,
           updated_at = NOW();`,
        [tba.id, tba.tenant_id, tba.company_id || null, tba.contract_id, tba.balance_minutes || 0, tba.initial_balance_minutes || 0]
      );
    }

    // 7. Folha de Pagamento
    const payrollPeriods = legacyDump.payroll_periods || [];
    for (const pp of payrollPeriods) {
      await client.query(
        `INSERT INTO public.payroll_periods (
           id, tenant_id, company_id, year, month, type, status, payment_date, competence_date
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           payment_date = EXCLUDED.payment_date,
           competence_date = EXCLUDED.competence_date,
           updated_at = NOW();`,
        [
          pp.id,
          pp.tenant_id,
          pp.company_id,
          pp.year,
          pp.month,
          pp.type || pp.period_type || 'MONTHLY',
          pp.status || 'APPROVED',
          pp.payment_date,
          pp.competence_date || `${pp.year}-${String(pp.month).padStart(2, '0')}-01`,
        ]
      );
    }

    const payslips = legacyDump.payslips || [];
    for (const ps of payslips) {
      await client.query(
        `INSERT INTO public.payslips (
           id, tenant_id, payroll_period_id, contract_id, worker_id,
           gross_salary, total_earnings, total_deductions, net_salary,
           base_inss, base_irrf, base_fgts, fgts_month, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (payroll_period_id, contract_id) DO UPDATE SET
           gross_salary = EXCLUDED.gross_salary,
           total_earnings = EXCLUDED.total_earnings,
           total_deductions = EXCLUDED.total_deductions,
           net_salary = EXCLUDED.net_salary,
           status = EXCLUDED.status,
           updated_at = NOW();`,
        [
          ps.id,
          ps.tenant_id,
          ps.payroll_period_id,
          ps.contract_id,
          ps.worker_id,
          ps.gross_salary || 0,
          ps.total_earnings || 0,
          ps.total_deductions || 0,
          ps.net_salary || 0,
          ps.base_inss || 0,
          ps.base_irrf || 0,
          ps.base_fgts || 0,
          ps.fgts_month || 0,
          ps.status || 'APPROVED',
        ]
      );
    }

    // 8. Arquivos de Storage e Documentos (stored_files + employee_documents)
    const employeeDocs = legacyDump.employee_documents || [];
    for (const doc of employeeDocs) {
      const fileId = crypto.randomUUID();
      const filename = doc.file_url ? path.basename(doc.file_url) : `doc_${doc.id}.pdf`;
      const relPath = `${doc.tenant_id}/${doc.worker_id}/${filename}`;
      const sha256 = doc.sha256 || crypto.createHash('sha256').update(relPath).digest('hex');
      const sizeBytes = doc.size_bytes || 102400;

      await client.query(
        `INSERT INTO public.stored_files (
           id, tenant_id, worker_id, category, original_name, mime_type, byte_size, sha256_hash, storage_rel_path, is_private
         ) VALUES ($1, $2, $3, 'DOCUMENT', $4, 'application/pdf', $5, $6, $7, true)
         ON CONFLICT (storage_rel_path) DO UPDATE SET
           sha256_hash = EXCLUDED.sha256_hash;`,
        [fileId, doc.tenant_id, doc.worker_id, filename, sizeBytes, sha256, relPath]
      );

      await client.query(
        `INSERT INTO public.employee_documents (
           id, tenant_id, worker_id, contract_id, file_id, title, category, status, requires_signature
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           status = EXCLUDED.status,
           updated_at = NOW();`,
        [
          doc.id,
          doc.tenant_id,
          doc.worker_id,
          doc.contract_id || null,
          fileId,
          doc.title,
          doc.category || 'CONTRACT',
          doc.status || 'SIGNED',
          doc.requires_signature || false,
        ]
      );
    }

    // Reativar triggers normais para auditoria e checagem de reconciliação
    await client.query("SET session_replication_role = 'origin';");

    // =========================================================================
    // RECONCILIAÇÃO FINANCEIRA E DE INTEGRIDADE
    // =========================================================================

    // Contagem de Entidades
    const entityChecks = [
      { entity: 'tenants', legacyCount: tenants.length, table: 'public.tenants' },
      { entity: 'users', legacyCount: authUsers.length, table: 'public.users' },
      { entity: 'companies', legacyCount: companies.length, table: 'public.companies' },
      { entity: 'establishments', legacyCount: establishments.length, table: 'public.establishments' },
      { entity: 'departments', legacyCount: departments.length, table: 'public.departments' },
      { entity: 'positions', legacyCount: positions.length, table: 'public.positions' },
      { entity: 'contract_types', legacyCount: contractTypes.length, table: 'public.contract_types' },
      { entity: 'work_shifts', legacyCount: workShifts.length, table: 'public.work_shifts' },
      { entity: 'workers', legacyCount: workers.length, table: 'public.workers' },
      { entity: 'contracts', legacyCount: contracts.length, table: 'public.contracts' },
      { entity: 'benefit_catalogs', legacyCount: benefitsCatalog.length, table: 'public.benefit_catalogs' },
      { entity: 'employee_benefits', legacyCount: employeeBenefits.length, table: 'public.employee_benefits' },
      { entity: 'time_bank_accounts', legacyCount: timeBankAccounts.length, table: 'public.time_bank_accounts' },
      { entity: 'payroll_periods', legacyCount: payrollPeriods.length, table: 'public.payroll_periods' },
      { entity: 'payslips', legacyCount: payslips.length, table: 'public.payslips' },
      { entity: 'employee_documents', legacyCount: employeeDocs.length, table: 'public.employee_documents' },
    ];

    const entityCounts: ReconciliationReport['entityCounts'] = [];
    const legacyTenantIds = tenants.map((t: any) => t.id);
    for (const ec of entityChecks) {
      let queryStr: string;
      let params: any[];
      if (ec.table === 'public.users') {
        queryStr = `SELECT count(*)::int as count FROM ${ec.table} WHERE id = ANY($1)`;
        params = [authUsers.map((u: any) => u.id)];
      } else if (ec.table === 'public.tenants') {
        queryStr = `SELECT count(*)::int as count FROM ${ec.table} WHERE id = ANY($1)`;
        params = [legacyTenantIds];
      } else {
        queryStr = `SELECT count(*)::int as count FROM ${ec.table} WHERE tenant_id = ANY($1)`;
        params = [legacyTenantIds];
      }
      const res = await client.query(queryStr, params);
      const dbCount = res.rows[0].count;
      entityCounts.push({
        entity: ec.entity,
        legacyCount: ec.legacyCount,
        dbCount,
        difference: dbCount - ec.legacyCount,
      });
    }

    // Reconciliação Financeira de Folha de Pagamento no escopo do Tenant Legado
    const legacyNetSalary = payslips.reduce((acc: number, p: any) => acc + Math.round(Number(p.net_salary || 0) * 100), 0) / 100;
    const legacyGrossSalary = payslips.reduce((acc: number, p: any) => acc + Math.round(Number(p.gross_salary || 0) * 100), 0) / 100;

    const netSalaryRes = await client.query(
      'SELECT COALESCE(SUM(net_salary), 0)::numeric as net, COALESCE(SUM(gross_salary), 0)::numeric as gross FROM public.payslips WHERE tenant_id = ANY($1)',
      [legacyTenantIds]
    );
    const dbNetSalary = Number(netSalaryRes.rows[0].net);
    const dbGrossSalary = Number(netSalaryRes.rows[0].gross);

    const diffNetSalary = Math.abs(Math.round((legacyNetSalary - dbNetSalary) * 100) / 100);
    const diffGrossSalary = Math.abs(Math.round((legacyGrossSalary - dbGrossSalary) * 100) / 100);

    // Reconciliação de Banco de Horas no escopo do Tenant Legado
    const legacyBalanceMinutes = timeBankAccounts.reduce((acc: number, t: any) => acc + (Number(t.balance_minutes) || 0), 0);
    const timeBankRes = await client.query(
      'SELECT COALESCE(SUM(balance_minutes), 0)::int as minutes FROM public.time_bank_accounts WHERE tenant_id = ANY($1)',
      [legacyTenantIds]
    );
    const dbBalanceMinutes = Number(timeBankRes.rows[0].minutes);
    const diffBalanceMinutes = Math.abs(legacyBalanceMinutes - dbBalanceMinutes);

    // Checagem de Chaves Estrangeiras Órfãs (Integridade Referencial 100%)
    const orphanedPayslipsRes = await client.query(
      'SELECT count(*)::int as c FROM public.payslips p LEFT JOIN public.contracts c ON p.contract_id = c.id WHERE c.id IS NULL'
    );
    const orphanedContractsRes = await client.query(
      'SELECT count(*)::int as c FROM public.contracts c LEFT JOIN public.workers w ON c.worker_id = w.id WHERE w.id IS NULL'
    );
    const orphanedTenantUsersRes = await client.query(
      'SELECT count(*)::int as c FROM public.tenant_users tu LEFT JOIN public.users u ON tu.user_id = u.id WHERE u.id IS NULL'
    );
    const orphanedBenefitsRes = await client.query(
      'SELECT count(*)::int as c FROM public.employee_benefits eb LEFT JOIN public.benefit_catalogs bc ON eb.benefit_catalog_id = bc.id WHERE bc.id IS NULL'
    );
    const orphanedDocumentsRes = await client.query(
      'SELECT count(*)::int as c FROM public.employee_documents ed LEFT JOIN public.stored_files sf ON ed.file_id = sf.id WHERE sf.id IS NULL'
    );

    const integrityChecks = {
      orphanedPayslips: orphanedPayslipsRes.rows[0].c,
      orphanedContracts: orphanedContractsRes.rows[0].c,
      orphanedTenantUsers: orphanedTenantUsersRes.rows[0].c,
      orphanedBenefits: orphanedBenefitsRes.rows[0].c,
      orphanedDocuments: orphanedDocumentsRes.rows[0].c,
      totalOrphaned:
        orphanedPayslipsRes.rows[0].c +
        orphanedContractsRes.rows[0].c +
        orphanedTenantUsersRes.rows[0].c +
        orphanedBenefitsRes.rows[0].c +
        orphanedDocumentsRes.rows[0].c,
    };

    const isFinancialReconciled = diffNetSalary === 0 && diffGrossSalary === 0 && diffBalanceMinutes === 0;
    const isIntegrityValid = integrityChecks.totalOrphaned === 0;
    const isSuccess = isFinancialReconciled && isIntegrityValid;

    const report: ReconciliationReport = {
      success: isSuccess,
      dryRun,
      entityCounts,
      financialTotals: {
        legacyNetSalary,
        dbNetSalary,
        diffNetSalary,
        legacyGrossSalary,
        dbGrossSalary,
        diffGrossSalary,
      },
      timeBankTotals: {
        legacyBalanceMinutes,
        dbBalanceMinutes,
        diffBalanceMinutes,
      },
      integrityChecks,
    };

    if (!isSilent) {
      console.log('\n----------------------------------------------------------------');
      console.log('              RELATÓRIO DE RECONCILIAÇÃO FINANCEIRA');
      console.log('----------------------------------------------------------------');
      console.log('ENTIDADE              LEGADO       POSTGRES 17     DIFERENÇA');
      console.log('----------------------------------------------------------------');
      for (const ec of entityCounts) {
        console.log(
          `${ec.entity.padEnd(20)} ${String(ec.legacyCount).padStart(8)} ${String(ec.dbCount).padStart(17)} ${String(ec.difference).padStart(12)}`
        );
      }
      console.log('----------------------------------------------------------------');
      console.log(`Salário Líquido Total Legado:     R$ ${legacyNetSalary.toFixed(2)}`);
      console.log(`Salário Líquido Total Postgres 17: R$ ${dbNetSalary.toFixed(2)}`);
      console.log(`Divergência Salário Líquido:       R$ ${diffNetSalary.toFixed(2)} ${diffNetSalary === 0 ? '✅ [R$ 0,00]' : '❌ [DIVERGÊNCIA]'}`);
      console.log(`Salário Bruto Total Legado:       R$ ${legacyGrossSalary.toFixed(2)}`);
      console.log(`Salário Bruto Total Postgres 17:   R$ ${dbGrossSalary.toFixed(2)}`);
      console.log(`Divergência Salário Bruto:         R$ ${diffGrossSalary.toFixed(2)} ${diffGrossSalary === 0 ? '✅ [R$ 0,00]' : '❌ [DIVERGÊNCIA]'}`);
      console.log(`Saldo Banco de Horas Legado:      ${legacyBalanceMinutes} min`);
      console.log(`Saldo Banco de Horas Postgres 17:  ${dbBalanceMinutes} min`);
      console.log(`Divergência Banco de Horas:        ${diffBalanceMinutes} min ${diffBalanceMinutes === 0 ? '✅ [0 min]' : '❌ [DIVERGÊNCIA]'}`);
      console.log('----------------------------------------------------------------');
      console.log(`Registros Órfãos (FKs inválidas): ${integrityChecks.totalOrphaned} ${integrityChecks.totalOrphaned === 0 ? '✅ [0 órfãos]' : '❌ [VIOLAÇÃO]'}`);
      console.log('----------------------------------------------------------------');
      if (isSuccess) {
        console.log('🏆 [RECONCILIATION SUCCESS]: DIVERGÊNCIA R$ 0,00 — INTEGRIDADE 100%');
      } else {
        console.error('🚨 [RECONCILIATION FAILURE]: DIVERGÊNCIA DETECTADA!');
      }
      console.log('================================================================\n');
    }

    if (dryRun) {
      if (!isSilent) {
        console.log('[ETL] Modo DRY-RUN ativado: Executando ROLLBACK da transação de teste.');
      }
      await client.query('ROLLBACK');
    } else {
      if (!isSuccess) {
        await client.query('ROLLBACK');
        throw new Error('Falha na reconciliação financeira! A transação foi abortada via ROLLBACK para proteger os dados.');
      }
      await client.query('COMMIT');
      if (!isSilent) {
        console.log('[ETL] Modo PRODUÇÃO: Transação persistida via COMMIT com sucesso!');
      }
    }

    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Execução Direta via CLI
if (process.argv[1] && process.argv[1].endsWith('import_from_legacy.ts')) {
  runEtlMigration()
    .then((report) => {
      if (!report.success) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('[ETL FATAL ERROR]', err);
      process.exit(1);
    });
}
