import type { BridgeConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { releaseBranchLocks, releaseOrphanedBranchLocks } from '../db/branch-locks.js';
import { recordTaskEvent } from '../db/events.js';
import { findExpiredLeaseTasks, updateTaskWhereStatus } from '../db/tasks.js';
import { findExpiredLeaseWorkflowRuns, updateWorkflowRunWhereStatus } from '../db/workflow-runs.js';
import type { Logger } from '../logger.js';

/**
 * Startup + periodic reconciliation: no Railway restart may leave a task in
 * Schrödinger state. Rules:
 *  - PREPARING with no Claude started and attempts remaining → requeued
 *    (preparation is side-effect-free and idempotent).
 *  - RUNNING (or PREPARING out of attempts) with an expired lease → FAILED
 *    WORKER_LOST; the Claude session, if it started, remains resumable.
 *  - CANCEL_REQUESTED with an expired lease → CANCELLED.
 *  - Branch locks whose task is no longer active are released.
 */
export async function reconcile(
  db: Db,
  config: BridgeConfig,
  logger: Logger,
): Promise<{ requeued: number; failed: number; cancelled: number }> {
  let requeued = 0;
  let failed = 0;
  let cancelled = 0;

  const eventOpts = { maxEventsPerTask: config.maxEventsPerTask, maxDetailBytes: config.maxEventDetailBytes };
  const expired = await findExpiredLeaseTasks(db);
  for (const task of expired) {
    await withTransaction(db, async (client) => {
      if (task.status === 'CANCEL_REQUESTED') {
        const updated = await updateTaskWhereStatus(client, task.id, ['CANCEL_REQUESTED'], {
          status: 'CANCELLED',
          phase: 'CANCELLED',
          cancelledAt: new Date(),
          completedAt: new Date(),
          claimedBy: null,
          leaseExpiresAt: null,
        });
        if (updated) {
          cancelled++;
          await releaseBranchLocks(client, task.id);
          await recordTaskEvent(client, task.id, 'CANCELLED', 'Worker lost during cancellation; task finalized as cancelled.', null, eventOpts);
        }
        return;
      }
      if (task.status === 'PREPARING' && !task.claudeStarted && task.attemptCount < config.maxPrepareAttempts) {
        const updated = await updateTaskWhereStatus(client, task.id, ['PREPARING'], {
          status: 'QUEUED',
          phase: 'REQUEUED',
          claimedBy: null,
          leaseExpiresAt: null,
        });
        if (updated) {
          requeued++;
          await recordTaskEvent(
            client,
            task.id,
            'RECONCILED',
            `Worker lost during preparation; task requeued (attempt ${task.attemptCount}/${config.maxPrepareAttempts}).`,
            null,
            eventOpts,
          );
        }
        return;
      }
      const updated = await updateTaskWhereStatus(client, task.id, ['PREPARING', 'RUNNING'], {
        status: 'FAILED',
        phase: 'FAILED',
        errorCode: 'WORKER_LOST',
        errorDetail:
          'The worker executing this task disappeared (crash or redeploy). Claude execution is NOT retried automatically because it may not be idempotent. If a Claude session was started it can be resumed with continue_repo_task; otherwise start a new task.',
        completedAt: new Date(),
        claimedBy: null,
        leaseExpiresAt: null,
      });
      if (updated) {
        failed++;
        await releaseBranchLocks(client, task.id);
        await recordTaskEvent(client, task.id, 'FAILED', 'Worker lost while the task was running; marked FAILED (session may be resumable).', null, eventOpts);
      }
    });
  }

  const expiredRuns = await findExpiredLeaseWorkflowRuns(db);
  for (const run of expiredRuns) {
    if (run.status === 'CANCEL_REQUESTED') {
      const updated = await updateWorkflowRunWhereStatus(db, run.id, ['CANCEL_REQUESTED'], {
        status: 'CANCELLED',
        phase: 'CANCELLED',
        cancelledAt: new Date(),
        completedAt: new Date(),
      });
      if (updated) cancelled++;
      continue;
    }
    if (run.status === 'PREPARING' && run.attemptCount < config.maxPrepareAttempts) {
      const updated = await updateWorkflowRunWhereStatus(db, run.id, ['PREPARING'], {
        status: 'QUEUED',
        phase: 'REQUEUED',
      });
      if (updated) requeued++;
      continue;
    }
    const updated = await updateWorkflowRunWhereStatus(db, run.id, ['PREPARING', 'RUNNING'], {
      status: 'FAILED',
      phase: 'FAILED',
      errorCode: 'WORKER_LOST',
      errorDetail: 'The worker executing this workflow disappeared. Re-run the workflow.',
      completedAt: new Date(),
    });
    if (updated) failed++;
  }

  const releasedLocks = await releaseOrphanedBranchLocks(db);
  if (requeued + failed + cancelled + releasedLocks > 0) {
    logger.info({ requeued, failed, cancelled, releasedLocks }, 'reconciliation applied');
  }
  return { requeued, failed, cancelled };
}
