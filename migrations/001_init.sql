-- Operava Claude Bridge — initial schema.
-- All durable state lives here: tasks, events, continuations, workflow runs,
-- the repository registry, idempotency keys, branch write locks, OAuth state,
-- and worker heartbeats. A Railway restart must never lose task state.

CREATE TABLE repositories (
    key                 TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    github_owner        TEXT NOT NULL,
    github_repo         TEXT NOT NULL,
    default_branch      TEXT NOT NULL DEFAULT 'main',
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    -- Repository-level permission ceilings. Task-level permissions may never
    -- exceed these, whatever the MCP caller asks for.
    allow_code_changes  BOOLEAN NOT NULL DEFAULT TRUE,
    allow_commit        BOOLEAN NOT NULL DEFAULT TRUE,
    allow_push          BOOLEAN NOT NULL DEFAULT TRUE,
    allow_open_pr       BOOLEAN NOT NULL DEFAULT TRUE,
    allow_update_pr     BOOLEAN NOT NULL DEFAULT TRUE,
    allow_merge         BOOLEAN NOT NULL DEFAULT FALSE,
    concurrency_limit   INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 1),
    instructions        TEXT,
    workflows           TEXT[] NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (github_owner, github_repo)
);

CREATE TABLE claude_tasks (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL CHECK (type IN ('ENGINEERING', 'ANALYSIS')),
    status              TEXT NOT NULL CHECK (status IN
                          ('QUEUED','PREPARING','RUNNING','WAITING','COMPLETED','FAILED','CANCEL_REQUESTED','CANCELLED')),
    phase               TEXT,
    attention_required  BOOLEAN NOT NULL DEFAULT FALSE,
    attention_reason    TEXT,
    repository_key      TEXT REFERENCES repositories(key),
    context_mode        TEXT CHECK (context_mode IN ('general','repository','branch','pr')),
    base_branch         TEXT,
    target_branch       TEXT,
    working_branch      TEXT,
    pr_number           INTEGER,
    pr_url              TEXT,
    objective           TEXT NOT NULL,
    execution_mode      TEXT NOT NULL CHECK (execution_mode IN ('WRITE','READ')),
    requested_model     TEXT,
    actual_model        TEXT,
    claude_session_id   TEXT,
    allow_code_changes  BOOLEAN NOT NULL DEFAULT FALSE,
    allow_commit        BOOLEAN NOT NULL DEFAULT FALSE,
    allow_push          BOOLEAN NOT NULL DEFAULT FALSE,
    allow_open_pr       BOOLEAN NOT NULL DEFAULT FALSE,
    allow_update_pr     BOOLEAN NOT NULL DEFAULT FALSE,
    allow_merge         BOOLEAN NOT NULL DEFAULT FALSE,
    max_turns           INTEGER,
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    head_sha_before     TEXT,
    head_sha_after      TEXT,
    expected_head_sha   TEXT,
    merged              BOOLEAN NOT NULL DEFAULT FALSE,
    merge_sha           TEXT,
    merged_at           TIMESTAMPTZ,
    exit_code           INTEGER,
    result_summary      TEXT,
    result_report       JSONB,
    report_parse_error  TEXT,
    raw_final_response  TEXT,
    error_code          TEXT,
    error_detail        TEXT,
    total_cost_usd      DOUBLE PRECISION,
    num_turns           INTEGER,
    claimed_by          TEXT,
    lease_expires_at    TIMESTAMPTZ,
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    claude_started      BOOLEAN NOT NULL DEFAULT FALSE,
    event_seq           INTEGER NOT NULL DEFAULT 0,
    workspace_path      TEXT,
    workspace_cleaned   BOOLEAN NOT NULL DEFAULT FALSE,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_tasks_status_created ON claude_tasks (status, created_at);
CREATE INDEX idx_tasks_repo_created   ON claude_tasks (repository_key, created_at DESC);
CREATE INDEX idx_tasks_lease          ON claude_tasks (lease_expires_at)
    WHERE status IN ('PREPARING','RUNNING','CANCEL_REQUESTED');
CREATE INDEX idx_tasks_pr             ON claude_tasks (repository_key, pr_number)
    WHERE pr_number IS NOT NULL;
CREATE INDEX idx_tasks_working_branch ON claude_tasks (repository_key, working_branch)
    WHERE working_branch IS NOT NULL;

CREATE TABLE claude_task_events (
    id          BIGSERIAL PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES claude_tasks(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    type        TEXT NOT NULL,
    message     TEXT NOT NULL,
    detail      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id, seq)
);

CREATE INDEX idx_task_events_task ON claude_task_events (task_id, seq DESC);

CREATE TABLE claude_continuations (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES claude_tasks(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    instruction     TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    result_summary  TEXT,
    error_code      TEXT,
    error_detail    TEXT,
    UNIQUE (task_id, seq)
);

CREATE INDEX idx_continuations_task ON claude_continuations (task_id, seq);

CREATE TABLE workflow_runs (
    id                  TEXT PRIMARY KEY,
    repository_key      TEXT NOT NULL REFERENCES repositories(key),
    workflow            TEXT NOT NULL,
    branch              TEXT,
    pr_number           INTEGER,
    parameters          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              TEXT NOT NULL CHECK (status IN
                          ('QUEUED','PREPARING','RUNNING','WAITING','COMPLETED','FAILED','CANCEL_REQUESTED','CANCELLED')),
    phase               TEXT,
    head_sha            TEXT,
    exit_code           INTEGER,
    output_summary      TEXT,
    findings            JSONB,
    artifacts           JSONB,
    error_code          TEXT,
    error_detail        TEXT,
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    claimed_by          TEXT,
    lease_expires_at    TIMESTAMPTZ,
    attempt_count       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_wfruns_status_created ON workflow_runs (status, created_at);
CREATE INDEX idx_wfruns_repo           ON workflow_runs (repository_key, created_at DESC);
CREATE INDEX idx_wfruns_lease          ON workflow_runs (lease_expires_at)
    WHERE status IN ('PREPARING','RUNNING','CANCEL_REQUESTED');

-- Mutating MCP tools persist idempotency keys so AI-driven retries are safe.
-- Same (scope, key) + same request hash => same resource returned.
-- Same (scope, key) + different request hash => IDEMPOTENCY_CONFLICT.
CREATE TABLE idempotency_keys (
    scope         TEXT NOT NULL,
    key           TEXT NOT NULL,
    request_hash  TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, key)
);

-- One writer per (repository, branch). Held by active write tasks; released
-- on terminal transition. Prevents two Claude tasks rewriting the same branch.
CREATE TABLE branch_locks (
    repository_key TEXT NOT NULL REFERENCES repositories(key),
    branch         TEXT NOT NULL,
    task_id        TEXT NOT NULL REFERENCES claude_tasks(id) ON DELETE CASCADE,
    acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (repository_key, branch)
);

CREATE INDEX idx_branch_locks_task ON branch_locks (task_id);

-- ===== OAuth 2.1 authorization server state (ChatGPT connector auth) =====

CREATE TABLE oauth_clients (
    client_id          TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    client_metadata    JSONB NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pending authorization requests between GET /authorize (consent page shown)
-- and the operator approving with the operator key.
CREATE TABLE oauth_pending_authorizations (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state          TEXT,
    scopes         TEXT[] NOT NULL DEFAULT '{}',
    resource       TEXT,
    expires_at     TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Issued authorization codes (stored hashed, single use, short lived).
CREATE TABLE oauth_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes         TEXT[] NOT NULL DEFAULT '{}',
    resource       TEXT,
    expires_at     TIMESTAMPTZ NOT NULL,
    consumed       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Issued access/refresh tokens (stored hashed; revocable).
CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    client_id  TEXT NOT NULL,
    scopes     TEXT[] NOT NULL DEFAULT '{}',
    resource   TEXT,
    expires_at TIMESTAMPTZ,
    revoked    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_tokens_client ON oauth_tokens (client_id);

CREATE TABLE workers (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL,
    hostname          TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
