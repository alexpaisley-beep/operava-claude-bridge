import os from 'node:os';
import fs from 'node:fs/promises';
import { loadConfig, type BridgeConfig } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool, type Db } from '../db/pool.js';
import { claimNextTask } from '../db/tasks.js';
import { claimNextWorkflowRun } from '../db/workflow-runs.js';
import { heartbeatWorker } from '../db/workers.js';
import { BridgeError } from '../errors.js';
import { WorkspaceManager } from '../gitx/workspace.js';
import { createGitHubClient } from '../github/index.js';
import { createLogger, type Logger } from '../logger.js';
import { AgentSdkClaudeRunner } from '../claude/agent-sdk-runner.js';
import { MockClaudeRunner } from '../claude/mock-runner.js';
import type { ClaudeRunner } from '../claude/types.js';
import { syncRepositoriesFromFile } from '../registry/repositories-file.js';
import { loadWorkflowRegistry } from '../workflows/registry.js';
import { cleanupWorkspaces } from './cleanup.js';
import { reconcile } from './reconcile.js';
import { executeTask } from './task-execution.js';
import { executeWorkflowRun } from './workflow-execution.js';

function createClaudeRunner(config: BridgeConfig, logger: Logger): ClaudeRunner {
  if (config.claudeRunner === 'mock') {
    if (config.isProduction) {
      throw new BridgeError('INTERNAL_ERROR', 'CLAUDE_RUNNER=mock is not allowed in production.');
    }
    logger.warn('using MOCK Claude runner — no real Claude execution');
    return new MockClaudeRunner();
  }
  return new AgentSdkClaudeRunner({
    anthropicApiKey: config.anthropicApiKey,
    claudeHomeDir: config.claudeHomeDir,
    allowNetworkTools: config.claudeAllowNetworkTools,
    logger,
  });
}

/**
 * claude-bridge-worker entrypoint: claims QUEUED tasks and workflow runs from
 * Postgres (the only source of truth), executes them with leases and
 * heartbeats, reconciles orphans, and cleans up workspaces.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, service: 'claude-bridge-worker' });
  const db: Db = createPool(config);
  await runMigrations(db, { logger });
  if (config.repositoriesFile) {
    await syncRepositoriesFromFile(db, config.repositoriesFile, logger);
  }
  await fs.mkdir(config.workspaceRoot, { recursive: true });
  await fs.mkdir(config.claudeHomeDir, { recursive: true });

  const workflows = await loadWorkflowRegistry(config.workflowsFile);
  const github = createGitHubClient(config);
  const claude = createClaudeRunner(config, logger);
  const workspaces = new WorkspaceManager({
    workspaceRoot: config.workspaceRoot,
    gitUserName: config.gitUserName,
    gitUserEmail: config.gitUserEmail,
    logger,
    tokenProvider: () => config.githubToken,
    remoteUrlFor: (repo) => `${config.gitRemoteUrlBase}/${repo.githubOwner}/${repo.githubRepo}.git`,
  });

  let shuttingDown = false;
  const isShuttingDown = () => shuttingDown;
  const workerId = config.workerId;
  const running = new Map<string, Promise<void>>();

  const deps = {
    db,
    config,
    logger,
    github,
    claude,
    workspaces,
    workflows,
    workerId,
    isShuttingDown,
  };

  logger.info({ workerId, maxTasks: config.maxConcurrentTasks }, 'claude-bridge-worker starting');
  await reconcile(db, config, logger);

  const poll = async (): Promise<void> => {
    if (shuttingDown) return;
    try {
      const taskSlots =
        config.maxConcurrentTasks - [...running.keys()].filter((k) => k.startsWith('task:')).length;
      if (taskSlots > 0) {
        const task = await claimNextTask(db, workerId, config.leaseSeconds);
        if (task) {
          logger.info({ taskId: task.id, type: task.type }, 'claimed task');
          const key = `task:${task.id}`;
          running.set(
            key,
            executeTask(deps, task)
              .catch((err) => logger.error({ err, taskId: task.id }, 'task execution crashed'))
              .finally(() => running.delete(key)),
          );
        }
      }
      const wfSlots =
        config.maxConcurrentWorkflows - [...running.keys()].filter((k) => k.startsWith('wf:')).length;
      if (wfSlots > 0) {
        const run = await claimNextWorkflowRun(db, workerId, config.leaseSeconds);
        if (run) {
          logger.info({ workflowRunId: run.id, workflow: run.workflow }, 'claimed workflow run');
          const key = `wf:${run.id}`;
          running.set(
            key,
            executeWorkflowRun(deps, run)
              .catch((err) => logger.error({ err, workflowRunId: run.id }, 'workflow execution crashed'))
              .finally(() => running.delete(key)),
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'poll iteration failed');
    }
  };

  const pollTimer = setInterval(() => void poll(), config.workerPollIntervalMs);
  const reconcileTimer = setInterval(
    () => void reconcile(db, config, logger).catch((err) => logger.error({ err }, 'reconcile failed')),
    config.reconcileIntervalMs,
  );
  const cleanupTimer = setInterval(
    () => void cleanupWorkspaces(db, config, workspaces, logger).catch((err) => logger.error({ err }, 'cleanup failed')),
    config.cleanupIntervalMs,
  );
  const heartbeatTimer = setInterval(
    () =>
      void heartbeatWorker(db, { id: workerId, kind: 'worker', hostname: os.hostname() }).catch((err) =>
        logger.warn({ err }, 'worker heartbeat failed'),
      ),
    config.heartbeatIntervalMs,
  );
  await heartbeatWorker(db, { id: workerId, kind: 'worker', hostname: os.hostname() });
  void poll();

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, inFlight: running.size }, 'worker shutting down; giving in-flight work a grace period');
    clearInterval(pollTimer);
    clearInterval(reconcileTimer);
    clearInterval(cleanupTimer);
    clearInterval(heartbeatTimer);
    // isShuttingDown() flips the per-task shutdown watchers, which abort Claude.
    // Give executions time to finalize their state transitions durably.
    const grace = new Promise((resolve) => setTimeout(resolve, config.shutdownGraceMs));
    await Promise.race([Promise.allSettled([...running.values()]), grace]);
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('claude-bridge-worker failed to start:', err);
  process.exit(1);
});
