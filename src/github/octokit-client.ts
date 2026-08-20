import { Octokit } from '@octokit/rest';
import { RequestError } from '@octokit/request-error';
import { BridgeError } from '../errors.js';
import type {
  AccessibleRepositoriesResult,
  AccessibleRepository,
  ChecksSummary,
  GitHubClient,
  MergeResult,
  PrInfo,
} from './types.js';

/**
 * Hard ceiling on repository-discovery pagination (100 repos per page, so
 * 10,000 repositories). Hitting it is reported as `truncated` rather than
 * silently dropping the tail.
 */
export const MAX_DISCOVERY_PAGES = 100;

export function createOctokitClient(opts: {
  token: string;
  baseUrl?: string;
  /** Test seam: inject a stub fetch instead of the global one. */
  fetch?: typeof globalThis.fetch;
}): GitHubClient {
  const octokit = new Octokit({
    auth: opts.token,
    baseUrl: opts.baseUrl,
    userAgent: 'operava-claude-bridge/1.0.0',
    ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
  });
  return new OctokitGitHubClient(octokit);
}

type OctokitPr = {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
};

function mapPr(pr: OctokitPr): PrInfo {
  return {
    number: pr.number,
    url: pr.html_url,
    state: pr.state === 'open' ? 'open' : 'closed',
    merged: Boolean(pr.merged ?? pr.merged_at),
    draft: Boolean(pr.draft),
    title: pr.title,
    body: pr.body,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? null,
  };
}

function mapError(err: unknown, context: string): BridgeError {
  if (err instanceof RequestError) {
    if (err.status === 401 || err.status === 403) {
      return new BridgeError('GIT_AUTH_ERROR', `GitHub rejected the bridge's credentials while ${context}.`, {
        detail: `status=${err.status}`,
      });
    }
    return new BridgeError('GITHUB_API_ERROR', `GitHub API error while ${context}: ${err.message}`, {
      detail: `status=${err.status}`,
    });
  }
  return new BridgeError('GITHUB_API_ERROR', `GitHub API failure while ${context}.`, {
    cause: err,
    detail: err instanceof Error ? err.message : String(err),
  });
}

type OctokitRepo = {
  name: string;
  owner: { login: string } | null;
  default_branch?: string;
};

function mapAccessibleRepo(r: OctokitRepo): AccessibleRepository | null {
  const owner = r.owner?.login;
  if (!owner || !r.name) return null;
  return { owner, repo: r.name, defaultBranch: r.default_branch || 'main' };
}

/**
 * Drain a paginated repository listing, stopping at MAX_DISCOVERY_PAGES and
 * reporting whether GitHub still had more pages to give.
 */
async function collectRepos(
  pages: AsyncIterable<{ data: unknown; headers: { link?: string } }>,
): Promise<AccessibleRepositoriesResult> {
  const repositories: AccessibleRepository[] = [];
  let seenPages = 0;
  let truncated = false;
  for await (const response of pages) {
    // The paginate plugin normalizes {total_count, repositories} payloads into
    // an array; tolerate both shapes anyway.
    const items: OctokitRepo[] = Array.isArray(response.data)
      ? (response.data as OctokitRepo[])
      : ((response.data as { repositories?: OctokitRepo[] }).repositories ?? []);
    for (const item of items) {
      const mapped = mapAccessibleRepo(item);
      if (mapped) repositories.push(mapped);
    }
    seenPages += 1;
    if (seenPages >= MAX_DISCOVERY_PAGES) {
      truncated = (response.headers.link ?? '').includes('rel="next"');
      break;
    }
  }
  return { repositories, truncated };
}

class OctokitGitHubClient implements GitHubClient {
  constructor(private readonly octokit: Octokit) {}

