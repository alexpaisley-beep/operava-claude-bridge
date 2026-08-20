import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './git.js';
import { assertValidBranchName, assertValidRepoKey, isValidSha } from './validate.js';
import { truncateUtf8 } from '../db/events.js';
import { BridgeError } from '../errors.js';
import type { RepositoryConfig } from '../domain/types.js';
import type { Logger } from '../logger.js';

/**
 * Repository workspace manager.
 *
 * Layout under workspaceRoot:
 *   cache/<repoKey>.git   — shared bare mirror, refreshed before each task
 *   tasks/<taskId>        — isolated per-task clone (hardlinked objects, cheap)
 *   runs/<workflowRunId>  — isolated per-workflow-run clone
 *
 * Every task gets its own full working copy, so concurrent tasks can never
 * corrupt each other. Task clones talk to GitHub directly (origin is rewritten
 * after the local clone); credentials are injected per git invocation and only
 * for bridge-controlled operations — Claude's subprocess environment never
 * receives them.
 */

export interface WorkspaceInfo {
  dir: string;
  headSha: string;
  branchExistedOnRemote: boolean;
}

export interface CommitInfo {
  sha: string;
  message: string;
}

export class WorkspaceManager {
  private readonly repoMutexes = new Map<string, Promise<unknown>>();

  constructor(
    private readonly opts: {
      workspaceRoot: string;
      gitUserName: string;
      gitUserEmail: string;
      logger: Logger;
      tokenProvider: () => string | undefined;
      /** Override the remote URL (tests use local bare repos; GH Enterprise later). */
      remoteUrlFor?: (repo: RepositoryConfig) => string;
    },
  ) {}

  cachePath(repoKey: string): string {
    assertValidRepoKey(repoKey);
    return path.join(this.opts.workspaceRoot, 'cache', `${repoKey}.git`);
  }

  taskPath(taskId: string): string {
    if (!/^[a-z0-9_]+$/i.test(taskId)) {
      throw new BridgeError('VALIDATION_ERROR', `Invalid task id for workspace path: ${taskId}`);
    }
    return path.join(this.opts.workspaceRoot, 'tasks', taskId);
  }

  runPath(runId: string): string {
    if (!/^[a-z0-9_]+$/i.test(runId)) {
      throw new BridgeError('VALIDATION_ERROR', `Invalid run id for workspace path: ${runId}`);
    }
    return path.join(this.opts.workspaceRoot, 'runs', runId);
  }

  private remoteUrl(repo: RepositoryConfig): string {
    return this.opts.remoteUrlFor?.(repo) ?? `https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`;
  }

  /** Serialize cache operations per repository within this process. */
  private async withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.repoMutexes.get(repoKey) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.repoMutexes.set(
      repoKey,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Create or refresh the shared bare mirror for a repository. */
  async ensureCache(repo: RepositoryConfig): Promise<void> {
    await this.withRepoLock(repo.key, async () => {
      const cache = this.cachePath(repo.key);
      const token = this.opts.tokenProvider();
      const exists = await pathExists(path.join(cache, 'HEAD'));
      if (!exists) {
        await fs.mkdir(path.dirname(cache), { recursive: true });
        await runGit(['clone', '--mirror', '--', this.remoteUrl(repo), cache], {
          token,
          timeoutMs: 600_000,
        });
      } else {
        await runGit(['--git-dir', cache, 'remote', 'update', '--prune'], {
          token,
          timeoutMs: 600_000,
        });
      }
    });
  }

  /**
   * Create an isolated working copy for a task/run.
   * - `baseBranch` must exist on the remote (BRANCH_NOT_FOUND otherwise).
   * - `workingBranch` is checked out if it already exists remotely, otherwise
   *   created locally from the base branch.
   * - `detachAtRef` (e.g. a PR head ref) wins over branch checkout when given.
   */
  async createWorkspace(params: {
    dir: string;
    repo: RepositoryConfig;
    baseBranch: string;
    workingBranch?: string;
    /** Fail with BRANCH_NOT_FOUND instead of creating the working branch. */
    requireWorkingBranch?: boolean;
    /** Fetch this PR's head ref; with no workingBranch, check out detached at it. */
    fetchPrNumber?: number;
  }): Promise<WorkspaceInfo> {
    const { dir, repo } = params;
    assertValidBranchName(params.baseBranch, 'base branch');
    if (params.workingBranch) assertValidBranchName(params.workingBranch, 'working branch');

    await this.ensureCache(repo);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });

    const cache = this.cachePath(repo.key);
    await runGit(['clone', '--no-checkout', '--', cache, dir], { timeoutMs: 300_000 });
    await runGit(['-C', dir, 'remote', 'set-url', 'origin', this.remoteUrl(repo)]);
    await runGit(['-C', dir, 'config', 'user.name', this.opts.gitUserName]);
    await runGit(['-C', dir, 'config', 'user.email', this.opts.gitUserEmail]);
    await runGit(['-C', dir, 'config', 'commit.gpgsign', 'false']);
    await runGit(['-C', dir, 'config', 'gc.auto', '0']);

    const token = this.opts.tokenProvider();
    if (params.fetchPrNumber !== undefined) {
      await runGit(
        ['-C', dir, 'fetch', 'origin', `+refs/pull/${params.fetchPrNumber}/head:refs/remotes/origin/pr/${params.fetchPrNumber}`],
        { token, timeoutMs: 300_000 },
      );
    }

    const baseRef = `refs/remotes/origin/${params.baseBranch}`;
    const baseSha = await this.revParse(dir, baseRef);
    if (!baseSha) {
      throw new BridgeError(
        'BRANCH_NOT_FOUND',
        `Base branch "${params.baseBranch}" does not exist in ${repo.githubOwner}/${repo.githubRepo}.`,
      );
    }

