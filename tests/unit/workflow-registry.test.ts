import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOWS, WorkflowRegistry, workflowDefinitionSchema } from '../../src/workflows/registry.js';
import type { RepositoryConfig } from '../../src/domain/types.js';

const repo = (overrides: Partial<RepositoryConfig> = {}): RepositoryConfig => ({
  key: 'demo',
  githubOwner: 'o',
  githubRepo: 'r',
  defaultBranch: 'main',
  enabled: true,
  allowCodeChanges: true,
  allowCommit: true,
  allowPush: true,
  allowOpenPr: true,
  allowUpdatePr: true,
  allowMerge: false,
  concurrencyLimit: 1,
  instructions: null,
  workflows: ['echo-check'],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('WorkflowRegistry', () => {
  const registry = new WorkflowRegistry(BUILTIN_WORKFLOWS);
  const echo = registry.get('echo-check')!;

  it('requires BOTH the definition and the repository to opt in', () => {
    expect(registry.isAvailable(echo, repo())).toBe(true);
    expect(registry.isAvailable(echo, repo({ workflows: [] }))).toBe(false);
    const scoped = { ...echo, name: 'scoped', repositories: ['other'] };
    const scopedRegistry = new WorkflowRegistry([scoped]);
    expect(scopedRegistry.isAvailable(scoped, repo({ workflows: ['scoped'] }))).toBe(false);
  });

  it('validates parameters against the schema', () => {
    expect(registry.validateParameters(echo, { note: 'hello world' })).toEqual({ note: 'hello world' });
    expect(() => registry.validateParameters(echo, { unknown: 'x' })).toThrow(/Unknown parameter/);
    expect(() => registry.validateParameters(echo, { fail: 'maybe' })).toThrow(/invalid value/);
    expect(registry.validateParameters(echo, { fail: 'true' })).toEqual({ fail: 'true' });
  });

  it('rejects values that could act as flags', () => {
    expect(() => registry.validateParameters(echo, { note: '--exec=evil' })).toThrow(/invalid value/);
  });

  it('rejects raw commands from callers by construction', () => {
    // The registry has no API that accepts a command from a caller; the
    // definition schema is the only source, and names are constrained.
    expect(() =>
      workflowDefinitionSchema.parse({
        name: 'bad name!',
        description: 'x',
        repositories: '*',
        command: ['echo'],
      }),
    ).toThrow();
  });
});
