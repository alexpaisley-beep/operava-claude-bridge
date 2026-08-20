import fs from 'node:fs/promises';
import path from 'node:path';
import type { BridgeConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { releaseBranchLocks } from '../db/branch-locks.js';
import { nextQueuedContinuation, updateContinuation } from '../db/continuations.js';
import { recordTaskEvent, truncateUtf8 } from '../db/events.js';
import { getRepository } from '../db/repositories.js';
import { getTask, heartbeatTask, updateTaskWhereStatus } from '../db/tasks.js';
import {
  COMPLETION_REPORT_JSON_SCHEMA,
  extractReportFromText,
  parseCompletionReport,
  type CompletionReport,
} from '../domain/report.js';
import type { ClaudeTask, Continuation, RepositoryConfig, TaskEventType } from '../domain/types.js';
import { BridgeError, toBridgeError } from '../errors.js';
import type { WorkspaceManager } from '../gitx/workspace.js';
import type { GitHubClient, PrInfo } from '../github/types.js';
import type { Logger } from '../logger.js';
import type { ClaudeRunner, ClaudeRunResult } from '../claude/types.js';
import {
  buildAnalysisPrompt,
  buildContinuationPrompt,
  buildEngineeringPrompt,
  systemPromptAppend,
} from '../claude/prompts.js';
import { resolveModel } from '../services/task-service.js';

export interface TaskWorkerDeps {
  db: Db;
  config: BridgeConfig;
  logger: Logger;
  github: GitHubClient;
  claude: ClaudeRunner;
  workspaces: WorkspaceManager;
  workerId: string;
  isShuttingDown: () => boolean;
}

const eventOpts = (config: BridgeConfig) => ({
  maxEventsPerTask: config.maxEventsPerTask,
  maxDetailBytes: config.maxEventDetailBytes,
});

/**
 * Execute one claimed task to a terminal (or WAITING) state. Owns the lease
 * heartbeat and the cancellation watcher for the duration.
 */
export async function executeTask(deps: TaskWorkerDeps, claimed: ClaudeTask): Promise<void> {
  const { db, config, logger } = deps;
  const log = logger.child({ taskId: claimed.id });
  const abort = new AbortController();

  const heartbeat = setInterval(() => {
    heartbeatTask(db, claimed.id, deps.workerId, config.leaseSeconds)
      .then((owned) => {
        if (!owned) {
          log.warn('lost task lease; aborting execution');
          abort.abort();
        }
      })
      .catch((err) => log.warn({ err }, 'task heartbeat failed'));
  }, config.heartbeatIntervalMs);

  const cancelWatcher = setInterval(() => {
    isCancelRequested(db, claimed.id)
      .then((cancelled) => {
        if (cancelled) abort.abort();
      })
      .catch(() => undefined);
  }, 3000);

  const shutdownWatcher = setInterval(() => {
    if (deps.isShuttingDown()) abort.abort();
  }, 1000);

  try {
    if (claimed.type === 'ANALYSIS') {
      await runAnalysisTask(deps, claimed, abort.signal, log);
    } else {
      await runEngineeringTask(deps, claimed, abort.signal, log);
    }
  } catch (err) {
    await finalizeError(deps, claimed.id, err, log);
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancelWatcher);
    clearInterval(shutdownWatcher);
  }
}

async function isCancelRequested(db: Db, taskId: string): Promise<boolean> {
  const task = await getTask(db, taskId);
  return task?.status === 'CANCEL_REQUESTED';
}

async function event(
  deps: TaskWorkerDeps,
  taskId: string,
  type: TaskEventType,
  message: string,
  detail?: unknown,
): Promise<void> {
  await recordTaskEvent(deps.db, taskId, type, message, detail ?? null, eventOpts(deps.config));
}

async function loadRepo(deps: TaskWorkerDeps, task: ClaudeTask): Promise<RepositoryConfig> {
  if (!task.repositoryKey) {
    throw new BridgeError('REPOSITORY_NOT_FOUND', 'Task has no repository.');
  }
  const repo = await getRepository(deps.db, task.repositoryKey);
  if (!repo || !repo.enabled) {
    throw new BridgeError(
      repo ? 'REPOSITORY_DISABLED' : 'REPOSITORY_NOT_FOUND',
      `Repository "${task.repositoryKey}" is unavailable.`,
    );
  }
  return repo;
}

