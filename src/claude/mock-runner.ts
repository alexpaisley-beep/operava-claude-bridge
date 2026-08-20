import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { runGit } from '../gitx/git.js';
import type { ClaudeRunner, ClaudeRunOptions, ClaudeRunResult } from './types.js';

export type MockBehavior = (options: ClaudeRunOptions, callIndex: number) => Promise<ClaudeRunResult> | ClaudeRunResult;

/**
 * Scriptable Claude runner for tests and credential-less local development.
 * Mirrors the production runner's timeout/cancellation semantics: the behavior
 * races against options.timeoutMs (→ CLAUDE_TIMEOUT) and options.abortSignal
 * (→ TASK_CANCELLED). Never used in production (guarded at factory level).
 */
export class MockClaudeRunner implements ClaudeRunner {
  calls: ClaudeRunOptions[] = [];
  private behavior: MockBehavior;

  constructor(behavior?: MockBehavior) {
    this.behavior =
      behavior ??
      (async (options, index) => {
        // Opt-in for end-to-end runs: actually edit + commit in the workspace
        // so the bridge's push/PR pipeline is exercised for real.
        if (process.env.CLAUDE_MOCK_EDIT === 'true' && options.mode === 'write' && options.cwd) {
          const file = path.join(options.cwd, 'claude-mock-change.md');
          await fs.appendFile(file, `mock change #${index} for prompt hash ${options.prompt.length}\n`);
          await runGit(['-C', options.cwd, 'add', '--all']);
          await runGit(['-C', options.cwd, 'commit', '--no-verify', '-m', `mock: automated change #${index}`]);
        }
        return {
          ok: true,
          subtype: 'success',
          finalText: 'Mock run complete.',
          structuredOutput: {
            summary: `Mock execution of: ${options.prompt.slice(0, 80)}`,
            outcome: 'success',
            filesChanged: [],
            commits: [],
            tests: [{ command: 'mock-verify', status: 'passed' }],
            findings: [{ severity: 'info', title: 'mock analysis finding' }],
            blockers: [],
          },
          sessionId: options.resumeSessionId ?? `mock-session-${index}`,
          model: options.model,
          totalCostUsd: 0,
          numTurns: 1,
          permissionDenialCount: 0,
          errorMessage: null,
        };
      });
  }

  setBehavior(behavior: MockBehavior): void {
    this.behavior = behavior;
  }

  async run(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
    if (options.abortSignal.aborted) {
      throw new BridgeError('TASK_CANCELLED', 'Claude execution was cancelled.');
    }
    const index = this.calls.length;
    this.calls.push(options);
    options.onEvent?.({
      kind: 'session_started',
      message: 'Mock Claude session started',
      detail: { sessionId: `mock-session-${index}`, model: options.model },
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    try {
      return await new Promise<ClaudeRunResult>((resolve, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new BridgeError('CLAUDE_TIMEOUT', `Claude execution exceeded the task timeout (${options.timeoutMs}ms).`),
            ),
          options.timeoutMs,
        );
        abortHandler = () => reject(new BridgeError('TASK_CANCELLED', 'Claude execution was cancelled.'));
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });
        Promise.resolve(this.behavior(options, index)).then(resolve, reject);
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abortHandler) options.abortSignal.removeEventListener('abort', abortHandler);
    }
  }
}
