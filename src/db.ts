import { Pool, PoolClient, types } from 'pg';
import { config } from './config.js';

// pg returns BIGINT as string by default. Parse it to number.
types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : false,
});

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}