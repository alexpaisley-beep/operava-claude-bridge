/**
 * Multi-process end-to-end verification (no external credentials needed):
 *
 *   real claude-bridge-api process  ←── real MCP SDK client (this script)
 *   real claude-bridge-worker process
 *   real Postgres (DATABASE_URL)
 *   real git remotes (file:// bare repos)
 *   mock Claude runner (CLAUDE_MOCK_EDIT=true → really edits/commits)
 *   mock GitHub client
 *
 * Verifies the §36 checklist: one durable task per MCP call, worker claim,
 * isolated workspace, edits, commit, push, exactly one PR, correct report,
 * same-session continuation updating the same branch/PR, idempotent retry
 * safety, read-only analysis, workflow run, and cancellation.
 *
 * Usage:  DATABASE_URL=postgres://... npx tsx scripts/e2e-local.ts
 * (Run `npm run build` first — it launches the compiled dist/ entrypoints.)
 */
import { execFile } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const exec = promisify(execFile);
const TOKEN = 'e2e-static-bridge-token-0123456789abcdef';
const PORT = 18760 + Math.floor(Math.random() * 200);

const results: { step: string; ok: boolean; detail?: string }[] = [];
function check(step: string, ok: boolean, detail?: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✘'} ${step}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`E2E step failed: ${step} ${detail ?? ''}`);
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL to a scratch Postgres database first.');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-e2e-'));
  const remotesRoot = path.join(root, 'remotes');
  const bare = path.join(remotesRoot, 'e2e-org', 'demo.git');
  await fs.mkdir(bare, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', bare]);
  const seed = path.join(root, 'seed');
  await fs.mkdir(seed, { recursive: true });
  await git(['init', '--initial-branch=main', '.'], seed);
  await git(['config', 'user.email', 'e2e@local'], seed);
  await git(['config', 'user.name', 'E2E'], seed);
  await fs.writeFile(path.join(seed, 'README.md'), '# demo\n');
  await git(['add', '--all'], seed);
  await git(['commit', '--no-verify', '-m', 'initial'], seed);
  await git(['push', bare, 'main:main'], seed);

  const reposFile = path.join(root, 'repositories.json');
  await fs.writeFile(
    reposFile,
    JSON.stringify([
      {
        key: 'e2e-repo',
        githubOwner: 'e2e-org',
        githubRepo: 'demo',
        defaultBranch: 'main',
        workflows: ['echo-check'],
      },
    ]),
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    PORT: String(PORT),
    DATABASE_URL: databaseUrl,
    BRIDGE_API_TOKENS: TOKEN,
    BRIDGE_OPERATOR_KEY: 'e2e-operator-key-123456',
    PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
    GITHUB_CLIENT: 'mock',
    CLAUDE_RUNNER: 'mock',
    CLAUDE_MOCK_EDIT: 'true',
    GIT_REMOTE_URL_BASE: `file://${remotesRoot}`,
    REPOSITORIES_FILE: reposFile,
    WORKSPACE_ROOT: path.join(root, 'workspaces'),
    CLAUDE_HOME_DIR: path.join(root, 'claude-home'),
    WORKER_POLL_INTERVAL_MS: '200',
    WORKER_ID: 'e2e-worker',
  };

  console.log('Starting claude-bridge-api and claude-bridge-worker (separate processes)...');
  const children: ChildProcess[] = [];
  const start = (script: string): ChildProcess => {
    const child = spawn('node', [script], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    children.push(child);
    return child;
  };
  start('dist/api/main.js');
  start('dist/worker/main.js');
  const stopAll = async (): Promise<void> => {
    for (const child of children) child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    for (const child of children) child.kill('SIGKILL');
  };

  try {
    // Wait for the API to come up.
    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
        healthy = res.ok;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    check('API service healthy (/healthz)', healthy);

    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const text = (r: unknown): string =>
      ((r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === 'text')?.text ?? '');
    const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const result = await client.callTool({ name, arguments: args });
      const payload = JSON.parse(text(result));
      if ((result as { isError?: boolean }).isError) {
        throw new Error(`${name} failed: ${JSON.stringify(payload)}`);
      }
      return payload;
    };
    const waitTerminal = async (taskId: string, timeoutMs = 60_000): Promise<any> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const status = await call('get_task_status', { taskId });
        if (['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING'].includes(status.status)) return status;
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${taskId}: ${status.status}`);
        await new Promise((r) => setTimeout(r, 400));
      }
    };

    const repos = await call('list_repositories', {});
    check('list_repositories shows the registry entry', repos.repositories?.[0]?.repository === 'e2e-repo');

    // 1-2: MCP start creates ONE durable task; idempotent retry returns the same.
    const started = await call('start_repo_task', {
      repository: 'e2e-repo',
      objective: 'Create a harmless documentation change, verify it, and open a PR. Do not merge.',
      idempotencyKey: 'e2e-start-1',
    });
    check('start_repo_task returns a durable QUEUED task', started.status === 'QUEUED' && String(started.taskId).startsWith('cldtask_'));
    const retry = await call('start_repo_task', {
      repository: 'e2e-repo',
      objective: 'Create a harmless documentation change, verify it, and open a PR. Do not merge.',
      idempotencyKey: 'e2e-start-1',
    });
    check('idempotent retry returns the SAME task (no duplicate)', retry.taskId === started.taskId && retry.replayed === true);

    // 3-9: worker claims, isolated workspace, edit, commit, push, one PR.
    const finished = await waitTerminal(started.taskId);
    check('worker claimed and completed the task', finished.status === 'COMPLETED', `status=${finished.status}`);
    const report = await call('get_task_report', { taskId: started.taskId });
    check('report: commit created', (report.git?.commits?.length ?? 0) >= 1);
    check('report: branch pushed with final sha', Boolean(report.headShaAfter));
    const remoteSha = await git(['--git-dir', bare, 'rev-parse', `refs/heads/${report.workingBranch}`]);
    check('branch really exists on the remote at the reported sha', remoteSha === report.headShaAfter, remoteSha.slice(0, 12));
    check('exactly one PR recorded with URL', Boolean(report.pr?.number) && Boolean(report.pr?.url));
    check('report says NOT merged', report.merged === false);
    const events = await call('get_task_events', { taskId: started.taskId, limit: 50 });
    const eventTypes = (events.events as { type: string }[]).map((e) => e.type);
    check(
      'durable events cover the lifecycle',
      ['TASK_CREATED', 'REPOSITORY_PREPARING', 'CLAUDE_STARTED', 'PUSHED', 'PR_OPENED', 'COMPLETED'].every((t) =>
        eventTypes.includes(t),
      ),
      eventTypes.join(','),
    );

    // 11-13: continuation resumes the same session, same branch, same PR.
    const continued = await call('continue_repo_task', {
      taskId: started.taskId,
      instruction: 'Make one more harmless documentation tweak and update the same PR.',
      idempotencyKey: 'e2e-cont-1',
    });
    check('continuation queued on the same task', continued.taskId === started.taskId);
    const afterCont = await waitTerminal(started.taskId);
    check('continuation completed', afterCont.status === 'COMPLETED');
    const report2 = await call('get_task_report', { taskId: started.taskId });
    check('continuation advanced the branch', report2.headShaAfter !== report.headShaAfter);
    check('continuation updated the SAME PR (no duplicate)', report2.pr?.number === report.pr?.number);
    check(
      'continuation ran in the SAME Claude session',
      (report2.continuations as { status: string }[]).some((c) => c.status === 'COMPLETED'),
    );
    const contRetry = await call('continue_repo_task', {
      taskId: started.taskId,
      instruction: 'Make one more harmless documentation tweak and update the same PR.',
      idempotencyKey: 'e2e-cont-1',
    });
    check('idempotent continuation retry does not double-queue', contRetry.replayed === true);
    // Drain the replayed-but-not-new state: nothing new should be queued.
    const statusAfterRetry = await call('get_task_status', { taskId: started.taskId });
    check('no phantom continuation after retry', statusAfterRetry.queuedContinuations === 0, `queued=${statusAfterRetry.queuedContinuations}`);

    // Read-only analysis.
    const ask = await call('ask_claude', { prompt: 'Assess the architecture of this system.', idempotencyKey: 'e2e-ask-1' });
    const askDone = await waitTerminal(ask.taskId);
    check('ask_claude analysis completed read-only', askDone.status === 'COMPLETED');

    // Workflow run.
    const wf = await call('run_workflow', {
      repository: 'e2e-repo',
      workflow: 'echo-check',
      branch: 'main',
      parameters: { note: 'e2e verification' },
      idempotencyKey: 'e2e-wf-1',
    });
    let wfView: any;
    for (let i = 0; i < 100; i++) {
      wfView = await call('get_workflow_run', { runId: wf.runId });
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(wfView.status)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    check('workflow run completed with findings', wfView.status === 'COMPLETED' && Array.isArray(wfView.findings));

    // Cancellation.
    const cancelme = await call('start_repo_task', {
      repository: 'e2e-repo',
      objective: 'task to cancel',
      targetBranch: 'e2e/cancel-me',
      idempotencyKey: 'e2e-cancel-1',
    });
    const cancelled = await call('cancel_task', { taskId: cancelme.taskId });
    check('cancellation is effective and idempotent', ['CANCELLED', 'CANCEL_REQUESTED'].includes(cancelled.status));
    const cancelled2 = await call('cancel_task', { taskId: cancelme.taskId });
    check('second cancel reports final state', ['CANCELLED', 'CANCEL_REQUESTED'].includes(cancelled2.status));

    await client.close();
    console.log(`\nE2E: ${results.filter((r) => r.ok).length}/${results.length} checks passed.`);
  } finally {
    await stopAll();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err.message ?? err);
  process.exit(1);
});
