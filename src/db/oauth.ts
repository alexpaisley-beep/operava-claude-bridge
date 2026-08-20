import type { Queryable } from './pool.js';

/**
 * Storage for the built-in OAuth 2.1 authorization server. All secrets
 * (codes, tokens) are stored as SHA-256 hashes; the plaintext value exists
 * only in the HTTP response that delivers it to the client.
 */

export interface StoredOAuthClient {
  clientId: string;
  clientSecretHash: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export async function insertOAuthClient(
  q: Queryable,
  client: { clientId: string; clientSecretHash: string | null; metadata: Record<string, unknown> },
): Promise<void> {
  await q.query(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, client_metadata)
     VALUES ($1, $2, $3)`,
    [client.clientId, client.clientSecretHash, JSON.stringify(client.metadata)],
  );
}

export async function getOAuthClient(q: Queryable, clientId: string): Promise<StoredOAuthClient | null> {
  const { rows } = await q.query<{
    client_id: string;
    client_secret_hash: string | null;
    client_metadata: Record<string, unknown>;
    created_at: Date;
  }>(`SELECT client_id, client_secret_hash, client_metadata, created_at FROM oauth_clients WHERE client_id = $1`, [
    clientId,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    metadata: row.client_metadata,
    createdAt: row.created_at,
  };
}

export interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scopes: string[];
  resource: string | null;
  expiresAt: Date;
}

export async function insertPendingAuthorization(q: Queryable, p: PendingAuthorization): Promise<void> {
  await q.query(
    `INSERT INTO oauth_pending_authorizations
       (id, client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [p.id, p.clientId, p.redirectUri, p.codeChallenge, p.state, p.scopes, p.resource, p.expiresAt],
  );
}

/** Fetch and delete atomically — a pending authorization is single use. */
export async function consumePendingAuthorization(
  q: Queryable,
  id: string,
): Promise<PendingAuthorization | null> {
  const { rows } = await q.query<{
    id: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    state: string | null;
    scopes: string[];
    resource: string | null;
    expires_at: Date;
  }>(
    `DELETE FROM oauth_pending_authorizations WHERE id = $1 AND expires_at > now()
     RETURNING id, client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    state: row.state,
    scopes: row.scopes ?? [],
    resource: row.resource,
    expiresAt: row.expires_at,
  };
}

export interface StoredAuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string | null;
}

export async function insertAuthorizationCode(
  q: Queryable,
  c: StoredAuthorizationCode & { codeHash: string; expiresAt: Date },
): Promise<void> {
  await q.query(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [c.codeHash, c.clientId, c.redirectUri, c.codeChallenge, c.scopes, c.resource, c.expiresAt],
  );
}

export async function peekAuthorizationCode(
  q: Queryable,
  codeHash: string,
): Promise<StoredAuthorizationCode | null> {
  const { rows } = await q.query<{
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    scopes: string[];
    resource: string | null;
  }>(
    `SELECT client_id, redirect_uri, code_challenge, scopes, resource
     FROM oauth_codes WHERE code_hash = $1 AND consumed = FALSE AND expires_at > now()`,
    [codeHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scopes: row.scopes ?? [],
    resource: row.resource,
  };
}

/** Mark a code consumed; returns false when already consumed/expired (replay). */
export async function consumeAuthorizationCode(q: Queryable, codeHash: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE oauth_codes SET consumed = TRUE
     WHERE code_hash = $1 AND consumed = FALSE AND expires_at > now()`,
    [codeHash],
  );
  return (rowCount ?? 0) > 0;
}

export interface StoredToken {
  kind: 'access' | 'refresh';
  clientId: string;
  scopes: string[];
  resource: string | null;
  expiresAt: Date | null;
  revoked: boolean;
}

export async function insertToken(
  q: Queryable,
  t: StoredToken & { tokenHash: string },
): Promise<void> {
  await q.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, resource, expires_at, revoked)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [t.tokenHash, t.kind, t.clientId, t.scopes, t.resource, t.expiresAt, t.revoked],
  );
}

export async function getToken(q: Queryable, tokenHash: string): Promise<StoredToken | null> {
  const { rows } = await q.query<{
    kind: 'access' | 'refresh';
    client_id: string;
    scopes: string[];
    resource: string | null;
    expires_at: Date | null;
    revoked: boolean;
  }>(
    `SELECT kind, client_id, scopes, resource, expires_at, revoked FROM oauth_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    kind: row.kind,
    clientId: row.client_id,
    scopes: row.scopes ?? [],
    resource: row.resource,
    expiresAt: row.expires_at,
    revoked: row.revoked,
  };
}

export async function revokeToken(q: Queryable, tokenHash: string): Promise<void> {
  await q.query(`UPDATE oauth_tokens SET revoked = TRUE WHERE token_hash = $1`, [tokenHash]);
}

/** Periodic hygiene: purge expired codes/tokens/pending authorizations. */
export async function purgeExpiredOAuthState(q: Queryable): Promise<void> {
  await q.query(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'`);
  await q.query(`DELETE FROM oauth_pending_authorizations WHERE expires_at < now() - interval '1 day'`);
  await q.query(
    `DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at < now() - interval '30 days'`,
  );
}