  async listAccessibleRepositories(): Promise<AccessibleRepositoriesResult> {
    const context = 'listing repositories accessible to the bridge credentials';
    try {
      return await collectRepos(
        this.octokit.paginate.iterator(this.octokit.repos.listForAuthenticatedUser, {
          per_page: 100,
          affiliation: 'owner,collaborator,organization_member',
          sort: 'full_name',
        }),
      );
    } catch (err) {
      // GitHub App installation tokens cannot call /user/repos ("Resource not
      // accessible by integration"); they enumerate via /installation/repositories.
      if (err instanceof RequestError && err.status === 403) {
        try {
          return await collectRepos(
            this.octokit.paginate.iterator(this.octokit.apps.listReposAccessibleToInstallation, {
              per_page: 100,
            }),
          );
        } catch (fallbackErr) {
          throw mapError(fallbackErr, context);
        }
      }
      throw mapError(err, context);
    }
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PrInfo | null> {
    try {
      const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: number });
      return mapPr(data as OctokitPr);
    } catch (err) {
      if (err instanceof RequestError && err.status === 404) return null;
      throw mapError(err, `fetching PR #${number}`);
    }
  }

  async findOpenPrByHead(owner: string, repo: string, headBranch: string): Promise<PrInfo | null> {
    try {
      const { data } = await this.octokit.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${headBranch}`,
        per_page: 1,
      });
      const first = data[0];
      if (!first) return null;
      // pulls.list does not include mergeable fields; refetch for the full view.
      return this.getPullRequest(owner, repo, first.number);
    } catch (err) {
      throw mapError(err, `finding open PR for ${headBranch}`);
    }
  }

  async createPullRequest(
    owner: string,
    repo: string,
    params: { title: string; body: string; head: string; base: string; draft?: boolean },
  ): Promise<PrInfo> {
    try {
      const { data } = await this.octokit.pulls.create({
        owner,
        repo,
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
        draft: params.draft ?? false,
      });
      return mapPr(data as OctokitPr);
    } catch (err) {
      // "A pull request already exists" — resolve to the existing PR instead of failing,
      // so retries never create duplicates.
      if (err instanceof RequestError && err.status === 422 && /already exists/i.test(err.message)) {
        const existing = await this.findOpenPrByHead(owner, repo, params.head);
        if (existing) return existing;
      }
      throw mapError(err, `creating PR for ${params.head}`);
    }
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    params: { title?: string; body?: string },
  ): Promise<PrInfo> {
    try {
      const { data } = await this.octokit.pulls.update({
        owner,
        repo,
        pull_number: number,
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.body !== undefined ? { body: params.body } : {}),
      });
      return mapPr(data as OctokitPr);
    } catch (err) {
      throw mapError(err, `updating PR #${number}`);
    }
  }

  async createPrComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    try {
      await this.octokit.issues.createComment({ owner, repo, issue_number: number, body });
    } catch (err) {
      throw mapError(err, `commenting on PR #${number}`);
    }
  }

  async getChecksSummary(owner: string, repo: string, sha: string): Promise<ChecksSummary> {
    try {
      const [status, checks] = await Promise.all([
        this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 }),
        this.octokit.checks.listForRef({ owner, repo, ref: sha, per_page: 100 }),
      ]);

      const failing: string[] = [];
      const pending: string[] = [];
      for (const s of status.data.statuses) {
        if (s.state === 'failure' || s.state === 'error') failing.push(s.context);
        else if (s.state === 'pending') pending.push(s.context);
      }
      for (const run of checks.data.check_runs) {
        if (run.status !== 'completed') {
          pending.push(run.name);
        } else if (
          run.conclusion &&
          ['failure', 'timed_out', 'cancelled', 'action_required', 'stale'].includes(run.conclusion)
        ) {
          failing.push(run.name);
        }
      }
      const total = status.data.total_count + checks.data.total_count;
      const state: ChecksSummary['state'] =
        failing.length > 0 ? 'failure' : pending.length > 0 ? 'pending' : total === 0 ? 'none' : 'success';
      return { state, total, failing, pending };
    } catch (err) {
      throw mapError(err, `reading checks for ${sha.slice(0, 12)}`);
    }
  }

  async countUnresolvedReviewThreads(owner: string, repo: string, number: number): Promise<number | null> {
    try {
      const result = await this.octokit.graphql<{
        repository: {
          pullRequest: { reviewThreads: { nodes: { isResolved: boolean }[] } } | null;
        };
      }>(
        `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) { nodes { isResolved } }
            }
          }
        }`,
        { owner, repo, number },
      );
      const nodes = result.repository.pullRequest?.reviewThreads.nodes ?? [];
      return nodes.filter((n) => !n.isResolved).length;
    } catch {
      // Review-thread data is optional context; report "inaccessible" rather than failing.
      return null;
    }
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    params: { expectedHeadSha: string; commitTitle?: string; method?: 'squash' | 'merge' | 'rebase' },
  ): Promise<MergeResult> {
    try {
      const { data } = await this.octokit.pulls.merge({
        owner,
        repo,
        pull_number: number,
        merge_method: params.method ?? 'squash',
        sha: params.expectedHeadSha,
        ...(params.commitTitle ? { commit_title: params.commitTitle } : {}),
      });
      return { merged: data.merged, sha: data.sha ?? null, message: data.message };
    } catch (err) {
      if (err instanceof RequestError && err.status === 409) {
        throw new BridgeError(
          'EXPECTED_HEAD_MISMATCH',
          `PR #${number} head changed since verification — refusing to merge. Re-verify the new head first.`,
          { detail: err.message },
        );
      }
      if (err instanceof RequestError && err.status === 405) {
        throw new BridgeError('MERGE_BLOCKED', `GitHub refused the merge of PR #${number}: ${err.message}`, {
          detail: 'Branch protection, failing checks, or PR state prevents merging.',
        });
      }
      throw mapError(err, `merging PR #${number}`);
    }
  }

  async getBranchHead(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
      return data.object.sha;
    } catch (err) {
      if (err instanceof RequestError && err.status === 404) return null;
      throw mapError(err, `resolving branch ${branch}`);
    }
  }
}
