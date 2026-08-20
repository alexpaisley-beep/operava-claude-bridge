import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimNextTask, getTask, updateTaskWhereStatus } from '../../src/db/tasks.js';
import { listTaskEvents } from '../../src/db/events.js';
import { runGit } from '../../src/gitx/git.js';
import { askClaude, continueTask, getTaskReport, startRepoTask } from '../../src/services/task-service.js';
import { executeTask } from '../../src/worker/task-execution.js';
import { reconcile } from '../../src/worker/reconcile.js';
import type { ClaudeRunResult } from '../../src/claude/types.js';
import { addRemoteCommit, divergeRemoteBranch, remoteBranchHead } from '../helpers/git-fixtures.js';
import { createTestContext, type TestContext } from '../helpers/test-env.js';

let ctx: TestContext;
let barePath: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const reg = await ctx.registerRepo('pipeline-repo', { concurrencyLimit: 1 });
  barePath = reg.barePath;
});

afterAll(async () => {
  await ctx.destroy();
});

function successResult(overrides: Partial<ClaudeRunResult> = {}): ClaudeRunResult {
  return {
    ok: true,
    subtype: 'success',
    finalText: 'done',
    structuredOutput: {
      summary: 'Implemented the change and verified it.',
      outcome: 'success',
      filesChanged: [{ path: 'app.js', change: 'modified' }],
      commits: [],
      tests: [{ command: 'npm test', status: 'passed' }],
      findings: [],
      blockers: [],
    },
    sessionId: 'sess-pipeline-1',
    model: 'claude-sonnet-5',
    totalCostUsd: 0.42,
    numTurns: 7,
    permissionDenialCount: 0,
    errorMessage: null,
    ...overrides,
  };
}

async function claimAndRun(expectedTaskId?: string): Promise<void> {
  const claimed = await claimNextTask(ctx.db, ctx.config.workerId, ctx.config.leaseSeconds);
  expect(claimed).not.toBeNull();
  if (expectedTaskId) expect(claimed!.id).toBe(expectedTaskId);
  await executeTask(ctx.workerDeps, claimed!);
}