/* --------------------------- engineering tasks --------------------------- */

async function runEngineeringTask(
  deps: TaskWorkerDeps,
  claimed: ClaudeTask,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  const { db, config } = deps;
  const continuation = await nextQueuedContinuation(db, claimed.id);
  if (continuation) {
    await runContinuation(deps, claimed, continuation, signal, log);
    return;
  }

  const repo = await loadRepo(deps, claimed);
  const workingBranch = claimed.workingBranch;
  const baseBranch = claimed.baseBranch ?? repo.defaultBranch;
  if (!workingBranch) throw new BridgeError('INTERNAL_ERROR', 'Engineering task has no working branch.');

  await event(deps, claimed.id, 'REPOSITORY_PREPARING', `Preparing isolated workspace for ${repo.githubOwner}/${repo.githubRepo}`);
  const dir = deps.workspaces.taskPath(claimed.id);
  const workspace = await deps.workspaces.createWorkspace({
    dir,
    repo,
    baseBranch,
    workingBranch,
    requireWorkingBranch: claimed.prNumber !== null,
    ...(claimed.prNumber !== null ? { fetchPrNumber: claimed.prNumber } : {}),
  });
  const baseSha = await deps.workspaces.revParse(dir, `refs/remotes/origin/${baseBranch}`);

  let pr: PrInfo | null = null;
  if (claimed.prNumber !== null) {
    pr = await deps.github.getPullRequest(repo.githubOwner, repo.githubRepo, claimed.prNumber);
  }

  const running = await updateTaskWhereStatus(db, claimed.id, ['PREPARING'], {
    status: 'RUNNING',
    phase: 'CLAUDE',
    workspacePath: dir,
    workspaceCleaned: false,
    headShaBefore: workspace.headSha,
  });
  if (!running) {
    await handleNotRunnable(deps, claimed.id, log);
    return;
  }

  const model = resolveModel(config, claimed.requestedModel ?? undefined);
  const prompt = buildEngineeringPrompt({
    taskId: claimed.id,
    repo,
    baseBranch,
    baseSha,
    workingBranch,
    headSha: workspace.headSha,
    branchExistedOnRemote: workspace.branchExistedOnRemote,
    pr,
    permissions: claimed.permissions,
    objective: claimed.objective,
  });

  const result = await runClaude(deps, claimed.id, {
    prompt,
    mode: claimed.permissions.allowCodeChanges ? 'write' : 'read',
    cwd: dir,
    model,
    maxTurns: claimed.maxTurns ?? config.defaultMaxTurns,
    timeoutMs: config.taskTimeoutMs,
    signal,
  });

  await persistClaudeResult(deps, claimed.id, result);
  if (!result.ok) {
    throw new BridgeError('CLAUDE_EXECUTION_FAILED', `Claude run ended with ${result.subtype}.`, {
      detail: result.errorMessage ?? result.subtype,
    });
  }

  const { report } = interpretReport(result);
  const outcome = await inspectAndPublish(deps, claimed.id, dir, repo, workingBranch, baseBranch, workspace.headSha, report, log);
  await finalizeSuccess(deps, claimed.id, outcome.extraBlockers, log);
}

/* ----------------------------- continuations ------------------------------ */

