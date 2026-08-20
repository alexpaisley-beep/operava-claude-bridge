import { spawn } from 'node:child_process';
import os from 'node:os';
import type { BridgeConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { getRepository } from '../db/repositories.js';
import {
  getWorkflowRun,
  heartbeatWorkflowRun,
  updateWorkflowRunWhereStatus,
} from '../db/workflow-runs.js';
import { truncateUtf8 } from '../db/events.js';
import type { RepositoryConfig, WorkflowRun } from '../domain/types.js';
import { BridgeError, toBridgeError } from '../errors.js';
import type { WorkspaceManager } from '../gitx/workspace.js';
import type { Logger } from '../logger.js';
import type { WorkflowDefinition, WorkflowRegistry } from '../workflows/registry.js';

export interface WorkflowWorkerDeps {
  db: Db;
  config: BridgeConfig;
  logger: Logger;
  workflows: WorkflowRegistry;
  workspaces: WorkspaceManager;
  workerId: string;
  isShuttingDown: () => boolean;
}

/**
 * Execute one claimed workflow run: isolated checkout, allowlisted command via
 * spawn (no shell), bounded output, structured parsing, durable result.
 */
export async function executeWorkflowRun(deps: WorkflowWorkerDeps, claimed: WorkflowRun): Promise<void> {
  const { db, config, logger } = deps;
  const log = logger.child({ workflowRunId: claimed.id, workflow: claimed.workflow });

  const heartbeat = setInterval(() => {
    heartbeatWorkflowRun(db, claimed.id, deps.workerId, config.leaseSeconds).catch(() => undefined);
  }, config.heartbeatIntervalMs);

  try {
    const def = deps.workflows.get(claimed.workflow);
    if (!def) {
      throw new BridgeError('WORKFLOW_NOT_FOUND', `Workflow "${claimed.workflow}" is no longer configured.`);
    }
    const repo = await getRepository(db, claimed.repositoryKey);
    if (!repo || !repo.enabled) {
      throw new BridgeError('REPOSITORY_NOT_FOUND', `Repository "${claimed.repositoryKey}" is unavailable.`);
    }
    if (!deps.workflows.isAvailable(def, repo)) {
      throw new BridgeError('WORKFLOW_NOT_ALLOWED', `Workflow "${def.name}" is not enabled for "${repo.key}".`);
    }

    const dir = deps.workspaces.runPath(claimed.id);
    let headSha: string | null = null;
    if (def.requiresRef) {
      const ws = await deps.workspaces.createWorkspace({
        dir,
        repo,
        baseBranch: claimed.branch ?? repo.defaultBranch,
        ...(claimed.prNumber !== null
          ? { fetchPrNumber: claimed.prNumber }
          : claimed.branch
            ? { workingBranch: claimed.branch, requireWorkingBranch: true }
            : {}),
      });
      headSha = ws.headSha;
    }

    const running = await updateWorkflowRunWhereStatus(db, claimed.id, ['PREPARING'], {
      status: 'RUNNING',
      phase: 'EXECUTING',
      ...(headSha ? { headSha } : {}),
    });
    if (!running) {
      await maybeFinalizeCancelled(deps, claimed.id);
      return;
    }

    const result = await runCommand(deps, claimed, def, repo, dir, headSha);
    const parsed = parseOutput(def, result.stdout, result.stderr);

    if (result.cancelled) {
      await updateWorkflowRunWhereStatus(db, claimed.id, ['RUNNING', 'CANCEL_REQUESTED'], {
        status: 'CANCELLED',
        phase: 'CANCELLED',
        exitCode: result.exitCode,
        outputSummary: parsed.summary,
        cancelledAt: new Date(),
        completedAt: new Date(),
      });
      return;
    }
    if (result.timedOut) {
      throw new BridgeError('WORKFLOW_TIMEOUT', `Workflow exceeded its ${result.timeoutMs}ms timeout.`, {
        detail: parsed.summary ?? undefined,
      });
    }
    if (result.exitCode !== 0) {
      await updateWorkflowRunWhereStatus(db, claimed.id, ['RUNNING', 'CANCEL_REQUESTED'], {
        status: 'FAILED',
        phase: 'FAILED',
        exitCode: result.exitCode,
        outputSummary: parsed.summary,
        findings: parsed.findings ?? null,
        errorCode: 'WORKFLOW_FAILED',
        errorDetail: truncateUtf8(result.stderr || `exit code ${result.exitCode}`, 4000),
        completedAt: new Date(),
      });
      return;
    }
    await updateWorkflowRunWhereStatus(db, claimed.id, ['RUNNING', 'CANCEL_REQUESTED'], {
      status: 'COMPLETED',
      phase: 'DONE',
      exitCode: 0,
      outputSummary: parsed.summary,
      findings: parsed.findings ?? null,
      artifacts: parsed.artifacts ?? null,
      completedAt: new Date(),
    });
  } catch (err) {
    const bridgeErr = toBridgeError(err, 'WORKFLOW_FAILED');
    log.error({ err: bridgeErr }, 'workflow run failed');
    await updateWorkflowRunWhereStatus(db, claimed.id, ['QUEUED', 'PREPARING', 'RUNNING', 'CANCEL_REQUESTED'], {
      status: 'FAILED',
      phase: 'FAILED',
      errorCode: bridgeErr.code,
      errorDetail: truncateUtf8(`${bridgeErr.message}${bridgeErr.detail ? ` — ${bridgeErr.detail}` : ''}`, 4000),
      completedAt: new Date(),
    });
  } finally {
    clearInterval(heartbeat);
    // Workflow workspaces are disposable; artifacts live in Postgres.
    await deps.workspaces.removeWorkspace(deps.workspaces.runPath(claimed.id)).catch(() => undefined);
  }
}

async function maybeFinalizeCancelled(deps: WorkflowWorkerDeps, runId: string): Promise<void> {
  await updateWorkflowRunWhereStatus(deps.db, runId, ['CANCEL_REQUESTED'], {
    status: 'CANCELLED',
    phase: 'CANCELLED',
    cancelledAt: new Date(),
    completedAt: new Date(),
  });
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
  timeoutMs: number;
}

function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?::\w+)?)\}\}/g, (_m, keyRaw: string) => {
    const key = keyRaw.startsWith('param:') ? `param:${keyRaw.slice(6)}` : keyRaw;
    const value = values[key];
    if (value === undefined) {
      throw new BridgeError('VALIDATION_ERROR', `Workflow command references unknown placeholder {{${keyRaw}}}.`);
    }
    return value;
  });
}

