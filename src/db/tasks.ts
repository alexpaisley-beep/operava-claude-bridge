import type { Queryable, Db } from './pool.js';
import { withTransaction } from './pool.js';
import type {
  ClaudeTask,
  ContextMode,
  ExecutionMode,
  TaskPermissions,
  TaskStatus,
  TaskType,
} from '../domain/types.js';

const TASK_COLUMNS = `
  id, type, status, phase, attention_required, attention_reason,
  repository_key, context_mode, base_branch, target_branch, working_branch,
  pr_number, pr_url, objective, execution_mode, requested_model, actual_model,
  claude_session_id, allow_code_changes, allow_commit, allow_push, allow_open_pr,
  allow_update_pr, allow_merge, max_turns, created_by, created_at, started_at,
  completed_at, cancel_requested_at, cancelled_at, head_sha_before, head_sha_after,
  expected_head_sha, merged, merge_sha, merged_at, exit_code, result_summary,
  result_report, report_parse_error, raw_final_response, error_code, error_detail,
  total_cost_usd, num_turns, claimed_by, lease_expires_at, attempt_count,
  claude_started, event_seq, workspace_path, workspace_cleaned, metadata
`;

interface TaskRow {
  id: string;
  type: TaskType;
  status: TaskStatus;
  phase: string | null;
  attention_required: boolean;
  attention_reason: string | null;
  repository_key: string | null;
  context_mode: ContextMode | null;
  base_branch: string | null;
  target_branch: string | null;
  working_branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  objective: string;
  execution_mode: ExecutionMode;
  requested_model: string | null;
  actual_model: string | null;
  claude_session_id: string | null;
  allow_code_changes: boolean;
  allow_commit: boolean;
  allow_push: boolean;
  allow_open_pr: boolean;
  allow_update_pr: boolean;
  allow_merge: boolean;
  max_turns: number | null;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancel_requested_at: Date | null;
  cancelled_at: Date | null;
  head_sha_before: string | null;
  head_sha_after: string | null;
  expected_head_sha: string | null;
  merged: boolean;
  merge_sha: string | null;
  merged_at: Date | null;
  exit_code: number | null;
  result_summary: string | null;
  result_report: unknown | null;
  report_parse_error: string | null;
  raw_final_response: string | null;
  error_code: string | null;
  error_detail: string | null;
  total_cost_usd: number | null;
  num_turns: number | null;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  attempt_count: number;
  claude_started: boolean;
  event_seq: number;
  workspace_path: string | null;
  workspace_cleaned: boolean;
  metadata: Record<string, unknown>;
}

function mapRow(r: TaskRow): ClaudeTask {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    phase: r.phase,
    attentionRequired: r.attention_required,
    attentionReason: r.attention_reason,
    repositoryKey: r.repository_key,
    contextMode: r.context_mode,
    baseBranch: r.base_branch,
    targetBranch: r.target_branch,
    workingBranch: r.working_branch,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    objective: r.objective,
    executionMode: r.execution_mode,
    requestedModel: r.requested_model,
    actualModel: r.actual_model,
    claudeSessionId: r.claude_session_id,
    permissions: {
      allowCodeChanges: r.allow_code_changes,
      allowCommit: r.allow_commit,
      allowPush: r.allow_push,
      allowOpenPr: r.allow_open_pr,
      allowUpdatePr: r.allow_update_pr,
      allowMerge: r.allow_merge,
    },
    maxTurns: r.max_turns,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    cancelRequestedAt: r.cancel_requested_at,
    cancelledAt: r.cancelled_at,
    headShaBefore: r.head_sha_before,
    headShaAfter: r.head_sha_after,
    expectedHeadSha: r.expected_head_sha,
    merged: r.merged,
    mergeSha: r.merge_sha,
    mergedAt: r.merged_at,
    exitCode: r.exit_code,
    resultSummary: r.result_summary,
    resultReport: r.result_report,
    reportParseError: r.report_parse_error,
    rawFinalResponse: r.raw_final_response,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    totalCostUsd: r.total_cost_usd,
    numTurns: r.num_turns,
    claimedBy: r.claimed_by,
    leaseExpiresAt: r.lease_expires_at,
    attemptCount: r.attempt_count,
    claudeStarted: r.claude_started,
    eventSeq: r.event_seq,
    workspacePath: r.workspace_path,
    workspaceCleaned: r.workspace_cleaned,
    metadata: r.metadata ?? {},
  };
}

