import type { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
  OAuthTokenVerifier,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { BridgeConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import {
  consumeAuthorizationCode,
  consumePendingAuthorization,
  getOAuthClient,
  getToken,
  insertAuthorizationCode,
  insertOAuthClient,
  insertPendingAuthorization,
  insertToken,
  peekAuthorizationCode,
  revokeToken as dbRevokeToken,
} from '../db/oauth.js';
import {
  newAccessToken,
  newAuthorizationCode,
  newPendingAuthorizationId,
  newRefreshToken,
  safeEqual,
  sha256Hex,
} from '../ids.js';
import type { Logger } from '../logger.js';
import { renderConsentPage } from './consent-page.js';

const BRIDGE_SCOPE = 'bridge';
const STATIC_TOKEN_LIFETIME_SECONDS = 10 * 365 * 24 * 3600;

/**
 * Built-in OAuth 2.1 authorization server + resource-server token verifier.
 *
 * ChatGPT connectors require OAuth 2.1 with dynamic client registration and
 * PKCE; this provider implements exactly that, backed by Postgres:
 *  - DCR accepts PUBLIC clients only (token_endpoint_auth_method "none"),
 *    which is what ChatGPT uses — no client secrets are ever stored.
 *  - /authorize renders a consent page; the human operator approves with the
 *    BRIDGE_OPERATOR_KEY. Codes/tokens are stored as SHA-256 hashes.
 *  - verifyAccessToken also accepts the static BRIDGE_API_TOKENS entries so
 *    non-ChatGPT API clients can use a plain bearer token.
 */
export class BridgeAuthProvider implements OAuthServerProvider, OAuthTokenVerifier {
  constructor(
    private readonly deps: { db: Db; config: BridgeConfig; logger: Logger },
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const { db } = this.deps;
    return {
      getClient: async (clientId: string) => {
        const stored = await getOAuthClient(db, clientId);
        return stored ? (stored.metadata as OAuthClientInformationFull) : undefined;
      },
      registerClient: async (client: OAuthClientInformationFull) => {
        const method = client.token_endpoint_auth_method ?? 'client_secret_basic';
        if (method !== 'none') {
          throw new InvalidClientMetadataError(
            'This server registers public clients only; set token_endpoint_auth_method to "none" and use PKCE.',
          );
        }
        const redirectUris = client.redirect_uris ?? [];
        if (redirectUris.length === 0 || redirectUris.length > 10) {
          throw new InvalidClientMetadataError('redirect_uris must contain between 1 and 10 entries.');
        }
        for (const uri of redirectUris) {
          if (!isAcceptableRedirectUri(uri, this.deps.config.isProduction)) {
            throw new InvalidClientMetadataError(`Unacceptable redirect_uri: ${uri}`);
          }
        }
        const sanitized: OAuthClientInformationFull = {
          ...client,
          client_secret: undefined,
          client_secret_expires_at: undefined,
          token_endpoint_auth_method: 'none',
        };
        await insertOAuthClient(db, {
          clientId: sanitized.client_id,
          clientSecretHash: null,
          metadata: sanitized as unknown as Record<string, unknown>,
        });
        this.deps.logger.info({ clientId: sanitized.client_id, clientName: client.client_name }, 'oauth client registered');
        return sanitized;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!this.deps.config.operatorKey) {
      throw new ServerError('OAuth sign-in is not configured on this server (missing operator key).');
    }
    const pendingId = newPendingAuthorizationId();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await insertPendingAuthorization(this.deps.db, {
      id: pendingId,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state ?? null,
      scopes: params.scopes?.length ? params.scopes : [BRIDGE_SCOPE],
      resource: params.resource?.toString() ?? null,
      expiresAt,
    });
    res
      .status(200)
      .type('html')
      .send(
        renderConsentPage({
          clientName: client.client_name ?? client.client_id,
          redirectHost: safeHost(params.redirectUri),
          pendingId,
        }),
      );
  }

  /**
   * Operator approval from the consent form. Returns the redirect URL that
   * delivers the authorization code, or null when the operator key is wrong.
   */
  async approveConsent(pendingId: string, operatorKey: string): Promise<string | null> {
    const { config, db } = this.deps;
    if (!config.operatorKey || !safeEqual(operatorKey, config.operatorKey)) {
      return null;
    }
    const pending = await consumePendingAuthorization(db, pendingId);
    if (!pending) return null;
    const code = newAuthorizationCode();
    await insertAuthorizationCode(db, {
      codeHash: sha256Hex(code),
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: new Date(Date.now() + config.oauthCodeTtlSeconds * 1000),
    });
    const url = new URL(pending.redirectUri);
    url.searchParams.set('code', code);
    if (pending.state) url.searchParams.set('state', pending.state);
    return url.toString();
  }

  async denyConsent(pendingId: string): Promise<string | null> {
    const pending = await consumePendingAuthorization(this.deps.db, pendingId);
    if (!pending) return null;
    const url = new URL(pending.redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'The operator declined the request.');
    if (pending.state) url.searchParams.set('state', pending.state);
    return url.toString();
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const stored = await peekAuthorizationCode(this.deps.db, sha256Hex(authorizationCode));
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown, expired, or already-used authorization code.');
    }
    return stored.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const { db } = this.deps;
    const codeHash = sha256Hex(authorizationCode);
    const stored = await peekAuthorizationCode(db, codeHash);
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown, expired, or already-used authorization code.');
    }
    if (redirectUri && redirectUri !== stored.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    }
    const consumed = await consumeAuthorizationCode(db, codeHash);
    if (!consumed) {
      throw new InvalidGrantError('Authorization code was already used.');
    }
    return this.issueTokens(client.client_id, stored.scopes, stored.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const { db } = this.deps;
    const hash = sha256Hex(refreshToken);
    const stored = await getToken(db, hash);
    if (!stored || stored.kind !== 'refresh' || stored.revoked || stored.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown or revoked refresh token.');
    }
    if (stored.expiresAt && stored.expiresAt.getTime() < Date.now()) {
      throw new InvalidGrantError('Refresh token expired.');
    }
    const grantedScopes =
      scopes && scopes.length > 0 ? scopes.filter((s) => stored.scopes.includes(s)) : stored.scopes;
    // Rotate: the old refresh token dies with this exchange.
    await dbRevokeToken(db, hash);
    return this.issueTokens(client.client_id, grantedScopes, stored.resource);
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: string | null,
  ): Promise<OAuthTokens> {
    const { config, db } = this.deps;
    const accessToken = newAccessToken();
    const refreshToken = newRefreshToken();
    const now = Date.now();
    await insertToken(db, {
      tokenHash: sha256Hex(accessToken),
      kind: 'access',
      clientId,
      scopes,
      resource,
      expiresAt: new Date(now + config.oauthAccessTokenTtlSeconds * 1000),
      revoked: false,
    });
    await insertToken(db, {
      tokenHash: sha256Hex(refreshToken),
      kind: 'refresh',
      clientId,
      scopes,
      resource,
      expiresAt: new Date(now + config.oauthRefreshTokenTtlSeconds * 1000),
      revoked: false,
    });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: config.oauthAccessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { config, db } = this.deps;
    for (const staticToken of config.staticApiTokens) {
      if (safeEqual(token, staticToken)) {
        return {
          token,
          clientId: 'static-bridge-token',
          scopes: [BRIDGE_SCOPE],
          expiresAt: Math.floor(Date.now() / 1000) + STATIC_TOKEN_LIFETIME_SECONDS,
        };
      }
    }
    const stored = await getToken(db, sha256Hex(token));
    if (!stored || stored.kind !== 'access' || stored.revoked) {
      throw new InvalidTokenError('Unknown or revoked access token.');
    }
    if (stored.expiresAt && stored.expiresAt.getTime() < Date.now()) {
      throw new InvalidTokenError('Access token expired.');
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes.length > 0 ? stored.scopes : [BRIDGE_SCOPE],
      expiresAt: stored.expiresAt
        ? Math.floor(stored.expiresAt.getTime() / 1000)
        : Math.floor(Date.now() / 1000) + STATIC_TOKEN_LIFETIME_SECONDS,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const stored = await getToken(this.deps.db, sha256Hex(request.token));
    if (stored && stored.clientId === client.client_id) {
      await dbRevokeToken(this.deps.db, sha256Hex(request.token));
    }
  }
}

function isAcceptableRedirectUri(uri: string, isProduction: boolean): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'https:') return true;
    if (!isProduction && parsed.protocol === 'http:') {
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    }
    return false;
  } catch {
    return false;
  }
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return 'unknown host';
  }
}
