import { describe, expect, it } from 'vitest';
import { canonicalJson, requestHash, safeEqual, slugify } from '../../src/ids.js';
import { BridgeError, toBridgeError } from '../../src/errors.js';
import { extractReportFromText, parseCompletionReport } from '../../src/domain/report.js';
import { isValidBranchName } from '../../src/gitx/validate.js';
import { loadConfig } from '../../src/config.js';

describe('canonicalJson / requestHash', () => {
  it('is stable across key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toEqual(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
    expect(requestHash({ x: 1, y: 2 })).toEqual(requestHash({ y: 2, x: 1 }));
    expect(requestHash({ x: 1 })).not.toEqual(requestHash({ x: 2 }));
  });

  it('drops undefined values like JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toEqual(canonicalJson({ a: 1 }));
  });
});

describe('safeEqual / slugify', () => {
  it('compares without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
  it('slugifies to branch-safe tokens', () => {
    expect(slugify('Fix the Growth Engine analytics bug!')).toBe('fix-the-growth-engine-an');
    expect(slugify('  ---  ')).toBe('task');
  });
});

describe('BridgeError', () => {
  it('carries stable codes and payloads', () => {
    const err = new BridgeError('BRANCH_BUSY', 'busy', { detail: 'holder=x' });
    expect(err.toPayload()).toEqual({ error: { code: 'BRANCH_BUSY', message: 'busy', detail: 'holder=x' } });
    expect(err.httpStatus).toBe(409);
  });
  it('wraps unknown errors as INTERNAL_ERROR', () => {
    const wrapped = toBridgeError(new Error('boom'));
    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.message).toBe('boom');
  });
});

describe('completion report parsing', () => {
  it('accepts a valid structured report', () => {
    const { report, parseError } = parseCompletionReport({
      summary: 'did the thing',
      outcome: 'success',
      tests: [{ command: 'npm test', status: 'passed' }],
    });
    expect(parseError).toBeNull();
    expect(report?.tests[0]?.status).toBe('passed');
    expect(report?.blockers).toEqual([]);
  });

  it('rejects malformed reports without throwing', () => {
    const { report, parseError } = parseCompletionReport({ outcome: 'nope' });
    expect(report).toBeNull();
    expect(parseError).toContain('summary');
  });

  it('extracts the last fenced JSON block from free text', () => {
    const text = [
      'I did some work.',
      '```json',
      '{"summary": "first", "outcome": "partial"}',
      '```',
      'and then...',
      '```json',
      '{"summary": "final report", "outcome": "success", "blockers": []}',
      '```',
    ].join('\n');
    const { report } = extractReportFromText(text);
    expect(report?.summary).toBe('final report');
  });

  it('preserves a parse error when no valid JSON exists', () => {
    const { report, parseError } = extractReportFromText('no json here at all');
    expect(report).toBeNull();
    expect(parseError).toBeTruthy();
  });
});

describe('branch name validation', () => {
  it('accepts normal branch names', () => {
    for (const name of ['main', 'feature/acquisition-v2', 'claude/fix-bug-abc123', 'release-1.2.3']) {
      expect(isValidBranchName(name), name).toBe(true);
    }
  });
  it('rejects malicious or malformed names', () => {
    for (const name of [
      '-rf',
      '--force',
      '../escape',
      'a..b',
      'a//b',
      'branch.lock',
      'branch/',
      'branch.',
      'a@{1}',
      'has space',
      'semi;colon',
      '$(cmd)',
      '.hidden/x',
      'x/.hidden',
      '',
    ]) {
      expect(isValidBranchName(name), name).toBe(false);
    }
  });
});

describe('blocked bash patterns (defense in depth)', () => {
  it('catches push/fetch/remote/gh variants including global-flag evasion', async () => {
    const { BLOCKED_BASH_PATTERNS } = await import('../../src/claude/agent-sdk-runner.js');
    const blocked = (cmd: string) => BLOCKED_BASH_PATTERNS.some((p) => p.re.test(cmd));
    for (const cmd of [
      'git push',
      'git push origin main',
      'git -C /workspace push --force',
      'git -c user.name=x push',
      'git --no-pager push',
      'git remote set-url origin https://evil',
      'git remote add other https://evil',
      'git config credential.helper store',
      'gh pr merge 1',
      'cd x && gh auth login',
      'git fetch origin',
      'git -C . pull',
    ]) {
      expect(blocked(cmd), cmd).toBe(true);
    }
    for (const cmd of [
      'git status',
      'git commit -m "add push notification feature"',
      'git log --oneline',
      'npm test',
      'echo high',
      'git diff main...HEAD',
    ]) {
      expect(blocked(cmd), cmd).toBe(false);
    }
  });
});

describe('config', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/db',
  };

  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.defaultModel).toBe('claude-sonnet-5');
    expect(config.modelAliases.strong).toBe('claude-opus-5');
    expect(config.allowedModels.has('claude-haiku-4-5')).toBe(true);
    expect(config.maxConcurrentTasks).toBe(2);
    expect(config.oauthEnabled).toBe(true);
  });

  it('refuses production without authentication', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://x.example' })).toThrow(
      /without authentication/,
    );
  });

  it('refuses production oauth without PUBLIC_BASE_URL', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        BRIDGE_OPERATOR_KEY: 'a-very-long-operator-key-123',
      }),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it('enforces minimum token lengths in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://x.example',
        OAUTH_ENABLED: 'false',
        BRIDGE_API_TOKENS: 'short',
      }),
    ).toThrow(/at least 24 characters/);
  });
});
