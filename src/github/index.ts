import type { BridgeConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { createOctokitClient } from './octokit-client.js';
import { MockGitHubClient } from './mock-client.js';
import type { GitHubClient } from './types.js';

export function createGitHubClient(config: BridgeConfig): GitHubClient {
  if (config.githubClient === 'mock') {
    if (config.isProduction) {
      throw new BridgeError('INTERNAL_ERROR', 'GITHUB_CLIENT=mock is not allowed in production.');
    }
    return new MockGitHubClient();
  }
  if (!config.githubToken) {
    throw new BridgeError(
      'GIT_AUTH_ERROR',
      'GITHUB_TOKEN is not configured; the bridge cannot reach GitHub.',
    );
  }
  return createOctokitClient({ token: config.githubToken, baseUrl: config.githubApiBase });
}

export type { GitHubClient, PrInfo, ChecksSummary, MergeResult } from './types.js';
