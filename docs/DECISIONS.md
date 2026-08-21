# Technical decisions

Recorded during Phase 1 research (August 2026) and kept current. Each entry
states the decision, the alternative considered, and why.

## Claude execution: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.x)

The Agent SDK is Anthropic's officially supported programmatic interface to
the Claude Code engine — it bundles the engine and exposes `query()` with
structured message streaming. Everything the bridge needs is first-class API,
verified against the installed type definitions (not remembered CLI flags):

- **Non-interactive execution**: `query({ prompt, options })`, single-turn
  prompt mode; the process exits after the turn.
- **Structured output**: `options.outputFormat = { type: 'json_schema', schema }`
  forces a schema-validated `structured_output` on the final result message.
  The raw final text is still preserved as a fallback.
- **Session IDs / resume**: the `system/init` message carries `session_id`;
  `options.resume = sessionId` resumes it. Session state persists as JSONL
  under `$HOME/.claude` — which is why `CLAUDE_HOME_DIR` must live on the
  worker's persistent volume.
- **Model selection**: `options.model`; the init message reports the actual
  model used.
- **Permission modes / tool control**: `options.permissionMode`,
  `options.tools` (base toolset restriction), `options.disallowedTools`, and
  the `canUseTool` callback for per-call decisions.
- **Turn limits**: `options.maxTurns`; result subtype `error_max_turns`.
- **Working directory**: `options.cwd` (the isolated task workspace).
- **Environment**: `options.env` REPLACES the subprocess environment — the
  bridge builds a minimal env (PATH, HOME, ANTHROPIC_API_KEY, proxy vars) so
  no GitHub credentials can leak into Claude's process.
- **Cancellation**: `options.abortController`; timeouts are implemented by
  aborting after `TASK_TIMEOUT_MS`.
- **Settings isolation**: `settingSources: []` — no user/project settings files
  are loaded, so repository content cannot inject hooks or permission grants.

Alternative considered: shelling out to `claude -p --output-format stream-json`.
Rejected — the SDK wraps the same engine with typed messages and lifecycle
control, and is the documented integration path.

Authentication: `ANTHROPIC_API_KEY` in the worker environment (standard API
billing). Claude Code's interactive login does not exist in Railway; the API
key is the supported headless mechanism.

## MCP server: `@modelcontextprotocol/sdk` 1.30.x (v1, not v2)

The TypeScript SDK v2 (`@modelcontextprotocol/server` 2.0.0, spec 2026-07-28)
shipped three weeks before this implementation. v1.30 remains the `latest`
npm tag, is deployed at scale, and speaks the current protocol via version
negotiation. Production bias wins: v1.30 now, v2 migration when it has
mileage. Transport: **Streamable HTTP in stateless JSON mode** — one
server+transport per request, no server-side session affinity, which suits
Railway restarts and keeps the API replaceable. Verified end-to-end in tests
with the SDK's own `StreamableHTTPClientTransport`.

## ChatGPT authentication: built-in OAuth 2.1 authorization server

ChatGPT custom connectors require OAuth 2.1 with dynamic client registration
and PKCE (S256); plain bearer tokens are not accepted by the ChatGPT UI. The
MCP SDK ships the full authorization-server framework
(`mcpAuthRouter` + `OAuthServerProvider`), so the bridge implements the
provider against Postgres:

- DCR registers **public clients only** (`token_endpoint_auth_method: none`),
  which is what ChatGPT uses — no client secrets stored, PKCE mandatory.
- `/authorize` renders a consent page; the human operator approves with
  `BRIDGE_OPERATOR_KEY`.
- Codes and tokens are stored as SHA-256 hashes; codes are single-use;
  refresh tokens rotate on use.
- The `/mcp` endpoint advertises RFC 9728 protected-resource metadata in its
  401 `WWW-Authenticate` header, which is how ChatGPT discovers the flow.

Static bearer tokens (`BRIDGE_API_TOKENS`) are additionally accepted for
non-ChatGPT clients (scripts, the Responses API `headers` option, testing).

## Job queue: Postgres, not Redis/BullMQ

