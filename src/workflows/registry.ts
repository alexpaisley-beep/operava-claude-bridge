import fs from 'node:fs/promises';
import { z } from 'zod';
import { BridgeError } from '../errors.js';
import type { RepositoryConfig } from '../domain/types.js';

/**
 * Named, allowlisted workflows.
 *
 * Definitions are server-controlled only: built-ins below plus an optional
 * operator-provided JSON file (WORKFLOWS_FILE). MCP callers select a workflow
 * by name and supply validated parameters — they can never supply a command.
 *
 * A workflow is runnable for a repository only when BOTH sides opt in:
 * the definition allowlists the repository (or '*') AND the repository's
 * registry entry lists the workflow name.
 */

export const workflowParameterSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/),
  description: z.string().optional(),
  required: z.boolean().optional().default(false),
  /** Regex the value must fully match. Default is a conservative token pattern. */
  pattern: z.string().optional(),
});

export const workflowDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  description: z.string(),
  repositories: z.union([z.literal('*'), z.array(z.string())]),
  /** argv, spawned with execFile (no shell). Placeholders: {{repoDir}}, {{branch}}, {{param:NAME}}. */
  command: z.array(z.string()).min(1),
  parameters: z.array(workflowParameterSchema).optional().default([]),
  /** Extra static environment for the child process. */
  env: z.record(z.string(), z.string()).optional().default({}),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
  outputParser: z.enum(['json', 'text']).optional().default('text'),
  /** Whether the run must resolve a branch/PR to check out (default true). */
  requiresRef: z.boolean().optional().default(true),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowParameter = z.infer<typeof workflowParameterSchema>;

const DEFAULT_PARAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._/:=,-]{0,199}$/;

/**
 * Built-in `echo-check`: a harmless, dependency-free workflow used for
 * regression tests and for verifying the workflow pipeline end to end. It
 * prints structured findings derived from the injected environment.
 */
const ECHO_CHECK_SCRIPT = `
const out = {
  summary: 'echo-check completed on ' + (process.env.WORKFLOW_BRANCH || 'HEAD') +
    ' @ ' + (process.env.WORKFLOW_HEAD_SHA || 'unknown'),
  findings: [
    {
      severity: 'info',
      title: 'echo-check executed',
      rationale: 'Built-in workflow used to verify the Operava Claude Bridge workflow pipeline.',
    },
  ],
};
if (process.env.WORKFLOW_PARAM_NOTE) {
  out.findings.push({ severity: 'info', title: 'note parameter received', rationale: process.env.WORKFLOW_PARAM_NOTE });
}
if (process.env.WORKFLOW_PARAM_FAIL === 'true') {
  console.error('echo-check failing as requested');
  process.exit(2);
}
if (process.env.WORKFLOW_PARAM_SLEEP_MS) {
  const until = Date.now() + Number(process.env.WORKFLOW_PARAM_SLEEP_MS);
  while (Date.now() < until) {}
}
console.log(JSON.stringify(out));
`.trim();

export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  {
    name: 'echo-check',
    description:
      'Harmless built-in verification workflow: checks out the requested ref and emits structured findings. Use it to verify the pipeline.',
    repositories: '*',
    command: ['node', '-e', ECHO_CHECK_SCRIPT],
    parameters: [
      { name: 'note', description: 'Echoed back as an info finding.', required: false, pattern: undefined },
      { name: 'fail', description: 'Set to "true" to make the workflow exit non-zero.', required: false, pattern: '^(true|false)$' },
      { name: 'sleep_ms', description: 'Busy-wait this many milliseconds (timeout testing).', required: false, pattern: '^[0-9]{1,7}$' },
    ],
    env: {},
    timeoutMs: 60_000,
    outputParser: 'json',
    requiresRef: true,
  },
];

export class WorkflowRegistry {
  private readonly byName = new Map<string, WorkflowDefinition>();

  constructor(definitions: WorkflowDefinition[]) {
    for (const def of definitions) {
      if (this.byName.has(def.name)) {
        throw new BridgeError('INTERNAL_ERROR', `Duplicate workflow definition: ${def.name}`);
      }
      this.byName.set(def.name, def);
    }
  }

  get(name: string): WorkflowDefinition | null {
    return this.byName.get(name) ?? null;
  }

  all(): WorkflowDefinition[] {
    return [...this.byName.values()];
  }

  availableFor(repo: RepositoryConfig): WorkflowDefinition[] {
    return this.all().filter((def) => this.isAvailable(def, repo));
  }

  isAvailable(def: WorkflowDefinition, repo: RepositoryConfig): boolean {
    const defAllows = def.repositories === '*' || def.repositories.includes(repo.key);
    const repoAllows = repo.workflows.includes(def.name);
    return defAllows && repoAllows;
  }

  /** Validate caller-supplied parameters against the definition's schema. */
  validateParameters(def: WorkflowDefinition, params: Record<string, unknown>): Record<string, string> {
    const known = new Map(def.parameters.map((p) => [p.name, p]));
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      const spec = known.get(key);
      if (!spec) {
        throw new BridgeError('VALIDATION_ERROR', `Unknown parameter "${key}" for workflow ${def.name}.`, {
          detail: `known parameters: ${[...known.keys()].join(', ') || 'none'}`,
        });
      }
      const str = String(value);
      const pattern = spec.pattern ? new RegExp(`^(?:${spec.pattern})$`) : DEFAULT_PARAM_PATTERN;
      if (!pattern.test(str) || str.startsWith('-')) {
        throw new BridgeError('VALIDATION_ERROR', `Parameter "${key}" has an invalid value.`, {
          detail: spec.pattern ? `must match ${spec.pattern}` : 'must be a short plain token',
        });
      }
      out[key] = str;
    }
    for (const p of def.parameters) {
      if (p.required && out[p.name] === undefined) {
        throw new BridgeError('VALIDATION_ERROR', `Missing required parameter "${p.name}" for workflow ${def.name}.`);
      }
    }
    return out;
  }
}

export async function loadWorkflowRegistry(workflowsFile?: string): Promise<WorkflowRegistry> {
  const defs = [...BUILTIN_WORKFLOWS];
  if (workflowsFile) {
    const raw = await fs.readFile(workflowsFile, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new BridgeError('INTERNAL_ERROR', `WORKFLOWS_FILE is not valid JSON: ${workflowsFile}`, {
        cause: err,
      });
    }
    const fileSchema = z.array(workflowDefinitionSchema);
    const result = fileSchema.safeParse(parsed);
    if (!result.success) {
      throw new BridgeError('INTERNAL_ERROR', `WORKFLOWS_FILE failed validation: ${result.error.message}`);
    }
    for (const def of result.data) {
      if (defs.some((d) => d.name === def.name)) {
        throw new BridgeError('INTERNAL_ERROR', `Workflow "${def.name}" conflicts with a built-in workflow.`);
      }
      defs.push(def);
    }
  }
  return new WorkflowRegistry(defs);
}
