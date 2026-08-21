/**
 * GitHub integration boundary.
 *
 * v1 authenticates with a server-side token (fine-grained PAT or GitHub App
 * installation token supplied via GITHUB_TOKEN). Everything the bridge needs
 * from GitHub goes through this interface, so migrating to a GitHub App that
 * mints installation tokens is a drop-in replacement of the implementation —
 * no call sites change. Tokens are never exposed through MCP.
 */

export interface PrInfo {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  title: string;
  body: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  /** GitHub's computed mergeability; null while GitHub is still calculating. */
  mergeable: boolean | null;
  mergeableState: string | null;
}

export type ChecksState = 'success' | 'failure' | 'pending' | 'none';

export interface ChecksSummary {
  state: ChecksState;
  total: number;
  failing: string[];
  pending: string[];
}

export interface MergeResult {
  merged: boolean;
  sha: string | null;
  message: string;
}

/** A repository the configured GITHUB_TOKEN can reach. */
export interface AccessibleRepository {
  owner: string;
  repo: string;
  defaultBranch: string;
}

export interface AccessibleRepositoriesResult {
  repositories: AccessibleRepository[];
  /** True when the page cap stopped enumeration before GitHub ran out of pages. */
  truncated: boolean;
}

export interface GitHubClient {
  /**
   * Every repository the bridge's credentials can reach, across all pages.
   * Used at boot to populate the repository registry so production never
   * starts with an empty allowlist.
   */
  listAccessibleRepositories(): Promise<AccessibleRepositoriesResult>;
  getPullRequest(owner: string, repo: string, number: number): Promise<PrInfo | null>;
  findOpenPrByHead(owner: string, repo: string, headBranch: string): Promise<PrInfo | null>;
  createPullRequest(
    owner: string,
    repo: string,
    params: { title: string; body: string; head: string; base: string; draft?: boolean },
  ): Promise<PrInfo>;
  updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    params: { title?: string; body?: string },
  ): Promise<PrInfo>;
  createPrComment(owner: string, repo: string, number: number, body: string): Promise<void>;
  getChecksSummary(owner: string, repo: string, sha: string): Promise<ChecksSummary>;
  /** Returns null when review-thread data is not accessible with current credentials. */
  countUnresolvedReviewThreads(owner: string, repo: string, number: number): Promise<number | null>;
  /**
   * Squash-merge with expected-head protection: fails with
   * EXPECTED_HEAD_MISMATCH when the PR head moved past expectedHeadSha.
   */
  mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    params: { expectedHeadSha: string; commitTitle?: string; method?: 'squash' | 'merge' | 'rebase' },
  ): Promise<MergeResult>;
  getBranchHead(owner: string, repo: string, branch: string): Promise<string | null>;
}