describe('engineering pipeline end to end (mock Claude, real git)', () => {
  let taskId: string;

  it('runs a full task: clone → edit → commit → push → PR → report', async () => {
    ctx.claude.setBehavior(async (options) => {
      // Simulate Claude editing a file and committing in the isolated workspace.
      const cwd = options.cwd!;
      expect(options.mode).toBe('write');
      expect(options.prompt).toContain('pipeline-repo');
      expect(options.prompt).toContain('Working branch');
      await fs.writeFile(path.join(cwd, 'app.js'), 'console.log("v2 — fixed");\n');
      await runGit(['-C', cwd, 'add', '--all']);
      await runGit(['-C', cwd, 'commit', '--no-verify', '-m', 'fix: correct analytics output']);
      return successResult();
    });

    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'pipeline-repo',
      objective: 'Fix the analytics output bug',
      idempotencyKey: 'pipeline-run-1',
    });
    taskId = task.id;
    await claimAndRun();

    const done = await getTask(ctx.db, taskId);
    expect(done?.status).toBe('COMPLETED');
    expect(done?.claudeSessionId).toBe('sess-pipeline-1');
    expect(done?.actualModel).toBe('claude-sonnet-5');
    expect(done?.headShaBefore).toBeTruthy();
    expect(done?.headShaAfter).toBeTruthy();
    expect(done?.headShaAfter).not.toBe(done?.headShaBefore);
    expect(done?.expectedHeadSha).toBe(done?.headShaAfter);

    // The branch really exists on the "remote" with the new commit.
    const remoteHead = await remoteBranchHead(barePath, task.workingBranch!);
    expect(remoteHead).toBe(done?.headShaAfter);

    // Exactly one PR was opened.
    expect(done?.prNumber).toBeTruthy();
    const prs = [...ctx.github.prs.values()].filter((p) => p.headRef === task.workingBranch);
    expect(prs.length).toBe(1);

    const report = await getTaskReport(ctx.taskDeps, taskId);
    expect(report.status).toBe('COMPLETED');
    expect((report.claudeReport as { summary: string }).summary).toContain('Implemented');
    expect((report.git as { commits: unknown[] }).commits).toHaveLength(1);
    expect(report.merged).toBe(false);

    const events = await listTaskEvents(ctx.db, taskId, { limit: 100 });
    const types = events.map((e) => e.type);
    for (const expected of ['TASK_CREATED', 'REPOSITORY_PREPARING', 'CLAUDE_STARTED', 'CLAUDE_FINISHED', 'PUSHED', 'PR_OPENED', 'COMPLETED']) {
      expect(types).toContain(expected);
    }
  });

  it('continues the SAME session, pushes to the same branch, reuses the same PR', async () => {
    const before = await getTask(ctx.db, taskId);
    ctx.claude.setBehavior(async (options) => {
      expect(options.resumeSessionId).toBe('sess-pipeline-1');
      expect(options.prompt).toContain('Continuation');
      expect(options.prompt).toContain('fix the review findings');
      const cwd = options.cwd!;
      await fs.writeFile(path.join(cwd, 'fix2.js'), 'console.log("follow-up");\n');
      await runGit(['-C', cwd, 'add', '--all']);
      await runGit(['-C', cwd, 'commit', '--no-verify', '-m', 'fix: address review findings']);
      return successResult({ sessionId: 'sess-pipeline-1' });
    });

    await continueTask(ctx.taskDeps, {
      taskId,
      instruction: 'fix the review findings and update the PR',
      idempotencyKey: 'pipeline-cont-1',
    });
    await claimAndRun();

    const after = await getTask(ctx.db, taskId);
    expect(after?.status).toBe('COMPLETED');
    expect(after?.headShaAfter).not.toBe(before?.headShaAfter);
    expect(after?.prNumber).toBe(before?.prNumber);
    const prs = [...ctx.github.prs.values()].filter((p) => p.headRef === after?.workingBranch);
    expect(prs.length).toBe(1);
    expect(ctx.claude.calls.at(-1)?.resumeSessionId).toBe('sess-pipeline-1');
  });

  it('fast-forwards safely when the remote gained commits before a continuation', async () => {
    const task = await getTask(ctx.db, taskId);
    const externalSha = await addRemoteCommit(barePath, task!.workingBranch!, 'external.txt', 'reviewer tweak\n');

    ctx.claude.setBehavior(async (options) => {
      // The workspace must have been fast-forwarded to include the external commit.
      const head = (await runGit(['-C', options.cwd!, 'rev-parse', 'HEAD'])).stdout.trim();
      expect(head).toBe(externalSha);
      return successResult({ sessionId: 'sess-pipeline-1' });
    });
    await continueTask(ctx.taskDeps, {
      taskId,
      instruction: 'verify nothing broke after the reviewer tweak',
      idempotencyKey: 'pipeline-cont-2',
    });
    await claimAndRun();
    const after = await getTask(ctx.db, taskId);
    expect(after?.status).toBe('COMPLETED');
  });

  it('halts with EXPECTED_HEAD_MISMATCH (WAITING) when the remote branch diverged', async () => {
    const task = await getTask(ctx.db, taskId);
    await divergeRemoteBranch(barePath, task!.workingBranch!);

    ctx.claude.setBehavior(async () => {
      throw new Error('Claude must not run when the branch diverged');
    });
    await continueTask(ctx.taskDeps, {
      taskId,
      instruction: 'this must not run',
      idempotencyKey: 'pipeline-cont-3',
    });
    await claimAndRun();

    const after = await getTask(ctx.db, taskId);
    expect(after?.status).toBe('WAITING');
    expect(after?.attentionRequired).toBe(true);
    expect(after?.attentionReason).toContain('diverged');
  });
});

