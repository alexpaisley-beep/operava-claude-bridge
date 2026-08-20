import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Unambiguous lowercase alphabet (no i/l/o/u) so IDs survive humans reading
 * them aloud and URLs without escaping.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function randomToken(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return out;
}

export const newTaskId = (): string => `cldtask_${randomToken(20)}`;
export const newContinuationId = (): string => `cont_${randomToken(20)}`;
export const newWorkflowRunId = (): string => `wfrun_${randomToken(20)}`;
export const newWorkerId = (): string => `wrk_${randomToken(12)}`;
export const newOAuthClientId = (): string => `client_${randomToken(24)}`;
export const newAccessToken = (): string => `mcpat_${randomToken(48)}`;
export const newRefreshToken = (): string => `mcprt_${randomToken(48)}`;
export const newAuthorizationCode = (): string => `mcpac_${randomToken(48)}`;
export const newPendingAuthorizationId = (): string => `pauth_${randomToken(24)}`;

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison that does not leak length information.
 * Both inputs are hashed first so lengths always match for timingSafeEqual.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Filesystem/branch-safe slug from free text. */
export function slugify(text: string, maxLength = 24): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'task';
}

/**
 * Canonical JSON for idempotency request hashing: stable key order so that
 * semantically identical payloads hash identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortValue(v);
    return out;
  }
  return value;
}

export function requestHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
