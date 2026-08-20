import type { Queryable } from './pool.js';
import { BridgeError } from '../errors.js';

/**
 * Durable one-writer-per-branch locks. Acquired when a write task is created
 * (or a continuation re-activates a task), released on terminal transition
 * and by reconciliation when a lock's task is no longer active.
 */

export async function acquireBranchLock(
  q: Queryable,
  repositoryKey: string,
  branch: string,
  taskId: string,
): Promise<void> {
  const { rows } = await q.query<{ task_id: string }>(
    `INSERT INTO branch_locks (repository_key, branch, task_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (repository_key, branch) DO NOTHING
     RETURNING task_id`,
    [repositoryKey, branch, taskId],
  );
  if (rows.length > 0) return;

  const { rows: holder } = await q.query<{ task_id: string }>(
    `SELECT task_id FROM branch_locks WHERE repository_key = $1 AND branch = $2`,
    [repositoryKey, branch],
  );
  const holderId = holder[0]?.task_id;
  if (holderId === taskId) return; // already ours (idempotent re-acquire)
  throw new BridgeError(
    'BRANCH_BUSY',
    `Branch "${branch}" in repository "${repositoryKey}" is already being written by task ${holderId ?? 'unknown'}.`,
    { detail: `holderTaskId=${holderId ?? 'unknown'}` },
  );
}

export async function releaseBranchLocks(q: Queryable, taskId: string): Promise<number> {
  const { rowCount } = await q.query(`DELETE FROM branch_locks WHERE task_id = $1`, [taskId]);
  return rowCount ?? 0;
}

/** Drop locks held by tasks that are no longer active (reconciliation sweep). */
export async function releaseOrphanedBranchLocks(q: Queryable): Promise<number> {
  const { rowCount } = await q.query(
    `DELETE FROM branch_locks bl
     USING claude_tasks t
     WHERE bl.task_id = t.id
       AND t.status IN ('COMPLETED','FAILED','CANCELLED')
       AND NOT EXISTS (
         SELECT 1 FROM claude_continuations c
         WHERE c.task_id = t.id AND c.status IN ('QUEUED','RUNNING')
       )`,
  );
  return rowCount ?? 0;
}
