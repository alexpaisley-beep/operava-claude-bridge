import type { Queryable } from './pool.js';
import type { Continuation, ContinuationStatus } from '../domain/types.js';

interface ContinuationRow {
  id: string;
  task_id: string;
  seq: number;
  instruction: string;
  status: ContinuationStatus;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  result_summary: string | null;
  error_code: string | null;
  error_detail: string | null;
}

const COLUMNS =
  'id, task_id, seq, instruction, status, created_at, started_at, completed_at, result_summary, error_code, error_detail';

function mapRow(r: ContinuationRow): Continuation {
  return {
    id: r.id,
    taskId: r.task_id,
    seq: r.seq,
    instruction: r.instruction,
    status: r.status,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    resultSummary: r.result_summary,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
  };
}

export async function insertContinuation(
  q: Queryable,
  c: { id: string; taskId: string; instruction: string },
): Promise<Continuation> {
  const { rows } = await q.query<ContinuationRow>(
    `INSERT INTO claude_continuations (id, task_id, seq, instruction, status)
     VALUES (
       $1, $2,
       COALESCE((SELECT max(seq) FROM claude_continuations WHERE task_id = $2), 0) + 1,
       $3, 'QUEUED'
     )
     RETURNING ${COLUMNS}`,
    [c.id, c.taskId, c.instruction],
  );
  return mapRow(rows[0] as ContinuationRow);
}

export async function getContinuation(q: Queryable, id: string): Promise<Continuation | null> {
  const { rows } = await q.query<ContinuationRow>(
    `SELECT ${COLUMNS} FROM claude_continuations WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function nextQueuedContinuation(
  q: Queryable,
  taskId: string,
): Promise<Continuation | null> {
  const { rows } = await q.query<ContinuationRow>(
    `SELECT ${COLUMNS} FROM claude_continuations
     WHERE task_id = $1 AND status = 'QUEUED'
     ORDER BY seq LIMIT 1`,
    [taskId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function hasPendingContinuation(q: Queryable, taskId: string): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM claude_continuations WHERE task_id = $1 AND status IN ('QUEUED','RUNNING') LIMIT 1`,
    [taskId],
  );
  return rows.length > 0;
}

export async function updateContinuation(
  q: Queryable,
  id: string,
  patch: {
    status?: ContinuationStatus;
    startedAt?: Date;
    completedAt?: Date;
    resultSummary?: string | null;
    errorCode?: string | null;
    errorDetail?: string | null;
  },
): Promise<Continuation | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const map: Record<string, string> = {
    status: 'status',
    startedAt: 'started_at',
    completedAt: 'completed_at',
    resultSummary: 'result_summary',
    errorCode: 'error_code',
    errorDetail: 'error_detail',
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${map[key]} = $${params.length}`);
  }
  if (sets.length === 0) return getContinuation(q, id);
  const { rows } = await q.query<ContinuationRow>(
    `UPDATE claude_continuations SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function cancelQueuedContinuations(q: Queryable, taskId: string): Promise<number> {
  const { rowCount } = await q.query(
    `UPDATE claude_continuations SET status = 'CANCELLED', completed_at = now()
     WHERE task_id = $1 AND status = 'QUEUED'`,
    [taskId],
  );
  return rowCount ?? 0;
}

export async function listContinuations(q: Queryable, taskId: string): Promise<Continuation[]> {
  const { rows } = await q.query<ContinuationRow>(
    `SELECT ${COLUMNS} FROM claude_continuations WHERE task_id = $1 ORDER BY seq`,
    [taskId],
  );
  return rows.map(mapRow);
}
