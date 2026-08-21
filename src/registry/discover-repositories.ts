import type { Db } from '../db/pool.js';
import { listRepositories, upsertRepository } from '../db/repositories.js';
import type { GitHubClient } from '../github/types.js';
import { sha256Hex } from '../ids.js';
import type { Logger } from '../logger.js';

/**
 * Registry bootstrap from GitHub: every repository the configured GITHUB_TOKEN
 * can reach is registered at boot, so a fresh production deployment never comes
 * up with an empty allowlist.
 *
 * Discovery only ever *adds* entries. Repositories already in the registry —
 * from REPOSITORIES_FILE, the `repos` CLI, or an earlier discovery run — are
 * left exactly as they are, so explicit configuration keeps winning and a
 * disabled repository is never silently re-enabled. Permission ceilings stay a
 * server-side decision: newly discovered repositories get normal engineering
 * permissions (code changes, commits, pushes, PR create/update) with merge
 * disabled, and a concurrency limit of 1.
 */

/** Server-side ceilings applied to a newly discovered repository. */
export const DISCOVERED_REPOSITORY_DEFAULTS = {
  enabled: true,
  allowCodeChanges: true,
  allowCommit: true,
  allowPush: true,
  allowOpenPr: true,
  allowUpdatePr: true,
  allowMerge: false,
  concurrencyLimit: 1,
} as const;

const KEY_MAX_LENGTH = 64;
const HASH_LENGTH = 6;

function canonicalPair(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function shortHash(owner: string, repo: string): string {
  return sha256Hex(canonicalPair(owner, repo)).slice(0, HASH_LENGTH);
}

function baseKey(owner: string, repo: string): string {
  return canonicalPair(owner, repo)
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-_]+$/, '');
}

function withHash(base: string, owner: string, repo: string): string {
  const stem =
    base.slice(0, KEY_MAX_LENGTH - HASH_LENGTH - 1).replace(/[-_]+$/, '') || 'repo';
  return `${stem}-${shortHash(owner, repo)}`;
}

/**
 * Stable registry key for a GitHub repository: `owner/repo` lowercased with
 * everything outside `[a-z0-9_-]` folded to `-`. Over-long keys are truncated
 * and suffixed with a hash of the full `owner/repo` so they stay unique and
 * reproducible across runs.
 */
export function repositoryKeyFor(owner: string, repo: string): string {
  const base = baseKey(owner, repo);
  if (base.length === 0) return `repo-${shortHash(owner, repo)}`;
  return base.length <= KEY_MAX_LENGTH ? base : withHash(base, owner, repo);
}

/**
 * Deterministic alternative used when the preferred key is already taken by a
 * different repository (e.g. `acme/foo-bar` and `acme-foo/bar` both fold to
 * `acme-foo-bar`).
 */
export function disambiguatedRepositoryKeyFor(owner: string, repo: string): string {
  return withHash(baseKey(owner, repo), owner, repo);
}

export interface DiscoverySummary {
  /** Distinct repositories reported by GitHub. */
  discovered: number;
  /** Newly added registry entries. */
  registered: number;
  /** Already registered; left untouched (explicit config and disabled repos). */
  existing: number;
  /** Reported by GitHub but not registerable (invalid names, key exhaustion). */
  skipped: number;
  /** GitHub had more pages than the discovery page cap allows. */
  truncated: boolean;
}

export async function syncRepositoriesFromGitHub(
  db: Db,
  github: GitHubClient,
  logger: Logger,
): Promise<DiscoverySummary> {
  const { repositories, truncated } = await github.listAccessibleRepositories();

  // GitHub can return the same repository on more than one page (a write
  // between page fetches shifts the window); dedupe on owner/repo, and sort so
  // key assignment does not depend on GitHub's ordering.
  const unique = new Map<string, { owner: string; repo: string; defaultBranch: string }>();
  for (const r of repositories) {
    const pair = canonicalPair(r.owner, r.repo);
    if (!unique.has(pair)) unique.set(pair, r);
  }
  const discovered = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // Existing entries are matched by owner/repo, not by key, so a repository
  // registered under a hand-picked key is recognised and left alone.
  const registered = await listRepositories(db);
  const knownPairs = new Set(registered.map((r) => canonicalPair(r.githubOwner, r.githubRepo)));
  const usedKeys = new Set(registered.map((r) => r.key));

  const summary: DiscoverySummary = {
    discovered: discovered.length,
    registered: 0,
    existing: 0,
    skipped: 0,
    truncated,
  };

  for (const [pair, repo] of discovered) {
    if (knownPairs.has(pair)) {
      summary.existing += 1;
      continue;
    }
    let key = repositoryKeyFor(repo.owner, repo.repo);
    if (usedKeys.has(key)) key = disambiguatedRepositoryKeyFor(repo.owner, repo.repo);
    if (usedKeys.has(key)) {
      summary.skipped += 1;
      logger.warn({ github: pair, key }, 'skipping discovered repository: registry key already in use');
      continue;
    }
    try {
      await upsertRepository(db, {
        key,
        githubOwner: repo.owner,
        githubRepo: repo.repo,
        defaultBranch: repo.defaultBranch,
        ...DISCOVERED_REPOSITORY_DEFAULTS,
      });
    } catch (err) {
      // One unusable repository (a name or default branch our validators
      // reject) must not stop the rest from being registered.
      summary.skipped += 1;
      logger.warn({ err, github: pair, key }, 'skipping discovered repository: registration rejected');
      continue;
    }
    knownPairs.add(pair);
    usedKeys.add(key);
    summary.registered += 1;
    logger.info({ repository: key, github: pair }, 'repository registered from GitHub discovery');
  }

  if (truncated) {
    logger.warn(
      { discovered: summary.discovered },
      'GitHub repository discovery hit its page cap; some repositories were not enumerated',
    );
  }
  return summary;
}
