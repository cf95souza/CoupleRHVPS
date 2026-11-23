import { describe, it, expect } from 'vitest';
import {
  runEtlMigration,
  sanitizeCpf,
  sanitizeEmail,
  mapBenefitType,
} from '../db/etl/import_from_legacy.js';

describe('ETL Idempotente Legado -> PostgreSQL 17 Puro', () => {
  it('deve sanitizar CPFs corretamente', () => {
    expect(sanitizeCpf('123.456.789-01')).toBe('12345678901');
    expect(sanitizeCpf('12345678901')).toBe('12345678901');
    expect(sanitizeCpf('123.456.789')).toBeNull();
    expect(sanitizeCpf(null)).toBeNull();
    expect(sanitizeCpf(undefined)).toBeNull();
  });

  it('deve sanitizar e-mails para lowercase e sem espacos', () => {
    expect(sanitizeEmail('  ADMIN.RH@Empresa.COM.br  ')).toBe('admin.rh@empresa.com.br');
  });

  it('deve mapear tipos de beneficios legados para o padrao PostgreSQL 17', () => {
    expect(mapBenefitType('VT')).toBe('TRANSPORTATION_VOUCHER');
    expect(mapBenefitType('VR')).toBe('MEAL_VOUCHER');
    expect(mapBenefitType('VA')).toBe('FOOD_VOUCHER');
    expect(mapBenefitType('HEALTH')).toBe('HEALTH_PLAN');
    expect(mapBenefitType('DENTAL')).toBe('DENTAL_PLAN');
    expect(mapBenefitType('LIFE')).toBe('LIFE_INSURANCE');
    expect(mapBenefitType('OUTRO_DESCONHECIDO')).toBe('OTHER');
  });

  it('deve executar Dry-Run no PostgreSQL 17 com reconciliacao financeira R$ 0,00 e 0 registros orfaos', async () => {
    const report = await runEtlMigration({
      dryRun: true,
      silent: true,
      connectionString:
        process.env.DATABASE_ADMIN_URL ||
        process.env.DATABASE_URL ||
        'postgres://postgres:postgres_super_pass@localhost:5435/couplerh_prod',
    });

    expect(report.dryRun).toBe(true);
    expect(report.success).toBe(true);
    expect(report.financialTotals.diffNetSalary).toBe(0);
    expect(report.financialTotals.diffGrossSalary).toBe(0);
    expect(report.timeBankTotals.diffBalanceMinutes).toBe(0);
    expect(report.integrityChecks.totalOrphaned).toBe(0);

    // Valida valores esperados no dump de teste
    expect(report.financialTotals.legacyNetSalary).toBe(7624.5);
    expect(report.financialTotals.legacyGrossSalary).toBe(9000);
    expect(report.timeBankTotals.legacyBalanceMinutes).toBe(540);
  });
});