describe('permission enforcement in the pipeline', () => {
  it('does not push when allowPush=false, and reports it', async () => {
    await ctx.registerRepo('no-push-repo');
    ctx.claude.setBehavior(async (options) => {
      const cwd = options.cwd!;
      await fs.writeFile(path.join(cwd, 'change.txt'), 'local only\n');
      await runGit(['-C', cwd, 'add', '--all']);
      await runGit(['-C', cwd, 'commit', '--no-verify', '-m', 'local change']);
      return successResult({ sessionId: 'sess-nopush' });
    });
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'no-push-repo',
      objective: 'make a local-only change',
      permissions: { allowPush: false, allowOpenPr: false, allowUpdatePr: false },
    });
    await claimAndRun();
    const done = await getTask(ctx.db, task.id);
    expect(done?.status).toBe('COMPLETED');
    expect(done?.headShaAfter).toBeNull();
    expect(await remoteBranchHead(ctx.remotes.get('no-push-repo')!, task.workingBranch!)).toBeNull();
    expect((done?.metadata.bridgeBlockers as string[])[0]).toContain('allowPush=false');
  });

  it('runs read-only Claude when allowCodeChanges=false', async () => {
    await ctx.registerRepo('read-only-repo');
    ctx.claude.setBehavior(async (options) => {
      expect(options.mode).toBe('read');
      return successResult({ sessionId: 'sess-ro' });
    });
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'read-only-repo',
      objective: 'inspect only',
      permissions: {
        allowCodeChanges: false,
        allowCommit: false,
        allowPush: false,
        allowOpenPr: false,
        allowUpdatePr: false,
      },
    });
    await claimAndRun();
    const done = await getTask(ctx.db, task.id);
    expect(done?.status).toBe('COMPLETED');
  });
});

