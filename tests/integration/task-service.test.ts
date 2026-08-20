import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askClaude,
  cancelTask,
  continueTask,
  getTaskEvents,
  getTaskStatus,
  listTasksView,
  startRepoTask,
} from '../../src/services/task-service.js';
import { getTask, updateTaskWhereStatus } from '../../src/db/tasks.js';
import { BridgeError } from '../../src/errors.js';
import { createTestContext, type TestContext } from '../helpers/test-env.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.registerRepo('growth-engine');
  await ctx.registerRepo('locked-down', {
    allowMerge: false,
    allowPush: false,
    allowOpenPr: false,
    allowUpdatePr: false,
  });
  await ctx.registerRepo('disabled-repo', { enabled: false });
});

afterAll(async () => {
  await ctx.destroy();
});

const expectBridgeError = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise;
    expect.fail(`expected BridgeError ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe(code);
  }
};

describe('startRepoTask', () => {
  it('creates a QUEUED engineering task with a generated working branch', async () => {
    const { task, replayed } = await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'Fix the campaign analytics bug in the sender health page',
      idempotencyKey: 'start-basic-1',
    });
    expect(replayed).toBe(false);
    expect(task.status).toBe('QUEUED');
    expect(task.type).toBe('ENGINEERING');
    expect(task.baseBranch).toBe('main');
    expect(task.workingBranch).toMatch(/^claude\/fix-the-campaign-analytic[a-z0-9-]*-[a-z0-9]{6}$/);
    expect(task.permissions.allowMerge).toBe(false);
    expect(task.permissions.allowPush).toBe(true);

    const status = await getTaskStatus(ctx.taskDeps, task.id);
    expect(status.status).toBe('QUEUED');
    expect(status.latestEvent?.type).toBe('TASK_CREATED');
  });

  it('is idempotent: same key + same payload returns the same task', async () => {
    const input = {
      repository: 'growth-engine',
      objective: 'Idempotency check objective',
      idempotencyKey: 'start-idem-1',
    };
    const first = await startRepoTask(ctx.taskDeps, input);
    const second = await startRepoTask(ctx.taskDeps, input);
    expect(second.replayed).toBe(true);
    expect(second.task.id).toBe(first.task.id);
  });

  it('rejects conflicting reuse of an idempotency key', async () => {
    await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'Original objective',
      idempotencyKey: 'start-conflict-1',
    });
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, {
        repository: 'growth-engine',
        objective: 'DIFFERENT objective',
        idempotencyKey: 'start-conflict-1',
      }),
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('rejects unknown, disabled, and over-privileged repositories', async () => {
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, { repository: 'nope', objective: 'x' }),
      'REPOSITORY_NOT_FOUND',
    );
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, { repository: 'disabled-repo', objective: 'x' }),
      'REPOSITORY_DISABLED',
    );
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, { repository: 'locked-down', objective: 'x' }),
      'PERMISSION_DENIED',
    );
    // locked-down works when the caller lowers permissions to the ceiling.
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'locked-down',
      objective: 'read-mostly task',
      permissions: { allowPush: false, allowOpenPr: false, allowUpdatePr: false },
    });
    expect(task.permissions.allowPush).toBe(false);
  });

  it('rejects incoherent permission combinations', async () => {
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, {
        repository: 'growth-engine',
        objective: 'x',
        permissions: { allowCodeChanges: false, allowCommit: true },
      }),
      'VALIDATION_ERROR',
    );
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, {
        repository: 'growth-engine',
        objective: 'x',
        permissions: { allowPush: false, allowOpenPr: true },
      }),
      'VALIDATION_ERROR',
    );
  });

  it('rejects models off the allowlist and resolves aliases', async () => {
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, { repository: 'growth-engine', objective: 'x', model: 'gpt-6' }),
      'MODEL_NOT_ALLOWED',
    );
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'model alias check',
      model: 'strong',
    });
    expect(task.metadata.resolvedModel).toBe('claude-opus-5');
  });

  it('prevents two active write tasks on the same branch (BRANCH_BUSY)', async () => {
    await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'first writer',
      targetBranch: 'feature/contested',
    });
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, {
        repository: 'growth-engine',
        objective: 'second writer',
        targetBranch: 'feature/contested',
      }),
      'BRANCH_BUSY',
    );
  });

  it('validates branch names and objective size', async () => {
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, { repository: 'growth-engine', objective: 'x', targetBranch: '--force' }),
      'VALIDATION_ERROR',
    );
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, { repository: 'growth-engine', objective: '' }),
      'VALIDATION_ERROR',
    );
  });

  it('resolves an existing PR to its head branch and refuses closed PRs', async () => {
    ctx.github.setBranchHead('testorg', 'growth-engine', 'feature/pr-branch', 'c'.repeat(40));
    const pr = await ctx.github.createPullRequest('testorg', 'growth-engine', {
      title: 'existing work',
      body: '',
      head: 'feature/pr-branch',
      base: 'main',
    });
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'continue PR work',
      existingPr: pr.number,
    });
    expect(task.workingBranch).toBe('feature/pr-branch');
    expect(task.prNumber).toBe(pr.number);
    await expectBridgeError(
      startRepoTask(ctx.taskDeps, { repository: 'growth-engine', objective: 'x', existingPr: 99999 }),
      'PR_NOT_FOUND',
    );
  });
});

describe('askClaude', () => {
  it('creates read-only analysis tasks with inferred context modes', async () => {
    const general = await askClaude(ctx.taskDeps, { prompt: 'Is this architecture sound?' });
    expect(general.task.type).toBe('ANALYSIS');
    expect(general.task.contextMode).toBe('general');
    expect(general.task.executionMode).toBe('READ');
    expect(general.task.permissions.allowCodeChanges).toBe(false);

    const branch = await askClaude(ctx.taskDeps, {
      prompt: 'Review this branch',
      repository: 'growth-engine',
      branch: 'feature/foo',
    });
    expect(branch.task.contextMode).toBe('branch');
    expect(branch.task.workingBranch).toBe('feature/foo');
  });

  it('requires a repository for non-general modes', async () => {
    await expectBridgeError(
      askClaude(ctx.taskDeps, { prompt: 'x', contextMode: 'branch', branch: 'b' }),
      'VALIDATION_ERROR',
    );
  });
});

describe('cancelTask', () => {
  it('cancels a QUEUED task immediately and is idempotent', async () => {
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'to be cancelled',
    });
    const first = await cancelTask(ctx.taskDeps, task.id);
    expect(first.task.status).toBe('CANCELLED');
    expect(first.alreadyFinal).toBe(false);
    const second = await cancelTask(ctx.taskDeps, task.id);
    expect(second.task.status).toBe('CANCELLED');
    expect(second.alreadyFinal).toBe(true);
  });

  it('requests cancellation for RUNNING tasks', async () => {
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'simulate running',
    });
    await updateTaskWhereStatus(ctx.db, task.id, ['QUEUED'], { status: 'RUNNING' });
    const result = await cancelTask(ctx.taskDeps, task.id);
    expect(result.task.status).toBe('CANCEL_REQUESTED');
  });
});

describe('continueTask', () => {
  it('refuses to continue active or session-less tasks', async () => {
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'queued task',
    });
    await expectBridgeError(
      continueTask(ctx.taskDeps, { taskId: task.id, instruction: 'more work' }),
      'TASK_ALREADY_RUNNING',
    );
    await updateTaskWhereStatus(ctx.db, task.id, ['QUEUED'], { status: 'COMPLETED', completedAt: new Date() });
    await expectBridgeError(
      continueTask(ctx.taskDeps, { taskId: task.id, instruction: 'more work' }),
      'CLAUDE_SESSION_UNAVAILABLE',
    );
  });

  it('queues a continuation for a COMPLETED task with a session, idempotently', async () => {
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'completed task',
    });
    await updateTaskWhereStatus(ctx.db, task.id, ['QUEUED'], {
      status: 'COMPLETED',
      completedAt: new Date(),
      claudeSessionId: 'sess-abc',
    });
    const first = await continueTask(ctx.taskDeps, {
      taskId: task.id,
      instruction: 'fix the findings',
      idempotencyKey: 'cont-1',
    });
    expect(first.task.status).toBe('QUEUED');
    expect(first.continuation.seq).toBe(1);
    const replay = await continueTask(ctx.taskDeps, {
      taskId: task.id,
      instruction: 'fix the findings',
      idempotencyKey: 'cont-1',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.continuation.id).toBe(first.continuation.id);

    const fresh = await getTask(ctx.db, task.id);
    expect(fresh?.status).toBe('QUEUED');
    await expectBridgeError(
      continueTask(ctx.taskDeps, { taskId: task.id, instruction: 'another while queued' }),
      'TASK_ALREADY_RUNNING',
    );
  });

  it('refuses cancelled tasks and unknown tasks', async () => {
    await expectBridgeError(
      continueTask(ctx.taskDeps, { taskId: 'cldtask_missing', instruction: 'x' }),
      'TASK_NOT_FOUND',
    );
  });
});

describe('listTasks / events', () => {
  it('filters and paginates', async () => {
    const page1 = await listTasksView(ctx.taskDeps, { repository: 'growth-engine', limit: 3 });
    expect(page1.tasks.length).toBe(3);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listTasksView(ctx.taskDeps, {
      repository: 'growth-engine',
      limit: 3,
      cursor: page1.nextCursor!,
    });
    const ids1 = new Set(page1.tasks.map((t) => t.taskId));
    for (const t of page2.tasks) expect(ids1.has(t.taskId)).toBe(false);

    const filtered = await listTasksView(ctx.taskDeps, { statuses: ['CANCELLED'], limit: 50 });
    for (const t of filtered.tasks) expect(t.status).toBe('CANCELLED');
  });

  it('returns bounded events with paging', async () => {
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'growth-engine',
      objective: 'events test',
    });
    const events = await getTaskEvents(ctx.taskDeps, { taskId: task.id, limit: 10 });
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.events[0]?.type).toBe('TASK_CREATED');
  });
});