async function runContinuation(
  deps: TaskWorkerDeps,
  claimed: ClaudeTask,
  continuation: Continuation,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  const { db, config } = deps;
  const repo = await loadRepo(deps, claimed);
  const workingBranch = claimed.workingBranch;
  if (!workingBranch) throw new BridgeError('INTERNAL_ERROR', 'Task has no working branch.');
  if (!claimed.claudeSessionId) {
    throw new BridgeError('CLAUDE_SESSION_UNAVAILABLE', 'Task has no Claude session to resume.');
  }

  await updateContinuation(db, continuation.id, { status: 'RUNNING', startedAt: new Date() });
  await event(deps, claimed.id, 'CONTINUATION_STARTED', `Continuation #${continuation.seq} started.`);

  try {
    const dir = deps.workspaces.taskPath(claimed.id);
    const startHead = await prepareContinuationWorkspace(deps, claimed, repo, workingBranch, dir);

    const running = await updateTaskWhereStatus(db, claimed.id, ['PREPARING'], {
      status: 'RUNNING',
      phase: 'CONTINUATION',
      workspacePath: dir,
      workspaceCleaned: false,
      headShaBefore: startHead,
    });
    if (!running) {
      await handleNotRunnable(deps, claimed.id, log);
      await updateContinuation(db, continuation.id, { status: 'CANCELLED', completedAt: new Date() });
      return;
    }

    let pr: PrInfo | null = null;
    if (claimed.prNumber !== null) {
      pr = await deps.github.getPullRequest(repo.githubOwner, repo.githubRepo, claimed.prNumber);
    }
    const model = resolveModel(config, claimed.requestedModel ?? undefined);
    const prompt = buildContinuationPrompt({
      taskId: claimed.id,
      workingBranch,
      headSha: startHead,
      pr,
      permissions: claimed.permissions,
      instruction: continuation.instruction,
    });

    const result = await runClaude(deps, claimed.id, {
      prompt,
      mode: claimed.permissions.allowCodeChanges ? 'write' : 'read',
      cwd: dir,
      model,
      maxTurns: claimed.maxTurns ?? config.defaultMaxTurns,
      timeoutMs: config.taskTimeoutMs,
      signal,
      resumeSessionId: claimed.claudeSessionId,
    });

    await persistClaudeResult(deps, claimed.id, result);
    if (!result.ok) {
      throw new BridgeError('CLAUDE_EXECUTION_FAILED', `Claude continuation ended with ${result.subtype}.`, {
        detail: result.errorMessage ?? result.subtype,
      });
    }
    const { report } = interpretReport(result);
    const outcome = await inspectAndPublish(
      deps,
      claimed.id,
      dir,
      repo,
      workingBranch,
      claimed.baseBranch ?? repo.defaultBranch,
      startHead,
      report,
      log,
    );
    await updateContinuation(db, continuation.id, {
      status: 'COMPLETED',
      completedAt: new Date(),
      resultSummary: truncateUtf8(report?.summary ?? result.finalText, 4000),
    });
    await event(deps, claimed.id, 'CONTINUATION_FINISHED', `Continuation #${continuation.seq} completed.`);
    await finalizeSuccess(deps, claimed.id, outcome.extraBlockers, log);
  } catch (err) {
    const bridgeErr = toBridgeError(err);
    await updateContinuation(db, continuation.id, {
      status: bridgeErr.code === 'TASK_CANCELLED' ? 'CANCELLED' : 'FAILED',
      completedAt: new Date(),
      errorCode: bridgeErr.code,
      errorDetail: truncateUtf8(bridgeErr.message, 2000),
    });
    throw err;
  }
}

/**
 * Reuse or rebuild the task workspace for a continuation, enforcing
 * expected-head safety: fast-forward to a moved remote is fine, divergence is
 * refused (EXPECTED_HEAD_MISMATCH → task WAITING).
 */
