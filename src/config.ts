import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { newWorkerId } from './ids.js';

/**
 * All runtime configuration comes from the environment (Railway variables in
 * production, .env via your shell locally). Parsed once at process start and
 * passed down explicitly — no module-global config access — so tests can
 * construct configs freely.
 */

const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const intFromEnv = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return defaultValue;
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer in [${min}, ${max}]` });
        return z.NEVER;
      }
      return n;
    });

const csvFromEnv = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

const envSchema = z.object({
  NODE_ENV: z.string().optional().transform((v) => v ?? 'development'),
  LOG_LEVEL: z.string().optional().transform((v) => v ?? 'info'),
  PORT: intFromEnv(8080, 1, 65535),

  /**
   * Public HTTPS origin of the API service (e.g. https://claude-bridge.up.railway.app).
   * Required for OAuth metadata / redirect handling when OAuth is enabled.
   */
  PUBLIC_BASE_URL: z.string().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: boolFromEnv(false),
  DATABASE_POOL_SIZE: intFromEnv(10, 1, 100),

  /** Static bearer tokens (comma separated) for non-OAuth API clients. */
  BRIDGE_API_TOKENS: csvFromEnv(),
  /** Built-in OAuth 2.1 authorization server (required for ChatGPT connectors). */
  OAUTH_ENABLED: boolFromEnv(true),
  /** Human operator secret entered on the OAuth consent page. */
  BRIDGE_OPERATOR_KEY: z.string().optional(),
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: intFromEnv(8 * 3600, 60, 90 * 24 * 3600),
  OAUTH_REFRESH_TOKEN_TTL_SECONDS: intFromEnv(30 * 24 * 3600, 3600, 365 * 24 * 3600),
  OAUTH_CODE_TTL_SECONDS: intFromEnv(600, 30, 3600),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_API_BASE: z.string().optional().transform((v) => v ?? 'https://api.github.com'),
  /** Git remote base (GH Enterprise, or file:// roots for local E2E runs). */
  GIT_REMOTE_URL_BASE: z.string().optional().transform((v) => v ?? 'https://github.com'),
  /** 'octokit' for real GitHub, 'mock' only for tests/local dry runs. */
  GITHUB_CLIENT: z.enum(['octokit', 'mock']).optional().transform((v) => v ?? 'octokit'),
  /**
   * Register every repository GITHUB_TOKEN can reach into the registry at boot
   * (additive only — existing entries, including disabled ones, are untouched).
   */
  GITHUB_AUTO_REGISTER_REPOS: boolFromEnv(true),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** 'agent-sdk' for real Claude Code execution, 'mock' only for tests. */
  CLAUDE_RUNNER: z.enum(['agent-sdk', 'mock']).optional().transform((v) => v ?? 'agent-sdk'),

  WORKSPACE_ROOT: z.string().optional(),
  CLAUDE_HOME_DIR: z.string().optional(),

  CLAUDE_MODEL_DEFAULT: z.string().optional().transform((v) => v ?? 'claude-sonnet-5'),
  CLAUDE_MODEL_FAST: z.string().optional().transform((v) => v ?? 'claude-haiku-4-5'),
  CLAUDE_MODEL_STRONG: z.string().optional().transform((v) => v ?? 'claude-opus-5'),
  CLAUDE_MODEL_STRONGEST: z.string().optional().transform((v) => v ?? 'claude-opus-5'),
  /** Extra explicit model IDs callers may request, comma separated. */
  CLAUDE_MODEL_EXTRA_ALLOWED: csvFromEnv(),
  /** Allow Claude to use WebFetch/WebSearch during engineering tasks. */
  CLAUDE_ALLOW_NETWORK_TOOLS: boolFromEnv(false),

  MAX_CONCURRENT_TASKS: intFromEnv(2, 1, 32),
  MAX_CONCURRENT_WORKFLOWS: intFromEnv(2, 1, 32),
  TASK_TIMEOUT_MS: intFromEnv(45 * 60_000, 60_000, 6 * 3600_000),
  ANALYSIS_TIMEOUT_MS: intFromEnv(20 * 60_000, 60_000, 3600_000 * 2),
  DEFAULT_WORKFLOW_TIMEOUT_MS: intFromEnv(15 * 60_000, 10_000, 3600_000 * 2),
  DEFAULT_MAX_TURNS: intFromEnv(150, 1, 1000),
  MAX_MAX_TURNS: intFromEnv(400, 1, 2000),
  ASK_GENERAL_MAX_TURNS: intFromEnv(16, 1, 100),

  LEASE_SECONDS: intFromEnv(90, 15, 3600),
  HEARTBEAT_INTERVAL_MS: intFromEnv(30_000, 1_000, 300_000),
  WORKER_POLL_INTERVAL_MS: intFromEnv(2_000, 100, 60_000),
  RECONCILE_INTERVAL_MS: intFromEnv(60_000, 5_000, 600_000),
  CLEANUP_INTERVAL_MS: intFromEnv(10 * 60_000, 10_000, 3600_000),
  WORKSPACE_RETENTION_MINUTES: intFromEnv(240, 1, 7 * 24 * 60),
  SHUTDOWN_GRACE_MS: intFromEnv(25_000, 1_000, 300_000),
  MAX_PREPARE_ATTEMPTS: intFromEnv(3, 1, 10),

  MAX_EVENTS_PER_TASK: intFromEnv(500, 20, 10_000),
  MAX_EVENT_DETAIL_BYTES: intFromEnv(8_192, 256, 1_000_000),
  MAX_RESULT_SUMMARY_BYTES: intFromEnv(20_000, 1_000, 1_000_000),
  MAX_RAW_RESPONSE_BYTES: intFromEnv(100_000, 1_000, 5_000_000),
  MAX_OBJECTIVE_BYTES: intFromEnv(512_000, 1_000, 5_000_000),
  MAX_DIFF_CONTEXT_BYTES: intFromEnv(200_000, 1_000, 2_000_000),
  MAX_WORKFLOW_OUTPUT_BYTES: intFromEnv(1_000_000, 10_000, 20_000_000),

  MERGE_REQUIRE_CHECKS: boolFromEnv(true),
  MERGE_REQUIRE_RESOLVED_THREADS: boolFromEnv(true),

  RATE_LIMIT_RPM: intFromEnv(240, 1, 100_000),
  AUTH_RATE_LIMIT_RPM: intFromEnv(30, 1, 10_000),

  REPOSITORIES_FILE: z.string().optional(),
  WORKFLOWS_FILE: z.string().optional(),

  GIT_USER_NAME: z.string().optional().transform((v) => v ?? 'Operava Claude Bridge'),
  GIT_USER_EMAIL: z
    .string()
    .optional()
    .transform((v) => v ?? 'claude-bridge[bot]@users.noreply.github.com'),

  WORKER_ID: z.string().optional(),
});

export type BridgeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;

  const isProduction = e.NODE_ENV === 'production';
  const publicBaseUrl = (e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, '');

  if (isProduction) {
    if (e.BRIDGE_API_TOKENS.length === 0 && !(e.OAUTH_ENABLED && e.BRIDGE_OPERATOR_KEY)) {
      throw new Error(
        'Refusing to start in production without authentication: set BRIDGE_API_TOKENS and/or OAUTH_ENABLED=true with BRIDGE_OPERATOR_KEY.',
      );
    }
    if (e.OAUTH_ENABLED && !e.PUBLIC_BASE_URL) {
      throw new Error('PUBLIC_BASE_URL is required in production when OAUTH_ENABLED=true.');
    }
    if (e.OAUTH_ENABLED && e.BRIDGE_OPERATOR_KEY && e.BRIDGE_OPERATOR_KEY.length < 16) {
      throw new Error('BRIDGE_OPERATOR_KEY must be at least 16 characters.');
    }
    for (const t of e.BRIDGE_API_TOKENS) {
      if (t.length < 24) throw new Error('Each BRIDGE_API_TOKENS entry must be at least 24 characters.');
    }
  }

  const dataRoot = path.resolve(process.cwd(), 'data');
  const modelAliases: Record<string, string> = {
    default: e.CLAUDE_MODEL_DEFAULT,
    fast: e.CLAUDE_MODEL_FAST,
    strong: e.CLAUDE_MODEL_STRONG,
    strongest: e.CLAUDE_MODEL_STRONGEST,
  };
  const allowedModels = new Set<string>([
    ...Object.values(modelAliases),
    ...e.CLAUDE_MODEL_EXTRA_ALLOWED,
  ]);

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    logLevel: e.LOG_LEVEL,
    port: e.PORT,
    publicBaseUrl,

    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    databasePoolSize: e.DATABASE_POOL_SIZE,

    staticApiTokens: e.BRIDGE_API_TOKENS,
    oauthEnabled: e.OAUTH_ENABLED,
    operatorKey: e.BRIDGE_OPERATOR_KEY,
    oauthAccessTokenTtlSeconds: e.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    oauthRefreshTokenTtlSeconds: e.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    oauthCodeTtlSeconds: e.OAUTH_CODE_TTL_SECONDS,

    githubToken: e.GITHUB_TOKEN,
    githubApiBase: e.GITHUB_API_BASE,
    githubClient: e.GITHUB_CLIENT,
    githubAutoRegisterRepos: e.GITHUB_AUTO_REGISTER_REPOS,
    gitRemoteUrlBase: e.GIT_REMOTE_URL_BASE.replace(/\/+$/, ''),

    anthropicApiKey: e.ANTHROPIC_API_KEY,
    claudeRunner: e.CLAUDE_RUNNER,

    workspaceRoot: e.WORKSPACE_ROOT ?? path.join(dataRoot, 'workspaces'),
    claudeHomeDir: e.CLAUDE_HOME_DIR ?? path.join(dataRoot, 'claude-home'),

    modelAliases,
    allowedModels,
    defaultModel: e.CLAUDE_MODEL_DEFAULT,
    claudeAllowNetworkTools: e.CLAUDE_ALLOW_NETWORK_TOOLS,

    maxConcurrentTasks: e.MAX_CONCURRENT_TASKS,
    maxConcurrentWorkflows: e.MAX_CONCURRENT_WORKFLOWS,
    taskTimeoutMs: e.TASK_TIMEOUT_MS,
    analysisTimeoutMs: e.ANALYSIS_TIMEOUT_MS,
    defaultWorkflowTimeoutMs: e.DEFAULT_WORKFLOW_TIMEOUT_MS,
    defaultMaxTurns: e.DEFAULT_MAX_TURNS,
    maxMaxTurns: e.MAX_MAX_TURNS,
    askGeneralMaxTurns: e.ASK_GENERAL_MAX_TURNS,

    leaseSeconds: e.LEASE_SECONDS,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    workerPollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
    reconcileIntervalMs: e.RECONCILE_INTERVAL_MS,
    cleanupIntervalMs: e.CLEANUP_INTERVAL_MS,
    workspaceRetentionMinutes: e.WORKSPACE_RETENTION_MINUTES,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    maxPrepareAttempts: e.MAX_PREPARE_ATTEMPTS,

    maxEventsPerTask: e.MAX_EVENTS_PER_TASK,
    maxEventDetailBytes: e.MAX_EVENT_DETAIL_BYTES,
    maxResultSummaryBytes: e.MAX_RESULT_SUMMARY_BYTES,
    maxRawResponseBytes: e.MAX_RAW_RESPONSE_BYTES,
    maxObjectiveBytes: e.MAX_OBJECTIVE_BYTES,
    maxDiffContextBytes: e.MAX_DIFF_CONTEXT_BYTES,
    maxWorkflowOutputBytes: e.MAX_WORKFLOW_OUTPUT_BYTES,

    mergeRequireChecks: e.MERGE_REQUIRE_CHECKS,
    mergeRequireResolvedThreads: e.MERGE_REQUIRE_RESOLVED_THREADS,

    rateLimitRpm: e.RATE_LIMIT_RPM,
    authRateLimitRpm: e.AUTH_RATE_LIMIT_RPM,

    repositoriesFile: e.REPOSITORIES_FILE,
    workflowsFile: e.WORKFLOWS_FILE,

    gitUserName: e.GIT_USER_NAME,
    gitUserEmail: e.GIT_USER_EMAIL,

    workerId: e.WORKER_ID ?? `${newWorkerId()}@${os.hostname()}`,
  };
}