export interface NewTask {
  id: string;
  type: TaskType;
  repositoryKey: string | null;
  contextMode: ContextMode | null;
  baseBranch: string | null;
  targetBranch: string | null;
  workingBranch: string | null;
  prNumber: number | null;
  objective: string;
  executionMode: ExecutionMode;
  requestedModel: string | null;
  permissions: TaskPermissions;
  maxTurns: number | null;
  createdBy: string | null;
  metadata?: Record<string, unknown>;
}

export async function insertTask(q: Queryable, t: NewTask): Promise<ClaudeTask> {
  const { rows } = await q.query<TaskRow>(
    `INSERT INTO claude_tasks (
       id, type, status, repository_key, context_mode, base_branch, target_branch,
       working_branch, pr_number, objective, execution_mode, requested_model,
       allow_code_changes, allow_commit, allow_push, allow_open_pr, allow_update_pr,
       allow_merge, max_turns, created_by, metadata
     ) VALUES ($1,$2,'QUEUED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING ${TASK_COLUMNS}`,
    [
      t.id,
      t.type,
      t.repositoryKey,
      t.contextMode,
      t.baseBranch,
      t.targetBranch,
      t.workingBranch,
      t.prNumber,
      t.objective,
      t.executionMode,
      t.requestedModel,
      t.permissions.allowCodeChanges,
      t.permissions.allowCommit,
      t.permissions.allowPush,
      t.permissions.allowOpenPr,
      t.permissions.allowUpdatePr,
      t.permissions.allowMerge,
      t.maxTurns,
      t.createdBy,
      JSON.stringify(t.metadata ?? {}),
    ],
  );
  return mapRow(rows[0] as TaskRow);
}

