import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BridgeConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { TASK_STATUSES } from '../domain/types.js';
import { isBridgeError, toBridgeError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { GitHubClient } from '../github/types.js';
import {
  askClaude,
  cancelTask,
  continueTask,
  getTaskEvents,
  getTaskReport,
  getTaskStatus,
  listTasksView,
  mergeTaskPr,
  startRepoTask,
  type TaskServiceDeps,
} from '../services/task-service.js';
import {
  cancelWorkflowRun,
  getWorkflowRunView,
  listRepositoriesView,
  listWorkflowsForRepository,
  runWorkflow,
  type WorkflowServiceDeps,
} from '../services/workflow-service.js';
import type { WorkflowRegistry } from '../workflows/registry.js';

export interface McpDeps {
  db: Db;
  config: BridgeConfig;
  logger: Logger;
  github: GitHubClient;
  workflows: WorkflowRegistry;
}

/* ------------------------------ plumbing --------------------------------- */

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown, logger: Logger): CallToolResult {
  const bridgeErr = toBridgeError(err);
  if (!isBridgeError(err)) {
    logger.error({ err }, 'unexpected error in MCP tool');
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(bridgeErr.toPayload(), null, 2) }],
  };
}

type ToolExtra = { authInfo?: { clientId?: string } };

function callerOf(extra: ToolExtra): string {
  return extra.authInfo?.clientId ?? 'unknown';
}

/* ------------------------------ schemas ---------------------------------- */

const idempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .describe(
    'Caller-chosen key making this mutation retry-safe: retrying with the same key and same arguments returns the original resource instead of creating a duplicate; reusing a key with different arguments fails with IDEMPOTENCY_CONFLICT. Always set this.',
  );

const permissionsShape = {
  allowCodeChanges: z.boolean().optional().describe('Claude may edit files in the isolated workspace (default true).'),
  allowCommit: z.boolean().optional().describe('Claude may create local git commits (default true; requires allowCodeChanges).'),
  allowPush: z.boolean().optional().describe('The bridge pushes the working branch to GitHub after the run (default true; requires allowCommit).'),
  allowOpenPr: z.boolean().optional().describe('The bridge may open a pull request for the working branch (default true; requires allowPush).'),
  allowUpdatePr: z.boolean().optional().describe('The bridge may update the existing pull request (default true; requires allowPush).'),
  allowMerge: z.boolean().optional().describe('Pre-authorize merging via merge_task_pr WITHOUT a later authorizeMerge flag (default false — merge is never implicit).'),
};

/* ------------------------------ registry --------------------------------- */

