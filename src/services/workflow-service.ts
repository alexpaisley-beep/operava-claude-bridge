import type { BridgeConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { BridgeError } from '../errors.js';
import { newWorkflowRunId, requestHash, sha256Hex } from '../ids.js';
import type { Logger } from '../logger.js';
import type { RepositoryConfig, WorkflowRun } from '../domain/types.js';
import { findIdempotentReplay, isUniqueViolation, saveIdempotencyKey } from '../db/idempotency.js';
import { getRepository, listRepositories } from '../db/repositories.js';
import {
  getWorkflowRun,
  insertWorkflowRun,
  updateWorkflowRunWhereStatus,
} from '../db/workflow-runs.js';
import { isValidBranchName } from '../gitx/validate.js';
import type { GitHubClient } from '../github/types.js';
import type { WorkflowRegistry } from '../workflows/registry.js';

export interface WorkflowServiceDeps {
  db: Db;
  config: BridgeConfig;
  logger: Logger;
  github: GitHubClient;
  workflows: WorkflowRegistry;
}

async function loadEnabledRepository(deps: WorkflowServiceDeps, key: string): Promise<RepositoryConfig> {
  const repo = await getRepository(deps.db, key);
  if (!repo) {
    throw new BridgeError('REPOSITORY_NOT_FOUND', `Repository "${key}" is not in the registry.`);
  }
  if (!repo.enabled) {
    throw new BridgeError('REPOSITORY_DISABLED', `Repository "${key}" is disabled.`);
  }
  return repo;
}

export async function listWorkflowsForRepository(
  deps: WorkflowServiceDeps,
  repositoryKey: string,
): Promise<{ name: string; description: string; parameters: unknown[]; timeoutMs: number }[]> {
  const repo = await loadEnabledRepository(deps, repositoryKey);
  return deps.workflows.availableFor(repo).map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters.map((p) => ({
      name: p.name,
      description: p.description ?? null,
      required: p.required,
    })),
    timeoutMs: def.timeoutMs ?? deps.config.defaultWorkflowTimeoutMs,
  }));
}

export async function listRepositoriesView(deps: { db: Db; workflows: WorkflowRegistry }) {
  const repos = await listRepositories(deps.db, { enabledOnly: true });
  return repos.map((r) => ({
    repository: r.key,
    github: `${r.githubOwner}/${r.githubRepo}`,
    defaultBranch: r.defaultBranch,
    allowedOperations: {
      codeChanges: r.allowCodeChanges,
      commit: r.allowCommit,
      push: r.allowPush,
      openPr: r.allowOpenPr,
      updatePr: r.allowUpdatePr,
      merge: r.allowMerge,
    },
    concurrencyLimit: r.concurrencyLimit,
    workflows: deps.workflows.availableFor(r).map((d) => d.name),
    hasInstructions: Boolean(r.instructions),
  }));
}

export interface RunWorkflowInput {
  repository: string;
  workflow: string;
  branch?: string;
  prNumber?: number;
  parameters?: Record<string, unknown>;
  idempotencyKey?: string;
  createdBy?: string;
}

