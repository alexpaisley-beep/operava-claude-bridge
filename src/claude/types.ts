/**
 * Claude execution boundary.
 *
 * The production implementation drives Claude Code through the official
 * Claude Agent SDK (@anthropic-ai/claude-agent-sdk). Tests use a scriptable
 * mock. The worker only sees this interface.
 */

export type ClaudeRunMode =
  /** Engineering: full Claude Code toolset in an isolated workspace. */
  | 'write'
  /** Analysis: read-only tools (Read/Grep/Glob) in an isolated workspace. */
  | 'read'
  /** Pure reasoning: no tools at all (general ask_claude). */
  | 'reason';

export interface ClaudeRunnerEvent {
  kind: 'session_started' | 'tool_use' | 'text' | 'notice';
  message: string;
  detail?: Record<string, unknown>;
}

export interface ClaudeRunOptions {
  prompt: string;
  mode: ClaudeRunMode;
  /** Absolute workspace directory; required for write/read modes. */
  cwd?: string;
  model: string;
  maxTurns?: number;
  /** Resume this Claude Code session instead of starting fresh. */
  resumeSessionId?: string;
  timeoutMs: number;
  /** External cancellation (task cancel, worker shutdown). */
  abortSignal: AbortSignal;
  /** JSON Schema for the structured final output. */
  outputSchema?: Record<string, unknown>;
  systemPromptAppend?: string;
  onEvent?: (event: ClaudeRunnerEvent) => void;
}

export interface ClaudeRunResult {
  ok: boolean;
  /** SDK result subtype: success | error_max_turns | error_during_execution | ... */
  subtype: string;
  finalText: string;
  structuredOutput: unknown | null;
  sessionId: string | null;
  model: string | null;
  totalCostUsd: number | null;
  numTurns: number | null;
  permissionDenialCount: number;
  errorMessage: string | null;
}

export interface ClaudeRunner {
  run(options: ClaudeRunOptions): Promise<ClaudeRunResult>;
}