export function registerBridgeTools(server: McpServer, deps: McpDeps): void {
  const taskDeps: TaskServiceDeps = deps;
  const wfDeps: WorkflowServiceDeps = deps;
  const { logger } = deps;

  server.registerTool(
    'list_repositories',
    {
      title: 'List available repositories',
      description:
        'Read-only. Lists the repositories this bridge is allowed to operate on: registry key (use it as `repository` in every other tool), GitHub owner/name, default branch, permitted operations, and available workflows. No side effects. Call this first when unsure which repository keys exist — arbitrary paths or unlisted repositories are always rejected.',
      inputSchema: {},
    },
    async (extra) => {
      void extra;
      try {
        return ok({ repositories: await listRepositoriesView({ db: deps.db, workflows: deps.workflows }) });
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'ask_claude',
    {
      title: 'Ask Claude (read-only analysis)',
      description:
        'Use Claude as a second engineering brain WITHOUT changing any code. Starts a durable read-only analysis task and returns { taskId, status: "QUEUED" } immediately — poll get_task_status, then fetch structured findings with get_task_report. Context modes: "general" (no repository, pure reasoning), "repository" (read-only checkout of the default branch), "branch" (checkout + diff of branch vs baseBranch), "pr" (checkout + diff of a pull request). Side effects: none on GitHub, ever — no branches, no commits, no PRs. Completion means the analysis is ready, nothing was merged or changed. Use start_repo_task instead when code should actually be modified.',
      inputSchema: {
        prompt: z.string().describe('The question or review objective for Claude. Large prompts are supported.'),
        repository: z.string().optional().describe('Repository registry key (see list_repositories). Required for repository/branch/pr modes.'),
        branch: z.string().optional().describe('Branch to analyze (branch mode).'),
        baseBranch: z.string().optional().describe('Base to diff against (branch mode; defaults to the repository default branch).'),
        prNumber: z.number().int().positive().optional().describe('Pull request number to review (pr mode).'),
        contextMode: z.enum(['general', 'repository', 'branch', 'pr']).optional().describe('Explicit context mode; inferred from the other arguments when omitted.'),
        model: z.string().optional().describe('Model alias (default | fast | strong | strongest) or an allowlisted model id. Omit for the server default. The actual model used is reported back.'),
        idempotencyKey: idempotencyKey.optional(),
      },
    },
    async (args, extra) => {
      try {
        const { task, replayed } = await askClaude(taskDeps, { ...args, prompt: args.prompt, createdBy: callerOf(extra as ToolExtra) });
        return ok({ taskId: task.id, status: task.status, replayed, note: 'Poll get_task_status; findings arrive via get_task_report.' });
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'start_repo_task',
    {
      title: 'Start a Claude engineering task',
      description:
        'Starts a durable Claude engineering task against an allowlisted repository and returns { taskId, status: "QUEUED", workingBranch } immediately; a worker then clones the repo into an isolated workspace, checks out the branch, lets Claude implement/test/self-review, and (per permissions) commits, pushes, and opens or updates exactly one pull request. Side effects (gated per-permission): pushes the working branch and opens/updates a PR. It NEVER merges — COMPLETED means work is pushed/PR-ready, not merged; merging requires merge_task_pr. Branch semantics: omit targetBranch to get a fresh `claude/...` branch off baseBranch; pass targetBranch to continue an existing branch; pass existingPr to work on that PR\'s branch (no duplicate PR will be created). Concurrent write tasks on the same branch are rejected with BRANCH_BUSY. Statuses: QUEUED→PREPARING→RUNNING→COMPLETED/FAILED (WAITING = needs your attention; CANCEL_REQUESTED/CANCELLED). Poll get_task_status; use continue_repo_task for follow-ups in the same Claude session. Retries with the same idempotencyKey return the same task.',
      inputSchema: {
        repository: z.string().describe('Repository registry key from list_repositories. Never a filesystem path.'),
        objective: z.string().describe('Full engineering objective/master prompt. Can be very large; it is passed to Claude verbatim, never truncated.'),
        baseBranch: z.string().optional().describe('Branch to start from (default: repository default branch).'),
        targetBranch: z.string().optional().describe('Exact branch to work on (created from baseBranch if it does not exist remotely). Omit for an auto-generated claude/<slug>-<id> branch.'),
        existingPr: z.number().int().positive().optional().describe('Continue work on this open PR: its head branch becomes the working branch and updates go to the same PR.'),
        model: z.string().optional().describe('Model alias (default | fast | strong | strongest) or an allowlisted model id. The actual model used is reported back.'),
        maxTurns: z.number().int().positive().optional().describe('Cap on Claude agentic turns for this run (server default and ceiling apply).'),
        ...permissionsShape,
        idempotencyKey,
        metadata: z.record(z.string(), z.unknown()).optional().describe('Free-form metadata stored with the task.'),
      },
    },
    async (args, extra) => {
      try {
        const { task, replayed } = await startRepoTask(taskDeps, {
          repository: args.repository,
          objective: args.objective,
          baseBranch: args.baseBranch,
          targetBranch: args.targetBranch,
          existingPr: args.existingPr,
          model: args.model,
          maxTurns: args.maxTurns,
          idempotencyKey: args.idempotencyKey,
          metadata: args.metadata,
          createdBy: callerOf(extra as ToolExtra),
          permissions: {
            allowCodeChanges: args.allowCodeChanges,
            allowCommit: args.allowCommit,
            allowPush: args.allowPush,
            allowOpenPr: args.allowOpenPr,
            allowUpdatePr: args.allowUpdatePr,
            allowMerge: args.allowMerge,
          },
        });
        return ok({
          taskId: task.id,
          status: task.status,
          repository: task.repositoryKey,
          baseBranch: task.baseBranch,
          workingBranch: task.workingBranch,
          existingPr: task.prNumber,
          replayed,
        });
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'continue_repo_task',
    {
      title: 'Continue a task in the same Claude session',
      description:
        'Sends a follow-up instruction to an existing task, resuming the SAME Claude session (full prior context — Claude remembers what it did). Use it for iteration: "fix the review findings, rerun tests, update the same PR". Works when the task is COMPLETED, FAILED, or WAITING and has a resumable session; running tasks return TASK_ALREADY_RUNNING, cancelled tasks cannot be continued, and a lost session returns CLAUDE_SESSION_UNAVAILABLE (start a new task then). Side effects: same as the original task\'s permissions — same working branch, same PR (never a duplicate PR), still never merges. The task goes back to QUEUED and runs again; poll get_task_status. Retries with the same idempotencyKey do NOT deliver the instruction twice.',
      inputSchema: {
        taskId: z.string().describe('The task to continue.'),
        instruction: z.string().describe('The follow-up instruction for Claude. Can be large.'),
        idempotencyKey,
      },
    },
    async (args, extra) => {
      void extra;
      try {
        const { task, continuation, replayed } = await continueTask(taskDeps, args);
        return ok({
          taskId: task.id,
          continuationId: continuation.id,
          continuationSeq: continuation.seq,
          status: task.status,
          replayed,
        });
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'get_task_status',
    {
      title: 'Get task status (cheap poll)',
      description:
        'Read-only, cheap. Returns the task\'s operational state: status (QUEUED = waiting for a worker; PREPARING = cloning repo; RUNNING = Claude working; WAITING = paused, needs your attention — read attentionReason; COMPLETED = finished, NOT merged; FAILED; CANCEL_REQUESTED; CANCELLED), current phase, repository/branch/PR, timing, the most recent event, and whether continuations are queued. Poll this while a task runs (every 30–60s is plenty); fetch full results with get_task_report and detailed progress with get_task_events.',
      inputSchema: { taskId: z.string() },
    },
    async (args) => {
      try {
        return ok(await getTaskStatus(taskDeps, args.taskId));
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'get_task_report',
    {
      title: 'Get task report (full results)',
      description:
        'Read-only. Returns the full results of a task: bridge-verified git facts (starting/final SHA, commits made, files changed, pushed branch), PR number/URL, Claude\'s structured completion report (summary, outcome, tests with real results, findings for analysis tasks, blockers), continuation history, cost/turn accounting, and error details when failed. `expectedHeadSha` is the verified head to pass to merge_task_pr. A COMPLETED report NEVER implies the PR was merged — check `merged`. If Claude\'s report failed structured parsing, the raw final text is preserved in rawFinalResponse. Works on partial/failed tasks too.',
      inputSchema: { taskId: z.string() },
    },
    async (args) => {
      try {
        return ok(await getTaskReport(taskDeps, args.taskId));
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'get_task_events',
    {
      title: 'Get task progress events',
      description:
        'Read-only. Returns a bounded window of the task\'s durable progress events, oldest→newest (task created, repo prepared, Claude started, tool activity, commits, pushes, PR opened/updated, completion/failure). Use this to answer "what is Claude doing?" without dumping logs. Pagination: pass beforeSeq = the previous response\'s oldestSeq to go further back. Event history is capped per task; verbose progress events are pruned first, lifecycle events are always retained.',
      inputSchema: {
        taskId: z.string(),
        limit: z.number().int().min(1).max(100).optional().describe('Max events to return (default 20).'),
        beforeSeq: z.number().int().optional().describe('Return events with seq strictly below this (for paging back).'),
      },
    },
    async (args) => {
      try {
        return ok(await getTaskEvents(taskDeps, args));
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'cancel_task',
    {
      title: 'Cancel a task',
      description:
        'Requests cancellation of a task. Idempotent — repeated calls are safe and report the current state. QUEUED/WAITING tasks cancel immediately; RUNNING tasks transition to CANCEL_REQUESTED while the worker aborts Claude and its child processes, then to CANCELLED. Side effects already performed (commits pushed, PR opened) are NOT rolled back — the report shows exactly what happened. Queued continuations are cancelled too. The task workspace is retained briefly for diagnosis, then cleaned automatically.',
      inputSchema: { taskId: z.string() },
    },
    async (args) => {
      try {
        const { task, alreadyFinal } = await cancelTask(taskDeps, args.taskId);
        return ok({ taskId: task.id, status: task.status, alreadyFinal });
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'Read-only. Lists tasks newest-first with filters (repository key, statuses, branch, PR number, created date range) and cursor pagination (pass nextCursor back as cursor). Returns compact rows — use get_task_status / get_task_report for detail.',
      inputSchema: {
        repository: z.string().optional(),
        statuses: z.array(z.enum(TASK_STATUSES)).optional(),
        branch: z.string().optional().describe('Matches working, target, or base branch.'),
        prNumber: z.number().int().positive().optional(),
        createdAfter: z.string().optional().describe('ISO 8601 timestamp.'),
        createdBefore: z.string().optional().describe('ISO 8601 timestamp.'),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(await listTasksView(taskDeps, args));
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'merge_task_pr',
    {
      title: 'Merge a task PR (guarded)',
      description:
        'THE ONLY WAY TO MERGE. Squash-merges the pull request of a COMPLETED task, with strict guards: the repository registry must allow merging; the task must have been created with allowMerge OR you must pass authorizeMerge=true (this call is then the explicit authorization); expectedHeadSha must equal the task\'s verified head AND the live PR head (anything else fails with EXPECTED_HEAD_MISMATCH and the task is flagged WAITING); CI checks must be green (unless the repo has none), the PR must be mergeable and non-draft, unresolved review threads block (when readable), and unresolved blockers in Claude\'s report block. Side effect: merges to the base branch on GitHub and returns the merge SHA. Idempotent: if already merged, returns alreadyMerged=true with the recorded SHA. Get expectedHeadSha from get_task_report.',
      inputSchema: {
        taskId: z.string(),
        expectedHeadSha: z.string().describe('The verified head SHA from get_task_report (expectedHeadSha field). Merging is refused if the PR head differs.'),
        authorizeMerge: z.boolean().optional().describe('Explicit merge authorization for tasks created without allowMerge. You are authorizing the merge by setting this to true.'),
        commitTitle: z.string().max(200).optional().describe('Optional squash commit title.'),
      },
    },
    async (args) => {
      try {
        return ok(await mergeTaskPr(taskDeps, args));
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'list_workflows',
    {
      title: 'List workflows for a repository',
      description:
        'Read-only. Lists the named, server-configured workflows runnable for a repository (e.g. review/check pipelines like "fable"), with their parameters. Workflows are allowlisted server-side — run_workflow can only execute what appears here, never arbitrary commands.',
      inputSchema: { repository: z.string() },
    },
    async (args) => {
      try {
        return ok({ repository: args.repository, workflows: await listWorkflowsForRepository(wfDeps, args.repository) });
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'run_workflow',
    {
      title: 'Run a named workflow',
      description:
        'Starts a durable run of a server-configured workflow (see list_workflows) against a branch or PR, in an isolated checkout, and returns { runId, status: "QUEUED" } immediately — poll get_workflow_run for output and structured findings. Typical use: run the "fable" review workflow against a Claude task\'s branch, then feed valid findings back via continue_repo_task. Side effects: none on GitHub — workflows read a checkout and produce findings; they never push or merge. Unknown workflows fail with WORKFLOW_NOT_FOUND; workflows not enabled for the repository fail with WORKFLOW_NOT_ALLOWED; parameters are validated against the workflow\'s schema. Retries with the same idempotencyKey return the same run.',
      inputSchema: {
        repository: z.string().describe('Repository registry key.'),
        workflow: z.string().describe('Workflow name from list_workflows.'),
        branch: z.string().optional().describe('Branch to run against (default: repository default branch).'),
        prNumber: z.number().int().positive().optional().describe('Run against this PR\'s head instead of a branch.'),
        parameters: z.record(z.string(), z.string()).optional().describe('Workflow parameters (validated against the workflow schema).'),
        idempotencyKey,
      },
    },
    async (args, extra) => {
      try {
        const { run, replayed } = await runWorkflow(wfDeps, { ...args, createdBy: callerOf(extra as ToolExtra) });
        return ok({ runId: run.id, status: run.status, workflow: run.workflow, branch: run.branch, prNumber: run.prNumber, replayed });
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'get_workflow_run',
    {
      title: 'Get workflow run status/results',
      description:
        'Read-only. Returns a workflow run\'s status (same lifecycle as tasks), the resolved head SHA it ran against, exit code, bounded output summary, and structured findings when the workflow emits them (severity/title/file/line/rationale/recommendation). COMPLETED means the workflow process finished; check exitCode and findings to judge the outcome.',
      inputSchema: { runId: z.string() },
    },
    async (args) => {
      try {
        return ok(await getWorkflowRunView(wfDeps, args.runId));
      } catch (err) {
        return fail(err, logger);
      }
    },
  );

  server.registerTool(
    'cancel_workflow_run',
    {
      title: 'Cancel a workflow run',
      description:
        'Requests cancellation of a workflow run. Idempotent. QUEUED runs cancel immediately; RUNNING runs get their subprocess terminated and transition CANCEL_REQUESTED → CANCELLED.',
      inputSchema: { runId: z.string() },
    },
    async (args) => {
      try {
        return ok(await cancelWorkflowRun(wfDeps, args.runId));
      } catch (err) {
        return fail(err, logger);
      }
    },
  );
}
