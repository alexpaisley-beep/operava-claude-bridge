import type { DbClient, Queryable } from './pool.js';
import { BridgeError } from '../errors.js';

export interface IdempotencyRecord {
  scope: string;
  key: string;
  requestHash: string;
  resourceType: string;
  resourceId: string;
}

/**
 * Look up an idempotency key inside the caller's transaction. Returns the
 * existing record when the same request was already processed; throws
 * IDEMPOTENCY_CONFLICT when the key was used with a different payload.
 */
export async function findIdempotentReplay(
  client: Queryable,
  scope: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyRecord | null> {
  const { rows } = await client.query<{
    request_hash: string;
    resource_type: string;
    resource_id: string;
  }>(`SELECT request_hash, resource_type, resource_id FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
    scope,
    key,
  ]);
  const row = rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw new BridgeError(
      'IDEMPOTENCY_CONFLICT',
      `Idempotency key was already used for a different ${scope} request. Use a fresh key for new work.`,
      { detail: `scope=${scope}` },
    );
  }
  return {
    scope,
    key,
    requestHash: row.request_hash,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
  };
}

/**
 * Record an idempotency key for a newly created resource, in the same
 * transaction that created it. A concurrent duplicate insert surfaces as a
 * unique violation after this transaction commits; callers catch error code
 * 23505 and re-read the winner.
 */
export async function saveIdempotencyKey(
  client: DbClient,
  record: IdempotencyRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (scope, key, request_hash, resource_type, resource_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [record.scope, record.key, record.requestHash, record.resourceType, record.resourceId],
  );
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