export async function getTask(q: Queryable, id: string): Promise<ClaudeTask | null> {
  const { rows } = await q.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM claude_tasks WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface ListTasksFilter {
  repositoryKey?: string;
  statuses?: TaskStatus[];
  branch?: string;
  prNumber?: number;
  createdAfter?: Date;
  createdBefore?: Date;
  limit: number;
  /** Keyset cursor: return tasks strictly older than this (createdAt, id). */
  cursor?: { createdAt: Date; id: string };
}

export async function listTasks(
  q: Queryable,
  f: ListTasksFilter,
): Promise<{ tasks: ClaudeTask[]; nextCursor: { createdAt: Date; id: string } | null }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (f.repositoryKey) clauses.push(`repository_key = ${bind(f.repositoryKey)}`);
  if (f.statuses && f.statuses.length > 0) clauses.push(`status = ANY(${bind(f.statuses)})`);
  if (f.branch) {
    const p = bind(f.branch);
    clauses.push(`(working_branch = ${p} OR target_branch = ${p} OR base_branch = ${p})`);
  }
  if (f.prNumber !== undefined) clauses.push(`pr_number = ${bind(f.prNumber)}`);
  if (f.createdAfter) clauses.push(`created_at >= ${bind(f.createdAfter)}`);
  if (f.createdBefore) clauses.push(`created_at <= ${bind(f.createdBefore)}`);
  if (f.cursor) {
    clauses.push(`(created_at, id) < (${bind(f.cursor.createdAt)}, ${bind(f.cursor.id)})`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await q.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM claude_tasks ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ${bind(f.limit + 1)}`,
    params,
  );
  const hasMore = rows.length > f.limit;
  const page = rows.slice(0, f.limit).map(mapRow);
  const last = page[page.length - 1];
  return {
    tasks: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

/**
 * Claim the next runnable QUEUED task. Serialized with an advisory lock so
 * per-repository concurrency limits hold across multiple workers, then
 * row-locked with SKIP LOCKED as defense in depth.
 */
export async function claimNextTask(
  db: Db,
  workerId: string,
  leaseSeconds: number,
): Promise<ClaudeTask | null> {
  return withTransaction(db, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('claude_task_claim'))`);
    const { rows: candidates } = await client.query<{ id: string }>(
      `SELECT t.id FROM claude_tasks t
       WHERE t.status = 'QUEUED'
         AND (
           t.repository_key IS NULL
           OR (
             SELECT count(*) FROM claude_tasks a
             WHERE a.repository_key = t.repository_key
               AND a.status IN ('PREPARING','RUNNING','CANCEL_REQUESTED')
           ) < COALESCE(
             (SELECT r.concurrency_limit FROM repositories r WHERE r.key = t.repository_key),
             1
           )
         )
       ORDER BY t.created_at, t.id
       LIMIT 1
       FOR UPDATE OF t SKIP LOCKED`,
    );
    const candidate = candidates[0];
    if (!candidate) return null;
    const { rows } = await client.query<TaskRow>(
      `UPDATE claude_tasks
       SET status = 'PREPARING',
           phase = 'PREPARING',
           claimed_by = $2,
           lease_expires_at = now() + make_interval(secs => $3),
           attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, now())
       WHERE id = $1
       RETURNING ${TASK_COLUMNS}`,
      [candidate.id, workerId, leaseSeconds],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

/** Extend the lease of a task this worker owns. Returns false if ownership was lost. */
export async function heartbeatTask(
  q: Queryable,
  taskId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE claude_tasks
     SET lease_expires_at = now() + make_interval(secs => $3)
     WHERE id = $1 AND claimed_by = $2
       AND status IN ('PREPARING','RUNNING','CANCEL_REQUESTED')`,
    [taskId, workerId, leaseSeconds],
  );
  return (rowCount ?? 0) > 0;
}

export interface TaskPatch {
  status?: TaskStatus;
  phase?: string | null;
  attentionRequired?: boolean;
  attentionReason?: string | null;
  baseBranch?: string;
  workingBranch?: string;
  prNumber?: number;
  prUrl?: string;
  actualModel?: string;
  claudeSessionId?: string;
  claudeStarted?: boolean;
  headShaBefore?: string;
  headShaAfter?: string;
  expectedHeadSha?: string | null;
  merged?: boolean;
  mergeSha?: string;
  mergedAt?: Date;
  exitCode?: number | null;
  resultSummary?: string | null;
  resultReport?: unknown;
  reportParseError?: string | null;
  rawFinalResponse?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  totalCostUsd?: number;
  numTurns?: number;
  completedAt?: Date;
  cancelledAt?: Date;
  cancelRequestedAt?: Date;
  workspacePath?: string | null;
  workspaceCleaned?: boolean;
  claimedBy?: string | null;
  leaseExpiresAt?: Date | null;
}

const PATCH_COLUMN: Record<keyof TaskPatch, string> = {
  status: 'status',
  phase: 'phase',
  attentionRequired: 'attention_required',
  attentionReason: 'attention_reason',
  baseBranch: 'base_branch',
  workingBranch: 'working_branch',
  prNumber: 'pr_number',
  prUrl: 'pr_url',
  actualModel: 'actual_model',
  claudeSessionId: 'claude_session_id',
  claudeStarted: 'claude_started',
  headShaBefore: 'head_sha_before',
  headShaAfter: 'head_sha_after',
  expectedHeadSha: 'expected_head_sha',
  merged: 'merged',
  mergeSha: 'merge_sha',
  mergedAt: 'merged_at',
  exitCode: 'exit_code',
  resultSummary: 'result_summary',
  resultReport: 'result_report',
  reportParseError: 'report_parse_error',
  rawFinalResponse: 'raw_final_response',
  errorCode: 'error_code',
  errorDetail: 'error_detail',
  totalCostUsd: 'total_cost_usd',
  numTurns: 'num_turns',
  completedAt: 'completed_at',
  cancelledAt: 'cancelled_at',
  cancelRequestedAt: 'cancel_requested_at',
  workspacePath: 'workspace_path',
  workspaceCleaned: 'workspace_cleaned',
  claimedBy: 'claimed_by',
  leaseExpiresAt: 'lease_expires_at',
};

/**
 * Conditionally patch a task, guarded by its current status. Returns the
 * updated task, or null when the status guard did not match (caller re-reads
 * and decides — this is how status transitions stay explicit and race-free).
 */
export async function updateTaskWhereStatus(
  q: Queryable,
  taskId: string,
  expectedStatuses: TaskStatus[],
  patch: TaskPatch,
): Promise<ClaudeTask | null> {
  const sets: string[] = [];
  const params: unknown[] = [taskId, expectedStatuses];
  for (const [key, value] of Object.entries(patch) as [keyof TaskPatch, unknown][]) {
    if (value === undefined) continue;
    const column = PATCH_COLUMN[key];
    params.push(key === 'resultReport' && value !== null ? JSON.stringify(value) : value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) {
    const task = await getTask(q, taskId);
    return task && expectedStatuses.includes(task.status) ? task : null;
  }
  const { rows } = await q.query<TaskRow>(
    `UPDATE claude_tasks SET ${sets.join(', ')}
     WHERE id = $1 AND status = ANY($2)
     RETURNING ${TASK_COLUMNS}`,
    params,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Tasks whose worker lease expired while non-terminal — reconciliation input. */
export async function findExpiredLeaseTasks(q: Queryable): Promise<ClaudeTask[]> {
  const { rows } = await q.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM claude_tasks
     WHERE status IN ('PREPARING','RUNNING','CANCEL_REQUESTED')
       AND lease_expires_at IS NOT NULL AND lease_expires_at < now()`,
  );
  return rows.map(mapRow);
}

export async function countTasksByStatus(q: Queryable): Promise<Record<string, number>> {
  const { rows } = await q.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM claude_tasks GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}

/** Terminal tasks with a workspace still on disk, past the retention window. */
export async function findCleanableTasks(
  q: Queryable,
  retentionMinutes: number,
  limit: number,
): Promise<ClaudeTask[]> {
  const { rows } = await q.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM claude_tasks t
     WHERE t.status IN ('COMPLETED','FAILED','CANCELLED')
       AND t.workspace_cleaned = FALSE
       AND t.workspace_path IS NOT NULL
       AND t.completed_at IS NOT NULL
       AND t.completed_at < now() - make_interval(mins => $1)
       AND NOT EXISTS (
         SELECT 1 FROM claude_continuations c
         WHERE c.task_id = t.id AND c.status IN ('QUEUED','RUNNING')
       )
     ORDER BY t.completed_at
     LIMIT $2`,
    [retentionMinutes, limit],
  );
  return rows.map(mapRow);
}

/** Active write tasks on a repository+branch other than the given task. */
export async function findActiveWriteTaskOnBranch(
  q: Queryable,
  repositoryKey: string,
  branch: string,
  excludeTaskId?: string,
): Promise<ClaudeTask | null> {
  const { rows } = await q.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM claude_tasks
     WHERE repository_key = $1
       AND execution_mode = 'WRITE'
       AND status IN ('QUEUED','PREPARING','RUNNING','CANCEL_REQUESTED','WAITING')
       AND (working_branch = $2 OR target_branch = $2)
       AND ($3::text IS NULL OR id <> $3)
     LIMIT 1`,
    [repositoryKey, branch, excludeTaskId ?? null],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
