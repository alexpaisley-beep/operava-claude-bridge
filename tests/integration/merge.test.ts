import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTask, updateTaskWhereStatus } from '../../src/db/tasks.js';
import { BridgeError } from '../../src/errors.js';
import { mergeTaskPr, startRepoTask } from '../../src/services/task-service.js';
import { createTestContext, type TestContext } from '../helpers/test-env.js';

let ctx: TestContext;
const HEAD = 'f'.repeat(40);

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.registerRepo('merge-repo', { allowMerge: true });
  await ctx.registerRepo('no-merge-repo', { allowMerge: false });
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

/** Create a COMPLETED task with an open PR at HEAD, ready to merge. */
async function completedTaskWithPr(repoKey: string, branch: string, opts: { allowMerge?: boolean; blockers?: string[] } = {}) {
  const { task } = await startRepoTask(ctx.taskDeps, {
    repository: repoKey,
    objective: `merge test on ${branch}`,
    targetBranch: branch,
    permissions: opts.allowMerge !== undefined ? { allowMerge: opts.allowMerge } : {},
  });
  ctx.github.setBranchHead('testorg', repoKey, branch, HEAD);
  const pr = await ctx.github.createPullRequest('testorg', repoKey, {
    title: 'merge test',
    body: '',
    head: branch,
    base: 'main',
  });
  await updateTaskWhereStatus(ctx.db, task.id, ['QUEUED'], {
    status: 'COMPLETED',
    completedAt: new Date(),
    claudeSessionId: 'sess-merge',
    prNumber: pr.number,
    prUrl: pr.url,
    headShaAfter: HEAD,
    expectedHeadSha: HEAD,
    resultReport: {
      summary: 'done',
      outcome: 'success',
      filesChanged: [],
      commits: [],
      tests: [{ command: 'npm test', status: 'passed' }],
      findings: [],
      blockers: opts.blockers ?? [],
    },
  });
  return { task, pr };
}

describe('merge_task_pr guards', () => {
  it('refuses when the repository registry disallows merging', async () => {
    const { task } = await completedTaskWithPr('no-merge-repo', 'merge/denied');
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true }),
      'PERMISSION_DENIED',
    );
  });

  it('requires task allowMerge or explicit authorizeMerge', async () => {
    const { task } = await completedTaskWithPr('merge-repo', 'merge/auth');
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD }),
      'PERMISSION_DENIED',
    );
    const result = await mergeTaskPr(ctx.taskDeps, {
      taskId: task.id,
      expectedHeadSha: HEAD,
      authorizeMerge: true,
    });
    expect(result.merged).toBe(true);
    expect(result.mergeSha).toBeTruthy();
    const stored = await getTask(ctx.db, task.id);
    expect(stored?.merged).toBe(true);
  });

  it('is idempotent once merged', async () => {
    const { task } = await completedTaskWithPr('merge-repo', 'merge/idem');
    await mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true });
    const again = await mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true });
    expect(again.alreadyMerged).toBe(true);
  });

  it('refuses non-COMPLETED tasks', async () => {
    const { task } = await startRepoTask(ctx.taskDeps, {
      repository: 'merge-repo',
      objective: 'still queued',
      targetBranch: 'merge/queued',
    });
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true }),
      'TASK_ALREADY_RUNNING',
    );
  });

  it('enforces expected-head match against the recorded verification sha', async () => {
    const { task } = await completedTaskWithPr('merge-repo', 'merge/wrong-expected');
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: 'a'.repeat(40), authorizeMerge: true }),
      'EXPECTED_HEAD_MISMATCH',
    );
  });

  it('detects live PR head drift, flags the task WAITING, and refuses', async () => {
    const { task, pr } = await completedTaskWithPr('merge-repo', 'merge/drift');
    // Someone pushes after verification: the live PR head moves.
    const stored = ctx.github.prs.get(`testorg/merge-repo#${pr.number}`)!;
    stored.headSha = 'd'.repeat(40);
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true }),
      'EXPECTED_HEAD_MISMATCH',
    );
    const flagged = await getTask(ctx.db, task.id);
    expect(flagged?.status).toBe('WAITING');
    expect(flagged?.attentionRequired).toBe(true);
  });

  it('blocks on failing or pending CI', async () => {
    const { task } = await completedTaskWithPr('merge-repo', 'merge/red-ci');
    ctx.github.setChecks('testorg', 'merge-repo', HEAD, {
      state: 'failure',
      total: 3,
      failing: ['unit-tests'],
      pending: [],
    });
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true }),
      'MERGE_BLOCKED',
    );
    ctx.github.setChecks('testorg', 'merge-repo', HEAD, {
      state: 'pending',
      total: 3,
      failing: [],
      pending: ['unit-tests'],
    });
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true }),
      'MERGE_BLOCKED',
    );
    // Green CI unblocks.
    ctx.github.setChecks('testorg', 'merge-repo', HEAD, { state: 'success', total: 3, failing: [], pending: [] });
    const result = await mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true });
    expect(result.merged).toBe(true);
  });

  it('blocks on unresolved review threads', async () => {
    const { task, pr } = await completedTaskWithPr('merge-repo', 'merge/threads');
    ctx.github.unresolvedThreads.set(`testorg/merge-repo#${pr.number}`, 2);
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true }),
      'MERGE_BLOCKED',
    );
  });

  it('blocks on unresolved blockers in the Claude report', async () => {
    const { task } = await completedTaskWithPr('merge-repo', 'merge/blockers', {
      blockers: ['migration not applied'],
    });
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true }),
      'MERGE_BLOCKED',
    );
  });

  it('refuses when the PR is not mergeable', async () => {
    const { task, pr } = await completedTaskWithPr('merge-repo', 'merge/conflicted');
    const stored = ctx.github.prs.get(`testorg/merge-repo#${pr.number}`)!;
    stored.mergeable = false;
    await expectBridgeError(
      mergeTaskPr(ctx.taskDeps, { taskId: task.id, expectedHeadSha: HEAD, authorizeMerge: true }),
      'MERGE_BLOCKED',
    );
  });
});
