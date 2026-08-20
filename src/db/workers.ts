import type { Queryable } from './pool.js';

export async function heartbeatWorker(
  q: Queryable,
  worker: { id: string; kind: 'worker' | 'api'; hostname: string },
): Promise<void> {
  await q.query(
    `INSERT INTO workers (id, kind, hostname)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = now()`,
    [worker.id, worker.kind, worker.hostname],
  );
}

export interface WorkerInfo {
  id: string;
  kind: string;
  hostname: string | null;
  startedAt: Date;
  lastHeartbeatAt: Date;
}

export async function listWorkers(q: Queryable, sinceMinutes = 10): Promise<WorkerInfo[]> {
  const { rows } = await q.query<{
    id: string;
    kind: string;
    hostname: string | null;
    started_at: Date;
    last_heartbeat_at: Date;
  }>(
    `SELECT id, kind, hostname, started_at, last_heartbeat_at FROM workers
     WHERE last_heartbeat_at > now() - make_interval(mins => $1)
     ORDER BY last_heartbeat_at DESC`,
    [sinceMinutes],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    hostname: r.hostname,
    startedAt: r.started_at,
    lastHeartbeatAt: r.last_heartbeat_at,
  }));
}
