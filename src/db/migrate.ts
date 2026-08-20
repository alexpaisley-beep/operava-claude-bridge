import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './pool.js';
import type { Logger } from '../logger.js';

/**
 * Minimal forward-only SQL migration runner. Files in the migrations
 * directory are applied in lexicographic order inside a transaction, guarded
 * by an advisory lock so concurrent deploys cannot race each other.
 */

const MIGRATION_LOCK_KEY = 727215; // arbitrary stable app-wide key

export async function runMigrations(
  db: Db,
  opts: { migrationsDir?: string; logger?: Logger } = {},
): Promise<string[]> {
  const dir = opts.migrationsDir ?? path.resolve(process.cwd(), 'migrations');
  const files = (await fs.readdir(dir))
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort((a, b) => (a < b ? -1 : 1));

  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : err}`, {
          cause: err,
        });
      }
      applied.push(file);
      opts.logger?.info({ migration: file }, 'migration applied');
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
  return applied;
}
