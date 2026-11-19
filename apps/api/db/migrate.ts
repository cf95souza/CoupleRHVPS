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

const connectionString =
  process.env.DATABASE_ADMIN_URL ||
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/couplerh_prod';

console.log(`[MIGRATE] Conectando ao banco de dados: ${connectionString.replace(/:([^:@]+)@/, ':****@')}`);

const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 10000,
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('[MIGRATE] Inicializando tabela de controle schema_migrations...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const { rows: appliedRows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM public.schema_migrations ORDER BY version ASC'
    );
    const appliedMap = new Map(appliedRows.map((r) => [r.version, r.checksum]));

    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.log('[MIGRATE] Diretorio de migrations nao encontrado.');
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    console.log(`[MIGRATE] Total de migrations encontradas: ${files.length}`);

    for (const file of files) {
      const version = file;
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      if (appliedMap.has(version)) {
        const recordedChecksum = appliedMap.get(version);
        if (recordedChecksum !== checksum) {
          console.warn(`[MIGRATE WARNING] Migration ${version} ja foi aplicada mas seu checksum difere!`);
        } else {
          console.log(`[MIGRATE SKIP] ${version} ja aplicada.`);
        }
        continue;
      }

      console.log(`[MIGRATE RUNNING] Aplicando migration: ${version}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, checksum, applied_at) VALUES ($1, $2, NOW())',
          [version, checksum]
        );
        await client.query('COMMIT');
        console.log(`[MIGRATE SUCCESS] ${version} aplicada com sucesso!`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[MIGRATE ERROR] Falha ao aplicar migration ${version}:`, err);
        throw err;
      }
    }

    // Processar seeds se solicitado
    const isSeed = process.argv.includes('--seed');
    if (isSeed) {
      const seedsDir = path.join(__dirname, 'seeds');
      if (fs.existsSync(seedsDir)) {
        const seedFiles = fs
          .readdirSync(seedsDir)
          .filter((f) => f.endsWith('.sql'))
          .sort();
        console.log(`[MIGRATE] Executando ${seedFiles.length} arquivos de seeds...`);
        for (const sFile of seedFiles) {
          console.log(`[SEED RUNNING] Executando seed: ${sFile}...`);
          const sPath = path.join(seedsDir, sFile);
          const sSql = fs.readFileSync(sPath, 'utf-8');
          await client.query('BEGIN');
          try {
            await client.query(sSql);
            await client.query('COMMIT');
            console.log(`[SEED SUCCESS] ${sFile} executado com sucesso!`);
          } catch (sErr) {
            await client.query('ROLLBACK');
            console.error(`[SEED ERROR] Falha ao executar seed ${sFile}:`, sErr);
            throw sErr;
          }
        }
      }
    }

    console.log('[MIGRATE] Todas as operacoes concluidas com sucesso.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('[MIGRATE FATAL]', err);
  process.exit(1);
});
