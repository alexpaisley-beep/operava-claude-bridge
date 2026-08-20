import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getRepository,
  listRepositories,
  setRepositoryEnabled,
  upsertRepository,
} from '../../src/db/repositories.js';
import { BridgeError } from '../../src/errors.js';
import type { GitHubClient } from '../../src/github/types.js';
import { bootstrapRepositoryRegistry } from '../../src/registry/bootstrap.js';
import { syncRepositoriesFromGitHub } from '../../src/registry/discover-repositories.js';
import { listRepositoriesView } from '../../src/services/workflow-service.js';
import { createTestContext, type TestContext } from '../helpers/test-env.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.destroy();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM repositories');
  ctx.github.accessibleRepos = [];
  ctx.github.accessibleReposTruncated = false;
});

const sync = () => syncRepositoriesFromGitHub(ctx.db, ctx.github, ctx.logger);

describe('GitHub repository discovery', () => {
  it('registers every accessible repository with engineering defaults and merge disabled', async () => {
    ctx.github.accessibleRepos = [
      { owner: 'Operava', repo: 'growth-engine', defaultBranch: 'trunk' },
      { owner: 'operava', repo: 'docs', defaultBranch: 'main' },
    ];

    const summary = await sync();
    expect(summary).toEqual({ discovered: 2, registered: 2, existing: 0, skipped: 0, truncated: false });

    const repo = await getRepository(ctx.db, 'operava-growth-engine');
    expect(repo).toMatchObject({
      githubOwner: 'Operava',
      githubRepo: 'growth-engine',
      defaultBranch: 'trunk',
      enabled: true,
      allowCodeChanges: true,
      allowCommit: true,
      allowPush: true,
      allowOpenPr: true,
      allowUpdatePr: true,
      allowMerge: false,
      concurrencyLimit: 1,
      workflows: [],
    });
    expect(await getRepository(ctx.db, 'operava-docs')).not.toBeNull();
  });

  it('dedupes repositories repeated across pages and re-runs without churn', async () => {
    ctx.github.accessibleRepos = [
      { owner: 'acme', repo: 'api', defaultBranch: 'main' },
      // The same repository can appear twice when a write shifts the page window.
      { owner: 'acme', repo: 'api', defaultBranch: 'main' },
      { owner: 'ACME', repo: 'API', defaultBranch: 'main' },
    ];

    expect(await sync()).toMatchObject({ discovered: 1, registered: 1, existing: 0 });
    expect(await sync()).toMatchObject({ discovered: 1, registered: 0, existing: 1 });
    expect((await listRepositories(ctx.db)).map((r) => r.key)).toEqual(['acme-api']);
  });

  it('leaves explicitly configured repositories alone and never re-enables disabled ones', async () => {
    await upsertRepository(ctx.db, {
      key: 'growth',
      githubOwner: 'operava',
      githubRepo: 'growth-engine',
      defaultBranch: 'release',
      allowPush: false,
      allowMerge: true,
      concurrencyLimit: 4,
      instructions: 'run the integration suite first',
      workflows: ['echo-check'],
    });
    await setRepositoryEnabled(ctx.db, 'growth', false);
    ctx.github.accessibleRepos = [{ owner: 'operava', repo: 'growth-engine', defaultBranch: 'main' }];

    expect(await sync()).toMatchObject({ discovered: 1, registered: 0, existing: 1 });

    // No second entry for the same GitHub repository under a derived key.
    expect(await getRepository(ctx.db, 'operava-growth-engine')).toBeNull();
    expect(await getRepository(ctx.db, 'growth')).toMatchObject({
      enabled: false,
      defaultBranch: 'release',
      allowPush: false,
      allowMerge: true,
      concurrencyLimit: 4,
      instructions: 'run the integration suite first',
      workflows: ['echo-check'],
    });
  });

  it('gives repositories that fold to the same key distinct, stable keys', async () => {
    ctx.github.accessibleRepos = [
      { owner: 'acme-foo', repo: 'bar', defaultBranch: 'main' },
      { owner: 'acme', repo: 'foo-bar', defaultBranch: 'main' },
    ];

    expect(await sync()).toMatchObject({ discovered: 2, registered: 2, skipped: 0 });
    const keys = (await listRepositories(ctx.db)).map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain('acme-foo-bar');

    // Re-running discovery must not mint new keys for the same repositories.
    expect(await sync()).toMatchObject({ registered: 0, existing: 2 });
    expect((await listRepositories(ctx.db)).map((r) => r.key)).toEqual(keys);
  });

  it('skips repositories the registry validators reject without losing the rest', async () => {
    ctx.github.accessibleRepos = [
      { owner: 'acme', repo: 'good', defaultBranch: 'main' },
      { owner: 'acme', repo: 'bad', defaultBranch: '--not-a-branch' },
    ];

    expect(await sync()).toMatchObject({ discovered: 2, registered: 1, skipped: 1 });
    expect((await listRepositories(ctx.db)).map((r) => r.key)).toEqual(['acme-good']);
  });

  it('reports truncated enumeration instead of hiding it', async () => {
    ctx.github.accessibleRepos = [{ owner: 'acme', repo: 'api', defaultBranch: 'main' }];
    ctx.github.accessibleReposTruncated = true;
    expect(await sync()).toMatchObject({ registered: 1, truncated: true });
  });
});

