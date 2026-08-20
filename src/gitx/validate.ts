import { BridgeError } from '../errors.js';

/**
 * Strict validation for values that end up in git argv or filesystem paths.
 * Everything is spawned with execFile (never a shell), so the threat model is
 * flag injection ("-..." values) and git ref trickery, not shell metacharacters
 * — but we reject those too for defense in depth.
 */

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export function isValidBranchName(name: string): boolean {
  if (!BRANCH_RE.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.split('/').some((seg) => seg.length === 0 || seg.startsWith('.'))) return false;
  return true;
}

export function assertValidBranchName(name: string, label = 'branch'): string {
  if (!isValidBranchName(name)) {
    throw new BridgeError('VALIDATION_ERROR', `Invalid ${label} name: ${JSON.stringify(name)}`);
  }
  return name;
}

const REPO_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertValidRepoKey(key: string): string {
  if (!REPO_KEY_RE.test(key)) {
    throw new BridgeError('VALIDATION_ERROR', `Invalid repository key: ${JSON.stringify(key)}`);
  }
  return key;
}

const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

export function assertValidGitHubName(name: string, label: string): string {
  if (!OWNER_REPO_RE.test(name) || name.includes('..')) {
    throw new BridgeError('VALIDATION_ERROR', `Invalid GitHub ${label}: ${JSON.stringify(name)}`);
  }
  return name;
}

const SHA_RE = /^[0-9a-f]{7,64}$/;

export function assertValidSha(sha: string): string {
  if (!SHA_RE.test(sha)) {
    throw new BridgeError('VALIDATION_ERROR', `Invalid commit SHA: ${JSON.stringify(sha)}`);
  }
  return sha;
}

export function isValidSha(sha: string): boolean {
  return SHA_RE.test(sha);
}
