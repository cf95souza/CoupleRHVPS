import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://couplerh_app:couplerh_app_password_2026@localhost:5432/couplerh_prod'),
  DATABASE_ADMIN_URL: z.string().optional(),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(20),
  JWT_ACCESS_SECRET: z.string().min(16).default('couplerh_jwt_access_secret_super_secure_key_change_in_production_min_64_chars'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().default(7),
  DATA_ENCRYPTION_KEY: z.string().default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  STORAGE_HMAC_SECRET: z.string().default('couplerh_storage_hmac_secret_super_secure_key_change_in_production'),
  STORAGE_BASE_PATH: z.string().default('./storage_data'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),
  APP_PUBLIC_URL: z.string().default('http://localhost:3000'),
  ESOCIAL_ENVIRONMENT: z.enum(['PRODUCTION', 'HOMOLOGATION']).default('HOMOLOGATION'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[CONFIG FATAL] Variaveis de ambiente invalidas:', parsed.error.format());
  throw new Error('Falha na validacao de configuracao do ambiente.');
}

export const env = parsed.data;

export const allowedOriginsList = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());