import os from 'node:os';
import { BridgeAuthProvider } from '../auth/provider.js';
import { loadConfig } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { purgeExpiredOAuthState } from '../db/oauth.js';
import { createPool } from '../db/pool.js';
import { heartbeatWorker } from '../db/workers.js';
import { createGitHubClient } from '../github/index.js';
import { createLogger } from '../logger.js';
import { createHttpApp } from '../mcp/http.js';
import { bootstrapRepositoryRegistry } from '../registry/bootstrap.js';
import { loadWorkflowRegistry } from '../workflows/registry.js';

/**
 * claude-bridge-api entrypoint: serves the MCP endpoint, OAuth, health and
 * metrics. All long-running work is executed by the worker service; every MCP
 * mutation returns quickly with a durable ID.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, service: 'claude-bridge-api' });
  const db = createPool(config);

  await runMigrations(db, { logger });
  const github = createGitHubClient(config);
  await bootstrapRepositoryRegistry({ db, config, github, logger });
  const workflows = await loadWorkflowRegistry(config.workflowsFile);
  const authProvider = new BridgeAuthProvider({ db, config, logger });

  const app = createHttpApp({ db, config, logger, github, workflows, authProvider });
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, publicBaseUrl: config.publicBaseUrl, oauth: config.oauthEnabled },
      'claude-bridge-api listening',
    );
  });
  server.requestTimeout = 120_000;

  const instanceId = `${config.workerId}-api`;
  const heartbeat = setInterval(() => {
    heartbeatWorker(db, { id: instanceId, kind: 'api', hostname: os.hostname() }).catch((err) =>
      logger.warn({ err }, 'api heartbeat failed'),
    );
  }, config.heartbeatIntervalMs);
  const oauthSweep = setInterval(() => {
    purgeExpiredOAuthState(db).catch((err) => logger.warn({ err }, 'oauth purge failed'));
  }, 6 * 3600_000);
  await heartbeatWorker(db, { id: instanceId, kind: 'api', hostname: os.hostname() });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'api shutting down');
    clearInterval(heartbeat);
    clearInterval(oauthSweep);
    server.close(() => {
      db.end()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    // Hard exit if connections refuse to drain in time.
    setTimeout(() => process.exit(0), config.shutdownGraceMs).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('claude-bridge-api failed to start:', err);
  process.exit(1);
});
