import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, type Db } from '../../src/db/pool.js';
import { randomToken } from '../../src/ids.js';

const CONN_FILE = path.resolve(process.cwd(), '.test-postgres', 'conn.json');

async function adminUrl(): Promise<string> {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const raw = await fs.readFile(CONN_FILE, 'utf8');
  return (JSON.parse(raw) as { adminUrl: string }).adminUrl;
}

export interface TestDatabase {
  db: Db;
  url: string;
  drop: () => Promise<void>;
}

/** Create a fresh database (with migrations applied) inside the shared cluster. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = await adminUrl();
  const name = `bridge_test_${randomToken(10)}`;
  const adminClient = new pg.Client({ connectionString: admin });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE ${name}`);
  await adminClient.end();

  const url = admin.replace(/\/[^/]*$/, `/${name}`);
  const db = createPool({ databaseUrl: url, databaseSsl: false, databasePoolSize: 6 });
  await runMigrations(db, { migrationsDir: path.resolve(process.cwd(), 'migrations') });

  return {
    db,
    url,
    drop: async () => {
      await db.end().catch(() => {});
      const cleaner = new pg.Client({ connectionString: admin });
      await cleaner.connect();
      await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await cleaner.end();
    },
  };
}