describe('registry bootstrap at startup', () => {
  it('applies REPOSITORIES_FILE first, then fills the registry from GitHub', async () => {
    const filePath = path.join(ctx.tmpRoot, 'repositories.json');
    await fs.writeFile(
      filePath,
      JSON.stringify([
        {
          key: 'pinned',
          githubOwner: 'operava',
          githubRepo: 'growth-engine',
          defaultBranch: 'release',
          concurrencyLimit: 3,
          workflows: ['echo-check'],
        },
      ]),
    );
    ctx.github.accessibleRepos = [
      { owner: 'operava', repo: 'growth-engine', defaultBranch: 'main' },
      { owner: 'operava', repo: 'docs', defaultBranch: 'main' },
    ];

    await bootstrapRepositoryRegistry({
      db: ctx.db,
      config: { ...ctx.config, repositoriesFile: filePath },
      github: ctx.github,
      logger: ctx.logger,
    });

    expect((await listRepositories(ctx.db)).map((r) => r.key)).toEqual(['operava-docs', 'pinned']);
    expect(await getRepository(ctx.db, 'pinned')).toMatchObject({
      defaultBranch: 'release',
      concurrencyLimit: 3,
      workflows: ['echo-check'],
    });
  });

  it('keeps the existing registry when GitHub discovery is unavailable', async () => {
    await upsertRepository(ctx.db, { key: 'existing', githubOwner: 'operava', githubRepo: 'existing' });
    const unavailable = {
      listAccessibleRepositories: async () => {
        throw new BridgeError('GITHUB_API_ERROR', 'GitHub is unreachable');
      },
    } as unknown as GitHubClient;

    await expect(
      bootstrapRepositoryRegistry({
        db: ctx.db,
        config: ctx.config,
        github: unavailable,
        logger: ctx.logger,
      }),
    ).resolves.toBeUndefined();

    expect((await listRepositories(ctx.db)).map((r) => r.key)).toEqual(['existing']);
  });

  it('honours GITHUB_AUTO_REGISTER_REPOS=false', async () => {
    ctx.github.accessibleRepos = [{ owner: 'acme', repo: 'api', defaultBranch: 'main' }];

    await bootstrapRepositoryRegistry({
      db: ctx.db,
      config: { ...ctx.config, githubAutoRegisterRepos: false },
      github: ctx.github,
      logger: ctx.logger,
    });

    expect(await listRepositories(ctx.db)).toHaveLength(0);
  });

  it('exposes discovered repositories through the list_repositories view', async () => {
    ctx.github.accessibleRepos = [{ owner: 'operava', repo: 'growth-engine', defaultBranch: 'main' }];

    await bootstrapRepositoryRegistry({
      db: ctx.db,
      config: ctx.config,
      github: ctx.github,
      logger: ctx.logger,
    });

    expect(await listRepositoriesView({ db: ctx.db, workflows: ctx.workflows })).toEqual([
      {
        repository: 'operava-growth-engine',
        github: 'operava/growth-engine',
        defaultBranch: 'main',
        allowedOperations: {
          codeChanges: true,
          commit: true,
          push: true,
          openPr: true,
          updatePr: true,
          merge: false,
        },
        concurrencyLimit: 1,
        workflows: [],
        hasInstructions: false,
      },
    ]);
  });
});