async function prepareContinuationWorkspace(
  deps: TaskWorkerDeps,
  task: ClaudeTask,
  repo: RepositoryConfig,
  workingBranch: string,
  dir: string,
): Promise<string> {
  const { workspaces } = deps;
  await event(deps, task.id, 'REPOSITORY_PREPARING', 'Refreshing workspace for continuation.');

  const gitDirOk = await pathExists(path.join(dir, '.git'));
  if (!gitDirOk) {
    const rebuilt = await workspaces.createWorkspace({
      dir,
      repo,
      baseBranch: task.baseBranch ?? repo.defaultBranch,
      workingBranch,
    });
    return rebuilt.headSha;
  }

  const localHead = await workspaces.currentHead(dir);
  const remoteSha = await workspaces.fetchBranch(dir, workingBranch);
  if (!remoteSha || remoteSha === localHead) {
    return localHead;
  }
  const localIsAncestor = await workspaces.isAncestor(dir, localHead, remoteSha);
  if (localIsAncestor) {
    // Remote gained commits on top of ours (reviewer tweaks etc.) — safe fast-forward.
    await workspaces.resetBranchTo(dir, workingBranch, remoteSha);
    await event(
      deps,
      task.id,
      'REPOSITORY_PREPARING',
      `Fast-forwarded ${workingBranch} to remote head ${remoteSha.slice(0, 12)}.`,
    );
    return remoteSha;
  }
  const remoteIsAncestor = await workspaces.isAncestor(dir, remoteSha, localHead);
  if (remoteIsAncestor) {
    // We are ahead locally (an earlier run that could not push); keep local state.
    return localHead;
  }
  await withTransaction(deps.db, async (client) => {
    await updateTaskWhereStatus(client, task.id, ['PREPARING', 'RUNNING'], {
      status: 'WAITING',
      phase: 'HEAD_MISMATCH',
      attentionRequired: true,
      attentionReason: `Remote branch ${workingBranch} diverged (remote ${remoteSha.slice(0, 12)}, local ${localHead.slice(0, 12)}). Refusing to overwrite; instruct explicitly how to proceed or start a fresh task.`,
    });
    await recordTaskEvent(
      client,
      task.id,
      'ATTENTION_REQUIRED',
      `Branch ${workingBranch} diverged from the task workspace; continuation halted before any changes.`,
      { remoteSha, localHead },
      eventOpts(deps.config),
    );
  });
  throw new BridgeError(
    'EXPECTED_HEAD_MISMATCH',
    `Branch ${workingBranch} diverged from the task's last verified state.`,
  );
}

/* ------------------------------- analysis -------------------------------- */

async function runAnalysisTask(
  deps: TaskWorkerDeps,
  claimed: ClaudeTask,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  const { db, config } = deps;
  const mode = claimed.contextMode ?? 'general';

  let dir: string | undefined;
  let diffStat: string | null = null;
  let diffText: string | null = null;
  let headSha: string | null = null;
  let pr: PrInfo | null = null;
  let repo: RepositoryConfig | null = null;

  if (mode !== 'general') {
    repo = await loadRepo(deps, claimed);
    await event(deps, claimed.id, 'REPOSITORY_PREPARING', `Preparing read-only checkout of ${repo.githubOwner}/${repo.githubRepo}`);
    dir = deps.workspaces.taskPath(claimed.id);
    const baseBranch = claimed.baseBranch ?? repo.defaultBranch;

    if (mode === 'pr' && claimed.prNumber !== null) {
      pr = await deps.github.getPullRequest(repo.githubOwner, repo.githubRepo, claimed.prNumber);
      if (!pr) throw new BridgeError('PR_NOT_FOUND', `PR #${claimed.prNumber} no longer exists.`);
      const ws = await deps.workspaces.createWorkspace({
        dir,
        repo,
        baseBranch: pr.baseRef,
        fetchPrNumber: pr.number,
      });
      headSha = ws.headSha;
      diffStat = await deps.workspaces.diffStat(dir, `refs/remotes/origin/${pr.baseRef}`, 'HEAD');
      diffText = await deps.workspaces.diffText(dir, `refs/remotes/origin/${pr.baseRef}`, 'HEAD', config.maxDiffContextBytes);
    } else if (mode === 'branch' && claimed.workingBranch) {
      const ws = await deps.workspaces.createWorkspace({
        dir,
        repo,
        baseBranch,
        workingBranch: claimed.workingBranch,
        requireWorkingBranch: true,
      });
      headSha = ws.headSha;
      diffStat = await deps.workspaces.diffStat(dir, `refs/remotes/origin/${baseBranch}`, 'HEAD');
      diffText = await deps.workspaces.diffText(dir, `refs/remotes/origin/${baseBranch}`, 'HEAD', config.maxDiffContextBytes);
    } else {
      const ws = await deps.workspaces.createWorkspace({ dir, repo, baseBranch });
      headSha = ws.headSha;
    }
    await updateTaskWhereStatus(db, claimed.id, ['PREPARING'], {
      workspacePath: dir,
      workspaceCleaned: false,
      headShaBefore: headSha ?? undefined,
    });
  }

  const running = await updateTaskWhereStatus(db, claimed.id, ['PREPARING'], {
    status: 'RUNNING',
    phase: 'CLAUDE',
  });
  if (!running) {
    await handleNotRunnable(deps, claimed.id, log);
    return;
  }

  const model = resolveModel(config, claimed.requestedModel ?? undefined);
  const prompt = buildAnalysisPrompt({
    taskId: claimed.id,
    repo,
    contextMode: mode,
    branch: claimed.workingBranch,
    baseBranch: claimed.baseBranch,
    headSha,
    pr,
    diffStat,
    diffText,
    objective: claimed.objective,
  });

  const result = await runClaude(deps, claimed.id, {
    prompt,
    mode: mode === 'general' ? 'reason' : 'read',
    cwd: dir,
    model,
    maxTurns: claimed.maxTurns ?? config.defaultMaxTurns,
    timeoutMs: config.analysisTimeoutMs,
    signal,
  });

  await persistClaudeResult(deps, claimed.id, result);
  if (!result.ok) {
    throw new BridgeError('CLAUDE_EXECUTION_FAILED', `Claude analysis ended with ${result.subtype}.`, {
      detail: result.errorMessage ?? result.subtype,
    });
  }
  await finalizeSuccess(deps, claimed.id, [], log);
}