Durable state already lives in Postgres; a second system adds failure modes
without adding durability. Claiming uses `FOR UPDATE SKIP LOCKED` plus a
transaction-scoped advisory lock so per-repository concurrency limits hold
across workers. Leases with heartbeats + startup/periodic reconciliation
handle worker loss explicitly: preparation-phase tasks are requeued
(side-effect free), running Claude tasks are marked `FAILED/WORKER_LOST` and
never re-run automatically (Claude execution is not idempotent) — the session
remains resumable via `continue_repo_task`.

## Workspaces: bare-mirror cache + per-task local clone

Each repository has a bare mirror under `WORKSPACE_ROOT/cache`, refreshed
before each task; each task gets its own full clone (hardlinked objects, so
cheap) with `origin` rewritten to GitHub. Full isolation between concurrent
tasks; deterministic cleanup after a retention window. Git credentials are
injected per-invocation via an askpass helper reading an env var — tokens
never appear in argv, on-disk config, or remote URLs — and only for
bridge-performed operations. During Claude's run the workspace has no
credentials at all, and `git push`/`gh` are additionally denied via
`canUseTool`, so pushing is provably bridge-controlled.

## GitHub: token-based v1 behind an interface

`GITHUB_TOKEN` (fine-grained PAT or GitHub App installation token) with the
Octokit REST client, entirely behind the `GitHubClient` interface. A GitHub
App with short-lived installation tokens is the better long-term security
posture (scoped installs, revocable, auditable); the interface makes that a
drop-in implementation swap. Trade-off documented in the README. Merge uses
the GitHub merge API's `sha` parameter — expected-head protection enforced by
GitHub itself, not just by the bridge's pre-checks.

## Repository registry: discovered from GitHub, additive only

A fresh production deployment used to start with an empty allowlist — every
MCP call failed with `REPOSITORY_NOT_FOUND` until an operator ran the `repos`
CLI or wired up `REPOSITORIES_FILE`. Both entrypoints now bootstrap the
registry at boot: `REPOSITORIES_FILE` first, then every repository the
`GITHUB_TOKEN` can reach (`GET /user/repos`, falling back to
`GET /installation/repositories` on the 403 a GitHub App token gets there).

The allowlist architecture is unchanged — discovery only writes rows through
the same `upsertRepository` chokepoint, and permission ceilings remain a
server-side decision (engineering permissions on, `allowMerge` off,
`concurrencyLimit` 1). Three properties make it safe to run on every boot:

- **Additive.** Existing entries are matched by `owner/repo`, not by key, and
  are left untouched — hand-tuned settings win and a disabled repository is
  never re-enabled by discovery.
- **Stable keys.** `owner/repo` lowercased with disallowed characters folded to
  `-`; over-long keys, and the rare pair that folds onto a key another
  repository already holds, get a suffix hashed from the full `owner/repo`, so
  a key never moves between runs.
- **Fail-safe.** A broken `REPOSITORIES_FILE` still fails startup loudly, but
  GitHub being unreachable only logs — the service starts on the registry it
  already has. Nothing is ever deleted or disabled. Pagination is capped
  (100 pages) and a truncated enumeration is reported, not hidden.

Alternative considered: discovering repositories lazily on `list_repositories`.
Rejected — it puts an unbounded GitHub call on a read path, and the registry
row is also what the worker and permission checks read.

## Workflows: server-side allowlist, argv templates, no shell

Definitions live in code (built-ins) plus an operator-provided JSON file.
Callers select by name and pass schema-validated parameters. Commands are
spawned with `spawn` (never a shell); substituted values are validated and may
not begin with `-`; parameters are also injected as `WORKFLOW_PARAM_*` env
vars. The workflow subprocess gets a minimal environment with **no** GitHub or
Anthropic credentials. `fable` ships as a config template
(`workflows.example.json`) because its exact invocation is repository-specific;
the built-in `echo-check` workflow exercises the identical pipeline in tests.

## Railway: two services + Postgres, one Docker image

`claude-bridge-api` (HTTP: MCP, OAuth, health, metrics) and
`claude-bridge-worker` (execution) run from the same image with different
start commands (`railway.json` vs `railway.worker.json`). Long Claude jobs
never depend on an HTTP request staying open — MCP mutations return a durable
ID immediately. The worker gets a volume at `/data` for workspaces and the
Claude session store. Run exactly one worker replica per volume;
scale by raising `MAX_CONCURRENT_TASKS` rather than adding replicas (the
claim protocol tolerates multiple workers, but they must not share a volume).