export async function runWorkflow(
  deps: WorkflowServiceDeps,
  input: RunWorkflowInput,
): Promise<{ run: WorkflowRun; replayed: boolean }> {
  const repo = await loadEnabledRepository(deps, input.repository);
  const def = deps.workflows.get(input.workflow);
  if (!def) {
    throw new BridgeError('WORKFLOW_NOT_FOUND', `Workflow "${input.workflow}" does not exist.`, {
      detail: 'Use list_workflows to see what is available for this repository.',
    });
  }
  if (!deps.workflows.isAvailable(def, repo)) {
    throw new BridgeError(
      'WORKFLOW_NOT_ALLOWED',
      `Workflow "${def.name}" is not enabled for repository "${repo.key}".`,
    );
  }
  const parameters = deps.workflows.validateParameters(def, input.parameters ?? {});

  let branch: string | null = null;
  let prNumber: number | null = null;
  if (input.prNumber !== undefined) {
    const pr = await deps.github.getPullRequest(repo.githubOwner, repo.githubRepo, input.prNumber);
    if (!pr) throw new BridgeError('PR_NOT_FOUND', `PR #${input.prNumber} not found in ${repo.githubOwner}/${repo.githubRepo}.`);
    prNumber = pr.number;
    branch = isValidBranchName(pr.headRef) ? pr.headRef : null;
  } else if (input.branch) {
    if (!isValidBranchName(input.branch)) {
      throw new BridgeError('VALIDATION_ERROR', `Invalid branch: ${JSON.stringify(input.branch)}`);
    }
    branch = input.branch;
  } else if (def.requiresRef) {
    branch = repo.defaultBranch;
  }

  const payload = {
    tool: 'run_workflow',
    repository: input.repository,
    workflow: input.workflow,
    branch: input.branch ?? null,
    prNumber: input.prNumber ?? null,
    parametersHash: sha256Hex(requestHash(parameters)),
  };
  const hash = requestHash(payload);

  const attempt = async (): Promise<{ run: WorkflowRun; replayed: boolean }> =>
    withTransaction(deps.db, async (client) => {
      if (input.idempotencyKey) {
        const replay = await findIdempotentReplay(client, 'run_workflow', input.idempotencyKey, hash);
        if (replay) {
          const existing = await getWorkflowRun(client, replay.resourceId);
          if (!existing) throw new BridgeError('INTERNAL_ERROR', 'Idempotency record points to a missing workflow run.');
          return { run: existing, replayed: true };
        }
      }
      const run = await insertWorkflowRun(client, {
        id: newWorkflowRunId(),
        repositoryKey: repo.key,
        workflow: def.name,
        branch,
        prNumber,
        parameters,
        createdBy: input.createdBy ?? null,
      });
      if (input.idempotencyKey) {
        await saveIdempotencyKey(client, {
          scope: 'run_workflow',
          key: input.idempotencyKey,
          requestHash: hash,
          resourceType: 'workflow_run',
          resourceId: run.id,
        });
      }
      return { run, replayed: false };
    });

  try {
    return await attempt();
  } catch (err) {
    if (input.idempotencyKey && isUniqueViolation(err)) return attempt();
    throw err;
  }
}

export async function getWorkflowRunView(
  deps: WorkflowServiceDeps,
  runId: string,
): Promise<Record<string, unknown>> {
  const run = await getWorkflowRun(deps.db, runId);
  if (!run) throw new BridgeError('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} not found.`);
  return {
    runId: run.id,
    repository: run.repositoryKey,
    workflow: run.workflow,
    branch: run.branch,
    prNumber: run.prNumber,
    parameters: run.parameters,
    status: run.status,
    phase: run.phase,
    running: run.status === 'PREPARING' || run.status === 'RUNNING' || run.status === 'CANCEL_REQUESTED',
    headSha: run.headSha,
    exitCode: run.exitCode,
    outputSummary: run.outputSummary,
    findings: run.findings,
    artifacts: run.artifacts,
    error: run.errorCode ? { code: run.errorCode, detail: run.errorDetail } : null,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

export async function cancelWorkflowRun(
  deps: WorkflowServiceDeps,
  runId: string,
): Promise<{ status: string; alreadyFinal: boolean }> {
  const run = await getWorkflowRun(deps.db, runId);
  if (!run) throw new BridgeError('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} not found.`);
  if (run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED') {
    return { status: run.status, alreadyFinal: true };
  }
  const direct = await updateWorkflowRunWhereStatus(deps.db, runId, ['QUEUED'], {
    status: 'CANCELLED',
    phase: 'CANCELLED',
    cancelRequestedAt: new Date(),
    cancelledAt: new Date(),
    completedAt: new Date(),
  });
  if (direct) return { status: direct.status, alreadyFinal: false };
  const requested = await updateWorkflowRunWhereStatus(deps.db, runId, ['PREPARING', 'RUNNING'], {
    status: 'CANCEL_REQUESTED',
    cancelRequestedAt: new Date(),
  });
  if (requested) return { status: requested.status, alreadyFinal: false };
  const current = await getWorkflowRun(deps.db, runId);
  return {
    status: current?.status ?? 'CANCELLED',
    alreadyFinal:
      current?.status === 'COMPLETED' || current?.status === 'FAILED' || current?.status === 'CANCELLED',
  };
}