/* ------------------------------ claude glue ------------------------------- */

async function runClaude(
  deps: TaskWorkerDeps,
  taskId: string,
  params: {
    prompt: string;
    mode: 'write' | 'read' | 'reason';
    cwd: string | undefined;
    model: string;
    maxTurns: number;
    timeoutMs: number;
    signal: AbortSignal;
    resumeSessionId?: string;
  },
): Promise<ClaudeRunResult> {
  const { db } = deps;
  await event(deps, taskId, 'CLAUDE_STARTED', `Claude starting (${params.mode} mode, model ${params.model})`);
  await updateTaskWhereStatus(db, taskId, ['RUNNING'], { claudeStarted: true });

  let lastEventAt = 0;
  const result = await deps.claude.run({
    prompt: params.prompt,
    mode: params.mode,
    cwd: params.cwd,
    model: params.model,
    maxTurns: params.maxTurns,
    timeoutMs: params.timeoutMs,
    abortSignal: params.signal,
    resumeSessionId: params.resumeSessionId,
    outputSchema: COMPLETION_REPORT_JSON_SCHEMA as unknown as Record<string, unknown>,
    systemPromptAppend: systemPromptAppend(),
    onEvent: (ev) => {
      if (ev.kind === 'session_started') {
        const sessionId = (ev.detail?.sessionId as string | undefined) ?? null;
        const model = (ev.detail?.model as string | undefined) ?? null;
        // Persist immediately so the session is resumable even after a crash.
        updateTaskWhereStatus(db, taskId, ['RUNNING', 'CANCEL_REQUESTED'], {
          ...(sessionId ? { claudeSessionId: sessionId } : {}),
          ...(model ? { actualModel: model } : {}),
        }).catch(() => undefined);
        void event(deps, taskId, 'CLAUDE_PROGRESS', ev.message);
        return;
      }
      // Throttle progress events to at most one per 2 seconds per task.
      const now = Date.now();
      if (now - lastEventAt < 2000) return;
      lastEventAt = now;
      void event(deps, taskId, ev.kind === 'tool_use' ? 'CLAUDE_TOOL_USE' : 'CLAUDE_PROGRESS', ev.message);
    },
  });
  await event(
    deps,
    taskId,
    'CLAUDE_FINISHED',
    `Claude finished (${result.subtype}${result.numTurns ? `, ${result.numTurns} turns` : ''}${result.totalCostUsd ? `, ~$${result.totalCostUsd.toFixed(2)}` : ''})`,
  );
  return result;
}

function interpretReport(result: ClaudeRunResult): { report: CompletionReport | null; parseError: string | null } {
  if (result.structuredOutput !== null && result.structuredOutput !== undefined) {
    const parsed = parseCompletionReport(result.structuredOutput);
    if (parsed.report) return { report: parsed.report, parseError: null };
    const fallback = extractReportFromText(result.finalText);
    return fallback.report ? fallback : parsed;
  }
  return extractReportFromText(result.finalText);
}

