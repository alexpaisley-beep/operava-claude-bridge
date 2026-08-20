import type { Queryable } from './pool.js';
import type { RepositoryConfig } from '../domain/types.js';
import { assertValidBranchName, assertValidGitHubName, assertValidRepoKey } from '../gitx/validate.js';

interface RepoRow {
  key: string;
  github_owner: string;
  github_repo: string;
  default_branch: string;
  enabled: boolean;
  allow_code_changes: boolean;
  allow_commit: boolean;
  allow_push: boolean;
  allow_open_pr: boolean;
  allow_update_pr: boolean;
  allow_merge: boolean;
  concurrency_limit: number;
  instructions: string | null;
  workflows: string[];
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `key, github_owner, github_repo, default_branch, enabled,
  allow_code_changes, allow_commit, allow_push, allow_open_pr, allow_update_pr,
  allow_merge, concurrency_limit, instructions, workflows, created_at, updated_at`;

function mapRow(r: RepoRow): RepositoryConfig {
  return {
    key: r.key,
    githubOwner: r.github_owner,
    githubRepo: r.github_repo,
    defaultBranch: r.default_branch,
    enabled: r.enabled,
    allowCodeChanges: r.allow_code_changes,
    allowCommit: r.allow_commit,
    allowPush: r.allow_push,
    allowOpenPr: r.allow_open_pr,
    allowUpdatePr: r.allow_update_pr,
    allowMerge: r.allow_merge,
    concurrencyLimit: r.concurrency_limit,
    instructions: r.instructions,
    workflows: r.workflows ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface RepositoryUpsert {
  key: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch?: string;
  enabled?: boolean;
  allowCodeChanges?: boolean;
  allowCommit?: boolean;
  allowPush?: boolean;
  allowOpenPr?: boolean;
  allowUpdatePr?: boolean;
  allowMerge?: boolean;
  concurrencyLimit?: number;
  instructions?: string | null;
  workflows?: string[];
}

export async function upsertRepository(q: Queryable, r: RepositoryUpsert): Promise<RepositoryConfig> {
  // Central chokepoint: these values end up in clone URLs and git argv.
  assertValidRepoKey(r.key);
  assertValidGitHubName(r.githubOwner, 'owner');
  assertValidGitHubName(r.githubRepo, 'repository name');
  if (r.defaultBranch !== undefined) assertValidBranchName(r.defaultBranch, 'default branch');
  const { rows } = await q.query<RepoRow>(
    `INSERT INTO repositories (
       key, github_owner, github_repo, default_branch, enabled,
       allow_code_changes, allow_commit, allow_push, allow_open_pr,
       allow_update_pr, allow_merge, concurrency_limit, instructions, workflows
     ) VALUES (
       $1, $2, $3, COALESCE($4, 'main'), COALESCE($5, TRUE),
       COALESCE($6, TRUE), COALESCE($7, TRUE), COALESCE($8, TRUE), COALESCE($9, TRUE),
       COALESCE($10, TRUE), COALESCE($11, FALSE), COALESCE($12, 1), $13, COALESCE($14::text[], '{}'::text[])
     )
     ON CONFLICT (key) DO UPDATE SET
       github_owner = EXCLUDED.github_owner,
       github_repo = EXCLUDED.github_repo,
       default_branch = COALESCE($4, repositories.default_branch),
       enabled = COALESCE($5, repositories.enabled),
       allow_code_changes = COALESCE($6, repositories.allow_code_changes),
       allow_commit = COALESCE($7, repositories.allow_commit),
       allow_push = COALESCE($8, repositories.allow_push),
       allow_open_pr = COALESCE($9, repositories.allow_open_pr),
       allow_update_pr = COALESCE($10, repositories.allow_update_pr),
       allow_merge = COALESCE($11, repositories.allow_merge),
       concurrency_limit = COALESCE($12, repositories.concurrency_limit),
       instructions = COALESCE($13, repositories.instructions),
       workflows = COALESCE($14::text[], repositories.workflows),
       updated_at = now()
     RETURNING ${COLUMNS}`,
    [
      r.key,
      r.githubOwner,
      r.githubRepo,
      r.defaultBranch ?? null,
      r.enabled ?? null,
      r.allowCodeChanges ?? null,
      r.allowCommit ?? null,
      r.allowPush ?? null,
      r.allowOpenPr ?? null,
      r.allowUpdatePr ?? null,
      r.allowMerge ?? null,
      r.concurrencyLimit ?? null,
      r.instructions ?? null,
      r.workflows ?? null,
    ],
  );
  return mapRow(rows[0] as RepoRow);
}

export async function getRepository(q: Queryable, key: string): Promise<RepositoryConfig | null> {
  const { rows } = await q.query<RepoRow>(
    `SELECT ${COLUMNS} FROM repositories WHERE key = $1`,
    [key],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listRepositories(
  q: Queryable,
  opts: { enabledOnly?: boolean } = {},
): Promise<RepositoryConfig[]> {
  const { rows } = await q.query<RepoRow>(
    `SELECT ${COLUMNS} FROM repositories ${opts.enabledOnly ? 'WHERE enabled = TRUE' : ''} ORDER BY key`,
  );
  return rows.map(mapRow);
}

export async function setRepositoryEnabled(
  q: Queryable,
  key: string,
  enabled: boolean,
): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE repositories SET enabled = $2, updated_at = now() WHERE key = $1`,
    [key, enabled],
  );
  return (rowCount ?? 0) > 0;
}
