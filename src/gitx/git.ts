import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from '../errors.js';

/**
 * Safe git execution:
 *  - execFile only, never a shell — caller-supplied values cannot inject commands;
 *  - values that could look like flags are validated upstream and passed after `--`
 *    where git supports it;
 *  - GitHub credentials are injected via an askpass helper reading an env var,
 *    so tokens never appear in argv, in on-disk git config, or in remote URLs;
 *  - prompts are disabled — git fails fast instead of hanging.
 */

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

let askpassPathPromise: Promise<string> | null = null;

/** Write the askpass helper once per process into a private temp dir. */
async function ensureAskpass(): Promise<string> {
  if (!askpassPathPromise) {
    askpassPathPromise = (async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-askpass-'));
      const file = path.join(dir, 'askpass.sh');
      const script = `#!/bin/sh
case "$1" in
  Username*) printf '%s' "x-access-token" ;;
  Password*) printf '%s' "$GIT_BRIDGE_TOKEN" ;;
esac
`;
      await fs.writeFile(file, script, { mode: 0o700 });
      return file;
    })();
  }
  return askpassPathPromise;
}

export interface GitOptions {
  cwd?: string;
  /** GitHub token for this invocation only. Omit to run credential-less. */
  token?: string;
  timeoutMs?: number;
  /** Do not throw on non-zero exit; return the result instead. */
  allowFailure?: boolean;
  env?: Record<string, string>;
  maxOutputBytes?: number;
}

export async function runGit(args: string[], opts: GitOptions = {}): Promise<GitRunResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? os.tmpdir(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    ...opts.env,
  };
  if (opts.token) {
    env.GIT_ASKPASS = await ensureAskpass();
    env.GIT_BRIDGE_TOKEN = opts.token;
  }
  // Disable any configured credential helpers so only our askpass answers,
  // and never write credentials anywhere.
  const fullArgs = ['-c', 'credential.helper=', ...args];

  return new Promise<GitRunResult>((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      {
        cwd: opts.cwd,
        env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxOutputBytes ?? 16 * 1024 * 1024,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as unknown as { code: number }).code as number)
            : error
              ? 1
              : 0;
        const result: GitRunResult = {
          stdout: stdout?.toString() ?? '',
          stderr: scrubSecrets(stderr?.toString() ?? '', opts.token),
          code,
        };
        if (error && !opts.allowFailure) {
          reject(mapGitError(args, result));
        } else {
          resolve(result);
        }
      },
    );
  });
}

function scrubSecrets(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join('[redacted]');
  return out;
}

function mapGitError(args: string[], result: GitRunResult): BridgeError {
  const op = args.find((a) => !a.startsWith('-')) ?? 'git';
  const stderr = result.stderr.slice(0, 2000);
  if (/authentication failed|could not read Username|invalid credentials|403/i.test(stderr)) {
    return new BridgeError('GIT_AUTH_ERROR', `git ${op} failed to authenticate with the remote.`, {
      detail: stderr,
    });
  }
  if (/(non-fast-forward|fetch first|cannot lock ref|merge conflict|rejected)/i.test(stderr)) {
    return new BridgeError('GIT_CONFLICT', `git ${op} was rejected by the remote.`, { detail: stderr });
  }
  return new BridgeError('GIT_ERROR', `git ${op} failed (exit ${result.code}).`, { detail: stderr });
}
