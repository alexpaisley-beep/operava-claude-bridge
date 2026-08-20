import { z } from 'zod';

/**
 * The machine-readable completion report Claude is asked to produce at the
 * end of every task. The worker requests it via the Agent SDK's
 * `outputFormat: { type: 'json_schema' }` support and falls back to parsing a
 * fenced JSON block from the final text. If both fail, the raw final response
 * is preserved and the task still completes — a malformed report never
 * destroys task state.
 */

export const findingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  endLine: z.number().int().optional(),
  rationale: z.string().optional(),
  recommendation: z.string().optional(),
});

export const completionReportSchema = z.object({
  summary: z.string(),
  outcome: z.enum(['success', 'partial', 'blocked', 'failed']),
  filesChanged: z
    .array(
      z.object({
        path: z.string(),
        change: z.enum(['added', 'modified', 'deleted', 'renamed']),
        description: z.string().optional(),
      }),
    )
    .default([]),
  commits: z
    .array(
      z.object({
        sha: z.string().optional(),
        message: z.string(),
      }),
    )
    .default([]),
  tests: z
    .array(
      z.object({
        command: z.string(),
        status: z.enum(['passed', 'failed', 'skipped', 'not_run']),
        details: z.string().optional(),
      }),
    )
    .default([]),
  findings: z.array(findingSchema).default([]),
  blockers: z.array(z.string()).default([]),
  recommendedNextAction: z.string().optional(),
});

export type CompletionReport = z.infer<typeof completionReportSchema>;
export type Finding = z.infer<typeof findingSchema>;

/**
 * Plain JSON Schema equivalent handed to the Agent SDK (`outputFormat`), which
 * requires standard JSON Schema rather than a zod object.
 */
export const COMPLETION_REPORT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'outcome'],
  properties: {
    summary: {
      type: 'string',
      description:
        'Concise report of what was done, what was verified, and the resulting state.',
    },
    outcome: {
      type: 'string',
      enum: ['success', 'partial', 'blocked', 'failed'],
      description:
        'success = objective fully met; partial = some of it done; blocked = could not proceed without input; failed = attempted but not achieved.',
    },
    filesChanged: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'change'],
        properties: {
          path: { type: 'string' },
          change: { type: 'string', enum: ['added', 'modified', 'deleted', 'renamed'] },
          description: { type: 'string' },
        },
      },
    },
    commits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: {
          sha: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    tests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'status'],
        properties: {
          command: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed', 'skipped', 'not_run'] },
          details: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      description:
        'Structured review/diagnosis findings. Required for analysis tasks; optional for engineering tasks.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          endLine: { type: 'integer' },
          rationale: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
    blockers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Unresolved problems that prevent the objective from being fully met.',
    },
    recommendedNextAction: { type: 'string' },
  },
} as const;

export interface ParsedReport {
  report: CompletionReport | null;
  parseError: string | null;
}

/** Parse a structured object emitted by the SDK's json_schema output format. */
export function parseCompletionReport(raw: unknown): ParsedReport {
  const result = completionReportSchema.safeParse(raw);
  if (result.success) return { report: result.data, parseError: null };
  return {
    report: null,
    parseError: result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; '),
  };
}

/**
 * Fallback: extract the last fenced JSON block (or a bare trailing JSON
 * object) from Claude's final free-form text.
 */
export function extractReportFromText(text: string): ParsedReport {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates: string[] = fences.map((m) => m[1] ?? '').filter((s) => s.trim().length > 0);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed);

  let lastError: string | null = 'no JSON report found in response text';
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const attempt = parseCompletionReport(parsed);
      if (attempt.report) return attempt;
      lastError = attempt.parseError;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { report: null, parseError: lastError };
}
