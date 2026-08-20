import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockClaudeRunner } from '../../src/claude/mock-runner.js';
import { loadConfig, type BridgeConfig } from '../../src/config.js';
import { upsertRepository, type RepositoryUpsert } from '../../src/db/repositories.js';
import type { Db } from '../../src/db/pool.js';
import type { RepositoryConfig } from '../../src/domain/types.js';
import { WorkspaceManager } from '../../src/gitx/workspace.js';
import { MockGitHubClient } from '../../src/github/mock-client.js';
import { createLogger } from '../../src/logger.js';
import type { TaskServiceDeps } from '../../src/services/task-service.js';
import type { WorkflowServiceDeps } from '../../src/services/workflow-service.js';
import type { TaskWorkerDeps } from '../../src/worker/task-execution.js';
import type { WorkflowWorkerDeps } from '../../src/worker/workflow-execution.js';
import { loadWorkflowRegistry, type WorkflowRegistry } from '../../src/workflows/registry.js';
import { randomToken } from '../../src/ids.js';
import { createBareRemote } from './git-fixtures.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';

export const TEST_STATIC_TOKEN = 'test-static-bridge-token-0123456789abcdef';
export const TEST_OPERATOR_KEY = 'operator-key-for-tests-123456';

export interface TestContext {
  db: Db;
  dbInfo: TestDatabase;
  config: BridgeConfig;
  logger: ReturnType<typeof createLogger>;
  github: MockGitHubClient;
  claude: MockClaudeRunner;
  workspaces: WorkspaceManager;
  workflows: WorkflowRegistry;
  taskDeps: TaskServiceDeps;
  wfDeps: WorkflowServiceDeps;
  workerDeps: TaskWorkerDeps & WorkflowWorkerDeps;
  tmpRoot: string;
  remotes: Map<string, string>;
  shuttingDown: { value: boolean };
  registerRepo: (key: string, overrides?: Partial<RepositoryUpsert>) => Promise<{ repo: RepositoryConfig; barePath: string }>;
  destroy: () => Promise<void>;
}

export async function createTestContext(envOverrides: Record<string, string> = {}): Promise<TestContext> {
  const dbInfo = await createTestDatabase();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: dbInfo.url,
    BRIDGE_API_TOKENS: TEST_STATIC_TOKEN,
    BRIDGE_OPERATOR_KEY: TEST_OPERATOR_KEY,
    OAUTH_ENABLED: 'true',
    PUBLIC_BASE_URL: 'http://127.0.0.1:0',
    GITHUB_CLIENT: 'mock',
    CLAUDE_RUNNER: 'mock',
    WORKSPACE_ROOT: path.join(tmpRoot, 'workspaces'),
    CLAUDE_HOME_DIR: path.join(tmpRoot, 'claude-home'),
    HEARTBEAT_INTERVAL_MS: '1000',
    LEASE_SECONDS: '15',
    WORKER_POLL_INTERVAL_MS: '100',
    TASK_TIMEOUT_MS: '60000',
    ANALYSIS_TIMEOUT_MS: '60000',
    WORKER_ID: `test-worker-${randomToken(6)}`,
    ...envOverrides,
  });

  const logger = createLogger({ level: process.env.TEST_LOG_LEVEL ?? 'silent', service: 'test' });
  const github = new MockGitHubClient();
  const claude = new MockClaudeRunner();
  const workflows = await loadWorkflowRegistry(config.workflowsFile);
  const remotes = new Map<string, string>();
  const workspaces = new WorkspaceManager({
    workspaceRoot: config.workspaceRoot,
    gitUserName: config.gitUserName,
    gitUserEmail: config.gitUserEmail,
    logger,
    tokenProvider: () => undefined,
    remoteUrlFor: (repo) => {
      const url = remotes.get(repo.key);
      if (!url) throw new Error(`no test remote registered for ${repo.key}`);
      return url;
    },
  });

  const shuttingDown = { value: false };
  const taskDeps: TaskServiceDeps = { db: dbInfo.db, config, logger, github };
  const wfDeps: WorkflowServiceDeps = { db: dbInfo.db, config, logger, github, workflows };
  const workerDeps: TaskWorkerDeps & WorkflowWorkerDeps = {
    db: dbInfo.db,
    config,
    logger,
    github,
    claude,
    workspaces,
    workflows,
    workerId: config.workerId,
    isShuttingDown: () => shuttingDown.value,
  };

  return {
    db: dbInfo.db,
    dbInfo,
    config,
    logger,
    github,
    claude,
    workspaces,
    workflows,
    taskDeps,
    wfDeps,
    workerDeps,
    tmpRoot,
    remotes,
    shuttingDown,
    registerRepo: async (key, overrides = {}) => {
      const barePath = await createBareRemote(tmpRoot);
      remotes.set(key, barePath);
      const repo = await upsertRepository(dbInfo.db, {
        key,
        githubOwner: 'testorg',
        githubRepo: key,
        defaultBranch: 'main',
        workflows: ['echo-check'],
        ...overrides,
      });
      return { repo, barePath };
    },
    destroy: async () => {
      await dbInfo.drop();
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
