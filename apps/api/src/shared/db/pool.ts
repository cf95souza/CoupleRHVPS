import pg from 'pg';
import { env } from '../../config/env.js';

const { Pool } = pg;

export const dbPool = new Pool({
  connectionString: env.DATABASE_URL,
  min: env.DATABASE_POOL_MIN,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

dbPool.on('error', (err) => {
  console.error('[DATABASE POOL ERROR] Erro inesperado no cliente do pool:', err);
});