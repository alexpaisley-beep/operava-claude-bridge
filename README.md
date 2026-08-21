# Operava Claude Bridge

A remote [MCP](https://modelcontextprotocol.io) server that lets **ChatGPT delegate real engineering work to Claude**.

ChatGPT connects as an MCP client. Claude Code runs server-side against allowlisted GitHub repositories in isolated workspaces. Tasks are durable (Postgres), resumable (same Claude session across follow-ups), permission-gated, and observable.

```text
ChatGPT
   │  Remote MCP (Streamable HTTP + OAuth 2.1)
   ▼
claude-bridge-api ──── PostgreSQL (tasks, events, continuations, runs, locks, auth)
                          ▲
claude-bridge-worker ─────┘
   ├─ repository workspace manager (bare-mirror cache + per-task isolated clones)
   ├─ Claude execution adapter (official Claude Agent SDK)
   ├─ workflow runner (allowlisted, named workflows — e.g. fable)
   └─ GitHub integration (branches, PRs, expected-head-protected merge)
```

## What it feels like

> **Alex:** Fix the Growth Engine sender-health stale counts bug. Don't merge.

ChatGPT calls `start_repo_task(repository="growth-engine", objective="…")` → gets `{ taskId, status: "QUEUED" }` back instantly. The worker clones the repo, checks out a `claude/…` branch, and Claude diagnoses, edits, runs the tests, self-reviews, commits. The bridge pushes and opens exactly one PR.

> **Alex:** What's Claude doing?

`get_task_status(taskId)` → `RUNNING`, phase, latest event. `get_task_events` shows the play-by-play.

> **Alex:** Run Fable against Claude's branch.

`run_workflow(repository="growth-engine", workflow="fable", branch="claude/…")` → structured findings from `get_workflow_run`.

> **Alex:** Have Claude fix the valid findings and update the PR.

`continue_repo_task(taskId, instruction)` — **the same Claude session resumes** with full context, pushes to the same branch, updates the same PR. Never a duplicate PR.

> **Alex:** Everything's green. Merge it.

`merge_task_pr(taskId, expectedHeadSha, authorizeMerge=true)` — squash merge, but only if: the repo registry allows merging, the head SHA equals the verified one (GitHub-enforced), CI is green, the PR is mergeable, review threads are resolved, and Claude reported no blockers.

> **Alex:** Ask Claude whether this architecture is stupid before we build it.

`ask_claude(prompt)` — read-only analysis, optionally against a repository/branch/PR checkout with a bridge-computed diff. No branches, no commits, ever.

## MCP tools

| Tool | What it does | Writes anything? |
|---|---|---|
| `list_repositories` | Registry keys + allowed operations + workflows | No |
| `ask_claude` | Durable read-only analysis (general/repository/branch/pr) | No |
| `start_repo_task` | Durable engineering task → branch, commits, push, PR (per permissions) | Yes (gated) |
| `continue_repo_task` | Resume the **same Claude session** with a new instruction | Yes (same gates) |
| `get_task_status` | Cheap operational state + latest event | No |
| `get_task_report` | Full results: verified git facts, Claude's structured report, PR, cost | No |
| `get_task_events` | Bounded durable progress events | No |
| `cancel_task` | Idempotent cancellation (aborts Claude + children) | Stops work |
| `list_tasks` | Filtered, paginated task listing | No |
| `merge_task_pr` | **The only way to merge** — guarded squash merge | Yes (heavily gated) |
| `list_workflows` | Allowlisted workflows for a repository | No |
| `run_workflow` | Durable run of a named server-side workflow | No (read-only checkout) |
| `get_workflow_run` | Workflow status/output/findings | No |
| `cancel_workflow_run` | Idempotent workflow cancellation | Stops work |

Every mutating tool takes an `idempotencyKey`: retries return the original resource; conflicting reuse fails with `IDEMPOTENCY_CONFLICT`. Errors carry stable machine-readable codes (`REPOSITORY_NOT_FOUND`, `BRANCH_BUSY`, `EXPECTED_HEAD_MISMATCH`, `CLAUDE_SESSION_UNAVAILABLE`, …).

## Task lifecycle

`QUEUED → PREPARING → RUNNING → COMPLETED | FAILED | CANCELLED`, plus `WAITING` (parked, needs your attention — e.g. the branch diverged after verification) and `CANCEL_REQUESTED`. All transitions are durable rows in Postgres; a Railway restart reconciles orphans explicitly (preparation is requeued; interrupted Claude runs are marked `FAILED/WORKER_LOST` with the session left resumable — never silently re-run). **`COMPLETED` never means merged.**

## Security & permission model

- **Server-side authorization always wins.** Repository access is a registry allowlist (keys, never paths). Workflows are a named allowlist (callers can never supply commands). Repository *file content* is data Claude reads — it cannot redefine permissions, and prompts state that boundary explicitly.
- **Per-task permissions**, each independently grantable and capped by per-repository ceilings: `allowCodeChanges`, `allowCommit`, `allowPush`, `allowOpenPr`, `allowUpdatePr`, `allowMerge` (default **false**). No generic force flag.
- **Claude cannot push.** Its subprocess env is built from scratch (no GitHub credentials), the workspace has no stored credentials, and `git push`/`gh`/remote-config commands are denied at the tool-permission layer. All pushes/PRs/merges are performed by the bridge itself after the run, according to the task's permissions.
- **Merge safety:** merges require repo-registry permission AND (task `allowMerge` OR an explicit `authorizeMerge=true` call), a `COMPLETED` task, expected-head match (enforced again by GitHub's merge API `sha` parameter), green CI, a mergeable non-draft PR, resolved review threads, and no reported blockers.
- **One writer per branch**: durable branch locks reject concurrent write tasks (`BRANCH_BUSY`).
- **Auth:** no unauthenticated access. ChatGPT connectors use the built-in OAuth 2.1 server (DCR + PKCE, public clients, operator-approved consent, hashed tokens, refresh rotation). Non-ChatGPT clients may use static bearer tokens. Rate limiting on `/mcp` and the auth endpoints.
- **No secret ever crosses MCP**: Anthropic and GitHub credentials live only in server env vars; logs redact credential-shaped fields; git errors are scrubbed.
- **No autonomous loops**: Claude performs bounded work (turn caps, timeouts) and returns control. ChatGPT decides when another turn is useful.

## Local development

```bash
npm install
# Ephemeral local Postgres (any Postgres 14+ works; on Ubuntu with postgres installed):
initdb -D /tmp/bridge-pg --auth=trust -U postgres && \
  pg_ctl -D /tmp/bridge-pg -o '-p 5433 -c listen_addresses=127.0.0.1' start
export DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres
export BRIDGE_API_TOKENS=dev-token-0123456789abcdefghij
export BRIDGE_OPERATOR_KEY=dev-operator-key-123
export GITHUB_CLIENT=mock CLAUDE_RUNNER=mock   # or real GITHUB_TOKEN / ANTHROPIC_API_KEY

npm run dev        # migrations + seed + API (tsx watch) + worker (tsx watch)
```

Quality gates: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` (the test suite provisions its own throwaway Postgres cluster, or uses `TEST_DATABASE_URL` when set — CI does this with a service container).

Registry management (operator-only, never via MCP):

```bash
npm run repos -- list
npm run repos -- add --key growth-engine --owner your-org --repo growth-engine \
    --workflows echo-check,fable --concurrency 1
npm run repos -- disable --key growth-engine
```

Or declaratively: point `REPOSITORIES_FILE` at a JSON file (see `repositories.example.json`) — synced at boot.

**Auto-registration from GitHub.** At boot (after `REPOSITORIES_FILE`), both services register every repository the `GITHUB_TOKEN` can reach, so a fresh deployment never comes up with an empty allowlist. Keys are derived from `owner/repo` (`operava/growth-engine` → `operava-growth-engine`; over-long or colliding names get a stable hash suffix). New entries get normal engineering permissions — code changes, commits, pushes, PR create/update — with **merge disabled** and `concurrencyLimit: 1`; ceilings stay a server-side decision and are never negotiable from MCP. Discovery is strictly additive: entries that already exist (from the file, the CLI, or an earlier run) are matched by `owner/repo` and left untouched, so hand-tuned settings win and a **disabled repository stays disabled**. If GitHub is unreachable at boot the services still start on the registry they already have. Set `GITHUB_AUTO_REGISTER_REPOS=false` to manage the allowlist by hand.

## Workflows (and Fable)

Workflow definitions are server-controlled: built-ins plus `WORKFLOWS_FILE` (see `workflows.example.json`). A workflow runs for a repository only when **both** the definition allowlists the repo and the repo's registry entry lists the workflow. Commands are argv arrays spawned without a shell; `{{repoDir}}`, `{{branch}}`, and validated `{{param:NAME}}` placeholders are substituted; parameters are also injected as `WORKFLOW_PARAM_*` env vars alongside `WORKFLOW_BRANCH`, `WORKFLOW_HEAD_SHA`, `WORKFLOW_PR_NUMBER`, `WORKFLOW_REPO_DIR`.

**To enable Fable:** copy the `fable` entry from `workflows.example.json` into your `WORKFLOWS_FILE`, set the real command argv for your repos, add `"fable"` to each repository's `workflows` list, redeploy. `run_workflow(repository, workflow="fable", branch=…)` then returns Fable's findings as structured JSON (the workflow should print a JSON object with `summary` and `findings` to stdout; `outputParser: "json"` picks up the last JSON object printed). The built-in `echo-check` workflow exercises the identical pipeline and is used by the regression tests.

## Deploying on Railway

Three services in one project:

1. **Postgres** — add the Railway Postgres plugin. Note its `DATABASE_URL`.
2. **claude-bridge-api** — new service from this repo.
   - Config file: `railway.json` (Dockerfile build, start `node dist/api/main.js`, healthcheck `/healthz`).
   - Variables: `DATABASE_URL` (reference the plugin), `NODE_ENV=production`, `PUBLIC_BASE_URL=https://<api-domain>`, `BRIDGE_OPERATOR_KEY` (long random), optional `BRIDGE_API_TOKENS`, `GITHUB_TOKEN`, `REPOSITORIES_FILE`/`WORKFLOWS_FILE` if used.
   - Generate a public domain for it; that domain is `PUBLIC_BASE_URL`.
3. **claude-bridge-worker** — second service from the same repo.
   - Settings → Config file path: `railway.worker.json` (start `node dist/worker/main.js`).
   - **Attach a volume mounted at `/data`** (workspaces + Claude session store — required for continuations to survive redeploys).
   - Variables: `DATABASE_URL`, `NODE_ENV=production`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and the same `PUBLIC_BASE_URL`.
   - Run **one replica** (scale via `MAX_CONCURRENT_TASKS`).

Migrations run automatically at boot (advisory-locked, idempotent); `npm run migrate` exists for manual/release-phase use. Deploys are safe mid-task: the worker aborts in-flight Claude runs on SIGTERM, marks them `FAILED/WORKER_SHUTDOWN`, and they remain resumable via `continue_repo_task`.

**Connect ChatGPT:** Settings → Connectors → Add custom connector → MCP server URL `https://<api-domain>/mcp`, authentication **OAuth**. ChatGPT discovers the authorization server via the 401 metadata, registers itself (DCR), and sends you to the consent page — enter `BRIDGE_OPERATOR_KEY` to approve. Done: ChatGPT can now operate Claude through the tools above.

### Credentials the server needs (never exposed to ChatGPT)

| Variable | Purpose | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Code execution (worker) | Standard Anthropic API billing; the supported headless auth for the Agent SDK |
| `GITHUB_TOKEN` | clone/fetch/push, PRs, checks, merge | Fine-grained PAT scoped to the allowlisted repos (contents + pull-requests RW, checks R). A GitHub App installation token also works — the integration is isolated behind one interface for that migration |
| `BRIDGE_OPERATOR_KEY` | Human approval on the OAuth consent page | ≥16 chars |
| `BRIDGE_API_TOKENS` | Optional static bearer tokens for non-ChatGPT clients | ≥24 chars each |

## Repository layout

```
migrations/           SQL schema (forward-only, advisory-locked runner)
src/api/              claude-bridge-api entrypoint
src/worker/           claude-bridge-worker: claiming, pipelines, reconcile, cleanup
src/mcp/              MCP tools + Streamable HTTP app
src/auth/             OAuth 2.1 provider, consent page, rate limiting
src/services/         task + workflow services (validation, idempotency, merge guards)
src/claude/           Agent SDK runner, mock runner, prompt builders
src/gitx/             safe git exec, validation, workspace manager
src/github/           GitHub client interface + Octokit/mock implementations
src/workflows/        allowlisted workflow registry
src/registry/         repository registry bootstrap (file sync + GitHub discovery)
src/db/               data access + migration runner
tests/                108 tests: unit + integration (real Postgres, real git, mock Claude/GitHub)
scripts/e2e-local.ts  multi-process end-to-end verification (see docs/VERIFICATION.md)
docs/DECISIONS.md     research findings and technical decisions
```
