import os from 'node:os';
import fs from 'node:fs/promises';
import { query, type Options, type PermissionResult, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BridgeError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ClaudeRunner, ClaudeRunOptions, ClaudeRunResult } from './types.js';

/**
 * Production Claude executor built on the official Claude Agent SDK, which
 * drives the bundled Claude Code engine programmatically (non-interactive).
 *
 * Guarantees enforced here, independent of anything the prompt says:
 *  - The subprocess environment is constructed from scratch: it receives the
 *    Anthropic API key and nothing else secret. No GitHub credentials exist in
 *    the workspace or environment, so `git push` cannot authenticate even if
 *    attempted.
 *  - `canUseTool` additionally denies push/PR-ish Bash commands outright in
 *    write mode, and read mode only exposes read-only tools in the first place.
 *  - Filesystem settings are never loaded (`settingSources: []`), so
 *    repository content cannot inject hooks or permission grants.
 *  - A hard timeout aborts the run; external cancellation aborts it too.
 */

// git global-option prefix: -C <path>, -c k=v, --long-flag[=value], -p, etc.
const GIT_OPTS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*`;

/**
 * Defense in depth only: the hard guarantee is that the workspace and the
 * Claude subprocess carry NO GitHub credentials, so remote writes cannot
 * succeed regardless. These patterns fail fast with a clear message instead
 * of a confusing auth error.
 */
export const BLOCKED_BASH_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: new RegExp(String.raw`\bgit${GIT_OPTS}\s+push\b`), reason: 'Pushing is performed by the bridge after the task completes, based on the task permissions.' },
  { re: new RegExp(String.raw`\bgit${GIT_OPTS}\s+remote\b`), reason: 'Remote configuration is managed by the bridge.' },
  { re: new RegExp(String.raw`\bgit${GIT_OPTS}\s+config\b[^\n]*credential`, 'i'), reason: 'Credential configuration is managed by the bridge.' },
  { re: /(^|[\s;|&(])gh\s+/, reason: 'GitHub CLI operations are performed by the bridge, not from inside the workspace.' },
  { re: new RegExp(String.raw`\bgit${GIT_OPTS}\s+(fetch|pull)\b`), reason: 'The bridge prepared the workspace with the exact refs for this task; remote fetches are disabled.' },
];

export class AgentSdkClaudeRunner implements ClaudeRunner {
  constructor(
    private readonly opts: {
      anthropicApiKey: string | undefined;
      claudeHomeDir: string;
      allowNetworkTools: boolean;
      logger: Logger;
    },
  ) {}

  async run(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
    if (!this.opts.anthropicApiKey) {
      throw new BridgeError(
        'CLAUDE_AUTH_ERROR',
        'ANTHROPIC_API_KEY is not configured on the server; Claude execution is unavailable.',
      );
    }
    await fs.mkdir(this.opts.claudeHomeDir, { recursive: true });

    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, options.timeoutMs);
    const onExternalAbort = () => abortController.abort();
    if (options.abortSignal.aborted) abortController.abort();
    options.abortSignal.addEventListener('abort', onExternalAbort, { once: true });

    const stderrTail: string[] = [];
    const sdkOptions: Options = {
      cwd: options.cwd ?? this.opts.claudeHomeDir,
      model: options.model,
      abortController,
      settingSources: [],
      persistSession: true,
      includePartialMessages: false,
      executable: 'node' as const,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(options.systemPromptAppend ? { append: options.systemPromptAppend } : {}),
      },
      env: this.buildEnv(),
      stderr: (data: string) => {
        stderrTail.push(data.slice(0, 2000));
        if (stderrTail.length > 20) stderrTail.shift();
      },
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
      ...(options.outputSchema
        ? { outputFormat: { type: 'json_schema' as const, schema: options.outputSchema } }
        : {}),
      ...this.modeOptions(options),
    };

    try {
      const result = await this.consume(query({ prompt: options.prompt, options: sdkOptions }), options);
      return result;
    } catch (err) {
      if (options.abortSignal.aborted && !timedOut) {
        throw new BridgeError('TASK_CANCELLED', 'Claude execution was cancelled.', { cause: err });
      }
      if (timedOut) {
        throw new BridgeError(
          'CLAUDE_TIMEOUT',
          `Claude execution exceeded the ${Math.round(options.timeoutMs / 60000)} minute task timeout.`,
          { cause: err },
        );
      }
      throw this.mapExecutionError(err, options, stderrTail.join('').slice(-4000));
    } finally {
      clearTimeout(timeout);
      options.abortSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  private buildEnv(): Record<string, string | undefined> {
    // Deliberately NOT inheriting process.env: only what Claude Code needs.
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: this.opts.claudeHomeDir,
      TMPDIR: os.tmpdir(),
      ANTHROPIC_API_KEY: this.opts.anthropicApiKey,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'operava-claude-bridge/1.0.0',
      DISABLE_AUTOUPDATER: '1',
      NO_COLOR: '1',
    };
    // Allow corporate proxy variables through when the host has them —
    // Claude API access may depend on them. They carry no repo credentials.
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return env;
  }

  private modeOptions(options: ClaudeRunOptions): Partial<Options> {
    const disallowedNetwork = this.opts.allowNetworkTools ? [] : ['WebFetch', 'WebSearch'];
    switch (options.mode) {
      case 'write':
        return {
          tools: { type: 'preset', preset: 'claude_code' },
          disallowedTools: disallowedNetwork,
          permissionMode: 'default',
          canUseTool: async (toolName, input): Promise<PermissionResult> => {
            if (toolName === 'Bash') {
              const command = String((input as { command?: unknown }).command ?? '');
              for (const { re, reason } of BLOCKED_BASH_PATTERNS) {
                if (re.test(command)) {
                  options.onEvent?.({
                    kind: 'notice',
                    message: `Blocked Bash command: ${command.slice(0, 120)}`,
                  });
                  return { behavior: 'deny', message: `Command blocked by the bridge: ${reason}` };
                }
              }
            }
            return { behavior: 'allow', updatedInput: input };
          },
        };
      case 'read':
        return {
          tools: ['Read', 'Grep', 'Glob'],
          permissionMode: 'default',
          canUseTool: async (_toolName, input): Promise<PermissionResult> => ({
            behavior: 'allow',
            updatedInput: input,
          }),
        };
      case 'reason':
        return {
          tools: [],
          permissionMode: 'default',
          canUseTool: async (_toolName, input): Promise<PermissionResult> => ({
            behavior: 'allow',
            updatedInput: input,
          }),
        };
    }
  }

  private async consume(
    stream: AsyncIterable<SDKMessage>,
    options: ClaudeRunOptions,
  ): Promise<ClaudeRunResult> {
    let sessionId: string | null = null;
    let model: string | null = null;
    let final: ClaudeRunResult | null = null;

    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        model = message.model;
        options.onEvent?.({
          kind: 'session_started',
          message: `Claude session started (model ${message.model})`,
          detail: { sessionId: message.session_id, model: message.model },
        });
      } else if (message.type === 'assistant') {
        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
              const b = block as { name?: string; input?: Record<string, unknown> };
              options.onEvent?.({
                kind: 'tool_use',
                message: summarizeToolUse(b.name ?? 'tool', b.input ?? {}),
                detail: { tool: b.name },
              });
            } else if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
              const text = String((block as { text?: unknown }).text ?? '');
              if (text.trim().length > 0) {
                options.onEvent?.({ kind: 'text', message: text.slice(0, 300) });
              }
            }
          }
        }
      } else if (message.type === 'result') {
        const isSuccess = message.subtype === 'success';
        final = {
          ok: isSuccess && !message.is_error,
          subtype: message.subtype,
          finalText: isSuccess ? (message as { result?: string }).result ?? '' : '',
          structuredOutput: isSuccess
            ? ((message as { structured_output?: unknown }).structured_output ?? null)
            : null,
          sessionId: message.session_id ?? sessionId,
          model,
          totalCostUsd: message.total_cost_usd ?? null,
          numTurns: message.num_turns ?? null,
          permissionDenialCount: message.permission_denials?.length ?? 0,
          errorMessage: isSuccess
            ? message.is_error
              ? ((message as { result?: string }).result ?? 'Claude reported an error')
              : null
            : ((message as { errors?: string[] }).errors ?? []).join('; ') || message.subtype,
        };
      }
    }

    if (!final) {
      throw new BridgeError('CLAUDE_EXECUTION_FAILED', 'Claude finished without emitting a result message.');
    }
    return final;
  }

  private mapExecutionError(err: unknown, options: ClaudeRunOptions, stderr: string): BridgeError {
    if (err instanceof BridgeError) return err;
    const text = `${err instanceof Error ? err.message : String(err)} ${stderr}`;
    this.opts.logger.error({ err, stderr: stderr.slice(0, 1000) }, 'claude execution failed');
    if (options.resumeSessionId && /no conversation|session.*(not found|does not exist)|unknown session/i.test(text)) {
      return new BridgeError(
        'CLAUDE_SESSION_UNAVAILABLE',
        `Claude session ${options.resumeSessionId} could not be resumed (it may have been lost in a redeploy). Start a new task instead.`,
        { cause: err },
      );
    }
    if (/api key|authentication|unauthorized|401|credit|billing/i.test(text)) {
      return new BridgeError('CLAUDE_AUTH_ERROR', 'Claude execution failed to authenticate with Anthropic.', {
        cause: err,
        detail: text.slice(0, 500),
      });
    }
    return new BridgeError('CLAUDE_EXECUTION_FAILED', 'Claude execution failed.', {
      cause: err,
      detail: text.slice(0, 1000),
    });
  }
}

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const interesting =
    (input.command as string | undefined) ??
    (input.file_path as string | undefined) ??
    (input.path as string | undefined) ??
    (input.pattern as string | undefined) ??
    '';
  const suffix = interesting ? `: ${String(interesting).slice(0, 160)}` : '';
  return `${name}${suffix}`;
}
