import type { BridgeConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import type { GitHubClient } from '../github/types.js';
import type { Logger } from '../logger.js';
import { syncRepositoriesFromGitHub } from './discover-repositories.js';
import { syncRepositoriesFromFile } from './repositories-file.js';

export interface RegistryBootstrapDeps {
  db: Db;
  config: BridgeConfig;
  github: GitHubClient;
  logger: Logger;
}

/**
 * Repository registry bootstrap, run by both entrypoints at startup.
 *
 * Order matters: REPOSITORIES_FILE is applied first so explicitly configured
 * repositories own their keys and settings, then GitHub discovery fills in
 * everything else the token can reach. A broken REPOSITORIES_FILE still fails
 * startup loudly; GitHub being unreachable does not — discovery is additive,
 * so the worst case is booting with the registry exactly as it already was.
 */
export async function bootstrapRepositoryRegistry(deps: RegistryBootstrapDeps): Promise<void> {
  const { db, config, github, logger } = deps;

  if (config.repositoriesFile) {
    await syncRepositoriesFromFile(db, config.repositoriesFile, logger);
  }

  if (!config.githubAutoRegisterRepos) {
    logger.info('github repository discovery disabled (GITHUB_AUTO_REGISTER_REPOS=false)');
    return;
  }

  try {
    const summary = await syncRepositoriesFromGitHub(db, github, logger);
    logger.info(summary, 'github repository discovery complete');
  } catch (err) {
    logger.error({ err }, 'github repository discovery failed; keeping the existing registry');
  }
}
