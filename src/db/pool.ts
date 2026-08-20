import pg from 'pg';
import type { BridgeConfig } from '../config.js';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(config: Pick<BridgeConfig, 'databaseUrl' | 'databaseSsl' | 'databasePoolSize'>): Db {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  });
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error matters more than a rollback failure.
    }
    throw err;
  } finally {
    client.release();
  }
}