    let headSha: string;
    let branchExistedOnRemote = false;
    if (params.workingBranch) {
      const remoteWorking = await this.revParse(dir, `refs/remotes/origin/${params.workingBranch}`);
      if (remoteWorking) {
        branchExistedOnRemote = true;
        await runGit(['-C', dir, 'checkout', '-B', params.workingBranch, remoteWorking, '--']);
        headSha = remoteWorking;
      } else if (params.requireWorkingBranch) {
        throw new BridgeError(
          'BRANCH_NOT_FOUND',
          `Branch "${params.workingBranch}" does not exist in ${repo.githubOwner}/${repo.githubRepo}.`,
        );
      } else {
        await runGit(['-C', dir, 'checkout', '-B', params.workingBranch, baseSha, '--']);
        headSha = baseSha;
      }
    } else if (params.fetchPrNumber !== undefined) {
      const prSha = await this.revParse(dir, `refs/remotes/origin/pr/${params.fetchPrNumber}`);
      if (!prSha) {
        throw new BridgeError('PR_NOT_FOUND', `PR #${params.fetchPrNumber} head ref could not be fetched.`);
      }
      await runGit(['-C', dir, 'checkout', '--detach', prSha, '--']);
      headSha = prSha;
    } else {
      await runGit(['-C', dir, 'checkout', '--detach', baseSha, '--']);
      headSha = baseSha;
    }

    return { dir, headSha, branchExistedOnRemote };
  }

  async currentBranch(dir: string): Promise<string | null> {
    const result = await runGit(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
    const name = result.stdout.trim();
    return result.code === 0 && name !== 'HEAD' ? name : null;
  }

  /** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
  async isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await runGit(['-C', dir, 'merge-base', '--is-ancestor', ancestor, descendant], {
      allowFailure: true,
    });
    return result.code === 0;
  }

  /** Hard-set the working branch to a specific commit (used for safe fast-forwards). */
  async resetBranchTo(dir: string, branch: string, sha: string): Promise<void> {
    assertValidBranchName(branch);
    await runGit(['-C', dir, 'checkout', '-B', branch, sha, '--']);
  }

  async revParse(dir: string, ref: string): Promise<string | null> {
    const result = await runGit(['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      allowFailure: true,
    });
    const sha = result.stdout.trim();
    return result.code === 0 && isValidSha(sha) ? sha : null;
  }

  async currentHead(dir: string): Promise<string> {
    const result = await runGit(['-C', dir, 'rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  /** Fetch latest refs for a branch from GitHub into an existing workspace. */
  async fetchBranch(dir: string, branch: string): Promise<string | null> {
    assertValidBranchName(branch);
    await runGit(
      ['-C', dir, 'fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { token: this.opts.tokenProvider(), timeoutMs: 300_000, allowFailure: true },
    );
    return this.revParse(dir, `refs/remotes/origin/${branch}`);
  }

  async listNewCommits(dir: string, sinceSha: string): Promise<CommitInfo[]> {
    const result = await runGit(
      ['-C', dir, 'log', '--format=%H%x1f%s', `${sinceSha}..HEAD`],
      { allowFailure: true },
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [sha, message] = line.split('\x1f');
        return { sha: sha ?? '', message: message ?? '' };
      })
      .reverse();
  }

  async isDirty(dir: string): Promise<boolean> {
    const result = await runGit(['-C', dir, 'status', '--porcelain']);
    return result.stdout.trim().length > 0;
  }

  /** Stage everything and commit as the bridge identity. Returns the new SHA or null when nothing to commit. */
  async commitAll(dir: string, message: string): Promise<string | null> {
    await runGit(['-C', dir, 'add', '--all']);
    const staged = await runGit(['-C', dir, 'diff', '--cached', '--quiet'], { allowFailure: true });
    if (staged.code === 0) return null;
    await runGit(['-C', dir, 'commit', '--no-verify', '-m', message]);
    return this.currentHead(dir);
  }

  /** Push the working branch. Never force-pushes. */
  async push(dir: string, branch: string): Promise<string> {
    assertValidBranchName(branch);
    await runGit(['-C', dir, 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], {
      token: this.opts.tokenProvider(),
      timeoutMs: 300_000,
    });
    return this.currentHead(dir);
  }

  async diffStat(dir: string, fromRef: string, toRef: string): Promise<string> {
    const result = await runGit(['-C', dir, 'diff', '--stat', `${fromRef}...${toRef}`, '--'], {
      allowFailure: true,
    });
    return result.code === 0 ? result.stdout : '';
  }

  async diffText(dir: string, fromRef: string, toRef: string, maxBytes: number): Promise<string> {
    const result = await runGit(['-C', dir, 'diff', `${fromRef}...${toRef}`, '--'], {
      allowFailure: true,
      maxOutputBytes: Math.max(maxBytes * 4, 16 * 1024 * 1024),
    });
    if (result.code !== 0) return '';
    return truncateUtf8(result.stdout, maxBytes);
  }

  async changedFilesSummary(dir: string, sinceSha: string): Promise<string> {
    const result = await runGit(
      ['-C', dir, 'diff', '--name-status', `${sinceSha}..HEAD`, '--'],
      { allowFailure: true },
    );
    return result.code === 0 ? truncateUtf8(result.stdout, 8000) : '';
  }

  async removeWorkspace(dir: string): Promise<void> {
    const root = path.resolve(this.opts.workspaceRoot);
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(root + path.sep)) {
      throw new BridgeError('WORKSPACE_ERROR', `Refusing to remove path outside workspace root: ${dir}`);
    }
    await fs.rm(resolved, { recursive: true, force: true });
    this.opts.logger.debug({ dir: resolved }, 'workspace removed');
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