async function runCommand(
  deps: WorkflowWorkerDeps,
  run: WorkflowRun,
  def: WorkflowDefinition,
  repo: RepositoryConfig,
  dir: string,
  headSha: string | null,
): Promise<CommandResult> {
  const { config, db } = deps;
  const timeoutMs = def.timeoutMs ?? config.defaultWorkflowTimeoutMs;
  const params = Object.fromEntries(
    Object.entries(run.parameters).map(([k, v]) => [k, String(v)]),
  );

  const values: Record<string, string> = {
    repoDir: dir,
    branch: run.branch ?? '',
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param:${k}`, v])),
  };
  const argv = def.command.map((part) => substitute(part, values));
  const substituted = argv.filter((part, i) => part !== def.command[i]);
  for (const part of substituted) {
    if (part.startsWith('-')) {
      throw new BridgeError('VALIDATION_ERROR', 'A substituted workflow argument may not start with "-".');
    }
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: os.tmpdir(),
    WORKFLOW_REPO_KEY: repo.key,
    WORKFLOW_REPO_DIR: dir,
    WORKFLOW_BRANCH: run.branch ?? '',
    WORKFLOW_HEAD_SHA: headSha ?? '',
    WORKFLOW_PR_NUMBER: run.prNumber !== null ? String(run.prNumber) : '',
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`WORKFLOW_PARAM_${k.toUpperCase()}`, v])),
    ...def.env,
  };

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: def.requiresRef ? dir : undefined,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let cancelled = false;
    let timedOut = false;
    const cap = config.maxWorkflowOutputBytes;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString('utf8').slice(0, cap - stdout.length);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString('utf8').slice(0, cap - stderr.length);
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    const cancelPoll = setInterval(() => {
      if (deps.isShuttingDown()) {
        cancelled = true;
        child.kill('SIGTERM');
        return;
      }
      getWorkflowRun(db, run.id)
        .then((fresh) => {
          if (fresh?.status === 'CANCEL_REQUESTED') {
            cancelled = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000).unref();
          }
        })
        .catch(() => undefined);
    }, 2000);

    child.on('error', (err) => {
      clearTimeout(killTimer);
      clearInterval(cancelPoll);
      reject(new BridgeError('WORKFLOW_FAILED', `Failed to start workflow command: ${err.message}`, { cause: err }));
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      clearInterval(cancelPoll);
      resolve({ exitCode: code, stdout, stderr, cancelled, timedOut, timeoutMs });
    });
  });
}

function parseOutput(
  def: WorkflowDefinition,
  stdout: string,
  stderr: string,
): { summary: string; findings: unknown | null; artifacts: unknown | null } {
  const fallbackSummary = truncateUtf8(stdout.trim() || stderr.trim() || '(no output)', 4000);
  if (def.outputParser !== 'json') {
    return { summary: fallbackSummary, findings: null, artifacts: null };
  }
  const candidates: string[] = [];
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  for (const line of stdout.split('\n').reverse()) {
    const l = line.trim();
    if (l.startsWith('{') && l.endsWith('}')) {
      candidates.push(l);
      break;
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      return {
        summary: truncateUtf8(String(parsed.summary ?? fallbackSummary), 4000),
        findings: parsed.findings ?? null,
        artifacts: parsed.artifacts ?? null,
      };
    } catch {
      // try next candidate
    }
  }
  return { summary: fallbackSummary, findings: null, artifacts: null };
}
