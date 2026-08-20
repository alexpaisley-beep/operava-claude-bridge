import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimNextWorkflowRun, getWorkflowRun } from '../../src/db/workflow-runs.js';
import { BridgeError } from '../../src/errors.js';
import {
  cancelWorkflowRun,
  getWorkflowRunView,
  listWorkflowsForRepository,
  runWorkflow,
} from '../../src/services/workflow-service.js';
import { executeWorkflowRun } from '../../src/worker/workflow-execution.js';
import { WorkflowRegistry, BUILTIN_WORKFLOWS } from '../../src/workflows/registry.js';
import { createTestContext, type TestContext } from '../helpers/test-env.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.registerRepo('wf-repo');
  await ctx.registerRepo('no-wf-repo', { workflows: [] });
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

async function claimAndRunWorkflow(expectedRunId: string): Promise<void> {
  const claimed = await claimNextWorkflowRun(ctx.db, ctx.config.workerId, ctx.config.leaseSeconds);
  expect(claimed?.id).toBe(expectedRunId);
  await executeWorkflowRun(ctx.workerDeps, claimed!);
}

describe('workflow service validation', () => {
  it('lists workflows only where both sides opt in', async () => {
    const enabled = await listWorkflowsForRepository(ctx.wfDeps, 'wf-repo');
    expect(enabled.map((w) => w.name)).toContain('echo-check');
    const disabled = await listWorkflowsForRepository(ctx.wfDeps, 'no-wf-repo');
    expect(disabled).toHaveLength(0);
  });

  it('refuses unknown and not-enabled workflows and bad parameters', async () => {
    await expectBridgeError(
      runWorkflow(ctx.wfDeps, { repository: 'wf-repo', workflow: 'nope' }),
      'WORKFLOW_NOT_FOUND',
    );
    await expectBridgeError(
      runWorkflow(ctx.wfDeps, { repository: 'no-wf-repo', workflow: 'echo-check' }),
      'WORKFLOW_NOT_ALLOWED',
    );
    await expectBridgeError(
      runWorkflow(ctx.wfDeps, {
        repository: 'wf-repo',
        workflow: 'echo-check',
        parameters: { evil: 'x' },
      }),
      'VALIDATION_ERROR',
    );
    await expectBridgeError(
      runWorkflow(ctx.wfDeps, { repository: 'missing', workflow: 'echo-check' }),
      'REPOSITORY_NOT_FOUND',
    );
  });

  it('is idempotent on the same key and rejects conflicting reuse', async () => {
    const first = await runWorkflow(ctx.wfDeps, {
      repository: 'wf-repo',
      workflow: 'echo-check',
      idempotencyKey: 'wf-idem-1',
    });
    const replay = await runWorkflow(ctx.wfDeps, {
      repository: 'wf-repo',
      workflow: 'echo-check',
      idempotencyKey: 'wf-idem-1',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.run.id).toBe(first.run.id);
    await expectBridgeError(
      runWorkflow(ctx.wfDeps, {
        repository: 'wf-repo',
        workflow: 'echo-check',
        parameters: { note: 'different' },
        idempotencyKey: 'wf-idem-1',
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    // Drain the queued run so later tests claim their own work.
    await cancelWorkflowRun(ctx.wfDeps, first.run.id);
  });
});

describe('workflow execution', () => {
  it('runs echo-check successfully with structured findings', async () => {
    const { run } = await runWorkflow(ctx.wfDeps, {
      repository: 'wf-repo',
      workflow: 'echo-check',
      branch: 'main',
      parameters: { note: 'hello from the test' },
    });
    await claimAndRunWorkflow(run.id);
    const view = await getWorkflowRunView(ctx.wfDeps, run.id);
    expect(view.status).toBe('COMPLETED');
    expect(view.exitCode).toBe(0);
    expect(view.headSha).toBeTruthy();
    const findings = view.findings as { title: string; rationale?: string }[];
    expect(findings.some((f) => f.rationale === 'hello from the test')).toBe(true);
    expect(String(view.outputSummary)).toContain('echo-check completed on main');
  });

  it('marks non-zero exits as FAILED with WORKFLOW_FAILED', async () => {
    const { run } = await runWorkflow(ctx.wfDeps, {
      repository: 'wf-repo',
      workflow: 'echo-check',
      parameters: { fail: 'true' },
    });
    await claimAndRunWorkflow(run.id);
    const view = await getWorkflowRunView(ctx.wfDeps, run.id);
    expect(view.status).toBe('FAILED');
    expect(view.exitCode).toBe(2);
    expect((view.error as { code: string }).code).toBe('WORKFLOW_FAILED');
  });

  it('fails with BRANCH_NOT_FOUND for a missing branch', async () => {
    const { run } = await runWorkflow(ctx.wfDeps, {
      repository: 'wf-repo',
      workflow: 'echo-check',
      branch: 'missing/branch',
    });
    await claimAndRunWorkflow(run.id);
    const view = await getWorkflowRunView(ctx.wfDeps, run.id);
    expect(view.status).toBe('FAILED');
    expect((view.error as { code: string }).code).toBe('BRANCH_NOT_FOUND');
  });

  it('enforces the workflow timeout', async () => {
    // Same echo-check but with a 1-second timeout via a test-scoped registry.
    const shortEcho = {
      ...BUILTIN_WORKFLOWS[0]!,
      timeoutMs: 1000,
    };
    const shortRegistry = new WorkflowRegistry([shortEcho]);
    const wfDeps = { ...ctx.wfDeps, workflows: shortRegistry };
    const workerDeps = { ...ctx.workerDeps, workflows: shortRegistry };
    const { run } = await runWorkflow(wfDeps, {
      repository: 'wf-repo',
      workflow: 'echo-check',
      parameters: { sleep_ms: '30000' },
    });
    const claimed = await claimNextWorkflowRun(ctx.db, ctx.config.workerId, ctx.config.leaseSeconds);
    expect(claimed?.id).toBe(run.id);
    await executeWorkflowRun(workerDeps, claimed!);
    const view = await getWorkflowRunView(ctx.wfDeps, run.id);
    expect(view.status).toBe('FAILED');
    expect((view.error as { code: string }).code).toBe('WORKFLOW_TIMEOUT');
  }, 30000);

  it('cancels a queued run immediately and is idempotent', async () => {
    const { run } = await runWorkflow(ctx.wfDeps, {
      repository: 'wf-repo',
      workflow: 'echo-check',
    });
    const first = await cancelWorkflowRun(ctx.wfDeps, run.id);
    expect(first.status).toBe('CANCELLED');
    const second = await cancelWorkflowRun(ctx.wfDeps, run.id);
    expect(second.alreadyFinal).toBe(true);
    const stored = await getWorkflowRun(ctx.db, run.id);
    expect(stored?.status).toBe('CANCELLED');
  });
});