describe('failure, malformed output, cancellation, timeout', () => {
  it('marks the task FAILED when Claude errors, preserving the session for continuation', async () => {
    await ctx.registerRepo('fail-repo');
    ctx.claude.setBehavior(async () => ({
      ok: false,
      subtype: 'error_max_turns',
      finalText: '',
      structuredOutput: null,
      sessionId: 'sess-fail-1',
      model: 'claude-sonnet-5',
      totalCostUsd: 0.1,
      numTurns: 5,
      permissionDenialCount: 0,
      errorMessage: 'hit the turn limit',
    }));
    const { task } = await startRepoTask(ctx.taskDeps, { repository: 'fail-repo', objective: 'will fail' });
    await claimAndRun();
    const done = await getTask(ctx.db, task.id);
    expect(done?.status).toBe('FAILED');
    expect(done?.errorCode).toBe('CLAUDE_EXECUTION_FAILED');
    expect(done?.claudeSessionId).toBe('sess-fail-1');
  });

  it('completes with preserved raw output when the report is malformed', async () => {
    await ctx.registerRepo('malformed-repo');
    ctx.claude.setBehavior(async () =>
      successResult({
        structuredOutput: { not: 'a report' },
        finalText: 'I did things but produced no valid JSON report.',
        sessionId: 'sess-malformed',
      }),
    );
    const { task } = await startRepoTask(ctx.taskDeps, { repository: 'malformed-repo', objective: 'malformed report' });
    await claimAndRun();
    const done = await getTask(ctx.db, task.id);
    expect(done?.status).toBe('COMPLETED');
    expect(done?.reportParseError).toBeTruthy();
    expect(done?.rawFinalResponse).toContain('no valid JSON report');
    const report = await getTaskReport(ctx.taskDeps, task.id);
    expect(report.rawFinalResponse).toContain('no valid JSON report');
  });

  it('cancels a running task via CANCEL_REQUESTED → CANCELLED', async () => {
    await ctx.registerRepo('cancel-repo');
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    ctx.claude.setBehavior(
      (options) =>
        new Promise((_resolve, reject) => {
          started?.();
          options.abortSignal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const { task } = await startRepoTask(ctx.taskDeps, { repository: 'cancel-repo', objective: 'long task' });
    const claimed = await claimNextTask(ctx.db, ctx.config.workerId, ctx.config.leaseSeconds);
    const execution = executeTask(ctx.workerDeps, claimed!);
    await startedPromise;
    await updateTaskWhereStatus(ctx.db, task.id, ['PREPARING', 'RUNNING'], {
      status: 'CANCEL_REQUESTED',
      cancelRequestedAt: new Date(),
    });
    await execution;
    const done = await getTask(ctx.db, task.id);
    expect(done?.status).toBe('CANCELLED');
  }, 30000);

  it('fails with CLAUDE_TIMEOUT when the run exceeds the task timeout', async () => {
    const shortCtxOverrides = ctx.config as { taskTimeoutMs: number };
    const original = shortCtxOverrides.taskTimeoutMs;
    shortCtxOverrides.taskTimeoutMs = 1500;
    try {
      await ctx.registerRepo('timeout-repo');
      ctx.claude.setBehavior(() => new Promise(() => undefined));
      const { task } = await startRepoTask(ctx.taskDeps, { repository: 'timeout-repo', objective: 'hangs' });
      await claimAndRun();
      const done = await getTask(ctx.db, task.id);
      expect(done?.status).toBe('FAILED');
      expect(done?.errorCode).toBe('CLAUDE_TIMEOUT');
    } finally {
      shortCtxOverrides.taskTimeoutMs = original;
    }
  }, 30000);
});

describe('concurrency and reconciliation', () => {
  it('respects per-repository concurrency at claim time', async () => {
    await ctx.registerRepo('serial-repo', { concurrencyLimit: 1 });
    await startRepoTask(ctx.taskDeps, { repository: 'serial-repo', objective: 'first', targetBranch: 'work/a' });
    await startRepoTask(ctx.taskDeps, { repository: 'serial-repo', objective: 'second', targetBranch: 'work/b' });

    const first = await claimNextTask(ctx.db, 'worker-A', ctx.config.leaseSeconds);
    expect(first).not.toBeNull();
    // While the first is PREPARING, the same repo must not admit another task.
    const second = await claimNextTask(ctx.db, 'worker-B', ctx.config.leaseSeconds);
    expect(second).toBeNull();
    // Finish the first; the second becomes claimable.
    await updateTaskWhereStatus(ctx.db, first!.id, ['PREPARING'], { status: 'COMPLETED', completedAt: new Date() });
    const third = await claimNextTask(ctx.db, 'worker-B', ctx.config.leaseSeconds);
    expect(third).not.toBeNull();
    await updateTaskWhereStatus(ctx.db, third!.id, ['PREPARING'], { status: 'COMPLETED', completedAt: new Date() });
  });

  it('requeues PREPARING tasks and fails RUNNING tasks after worker loss', async () => {
    await ctx.registerRepo('reconcile-repo');
    const { task: prepTask } = await startRepoTask(ctx.taskDeps, {
      repository: 'reconcile-repo',
      objective: 'lost while preparing',
      targetBranch: 'work/prep',
    });
    const { task: runTask } = await startRepoTask(ctx.taskDeps, {
      repository: 'reconcile-repo',
      objective: 'lost while running',
      targetBranch: 'work/run',
    });
    // Simulate a dead worker: states with already-expired leases.
    await ctx.db.query(
      `UPDATE claude_tasks SET status='PREPARING', claimed_by='dead', lease_expires_at=now() - interval '1 minute', attempt_count=1 WHERE id=$1`,
      [prepTask.id],
    );
    await ctx.db.query(
      `UPDATE claude_tasks SET status='RUNNING', claimed_by='dead', claude_started=TRUE, claude_session_id='sess-lost', lease_expires_at=now() - interval '1 minute', attempt_count=1 WHERE id=$1`,
      [runTask.id],
    );

    const result = await reconcile(ctx.db, ctx.config, ctx.logger);
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const prep = await getTask(ctx.db, prepTask.id);
    expect(prep?.status).toBe('QUEUED');
    const run = await getTask(ctx.db, runTask.id);
    expect(run?.status).toBe('FAILED');
    expect(run?.errorCode).toBe('WORKER_LOST');
    // The lost-but-started session remains continuable.
    expect(run?.claudeSessionId).toBe('sess-lost');

    // Drain the requeued task so later tests claim their own work.
    await updateTaskWhereStatus(ctx.db, prepTask.id, ['QUEUED'], {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      completedAt: new Date(),
    });
  });
});

describe('analysis tasks', () => {
  it('runs a general ask with no repository and no tools', async () => {
    ctx.claude.setBehavior(async (options) => {
      expect(options.mode).toBe('reason');
      expect(options.cwd).toBeUndefined();
      return successResult({
        sessionId: 'sess-ask',
        structuredOutput: {
          summary: 'The architecture is sound.',
          outcome: 'success',
          findings: [{ severity: 'medium', title: 'Single point of failure in queue design' }],
          blockers: [],
        },
      });
    });
    const { task } = await askClaude(ctx.taskDeps, { prompt: 'Is this architecture stupid?' });
    await claimAndRun();
    const report = await getTaskReport(ctx.taskDeps, task.id);
    expect(report.status).toBe('COMPLETED');
    const claudeReport = report.claudeReport as { findings: { title: string }[] };
    expect(claudeReport.findings[0]?.title).toContain('Single point of failure');
  });

  it('analyzes a branch read-only with a bridge-computed diff in the prompt', async () => {
    const { barePath: analysisBare } = await ctx.registerRepo('analysis-repo');
    await addRemoteCommit(analysisBare, 'main', 'unchanged.txt', 'base file\n');
    // Create a feature branch with a change on the remote.
    const work = `${analysisBare}-feature-setup`;
    await runGit(['clone', '--', analysisBare, work]);
    await runGit(['-C', work, 'config', 'user.email', 't@t']);
    await runGit(['-C', work, 'config', 'user.name', 't']);
    await runGit(['-C', work, 'checkout', '-b', 'feature/risky']);
    await fs.writeFile(path.join(work, 'risky.js'), 'eval(userInput);\n');
    await runGit(['-C', work, 'add', '--all']);
    await runGit(['-C', work, 'commit', '--no-verify', '-m', 'add risky code']);
    await runGit(['-C', work, 'push', 'origin', 'feature/risky:feature/risky']);
    await fs.rm(work, { recursive: true, force: true });

    ctx.claude.setBehavior(async (options) => {
      expect(options.mode).toBe('read');
      expect(options.prompt).toContain('READ-ONLY');
      expect(options.prompt).toContain('risky.js');
      return successResult({
        sessionId: 'sess-analysis',
        structuredOutput: {
          summary: 'Found an injection risk.',
          outcome: 'success',
          findings: [
            { severity: 'critical', title: 'eval of user input', file: 'risky.js', line: 1, recommendation: 'Remove eval' },
          ],
          blockers: [],
        },
      });
    });
    const { task } = await askClaude(ctx.taskDeps, {
      prompt: 'Review this branch for security issues',
      repository: 'analysis-repo',
      branch: 'feature/risky',
    });
    await claimAndRun();
    const done = await getTask(ctx.db, task.id);
    expect(done?.status).toBe('COMPLETED');
    // Analysis never touches GitHub.
    expect([...ctx.github.prs.values()].filter((p) => p.headRef === 'feature/risky')).toHaveLength(0);
    expect(await remoteBranchHead(analysisBare, 'feature/risky')).toBeTruthy();
  });

  it('fails cleanly when the analyzed branch does not exist', async () => {
    const { task } = await askClaude(ctx.taskDeps, {
      prompt: 'Review missing branch',
      repository: 'analysis-repo',
      branch: 'does/not-exist',
    });
    await claimAndRun();
    const done = await getTask(ctx.db, task.id);
    expect(done?.status).toBe('FAILED');
    expect(done?.errorCode).toBe('BRANCH_NOT_FOUND');
  });
});
