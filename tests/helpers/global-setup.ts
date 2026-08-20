import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

/**
 * Vitest global setup: provision one ephemeral PostgreSQL cluster for the
 * whole test run (each test file creates its own database inside it).
 *
 * Resolution order:
 *  1. TEST_DATABASE_URL — use an external server (CI service container).
 *  2. Local postgres binaries — init and start a throwaway cluster. When
 *     running as root (containers), the cluster runs as the `postgres` user.
 */
const CONN_FILE = path.resolve(process.cwd(), '.test-postgres', 'conn.json');
const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';

async function asPostgres(command: string): Promise<void> {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    await exec('su', ['postgres', '-s', '/bin/bash', '-c', command]);
  } else {
    await exec('bash', ['-c', command]);
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(CONN_FILE), { recursive: true });

  if (process.env.TEST_DATABASE_URL) {
    await fs.writeFile(CONN_FILE, JSON.stringify({ adminUrl: process.env.TEST_DATABASE_URL, managed: false }));
    return async () => {};
  }

  const port = 54100 + Math.floor(Math.random() * 800);
  const base = `/tmp/bridge-test-pg-${process.pid}`;
  const dataDir = `${base}/data`;
  await fs.rm(base, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    await exec('chown', ['-R', 'postgres:postgres', base]);
  }
  await asPostgres(`${PG_BIN}/initdb -D ${dataDir} --auth=trust -U postgres -E UTF8 >/dev/null`);
  await asPostgres(
    `${PG_BIN}/pg_ctl -D ${dataDir} -o '-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${base} -c fsync=off -c synchronous_commit=off' -l ${base}/log.txt -w start`,
  );
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  await fs.writeFile(CONN_FILE, JSON.stringify({ adminUrl, managed: true, base }));

  return async () => {
    try {
      await asPostgres(`${PG_BIN}/pg_ctl -D ${dataDir} -w -m immediate stop`);
    } catch {
      // best effort
    }
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    await fs.rm(CONN_FILE, { force: true }).catch(() => {});
  };
}
