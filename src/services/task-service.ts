import { z } from 'zod';
import type { BridgeConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { BridgeError } from '../errors.js';
import { canonicalJson, newContinuationId, newTaskId, requestHash, sha256Hex, slugify } from '../ids.js';
import type { Logger } from '../logger.js';
import {
  CONTINUABLE_STATUSES,
  READ_ONLY_PERMISSIONS,
  type ClaudeTask,
  type ContextMode,
  type Continuation,
  type RepositoryConfig,
  type TaskPermissions,
  type TaskStatus,
} from '../domain/types.js';
import { acquireBranchLock, releaseBranchLocks } from '../db/branch-locks.js';
import {
  cancelQueuedContinuations,
  getContinuation,
  insertContinuation,
  listContinuations,
} from '../db/continuations.js';
import { latestTaskEvent, listTaskEvents, recordTaskEvent } from '../db/events.js';
import { findIdempotentReplay, isUniqueViolation, saveIdempotencyKey } from '../db/idempotency.js';
import { getRepository } from '../db/repositories.js';
import {
  findActiveWriteTaskOnBranch,
  getTask,
  insertTask,
  listTasks,
  updateTaskWhereStatus,
  type ListTasksFilter,
} from '../db/tasks.js';
import { isValidBranchName } from '../gitx/validate.js';
import type { GitHubClient } from '../github/types.js';
import { completionReportSchema } from '../domain/report.js';

export interface TaskServiceDeps {
  db: Db;
  config: BridgeConfig;
  logger: Logger;
  github: GitHubClient;
}

/* ------------------------------- helpers -------------------------------- */

export function resolveModel(config: BridgeConfig, requested: string | undefined): string {
  if (!requested) return config.defaultModel;
  const viaAlias = config.modelAliases[requested];
  if (viaAlias) return viaAlias;
  if (config.allowedModels.has(requested)) return requested;
  throw new BridgeError(
    'MODEL_NOT_ALLOWED',
    `Model "${requested}" is not on the server allowlist.`,
    {
      detail: `allowed aliases: ${Object.keys(config.modelAliases).join(', ')}; allowed ids: ${[...config.allowedModels].join(', ')}`,
    },
  );
}

function assertObjectiveSize(config: BridgeConfig, objective: string): void {
  const bytes = Buffer.byteLength(objective, 'utf8');
  if (bytes === 0) throw new BridgeError('VALIDATION_ERROR', 'objective must not be empty.');
  if (bytes > config.maxObjectiveBytes) {
    throw new BridgeError(
      'VALIDATION_ERROR',
      `objective is ${bytes} bytes; the configured maximum is ${config.maxObjectiveBytes}. It was NOT truncated — split the task or raise MAX_OBJECTIVE_BYTES.`,
    );
  }
}

function normalizeBranch(name: string | undefined, label: string): string | undefined {
  if (name === undefined || name === null || name === '') return undefined;
  if (!isValidBranchName(name)) {
    throw new BridgeError('VALIDATION_ERROR', `Invalid ${label}: ${JSON.stringify(name)}`);
  }
  return name;
}

export interface RequestedPermissions {
  allowCodeChanges?: boolean;
  allowCommit?: boolean;
  allowPush?: boolean;
  allowOpenPr?: boolean;
  allowUpdatePr?: boolean;
  allowMerge?: boolean;
}

/**
 * Resolve effective task permissions: apply conservative defaults, enforce
 * internal coherence, and refuse (never silently clamp) anything above the
 * repository's registry ceiling.
 */
export function resolvePermissions(
  requested: RequestedPermissions,
  repo: RepositoryConfig,
): TaskPermissions {
  const p: TaskPermissions = {
    allowCodeChanges: requested.allowCodeChanges ?? true,
    allowCommit: requested.allowCommit ?? true,
    allowPush: requested.allowPush ?? true,
    allowOpenPr: requested.allowOpenPr ?? true,
    allowUpdatePr: requested.allowUpdatePr ?? true,
    allowMerge: requested.allowMerge ?? false,
  };
  if (p.allowCommit && !p.allowCodeChanges) {
    throw new BridgeError('VALIDATION_ERROR', 'allowCommit requires allowCodeChanges.');
  }
  if (p.allowPush && !p.allowCommit) {
    throw new BridgeError('VALIDATION_ERROR', 'allowPush requires allowCommit.');
  }
  if ((p.allowOpenPr || p.allowUpdatePr) && !p.allowPush) {
    throw new BridgeError('VALIDATION_ERROR', 'allowOpenPr/allowUpdatePr require allowPush.');
  }
  if (p.allowMerge && !(p.allowOpenPr || p.allowUpdatePr)) {
    throw new BridgeError('VALIDATION_ERROR', 'allowMerge requires PR permissions.');
  }
  const ceilingViolations: string[] = [];
  if (p.allowCodeChanges && !repo.allowCodeChanges) ceilingViolations.push('allowCodeChanges');
  if (p.allowCommit && !repo.allowCommit) ceilingViolations.push('allowCommit');
  if (p.allowPush && !repo.allowPush) ceilingViolations.push('allowPush');
  if (p.allowOpenPr && !repo.allowOpenPr) ceilingViolations.push('allowOpenPr');
  if (p.allowUpdatePr && !repo.allowUpdatePr) ceilingViolations.push('allowUpdatePr');
  if (p.allowMerge && !repo.allowMerge) ceilingViolations.push('allowMerge');
  if (ceilingViolations.length > 0) {
    throw new BridgeError(
      'PERMISSION_DENIED',
      `Repository "${repo.key}" does not allow: ${ceilingViolations.join(', ')}. Lower the requested permissions or update the repository registry.`,
    );
  }
  return p;
}

async function loadEnabledRepository(deps: TaskServiceDeps, key: string): Promise<RepositoryConfig> {
  const repo = await getRepository(deps.db, key);
  if (!repo) {
    throw new BridgeError('REPOSITORY_NOT_FOUND', `Repository "${key}" is not in the registry.`, {
      detail: 'Use list_repositories to see available repository keys.',
    });
  }
  if (!repo.enabled) {
    throw new BridgeError('REPOSITORY_DISABLED', `Repository "${key}" is disabled in the registry.`);
  }
  return repo;
}

function maxTurnsOrDefault(config: BridgeConfig, requested: number | undefined): number {
  const value = requested ?? config.defaultMaxTurns;
  if (value < 1 || value > config.maxMaxTurns) {
    throw new BridgeError(
      'VALIDATION_ERROR',
      `maxTurns must be between 1 and ${config.maxMaxTurns}.`,
    );
  }
  return value;
}

const eventOptions = (config: BridgeConfig) => ({
  maxEventsPerTask: config.maxEventsPerTask,
  maxDetailBytes: config.maxEventDetailBytes,
});

/**
 * Run `create` inside a transaction with idempotency-key bookkeeping.
 * Returns the created resource, or the previously created resource when the
 * same key+payload is replayed. Conflicting reuse throws IDEMPOTENCY_CONFLICT.
 */
async function withIdempotency<T>(
  deps: TaskServiceDeps,
  scope: string,
  key: string | undefined,
  payload: unknown,
  lookup: (resourceId: string) => Promise<T | null>,
  create: (client: import('pg').PoolClient) => Promise<{ resourceId: string; value: T }>,
): Promise<{ value: T; replayed: boolean }> {
  const hash = requestHash(payload);
  // Replay fast-path BEFORE any state validation: a retry of an already-applied
  // mutation must return the original resource even if current state would now
  // reject a fresh request.
  if (key) {
    const replay = await findIdempotentReplay(deps.db, scope, key, hash);
    if (replay) {
      const existing = await lookup(replay.resourceId);
      if (existing) return { value: existing, replayed: true };
    }
  }
  const attempt = async (): Promise<{ value: T; replayed: boolean }> =>
    withTransaction(deps.db, async (client) => {
      if (key) {
        const replay = await findIdempotentReplay(client, scope, key, hash);
        if (replay) {
          const existing = await lookup(replay.resourceId);
          if (!existing) {
            throw new BridgeError('INTERNAL_ERROR', `Idempotency record points to missing resource ${replay.resourceId}.`);
          }
          return { value: existing, replayed: true };
        }
      }
      const { resourceId, value } = await create(client);
      if (key) {
        await saveIdempotencyKey(client, { scope, key, requestHash: hash, resourceType: scope, resourceId });
      }
      return { value, replayed: false };
    });

  try {
    return await attempt();
  } catch (err) {
    // Concurrent duplicate: the other request won the key. Re-read it.
    if (key && isUniqueViolation(err)) return attempt();
    throw err;
  }
}

/* ---------------------------- start_repo_task ---------------------------- */

export interface StartRepoTaskInput {
  repository: string;
  objective: string;
  baseBranch?: string;
  targetBranch?: string;
  existingPr?: number;
  model?: string;
  permissions?: RequestedPermissions;
  maxTurns?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}

export async function startRepoTask(
  deps: TaskServiceDeps,
  input: StartRepoTaskInput,
): Promise<{ task: ClaudeTask; replayed: boolean }> {
  const { config } = deps;
  assertObjectiveSize(config, input.objective);
  if (input.metadata && Buffer.byteLength(JSON.stringify(input.metadata), 'utf8') > 65_536) {
    throw new BridgeError('VALIDATION_ERROR', 'metadata must be at most 64KB of JSON.');
  }
  const repo = await loadEnabledRepository(deps, input.repository);
  const permissions = resolvePermissions(input.permissions ?? {}, repo);
  const requestedModel = input.model;
  const resolvedModel = resolveModel(config, requestedModel);
  const maxTurns = maxTurnsOrDefault(config, input.maxTurns);
  const explicitTarget = normalizeBranch(input.targetBranch, 'targetBranch');
  let baseBranch = normalizeBranch(input.baseBranch, 'baseBranch') ?? repo.defaultBranch;

  // Resolve an existing PR up front so the branch lock covers its head branch
  // and callers get PR_NOT_FOUND at creation time, not mid-run.
  let prNumber: number | null = null;
  let prUrl: string | null = null;
  let workingBranch: string;
  const taskId = newTaskId();
  if (input.existingPr !== undefined) {
    const pr = await deps.github.getPullRequest(repo.githubOwner, repo.githubRepo, input.existingPr);
    if (!pr) {
      throw new BridgeError('PR_NOT_FOUND', `PR #${input.existingPr} not found in ${repo.githubOwner}/${repo.githubRepo}.`);
    }
    if (pr.state !== 'open') {
      throw new BridgeError('VALIDATION_ERROR', `PR #${pr.number} is ${pr.merged ? 'merged' : 'closed'}; start a fresh task against a branch instead.`);
    }
    if (explicitTarget && explicitTarget !== pr.headRef) {
      throw new BridgeError('VALIDATION_ERROR', `targetBranch "${explicitTarget}" conflicts with PR #${pr.number} head branch "${pr.headRef}".`);
    }
    prNumber = pr.number;
    prUrl = pr.url;
    workingBranch = pr.headRef;
    baseBranch = pr.baseRef;
    if (!isValidBranchName(workingBranch)) {
      throw new BridgeError('VALIDATION_ERROR', `PR head branch name is not acceptable: ${workingBranch}`);
    }
    if (!isValidBranchName(baseBranch)) {
      throw new BridgeError('VALIDATION_ERROR', `PR base branch name is not acceptable: ${baseBranch}`);
    }
  } else {
    workingBranch =
      explicitTarget ?? `claude/${slugify(input.objective, 28)}-${taskId.slice(-6)}`;
  }
  if (workingBranch === baseBranch) {
    throw new BridgeError('VALIDATION_ERROR', 'The working branch must differ from the base branch.');
  }

  const idempotencyPayload = {
    tool: 'start_repo_task',
    repository: input.repository,
    objectiveHash: sha256Hex(input.objective),
    baseBranch: input.baseBranch ?? null,
    targetBranch: input.targetBranch ?? null,
    existingPr: input.existingPr ?? null,
    model: requestedModel ?? null,
    permissions,
    maxTurns: input.maxTurns ?? null,
  };

  const { value, replayed } = await withIdempotency<ClaudeTask>(
    deps,
    'start_repo_task',
    input.idempotencyKey,
    idempotencyPayload,
    (id) => getTask(deps.db, id),
    async (client) => {
      const busy = await findActiveWriteTaskOnBranch(client, repo.key, workingBranch);
      if (busy) {
        throw new BridgeError(
          'BRANCH_BUSY',
          `Branch "${workingBranch}" already has active write task ${busy.id} (${busy.status}). Wait for it or cancel it first.`,
        );
      }
      const task = await insertTask(client, {
        id: taskId,
        type: 'ENGINEERING',
        repositoryKey: repo.key,
        contextMode: null,
        baseBranch,
        targetBranch: explicitTarget ?? null,
        workingBranch,
        prNumber,
        objective: input.objective,
        executionMode: 'WRITE',
        requestedModel: requestedModel ?? null,
        permissions,
        maxTurns,
        createdBy: input.createdBy ?? null,
        // Caller metadata is namespaced so it can never masquerade as
        // bridge-verified keys (git, bridgeBlockers, ...).
        metadata: {
          caller: input.metadata ?? {},
          resolvedModel,
          ...(prUrl ? { existingPrUrl: prUrl } : {}),
        },
      });
      if (prUrl) {
        await client.query(`UPDATE claude_tasks SET pr_url = $2 WHERE id = $1`, [taskId, prUrl]);
      }
      await acquireBranchLock(client, repo.key, workingBranch, taskId);
      await recordTaskEvent(
        client,
        taskId,
        'TASK_CREATED',
        `Engineering task queued for ${repo.key} (base ${baseBranch}, working branch ${workingBranch}${prNumber ? `, PR #${prNumber}` : ''})`,
        { model: resolvedModel, permissions },
        eventOptions(config),
      );
      return { resourceId: taskId, value: { ...task, prUrl } };
    },
  );
  return { task: value, replayed };
}

/* ----------------------------- ask_claude ------------------------------- */

export interface AskClaudeInput {
  prompt: string;
  repository?: string;
  branch?: string;
  baseBranch?: string;
  prNumber?: number;
  contextMode?: ContextMode;
  model?: string;
  idempotencyKey?: string;
  createdBy?: string;
}

export async function askClaude(
  deps: TaskServiceDeps,
  input: AskClaudeInput,
): Promise<{ task: ClaudeTask; replayed: boolean }> {
  const { config } = deps;
  assertObjectiveSize(config, input.prompt);
  const requestedModel = input.model;
  resolveModel(config, requestedModel); // validate now; worker resolves again

  let contextMode: ContextMode =
    input.contextMode ??
    (input.prNumber !== undefined ? 'pr' : input.branch ? 'branch' : input.repository ? 'repository' : 'general');

  let repo: RepositoryConfig | null = null;
  let baseBranch: string | null = null;
  let branch: string | null = null;
  let prNumber: number | null = null;

  if (contextMode !== 'general') {
    if (!input.repository) {
      throw new BridgeError('VALIDATION_ERROR', `contextMode "${contextMode}" requires a repository.`);
    }
    repo = await loadEnabledRepository(deps, input.repository);
    baseBranch = normalizeBranch(input.baseBranch, 'baseBranch') ?? repo.defaultBranch;
    if (contextMode === 'branch') {
      branch = normalizeBranch(input.branch, 'branch') ?? null;
      if (!branch) throw new BridgeError('VALIDATION_ERROR', 'contextMode "branch" requires a branch.');
    }
    if (contextMode === 'pr') {
      if (input.prNumber === undefined) {
        throw new BridgeError('VALIDATION_ERROR', 'contextMode "pr" requires prNumber.');
      }
      const pr = await deps.github.getPullRequest(repo.githubOwner, repo.githubRepo, input.prNumber);
      if (!pr) {
        throw new BridgeError('PR_NOT_FOUND', `PR #${input.prNumber} not found in ${repo.githubOwner}/${repo.githubRepo}.`);
      }
      prNumber = pr.number;
      branch = isValidBranchName(pr.headRef) ? pr.headRef : null;
      baseBranch = isValidBranchName(pr.baseRef) ? pr.baseRef : repo.defaultBranch;
    }
  } else if (input.repository) {
    contextMode = 'repository';
    repo = await loadEnabledRepository(deps, input.repository);
    baseBranch = repo.defaultBranch;
  }

  const taskId = newTaskId();
  const payload = {
    tool: 'ask_claude',
    promptHash: sha256Hex(input.prompt),
    repository: input.repository ?? null,
    branch: input.branch ?? null,
    prNumber: input.prNumber ?? null,
    contextMode,
    model: requestedModel ?? null,
  };

  const { value, replayed } = await withIdempotency<ClaudeTask>(
    deps,
    'ask_claude',
    input.idempotencyKey,
    payload,
    (id) => getTask(deps.db, id),
    async (client) => {
      const task = await insertTask(client, {
        id: taskId,
        type: 'ANALYSIS',
        repositoryKey: repo?.key ?? null,
        contextMode,
        baseBranch,
        targetBranch: null,
        workingBranch: branch,
        prNumber,
        objective: input.prompt,
        executionMode: 'READ',
        requestedModel: requestedModel ?? null,
        permissions: READ_ONLY_PERMISSIONS,
        maxTurns: contextMode === 'general' ? config.askGeneralMaxTurns : config.defaultMaxTurns,
        createdBy: input.createdBy ?? null,
      });
      await recordTaskEvent(
        client,
        taskId,
        'TASK_CREATED',
        `Analysis task queued (${contextMode}${repo ? `, ${repo.key}` : ''}${branch ? `, ${branch}` : ''}${prNumber ? `, PR #${prNumber}` : ''})`,
        null,
        eventOptions(config),
      );
      return { resourceId: taskId, value: task };
    },
  );
  return { task: value, replayed };
}

/* --------------------------- continue_repo_task -------------------------- */

export interface ContinueTaskInput {
  taskId: string;
  instruction: string;
  idempotencyKey?: string;
}

export async function continueTask(
  deps: TaskServiceDeps,
  input: ContinueTaskInput,
): Promise<{ task: ClaudeTask; continuation: Continuation; replayed: boolean }> {
  const { config } = deps;
  assertObjectiveSize(config, input.instruction);

  const payload = {
    tool: 'continue_repo_task',
    taskId: input.taskId,
    instructionHash: sha256Hex(input.instruction),
  };

  // All state validation happens inside the idempotency wrapper: a replayed
  // continuation must return the original result even though the first
  // application already changed the task's state.
  const { value, replayed } = await withIdempotency<{ task: ClaudeTask; continuation: Continuation }>(
    deps,
    'continue_repo_task',
    input.idempotencyKey,
    payload,
    async (id) => {
      const continuation = await getContinuation(deps.db, id);
      if (!continuation) return null;
      const freshTask = await getTask(deps.db, continuation.taskId);
      return freshTask ? { task: freshTask, continuation } : null;
    },
    async (client) => {
      const task = await getTask(client, input.taskId);
      if (!task) throw new BridgeError('TASK_NOT_FOUND', `Task ${input.taskId} not found.`);
      if (task.status === 'CANCELLED') {
        throw new BridgeError('TASK_CANCELLED', `Task ${task.id} was cancelled and cannot be continued.`);
      }
      if (!CONTINUABLE_STATUSES.includes(task.status)) {
        throw new BridgeError(
          ['RUNNING', 'PREPARING', 'QUEUED', 'CANCEL_REQUESTED'].includes(task.status)
            ? 'TASK_ALREADY_RUNNING'
            : 'TASK_NOT_CONTINUABLE',
          `Task ${task.id} is ${task.status}; continuations are accepted when a task is COMPLETED, FAILED, or WAITING.`,
        );
      }
      if (!task.claudeSessionId) {
        throw new BridgeError(
          'CLAUDE_SESSION_UNAVAILABLE',
          `Task ${task.id} has no resumable Claude session (it likely failed before Claude started). Start a new task instead.`,
        );
      }
      const fresh = await updateTaskWhereStatus(client, task.id, [...CONTINUABLE_STATUSES], {
        status: 'QUEUED',
        phase: 'CONTINUATION_QUEUED',
        attentionRequired: false,
        attentionReason: null,
        errorCode: null,
        errorDetail: null,
      });
      if (!fresh) {
        throw new BridgeError('TASK_ALREADY_RUNNING', `Task ${task.id} changed state; re-check status and retry.`);
      }
      if (fresh.type === 'ENGINEERING' && fresh.repositoryKey && fresh.workingBranch) {
        await acquireBranchLock(client, fresh.repositoryKey, fresh.workingBranch, fresh.id);
      }
      const continuation = await insertContinuation(client, {
        id: newContinuationId(),
        taskId: task.id,
        instruction: input.instruction,
      });
      await recordTaskEvent(
        client,
        task.id,
        'CONTINUATION_QUEUED',
        `Continuation #${continuation.seq} queued: ${input.instruction.slice(0, 200)}`,
        null,
        eventOptions(config),
      );
      return { resourceId: continuation.id, value: { task: fresh, continuation } };
    },
  );
  return { ...value, replayed };
}

/* ------------------------------ cancel_task ------------------------------ */

export async function cancelTask(
  deps: TaskServiceDeps,
  taskId: string,
): Promise<{ task: ClaudeTask; alreadyFinal: boolean }> {
  const { config } = deps;
  const task = await getTask(deps.db, taskId);
  if (!task) throw new BridgeError('TASK_NOT_FOUND', `Task ${taskId} not found.`);

  if (task.status === 'COMPLETED' || task.status === 'FAILED' || task.status === 'CANCELLED') {
    return { task, alreadyFinal: true };
  }

  return withTransaction(deps.db, async (client) => {
    // QUEUED/WAITING tasks cancel immediately — no worker owns them.
    const direct = await updateTaskWhereStatus(client, taskId, ['QUEUED', 'WAITING'], {
      status: 'CANCELLED',
      phase: 'CANCELLED',
      cancelRequestedAt: new Date(),
      cancelledAt: new Date(),
      completedAt: new Date(),
    });
    if (direct) {
      await cancelQueuedContinuations(client, taskId);
      await releaseBranchLocks(client, taskId);
      await recordTaskEvent(client, taskId, 'CANCELLED', 'Task cancelled before execution.', null, eventOptions(config));
      return { task: direct, alreadyFinal: false };
    }
    // PREPARING/RUNNING: ask the owning worker to stop.
    const requested = await updateTaskWhereStatus(client, taskId, ['PREPARING', 'RUNNING'], {
      status: 'CANCEL_REQUESTED',
      cancelRequestedAt: new Date(),
    });
    if (requested) {
      await cancelQueuedContinuations(client, taskId);
      await recordTaskEvent(client, taskId, 'CANCEL_REQUESTED', 'Cancellation requested; stopping Claude execution.', null, eventOptions(config));
      return { task: requested, alreadyFinal: false };
    }
    // Already CANCEL_REQUESTED or raced to terminal — return current state.
    const current = await getTask(client, taskId);
    if (!current) throw new BridgeError('TASK_NOT_FOUND', `Task ${taskId} not found.`);
    return {
      task: current,
      alreadyFinal: current.status === 'COMPLETED' || current.status === 'FAILED' || current.status === 'CANCELLED',
    };
  });
}

/* ------------------------- status / report / events ---------------------- */

export interface TaskStatusView {
  taskId: string;
  type: string;
  status: TaskStatus;
  phase: string | null;
  running: boolean;
  attentionRequired: boolean;
  attentionReason: string | null;
  repository: string | null;
  baseBranch: string | null;
  workingBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  model: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  latestEvent: { type: string; message: string; at: string } | null;
  queuedContinuations: number;
  errorCode: string | null;
}

export async function getTaskStatus(deps: TaskServiceDeps, taskId: string): Promise<TaskStatusView> {
  const task = await getTask(deps.db, taskId);
  if (!task) throw new BridgeError('TASK_NOT_FOUND', `Task ${taskId} not found.`);
  const [latest, continuations] = await Promise.all([
    latestTaskEvent(deps.db, taskId),
    listContinuations(deps.db, taskId),
  ]);
  const startRef = task.startedAt ?? task.createdAt;
  const endRef = task.completedAt ?? new Date();
  return {
    taskId: task.id,
    type: task.type,
    status: task.status,
    phase: task.phase,
    running: task.status === 'PREPARING' || task.status === 'RUNNING' || task.status === 'CANCEL_REQUESTED',
    attentionRequired: task.attentionRequired,
    attentionReason: task.attentionReason,
    repository: task.repositoryKey,
    baseBranch: task.baseBranch,
    workingBranch: task.workingBranch,
    prNumber: task.prNumber,
    prUrl: task.prUrl,
    model: task.actualModel ?? task.requestedModel,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    elapsedMs: task.startedAt ? Math.max(0, endRef.getTime() - startRef.getTime()) : null,
    latestEvent: latest
      ? { type: latest.type, message: latest.message, at: latest.createdAt.toISOString() }
      : null,
    queuedContinuations: continuations.filter((c) => c.status === 'QUEUED').length,
    errorCode: task.errorCode,
  };
}

export async function getTaskReport(deps: TaskServiceDeps, taskId: string): Promise<Record<string, unknown>> {
  const task = await getTask(deps.db, taskId);
  if (!task) throw new BridgeError('TASK_NOT_FOUND', `Task ${taskId} not found.`);
  const continuations = await listContinuations(deps.db, taskId);
  const git = (task.metadata.git ?? null) as Record<string, unknown> | null;

  const report = task.resultReport ? completionReportSchema.safeParse(task.resultReport) : null;
  return {
    taskId: task.id,
    type: task.type,
    status: task.status,
    phase: task.phase,
    attentionRequired: task.attentionRequired,
    attentionReason: task.attentionReason,
    repository: task.repositoryKey,
    baseBranch: task.baseBranch,
    workingBranch: task.workingBranch,
    headShaBefore: task.headShaBefore,
    headShaAfter: task.headShaAfter,
    expectedHeadSha: task.expectedHeadSha,
    pr: task.prNumber ? { number: task.prNumber, url: task.prUrl } : null,
    merged: task.merged,
    mergeSha: task.mergeSha,
    model: task.actualModel ?? task.requestedModel,
    numTurns: task.numTurns,
    totalCostUsd: task.totalCostUsd,
    /** Bridge-verified git facts (independent of Claude's own report). */
    git,
    /** Problems the bridge itself detected (e.g. push blocked, wrong branch). */
    bridgeBlockers: (task.metadata.bridgeBlockers as string[] | undefined) ?? [],
    /** Claude's structured completion report (validated) or null. */
    claudeReport: report?.success ? report.data : (task.resultReport ?? null),
    reportParseError: task.reportParseError,
    resultSummary: task.resultSummary,
    /** Raw final response text, preserved when structured parsing failed. */
    rawFinalResponse: task.reportParseError ? task.rawFinalResponse : null,
    error: task.errorCode ? { code: task.errorCode, detail: task.errorDetail } : null,
    continuations: continuations.map((c) => ({
      id: c.id,
      seq: c.seq,
      status: c.status,
      instruction: c.instruction.slice(0, 500),
      resultSummary: c.resultSummary,
      errorCode: c.errorCode,
    })),
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
  };
}

export async function getTaskEvents(
  deps: TaskServiceDeps,
  input: { taskId: string; limit?: number; beforeSeq?: number },
): Promise<{ events: { seq: number; type: string; message: string; at: string; detail: unknown }[]; oldestSeq: number | null }> {
  const task = await getTask(deps.db, input.taskId);
  if (!task) throw new BridgeError('TASK_NOT_FOUND', `Task ${input.taskId} not found.`);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const events = await listTaskEvents(deps.db, input.taskId, { limit, beforeSeq: input.beforeSeq });
  return {
    events: events.map((e) => ({
      seq: e.seq,
      type: e.type,
      message: e.message,
      at: e.createdAt.toISOString(),
      detail: e.detail,
    })),
    oldestSeq: events.length > 0 ? (events[0]?.seq ?? null) : null,
  };
}

/* ------------------------------- list_tasks ------------------------------ */

export interface ListTasksInput {
  repository?: string;
  statuses?: TaskStatus[];
  branch?: string;
  prNumber?: number;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  cursor?: string;
}

export function encodeCursor(cursor: { createdAt: Date; id: string }): string {
  return Buffer.from(canonicalJson({ c: cursor.createdAt.toISOString(), i: cursor.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = z
      .object({ c: z.string(), i: z.string() })
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) throw new Error('bad date');
    return { createdAt, id: parsed.i };
  } catch {
    throw new BridgeError('VALIDATION_ERROR', 'Invalid pagination cursor.');
  }
}

export async function listTasksView(deps: TaskServiceDeps, input: ListTasksInput) {
  const filter: ListTasksFilter = {
    repositoryKey: input.repository,
    statuses: input.statuses,
    branch: input.branch,
    prNumber: input.prNumber,
    createdAfter: input.createdAfter ? new Date(input.createdAfter) : undefined,
    createdBefore: input.createdBefore ? new Date(input.createdBefore) : undefined,
    limit: Math.min(Math.max(input.limit ?? 20, 1), 100),
    cursor: input.cursor ? decodeCursor(input.cursor) : undefined,
  };
  const { tasks, nextCursor } = await listTasks(deps.db, filter);
  return {
    tasks: tasks.map((t) => ({
      taskId: t.id,
      type: t.type,
      status: t.status,
      repository: t.repositoryKey,
      workingBranch: t.workingBranch,
      prNumber: t.prNumber,
      objectivePreview: t.objective.slice(0, 160),
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
      errorCode: t.errorCode,
    })),
    nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
  };
}

/* ------------------------------ merge_task_pr ---------------------------- */

export interface MergeTaskPrInput {
  taskId: string;
  expectedHeadSha: string;
  /** Explicit merge authorization for tasks created without allowMerge. */
  authorizeMerge?: boolean;
  commitTitle?: string;
}

export async function mergeTaskPr(
  deps: TaskServiceDeps,
  input: MergeTaskPrInput,
): Promise<Record<string, unknown>> {
  const { config } = deps;
  const task = await getTask(deps.db, input.taskId);
  if (!task) throw new BridgeError('TASK_NOT_FOUND', `Task ${input.taskId} not found.`);
  if (!task.repositoryKey) throw new BridgeError('VALIDATION_ERROR', 'Task has no repository.');
  const repo = await loadEnabledRepository(deps, task.repositoryKey);

  if (task.merged && task.mergeSha) {
    return { merged: true, alreadyMerged: true, mergeSha: task.mergeSha, prNumber: task.prNumber, prUrl: task.prUrl };
  }
  if (task.status !== 'COMPLETED') {
    throw new BridgeError(
      task.status === 'RUNNING' || task.status === 'PREPARING' || task.status === 'QUEUED'
        ? 'TASK_ALREADY_RUNNING'
        : 'MERGE_BLOCKED',
      `Task ${task.id} is ${task.status}; only COMPLETED tasks can be merged.`,
    );
  }
  if (!task.prNumber) {
    throw new BridgeError('PR_NOT_FOUND', `Task ${task.id} has no pull request to merge.`);
  }
  if (!repo.allowMerge) {
    throw new BridgeError(
      'PERMISSION_DENIED',
      `Repository "${repo.key}" does not allow merging through the bridge (registry ceiling).`,
    );
  }
  if (!task.permissions.allowMerge && input.authorizeMerge !== true) {
    throw new BridgeError(
      'PERMISSION_DENIED',
      `Task ${task.id} was created without allowMerge. Pass authorizeMerge=true to explicitly authorize this merge.`,
    );
  }
  if (task.expectedHeadSha && input.expectedHeadSha !== task.expectedHeadSha) {
    throw new BridgeError(
      'EXPECTED_HEAD_MISMATCH',
      `expectedHeadSha ${input.expectedHeadSha.slice(0, 12)} does not match the verified head ${task.expectedHeadSha.slice(0, 12)} recorded for this task.`,
    );
  }

  const report = task.resultReport ? completionReportSchema.safeParse(task.resultReport) : null;
  const claudeBlockers = report?.success ? report.data.blockers : [];
  const bridgeBlockers = (task.metadata.bridgeBlockers as string[] | undefined) ?? [];
  const blockers = [...claudeBlockers, ...bridgeBlockers];
  if (blockers.length > 0) {
    throw new BridgeError('MERGE_BLOCKED', `Task ${task.id} has unresolved blockers; resolve them first.`, {
      detail: blockers.slice(0, 5).join(' | '),
    });
  }

  const pr = await deps.github.getPullRequest(repo.githubOwner, repo.githubRepo, task.prNumber);
  if (!pr) throw new BridgeError('PR_NOT_FOUND', `PR #${task.prNumber} no longer exists.`);
  if (pr.merged) {
    await updateTaskWhereStatus(deps.db, task.id, ['COMPLETED'], {
      merged: true,
      mergeSha: pr.headSha,
      mergedAt: new Date(),
    });
    return { merged: true, alreadyMerged: true, mergeSha: pr.headSha, prNumber: pr.number, prUrl: pr.url };
  }
  if (pr.state !== 'open') throw new BridgeError('MERGE_BLOCKED', `PR #${pr.number} is closed.`);
  if (pr.draft) throw new BridgeError('MERGE_BLOCKED', `PR #${pr.number} is a draft.`);
  if (pr.headSha !== input.expectedHeadSha) {
    await flagHeadMismatch(deps, task.id, pr.headSha);
    throw new BridgeError(
      'EXPECTED_HEAD_MISMATCH',
      `PR #${pr.number} head is ${pr.headSha.slice(0, 12)}, not the verified ${input.expectedHeadSha.slice(0, 12)}. Someone pushed after verification — re-review before merging.`,
    );
  }
  if (pr.mergeable === false) {
    throw new BridgeError('MERGE_BLOCKED', `GitHub reports PR #${pr.number} is not mergeable (${pr.mergeableState ?? 'unknown'}).`);
  }

  let checksNote = 'checks not required by configuration';
  if (config.mergeRequireChecks) {
    const checks = await deps.github.getChecksSummary(repo.githubOwner, repo.githubRepo, pr.headSha);
    if (checks.state === 'failure') {
      throw new BridgeError('MERGE_BLOCKED', `CI is failing on PR #${pr.number}: ${checks.failing.slice(0, 5).join(', ')}`);
    }
    if (checks.state === 'pending') {
      throw new BridgeError('MERGE_BLOCKED', `CI is still running on PR #${pr.number}: ${checks.pending.slice(0, 5).join(', ')}`);
    }
    checksNote = checks.state === 'none' ? 'no CI checks are configured on this repository' : 'all checks green';
  }

  let threadsNote = 'review threads not required by configuration';
  if (config.mergeRequireResolvedThreads) {
    const unresolved = await deps.github.countUnresolvedReviewThreads(repo.githubOwner, repo.githubRepo, pr.number);
    if (unresolved === null) {
      threadsNote = 'review-thread state inaccessible with current credentials; proceeded';
    } else if (unresolved > 0) {
      throw new BridgeError('MERGE_BLOCKED', `PR #${pr.number} has ${unresolved} unresolved review thread(s).`);
    } else {
      threadsNote = 'no unresolved review threads';
    }
  }

  const result = await deps.github.mergePullRequest(repo.githubOwner, repo.githubRepo, pr.number, {
    expectedHeadSha: input.expectedHeadSha,
    method: 'squash',
    ...(input.commitTitle ? { commitTitle: input.commitTitle } : {}),
  });
  if (!result.merged) {
    throw new BridgeError('MERGE_BLOCKED', `GitHub did not merge PR #${pr.number}: ${result.message}`);
  }
  await withTransaction(deps.db, async (client) => {
    await updateTaskWhereStatus(client, task.id, ['COMPLETED'], {
      merged: true,
      mergeSha: result.sha ?? undefined,
      mergedAt: new Date(),
    });
    await recordTaskEvent(
      client,
      task.id,
      'PR_MERGED',
      `PR #${pr.number} squash-merged at ${result.sha ?? 'unknown'} (${checksNote}; ${threadsNote}).`,
      null,
      eventOptions(config),
    );
  });
  return {
    merged: true,
    alreadyMerged: false,
    mergeSha: result.sha,
    prNumber: pr.number,
    prUrl: pr.url,
    checks: checksNote,
    reviewThreads: threadsNote,
  };
}

async function flagHeadMismatch(deps: TaskServiceDeps, taskId: string, liveHead: string): Promise<void> {
  await withTransaction(deps.db, async (client) => {
    await updateTaskWhereStatus(client, taskId, ['COMPLETED'], {
      status: 'WAITING',
      attentionRequired: true,
      attentionReason: `PR head moved to ${liveHead.slice(0, 12)} after verification; re-review before merging.`,
    });
    await recordTaskEvent(
      client,
      taskId,
      'ATTENTION_REQUIRED',
      `Expected-head mismatch: live PR head ${liveHead.slice(0, 12)} differs from the verified sha.`,
      null,
      eventOptions(deps.config),
    );
  });
}
