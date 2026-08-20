import type { Db, Queryable } from './pool.js';
import { withTransaction } from './pool.js';
import type { TaskStatus, WorkflowRun } from '../domain/types.js';

interface RunRow {
  id: string;
  repository_key: string;
  workflow: string;
  branch: string | null;
  pr_number: number | null;
  parameters: Record<string, unknown>;
  status: TaskStatus;
  phase: string | null;
  head_sha: string | null;
  exit_code: number | null;
  output_summary: string | null;
  findings: unknown | null;
  artifacts: unknown | null;
  error_code: string | null;
  error_detail: string | null;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancel_requested_at: Date | null;
  cancelled_at: Date | null;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  attempt_count: number;
}

const COLUMNS = `id, repository_key, workflow, branch, pr_number, parameters, status, phase,
  head_sha, exit_code, output_summary, findings, artifacts, error_code, error_detail,
  created_by, created_at, started_at, completed_at, cancel_requested_at, cancelled_at,
  claimed_by, lease_expires_at, attempt_count`;

function mapRow(r: RunRow): WorkflowRun {
  return {
    id: r.id,
    repositoryKey: r.repository_key,
    workflow: r.workflow,
    branch: r.branch,
    prNumber: r.pr_number,
    parameters: r.parameters ?? {},
    status: r.status,
    phase: r.phase,
    headSha: r.head_sha,
    exitCode: r.exit_code,
    outputSummary: r.output_summary,
    findings: r.findings,
    artifacts: r.artifacts,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    cancelRequestedAt: r.cancel_requested_at,
    cancelledAt: r.cancelled_at,
    claimedBy: r.claimed_by,
    leaseExpiresAt: r.lease_expires_at,
    attemptCount: r.attempt_count,
  };
}

export async function insertWorkflowRun(
  q: Queryable,
  run: {
    id: string;
    repositoryKey: string;
    workflow: string;
    branch: string | null;
    prNumber: number | null;
    parameters: Record<string, unknown>;
    createdBy: string | null;
  },
): Promise<WorkflowRun> {
  const { rows } = await q.query<RunRow>(
    `INSERT INTO workflow_runs (id, repository_key, workflow, branch, pr_number, parameters, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED', $7)
     RETURNING ${COLUMNS}`,
    [run.id, run.repositoryKey, run.workflow, run.branch, run.prNumber, JSON.stringify(run.parameters), run.createdBy],
  );
  return mapRow(rows[0] as RunRow);
}

export async function getWorkflowRun(q: Queryable, id: string): Promise<WorkflowRun | null> {
  const { rows } = await q.query<RunRow>(`SELECT ${COLUMNS} FROM workflow_runs WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function claimNextWorkflowRun(
  db: Db,
  workerId: string,
  leaseSeconds: number,
): Promise<WorkflowRun | null> {
  return withTransaction(db, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('workflow_run_claim'))`);
    const { rows: candidates } = await client.query<{ id: string }>(
      `SELECT id FROM workflow_runs
       WHERE status = 'QUEUED'
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const candidate = candidates[0];
    if (!candidate) return null;
    const { rows } = await client.query<RunRow>(
      `UPDATE workflow_runs
       SET status = 'PREPARING', phase = 'PREPARING', claimed_by = $2,
           lease_expires_at = now() + make_interval(secs => $3),
           attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, now())
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [candidate.id, workerId, leaseSeconds],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

export async function heartbeatWorkflowRun(
  q: Queryable,
  id: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE workflow_runs SET lease_expires_at = now() + make_interval(secs => $3)
     WHERE id = $1 AND claimed_by = $2 AND status IN ('PREPARING','RUNNING','CANCEL_REQUESTED')`,
    [id, workerId, leaseSeconds],
  );
  return (rowCount ?? 0) > 0;
}

export interface WorkflowRunPatch {
  status?: TaskStatus;
  phase?: string | null;
  headSha?: string;
  exitCode?: number | null;
  outputSummary?: string | null;
  findings?: unknown;
  artifacts?: unknown;
  errorCode?: string | null;
  errorDetail?: string | null;
  completedAt?: Date;
  cancelledAt?: Date;
  cancelRequestedAt?: Date;
}

const PATCH_COLUMN: Record<keyof WorkflowRunPatch, string> = {
  status: 'status',
  phase: 'phase',
  headSha: 'head_sha',
  exitCode: 'exit_code',
  outputSummary: 'output_summary',
  findings: 'findings',
  artifacts: 'artifacts',
  errorCode: 'error_code',
  errorDetail: 'error_detail',
  completedAt: 'completed_at',
  cancelledAt: 'cancelled_at',
  cancelRequestedAt: 'cancel_requested_at',
};

export async function updateWorkflowRunWhereStatus(
  q: Queryable,
  id: string,
  expectedStatuses: TaskStatus[],
  patch: WorkflowRunPatch,
): Promise<WorkflowRun | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, expectedStatuses];
  for (const [key, value] of Object.entries(patch) as [keyof WorkflowRunPatch, unknown][]) {
    if (value === undefined) continue;
    const jsonColumns: (keyof WorkflowRunPatch)[] = ['findings', 'artifacts'];
    params.push(jsonColumns.includes(key) && value !== null ? JSON.stringify(value) : value);
    sets.push(`${PATCH_COLUMN[key]} = $${params.length}`);
  }
  if (sets.length === 0) {
    const run = await getWorkflowRun(q, id);
    return run && expectedStatuses.includes(run.status) ? run : null;
  }
  const { rows } = await q.query<RunRow>(
    `UPDATE workflow_runs SET ${sets.join(', ')}
     WHERE id = $1 AND status = ANY($2)
     RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findExpiredLeaseWorkflowRuns(q: Queryable): Promise<WorkflowRun[]> {
  const { rows } = await q.query<RunRow>(
    `SELECT ${COLUMNS} FROM workflow_runs
     WHERE status IN ('PREPARING','RUNNING','CANCEL_REQUESTED')
       AND lease_expires_at IS NOT NULL AND lease_expires_at < now()`,
  );
  return rows.map(mapRow);
}

export async function countWorkflowRunsByStatus(q: Queryable): Promise<Record<string, number>> {
  const { rows } = await q.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM workflow_runs GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}
