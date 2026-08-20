import type { BridgeConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { recordTaskEvent } from '../db/events.js';
import { findCleanableTasks, updateTaskWhereStatus } from '../db/tasks.js';
import type { WorkspaceManager } from '../gitx/workspace.js';
import type { Logger } from '../logger.js';

/**
 * Deterministic workspace cleanup: terminal tasks past the retention window
 * (and with no pending continuation) get their isolated clones deleted so
 * abandoned tasks never consume Railway disk forever. The retention window
 * keeps recent workspaces around for diagnosis and cheap continuations.
 */
export async function cleanupWorkspaces(
  db: Db,
  config: BridgeConfig,
  workspaces: WorkspaceManager,
  logger: Logger,
): Promise<number> {
  const tasks = await findCleanableTasks(db, config.workspaceRetentionMinutes, 20);
  let cleaned = 0;
  for (const task of tasks) {
    if (!task.workspacePath) continue;
    try {
      await workspaces.removeWorkspace(task.workspacePath);
      await updateTaskWhereStatus(db, task.id, [task.status], { workspaceCleaned: true, workspacePath: null });
      await recordTaskEvent(db, task.id, 'WORKSPACE_CLEANED', 'Task workspace removed after retention window.', null, {
        maxEventsPerTask: config.maxEventsPerTask,
        maxDetailBytes: config.maxEventDetailBytes,
      });
      cleaned++;
    } catch (err) {
      logger.warn({ err, taskId: task.id }, 'workspace cleanup failed');
    }
  }
  return cleaned;
}
