import { BridgeError } from '../errors.js';
import type { ChecksSummary, GitHubClient, MergeResult, PrInfo } from './types.js';

/**
 * In-memory GitHub client for tests and credential-less local development.
 * Behavior mirrors the real client's contract, including expected-head
 * protection and duplicate-PR prevention.
 */
export class MockGitHubClient implements GitHubClient {
  prs = new Map<string, PrInfo>();
  branchHeads = new Map<string, string>();
  checks = new Map<string, ChecksSummary>();
  unresolvedThreads = new Map<string, number | null>();
  comments: { key: string; body: string }[] = [];
  private nextPrNumber = 100;

  private key(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${number}`;
  }

  private branchKey(owner: string, repo: string, branch: string): string {
    return `${owner}/${repo}@${branch}`;
  }

  setBranchHead(owner: string, repo: string, branch: string, sha: string): void {
    this.branchHeads.set(this.branchKey(owner, repo, branch), sha);
  }

  setChecks(owner: string, repo: string, sha: string, summary: ChecksSummary): void {
    this.checks.set(`${owner}/${repo}@${sha}`, summary);
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PrInfo | null> {
    return this.prs.get(this.key(owner, repo, number)) ?? null;
  }

  async findOpenPrByHead(owner: string, repo: string, headBranch: string): Promise<PrInfo | null> {
    for (const pr of this.prs.values()) {
      if (pr.headRef === headBranch && pr.state === 'open') return pr;
    }
    return null;
  }

  async createPullRequest(
    owner: string,
    repo: string,
    params: { title: string; body: string; head: string; base: string; draft?: boolean },
  ): Promise<PrInfo> {
    const existing = await this.findOpenPrByHead(owner, repo, params.head);
    if (existing) return existing;
    const number = this.nextPrNumber++;
    const pr: PrInfo = {
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
      state: 'open',
      merged: false,
      draft: params.draft ?? false,
      title: params.title,
      body: params.body,
      headRef: params.head,
      headSha: this.branchHeads.get(this.branchKey(owner, repo, params.head)) ?? 'a'.repeat(40),
      baseRef: params.base,
      mergeable: true,
      mergeableState: 'clean',
    };
    this.prs.set(this.key(owner, repo, number), pr);
    return pr;
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    params: { title?: string; body?: string },
  ): Promise<PrInfo> {
    const pr = this.prs.get(this.key(owner, repo, number));
    if (!pr) throw new BridgeError('PR_NOT_FOUND', `PR #${number} not found`);
    if (params.title !== undefined) pr.title = params.title;
    if (params.body !== undefined) pr.body = params.body;
    return pr;
  }

  async createPrComment(owner: string, repo: string, number: number, body: string): Promise<void> {
    this.comments.push({ key: this.key(owner, repo, number), body });
  }

  async getChecksSummary(owner: string, repo: string, sha: string): Promise<ChecksSummary> {
    return (
      this.checks.get(`${owner}/${repo}@${sha}`) ?? { state: 'none', total: 0, failing: [], pending: [] }
    );
  }

  async countUnresolvedReviewThreads(owner: string, repo: string, number: number): Promise<number | null> {
    const value = this.unresolvedThreads.get(this.key(owner, repo, number));
    return value === undefined ? 0 : value;
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    params: { expectedHeadSha: string; commitTitle?: string; method?: 'squash' | 'merge' | 'rebase' },
  ): Promise<MergeResult> {
    const pr = this.prs.get(this.key(owner, repo, number));
    if (!pr) throw new BridgeError('PR_NOT_FOUND', `PR #${number} not found`);
    if (pr.merged) {
      return { merged: true, sha: `merged-${pr.number}`, message: 'Already merged' };
    }
    if (pr.headSha !== params.expectedHeadSha) {
      throw new BridgeError(
        'EXPECTED_HEAD_MISMATCH',
        `PR #${number} head changed since verification — refusing to merge. Re-verify the new head first.`,
      );
    }
    if (pr.mergeable === false) {
      throw new BridgeError('MERGE_BLOCKED', `GitHub refused the merge of PR #${number}.`);
    }
    pr.merged = true;
    pr.state = 'closed';
    return { merged: true, sha: `merged-${pr.number}`, message: 'Pull Request successfully merged' };
  }

  async getBranchHead(owner: string, repo: string, branch: string): Promise<string | null> {
    return this.branchHeads.get(this.branchKey(owner, repo, branch)) ?? null;
  }
}
