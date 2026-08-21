import { describe, expect, it } from 'vitest';
import { createOctokitClient, MAX_DISCOVERY_PAGES } from '../../src/github/octokit-client.js';
import {
  disambiguatedRepositoryKeyFor,
  repositoryKeyFor,
} from '../../src/registry/discover-repositories.js';

/** The registry's own key constraint (src/gitx/validate.ts). */
const REPO_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

describe('repository key derivation', () => {
  it('derives a readable key from owner/repo', () => {
    expect(repositoryKeyFor('operava', 'growth-engine')).toBe('operava-growth-engine');
    expect(repositoryKeyFor('alexpaisley-beep', 'operava-claude-bridge')).toBe(
      'alexpaisley-beep-operava-claude-bridge',
    );
  });

  it('lowercases and folds characters the registry does not allow', () => {
    expect(repositoryKeyFor('Operava-LLC', 'Growth.Engine')).toBe('operava-llc-growth-engine');
    expect(repositoryKeyFor('acme', 'docs_site')).toBe('acme-docs_site');
    expect(repositoryKeyFor('.hidden', 'repo.')).toBe('hidden-repo');
  });

  it('is stable: the same repository always maps to the same key', () => {
    const pairs: [string, string][] = [
      ['operava', 'growth-engine'],
      ['Operava', 'Growth-Engine'],
      ['a'.repeat(60), 'b'.repeat(60)],
      ['acme', '...'],
    ];
    for (const [owner, repo] of pairs) {
      expect(repositoryKeyFor(owner, repo)).toBe(repositoryKeyFor(owner, repo));
      expect(disambiguatedRepositoryKeyFor(owner, repo)).toBe(disambiguatedRepositoryKeyFor(owner, repo));
    }
  });

  it('always produces a key the registry accepts', () => {
    const cases: [string, string][] = [
      ['operava', 'growth-engine'],
      ['a'.repeat(60), 'b'.repeat(60)],
      ['UPPER', 'CASE.Repo'],
      ['acme', '...'],
      ['...', '...'],
      ['_x', '_y'],
      ['1', '2'],
    ];
    for (const [owner, repo] of cases) {
      const key = repositoryKeyFor(owner, repo);
      expect(key, `${owner}/${repo} → ${key}`).toMatch(REPO_KEY_RE);
      expect(disambiguatedRepositoryKeyFor(owner, repo)).toMatch(REPO_KEY_RE);
    }
  });

  it('truncates over-long names with a hash so they stay unique', () => {
    const owner = 'o'.repeat(40);
    const a = repositoryKeyFor(owner, `${'r'.repeat(40)}-alpha`);
    const b = repositoryKeyFor(owner, `${'r'.repeat(40)}-beta`);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });

  it('disambiguates repositories whose names fold to the same key', () => {
    expect(repositoryKeyFor('acme', 'foo-bar')).toBe(repositoryKeyFor('acme-foo', 'bar'));
    const a = disambiguatedRepositoryKeyFor('acme', 'foo-bar');
    const b = disambiguatedRepositoryKeyFor('acme-foo', 'bar');
    expect(a).not.toBe(b);
    expect(a.startsWith('acme-foo-bar-')).toBe(true);
    expect(b.startsWith('acme-foo-bar-')).toBe(true);
  });
});

/* ---------------------- GitHub discovery over HTTP ------------------------ */

function ghRepos(owner: string, names: string[], defaultBranch = 'main'): unknown[] {
  return names.map((name) => ({ name, owner: { login: owner }, default_branch: defaultBranch }));
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, url = ''): Response {
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
  // A constructed Response has an empty `url`; real fetch fills it in and
  // Octokit's paginator reads it.
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function nextLink(page: number): Record<string, string> {
  return { link: `<https://api.github.com/user/repos?page=${page}&per_page=100>; rel="next"` };
}

function pageOf(url: string): number {
  return Number(new URL(url).searchParams.get('page') ?? '1');
}

describe('listAccessibleRepositories', () => {
  it('follows every page of results', async () => {
    const calls: string[] = [];
    const fetchStub = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      const page = pageOf(url);
      return jsonResponse(
        ghRepos('acme', [`repo-${page}a`, `repo-${page}b`], page === 1 ? 'trunk' : 'main'),
        page < 3 ? nextLink(page + 1) : {},
      );
    }) as typeof globalThis.fetch;

    const client = createOctokitClient({ token: 'test-token', fetch: fetchStub });
    const { repositories, truncated } = await client.listAccessibleRepositories();

    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('/user/repos');
    expect(calls[0]).toContain('per_page=100');
    expect(truncated).toBe(false);
    expect(repositories.map((r) => r.repo)).toEqual([
      'repo-1a',
      'repo-1b',
      'repo-2a',
      'repo-2b',
      'repo-3a',
      'repo-3b',
    ]);
    expect(repositories[0]).toEqual({ owner: 'acme', repo: 'repo-1a', defaultBranch: 'trunk' });
  });

  it('falls back to the installation endpoint when the token is a GitHub App token', async () => {
    const calls: string[] = [];
    const fetchStub = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/user/repos')) {
        return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
          status: 403,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return jsonResponse(
        { total_count: 2, repositories: ghRepos('acme', ['app-one', 'app-two']) },
        {},
        url,
      );
    }) as typeof globalThis.fetch;

    const client = createOctokitClient({ token: 'test-token', fetch: fetchStub });
    const { repositories, truncated } = await client.listAccessibleRepositories();

    expect(calls[1]).toContain('/installation/repositories');
    expect(truncated).toBe(false);
    expect(repositories.map((r) => r.repo)).toEqual(['app-one', 'app-two']);
  });

  it('surfaces GitHub failures as bridge errors', async () => {
    const fetchStub = (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })) as typeof globalThis.fetch;

    const client = createOctokitClient({ token: 'bad-token', fetch: fetchStub });
    await expect(client.listAccessibleRepositories()).rejects.toMatchObject({ code: 'GIT_AUTH_ERROR' });
  });

  it('reports truncation instead of looping forever on the page cap', async () => {
    let calls = 0;
    const fetchStub = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      calls += 1;
      const page = pageOf(String(input));
      return jsonResponse(ghRepos('acme', [`repo-${page}`]), nextLink(page + 1));
    }) as typeof globalThis.fetch;

    const client = createOctokitClient({ token: 'test-token', fetch: fetchStub });
    const { repositories, truncated } = await client.listAccessibleRepositories();

    expect(calls).toBe(MAX_DISCOVERY_PAGES);
    expect(repositories).toHaveLength(MAX_DISCOVERY_PAGES);
    expect(truncated).toBe(true);
  });
});