async function persistClaudeResult(deps: TaskWorkerDeps, taskId: string, result: ClaudeRunResult): Promise<void> {
  const { config } = deps;
  const { report, parseError } = interpretReport(result);
  await updateTaskWhereStatus(deps.db, taskId, ['RUNNING', 'CANCEL_REQUESTED'], {
    ...(result.sessionId ? { claudeSessionId: result.sessionId } : {}),
    ...(result.model ? { actualModel: result.model } : {}),
    ...(result.totalCostUsd !== null ? { totalCostUsd: result.totalCostUsd } : {}),
    ...(result.numTurns !== null ? { numTurns: result.numTurns } : {}),
    resultSummary: truncateUtf8(report?.summary ?? result.finalText, config.maxResultSummaryBytes),
    resultReport: report ?? null,
    reportParseError: parseError,
    rawFinalResponse: truncateUtf8(result.finalText, config.maxRawResponseBytes),
  });
}

/* --------------------------- git/PR publication --------------------------- */

async function inspectAndPublish(
  deps: TaskWorkerDeps,
  taskId: string,
  dir: string,
  repo: RepositoryConfig,
  workingBranch: string,
  baseBranch: string,
  headShaBefore: string,
  report: CompletionReport | null,
  log: Logger,
): Promise<{ extraBlockers: string[] }> {
  const { db, workspaces } = deps;
  const task = await getTask(db, taskId);
  if (!task) throw new BridgeError('TASK_NOT_FOUND', `Task ${taskId} vanished.`);
  const permissions = task.permissions;
  const extraBlockers: string[] = [];

  const branchNow = await workspaces.currentBranch(dir);
  if (branchNow !== workingBranch) {
    extraBlockers.push(
      `Workspace ended on branch "${branchNow ?? 'detached HEAD'}" instead of "${workingBranch}"; nothing was pushed.`,
    );
    await event(deps, taskId, 'ATTENTION_REQUIRED', extraBlockers[0] as string);
    await mergeGitMetadata(deps, taskId, { commits: [], pushedSha: null, changedFiles: '', branchVerified: false });
    return { extraBlockers };
  }

  const dirty = await workspaces.isDirty(dir);
  if (dirty && permissions.allowCommit && permissions.allowCodeChanges) {
    const sha = await workspaces.commitAll(dir, `Claude task ${taskId}: finalize working tree changes`);
    if (sha) await event(deps, taskId, 'COMMIT_CREATED', `Bridge committed remaining working-tree changes (${sha.slice(0, 12)}).`);
  }

  const commits = await workspaces.listNewCommits(dir, headShaBefore);
  const changedFiles = await workspaces.changedFilesSummary(dir, headShaBefore);

  if (!permissions.allowCommit && commits.length > 0) {
    extraBlockers.push(`Task created ${commits.length} commit(s) without allowCommit; they were NOT pushed.`);
    await event(deps, taskId, 'ATTENTION_REQUIRED', extraBlockers[extraBlockers.length - 1] as string);
    await mergeGitMetadata(deps, taskId, { commits, pushedSha: null, changedFiles, branchVerified: true });
    return { extraBlockers };
  }

  let pushedSha: string | null = null;
  if (commits.length > 0 && permissions.allowPush) {
    try {
      pushedSha = await workspaces.push(dir, workingBranch);
      await event(deps, taskId, 'PUSHED', `Pushed ${commits.length} commit(s) to ${workingBranch} @ ${pushedSha.slice(0, 12)}.`);
      await updateTaskWhereStatus(db, taskId, ['RUNNING', 'CANCEL_REQUESTED'], {
        headShaAfter: pushedSha,
        expectedHeadSha: pushedSha,
      });
    } catch (err) {
      const bridgeErr = toBridgeError(err, 'GIT_ERROR');
      if (bridgeErr.code === 'GIT_CONFLICT') {
        extraBlockers.push(`Push to ${workingBranch} was rejected (remote moved). Work is preserved locally; continue the task to resolve.`);
        await event(deps, taskId, 'ATTENTION_REQUIRED', extraBlockers[extraBlockers.length - 1] as string, {
          error: bridgeErr.detail,
        });
        await mergeGitMetadata(deps, taskId, { commits, pushedSha: null, changedFiles, branchVerified: true });
        return { extraBlockers };
      }
      throw err;
    }
  } else if (commits.length > 0 && !permissions.allowPush) {
    extraBlockers.push('Commits exist but allowPush=false; nothing was pushed.');
  } else if (commits.length === 0) {
    await event(deps, taskId, 'CLAUDE_PROGRESS', 'No new commits were produced by this run.');
  }

  await mergeGitMetadata(deps, taskId, { commits, pushedSha, changedFiles, branchVerified: true });

  if (pushedSha) {
    await handlePullRequest(deps, taskId, repo, workingBranch, baseBranch, report, permissions, task.prNumber, log);
  }
  return { extraBlockers };
}

