# Verification status

## What has been verified (no external credentials required)

- `npm run lint`, `npm run typecheck`, `npm run build`: green.
- `npm test`: 108 tests across 9 files — unit + integration against a real
  Postgres cluster and real git repositories (Claude and GitHub mocked at
  their interfaces). Includes registry bootstrap: GitHub repository discovery
  (pagination, installation-token fallback, duplicate handling, key stability),
  explicit-config precedence, disabled repositories staying disabled, and a
  discovery outage leaving the registry intact.
- `scripts/e2e-local.ts`: 22/22 checks with the **real compiled API and
  worker running as separate processes**, a real Postgres, real `file://` git
  remotes, and a real MCP SDK client over Streamable HTTP:
  1. one MCP call → one durable task; 2. worker claims it; 3. isolated
  workspace created; 4. "Claude" launches (mock runner, really editing);
  5. edits made; 6. verification recorded; 7. commit created; 8. branch
  pushed; 9. exactly one PR; 10. report returns the correct PR/SHAs;
  11–12. continuation resumes the same session and updates the same
  branch/PR; 13. idempotent retries create no duplicate task/continuation.
  Plus: read-only analysis, workflow run with findings, cancellation.
- OAuth 2.1: DCR → authorize → consent → PKCE token exchange → MCP access,
  code replay rejection, refresh rotation — exercised by automated tests
  against the real HTTP endpoints.

**A mocked integration does not prove live execution.** The following final
pass needs real credentials and has NOT been run in this environment.

## Final live verification checklist (run after deploying with real credentials)

Prereqs: Railway deployment per README (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
`CLAUDE_RUNNER=agent-sdk`, `GITHUB_CLIENT=octokit`), this repository registered
as `claude-bridge` in the registry, worker volume mounted at `/data`.

1. **Health**: `GET /healthz` → `{ ok: true }`.
2. **Auth**: `POST /mcp` without a token → 401 with `WWW-Authenticate` naming
   `resource_metadata`; with a `BRIDGE_API_TOKENS` bearer → `tools/list` works.
3. **ChatGPT connector**: add `https://<api-domain>/mcp` as a custom connector
   with OAuth; approve on the consent page with `BRIDGE_OPERATOR_KEY`; confirm
   ChatGPT lists the 14 tools.
3b. **Registry auto-registration**: `list_repositories` right after the first
   deploy lists every repository the `GITHUB_TOKEN` can reach — keys derived
   from `owner/repo`, `merge: false`, `concurrencyLimit: 1` — plus any
   explicitly configured entries with their own settings. Redeploy and confirm
   keys are unchanged and no disabled repository came back enabled.
4. **Live engineering task** (harmless, this repo):
   `start_repo_task(repository="claude-bridge", objective="Create a harmless
   documentation branch: add a short ARCHITECTURE section to the README
   explaining the api/worker split. Run npm run typecheck. Commit. Do not
   merge.")` → poll `get_task_status` to COMPLETED → `get_task_report` shows
   real commits, a pushed `claude/...` branch, exactly one open PR; verify the
   PR on GitHub.
5. **Continuation**: `continue_repo_task(taskId, "Tighten the wording of the
   section you added and update the same PR.")` → same branch, same PR, second
   commit; confirm on GitHub that no second PR exists.
6. **Idempotency under retry**: repeat step 4's call with the same
   `idempotencyKey` → same taskId, `replayed: true`, still one PR.
7. **Analysis**: `ask_claude(repository="claude-bridge",
   branch=<task branch>, prompt="Review this branch against main")` → findings
   returned, no new branches/PRs created.
8. **Workflow**: `run_workflow(repository="claude-bridge",
   workflow="echo-check", branch=<task branch>)` → COMPLETED with findings.
9. **Cancellation**: start a long task, `cancel_task` while RUNNING → status
   reaches CANCELLED; worker log shows the Claude abort; no push occurred.
10. **Merge guard**: `merge_task_pr` with a wrong `expectedHeadSha` →
    `EXPECTED_HEAD_MISMATCH`; with the correct SHA but `allowMerge` not granted
    and no `authorizeMerge` → `PERMISSION_DENIED`. (Optionally complete a real
    guarded merge on a throwaway PR with `authorizeMerge=true` after enabling
    `allow_merge` on the registry entry.)
11. **Restart durability**: redeploy the worker mid-task → task becomes
    `FAILED/WORKER_LOST` (or `WORKER_SHUTDOWN`) with the session resumable;
    `continue_repo_task` picks it back up after the deploy.
