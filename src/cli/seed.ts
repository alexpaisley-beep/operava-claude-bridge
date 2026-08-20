import { loadConfig } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { upsertRepository } from '../db/repositories.js';
import { createLogger } from '../logger.js';

/**
 * Development seed: registers this bridge's own repository with the built-in
 * echo-check workflow enabled, which is enough to exercise every feature
 * locally (with mock or real integrations).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, service: 'seed' });
  const db = createPool(config);
  await runMigrations(db, { logger });
  const repo = await upsertRepository(db, {
    key: 'claude-bridge',
    githubOwner: process.env.SEED_GITHUB_OWNER ?? 'alexpaisley-beep',
    githubRepo: process.env.SEED_GITHUB_REPO ?? 'operava-claude-bridge',
    defaultBranch: process.env.SEED_DEFAULT_BRANCH ?? 'main',
    allowMerge: false,
    concurrencyLimit: 1,
    workflows: ['echo-check'],
    instructions:
      'This is the Operava Claude Bridge codebase itself (TypeScript, Node 22, ESM). Run `npm run typecheck && npm run lint && npm test` to verify changes.',
  });
  console.log(`Seeded repository "${repo.key}" → ${repo.githubOwner}/${repo.githubRepo}`);
  await db.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