async function handlePullRequest(
  deps: TaskWorkerDeps,
  taskId: string,
  repo: RepositoryConfig,
  workingBranch: string,
  baseBranch: string,
  report: CompletionReport | null,
  permissions: ClaudeTask['permissions'],
  knownPrNumber: number | null,
  log: Logger,
): Promise<void> {
  const { db, github } = deps;
  try {
    if (knownPrNumber !== null) {
      if (permissions.allowUpdatePr) {
        await event(deps, taskId, 'PR_UPDATED', `PR #${knownPrNumber} updated by the push to ${workingBranch}.`);
      }
      return;
    }
    // Reuse before create: never open a second PR for the same branch.
    const existing = await github.findOpenPrByHead(repo.githubOwner, repo.githubRepo, workingBranch);
    if (existing) {
      await updateTaskWhereStatus(db, taskId, ['RUNNING', 'CANCEL_REQUESTED'], {
        prNumber: existing.number,
        prUrl: existing.url,
      });
      await event(deps, taskId, 'PR_UPDATED', `Existing PR #${existing.number} covers ${workingBranch}; push updated it.`);
      return;
    }
    if (!permissions.allowOpenPr) return;
    const title = truncateUtf8(firstLine(report?.summary ?? `Claude task ${taskId}`), 120);
    const body = buildPrBody(taskId, report);
    const pr = await github.createPullRequest(repo.githubOwner, repo.githubRepo, {
      title,
      body,
      head: workingBranch,
      base: baseBranch,
    });
    await updateTaskWhereStatus(db, taskId, ['RUNNING', 'CANCEL_REQUESTED'], {
      prNumber: pr.number,
      prUrl: pr.url,
    });
    await event(deps, taskId, 'PR_OPENED', `Opened PR #${pr.number}: ${pr.url}`);
  } catch (err) {
    // PR problems shouldn't destroy a completed run — surface and continue.
    const bridgeErr = toBridgeError(err, 'GITHUB_API_ERROR');
    log.error({ err: bridgeErr }, 'pull request handling failed');
    await event(deps, taskId, 'ATTENTION_REQUIRED', `PR operation failed: ${bridgeErr.message}`);
  }
}

function buildPrBody(taskId: string, report: CompletionReport | null): string {
  const summary = report?.summary ?? 'Automated engineering task executed by Claude via the Operava Claude Bridge.';
  const tests =
    report && report.tests.length > 0
      ? `\n\n## Verification\n${report.tests.map((t) => `- \`${t.command}\`: ${t.status}`).join('\n')}`
      : '';
  const blockers =
    report && report.blockers.length > 0
      ? `\n\n## Open items\n${report.blockers.map((b) => `- ${b}`).join('\n')}`
      : '';
  return `${summary}${tests}${blockers}\n\n---\n_Automated by Operava Claude Bridge — task \`${taskId}\`. Completion of this PR's task does not imply merge; merging requires explicit authorization._`;
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text;
}

async function mergeGitMetadata(
  deps: TaskWorkerDeps,
  taskId: string,
  git: { commits: { sha: string; message: string }[]; pushedSha: string | null; changedFiles: string; branchVerified: boolean },
): Promise<void> {
  await deps.db.query(
    `UPDATE claude_tasks SET metadata = metadata || jsonb_build_object('git', $2::jsonb) WHERE id = $1`,
    [taskId, JSON.stringify(git)],
  );
}

/* ------------------------------ finalization ------------------------------ */

