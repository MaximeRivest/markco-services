/**
 * Database pool for sync-relay.
 * Shared Postgres connection used by yjs-store.
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/markco',
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[sync-relay:db] Unexpected pool error:', err.message);
});

/**
 * Run a query with timing.
 */
export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 200) console.warn(`[sync-relay:db] Slow query (${ms}ms):`, text.slice(0, 80));
  return result;
}

/**
 * Initialize schema (idempotent).
 */
export async function initSchema() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  try {
    await pool.query(sql);
    console.log('[sync-relay:db] Schema initialized');
  } catch (err) {
    console.error('[sync-relay:db] Schema init failed:', err.message);
    throw err;
  }
}

/**
 * Health check — can we reach Postgres?
 */
export async function healthCheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export default pool;