async function finalizeSuccess(deps: TaskWorkerDeps, taskId: string, extraBlockers: string[], log: Logger): Promise<void> {
  const { db, config } = deps;
  await withTransaction(db, async (client) => {
    if (extraBlockers.length > 0) {
      await client.query(
        `UPDATE claude_tasks SET metadata = metadata || jsonb_build_object('bridgeBlockers', $2::jsonb) WHERE id = $1`,
        [taskId, JSON.stringify(extraBlockers)],
      );
    }
    const completed = await updateTaskWhereStatus(client, taskId, ['RUNNING'], {
      status: 'COMPLETED',
      phase: 'DONE',
      completedAt: new Date(),
      claimedBy: null,
      leaseExpiresAt: null,
    });
    if (completed) {
      await releaseBranchLocks(client, taskId);
      await recordTaskEvent(client, taskId, 'COMPLETED', 'Task completed.', extraBlockers.length ? { blockers: extraBlockers } : null, eventOpts(config));
      return;
    }
    // Cancellation raced completion: preserve results, finish as CANCELLED.
    const cancelled = await updateTaskWhereStatus(client, taskId, ['CANCEL_REQUESTED'], {
      status: 'CANCELLED',
      phase: 'CANCELLED',
      cancelledAt: new Date(),
      completedAt: new Date(),
      claimedBy: null,
      leaseExpiresAt: null,
    });
    if (cancelled) {
      await releaseBranchLocks(client, taskId);
      await recordTaskEvent(client, taskId, 'CANCELLED', 'Cancellation was requested; the run had already finished — results preserved.', null, eventOpts(config));
    } else {
      log.warn('task not in finalizable state after run');
    }
  });
}

async function handleNotRunnable(deps: TaskWorkerDeps, taskId: string, log: Logger): Promise<void> {
  const task = await getTask(deps.db, taskId);
  if (task?.status === 'CANCEL_REQUESTED') {
    await finalizeCancelled(deps, taskId);
  } else {
    log.warn({ status: task?.status }, 'task left runnable path');
  }
}

async function finalizeCancelled(deps: TaskWorkerDeps, taskId: string): Promise<void> {
  const { db, config } = deps;
  await withTransaction(db, async (client) => {
    const cancelled = await updateTaskWhereStatus(client, taskId, ['PREPARING', 'RUNNING', 'CANCEL_REQUESTED'], {
      status: 'CANCELLED',
      phase: 'CANCELLED',
      cancelledAt: new Date(),
      completedAt: new Date(),
      claimedBy: null,
      leaseExpiresAt: null,
    });
    if (cancelled) {
      await releaseBranchLocks(client, taskId);
      await recordTaskEvent(client, taskId, 'CANCELLED', 'Task cancelled; partial results (if any) are preserved in the report.', null, eventOpts(config));
    }
  });
}

async function finalizeError(deps: TaskWorkerDeps, taskId: string, err: unknown, log: Logger): Promise<void> {
  const bridgeErr = toBridgeError(err);
  if (bridgeErr.code === 'TASK_CANCELLED') {
    await finalizeCancelled(deps, taskId);
    return;
  }
  if (bridgeErr.code === 'EXPECTED_HEAD_MISMATCH') {
    // Task was already parked in WAITING with attention set.
    return;
  }
  const failureCode = deps.isShuttingDown() ? 'WORKER_SHUTDOWN' : bridgeErr.code;
  const failureDetail =
    failureCode === 'WORKER_SHUTDOWN'
      ? 'The worker shut down (deploy/restart) during execution. If a Claude session was started it is resumable via continue_repo_task.'
      : bridgeErr.detail ?? null;
  log.error({ err: bridgeErr, code: failureCode }, 'task failed');
  await withTransaction(deps.db, async (client) => {
    const failed = await updateTaskWhereStatus(
      client,
      taskId,
      ['QUEUED', 'PREPARING', 'RUNNING', 'CANCEL_REQUESTED'],
      {
        status: 'FAILED',
        phase: 'FAILED',
        completedAt: new Date(),
        errorCode: failureCode,
        errorDetail: truncateUtf8(`${bridgeErr.message}${failureDetail ? ` — ${failureDetail}` : ''}`, 4000),
        claimedBy: null,
        leaseExpiresAt: null,
      },
    );
    if (failed) {
      await releaseBranchLocks(client, taskId);
      await recordTaskEvent(
        client,
        taskId,
        'FAILED',
        `Task failed: ${bridgeErr.code} — ${bridgeErr.message}`,
        null,
        eventOpts(deps.config),
      );
    }
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Re-exported for tests that need to drive single steps.
export { finalizeError as _finalizeErrorForTests };
