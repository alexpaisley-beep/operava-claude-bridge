import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BridgeAuthProvider } from '../../src/auth/provider.js';
import { createHttpApp } from '../../src/mcp/http.js';
import { createTestContext, TEST_OPERATOR_KEY, TEST_STATIC_TOKEN, type TestContext } from '../helpers/test-env.js';

let ctx: TestContext;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.registerRepo('http-repo');
  const authProvider = new BridgeAuthProvider({ db: ctx.db, config: ctx.config, logger: ctx.logger });
  const app = createHttpApp({
    db: ctx.db,
    config: ctx.config,
    logger: ctx.logger,
    github: ctx.github,
    workflows: ctx.workflows,
    authProvider,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.destroy();
});

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function toolText(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.find((c) => c.type === 'text')?.text ?? '';
}

describe('health and auth boundary', () => {
  it('serves /healthz without authentication', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('rejects unauthenticated MCP requests with 401 + WWW-Authenticate', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });

  it('rejects garbage bearer tokens', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it('requires auth on /metrics', async () => {
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(401);
    const authed = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${TEST_STATIC_TOKEN}` },
    });
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { tasksByStatus: Record<string, number> };
    expect(body.tasksByStatus).toBeDefined();
  });
});

describe('MCP over Streamable HTTP with a real SDK client', () => {
  it('lists all bridge tools with descriptions', async () => {
    const client = await mcpClient(TEST_STATIC_TOKEN);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'ask_claude',
          'cancel_task',
          'cancel_workflow_run',
          'continue_repo_task',
          'get_task_events',
          'get_task_report',
          'get_task_status',
          'get_workflow_run',
          'list_repositories',
          'list_tasks',
          'list_workflows',
          'merge_task_pr',
          'run_workflow',
          'start_repo_task',
        ].sort(),
      );
      for (const tool of tools) {
        expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      }
    } finally {
      await client.close();
    }
  });

  it('runs the start → status → cancel flow end to end through MCP', async () => {
    const client = await mcpClient(TEST_STATIC_TOKEN);
    try {
      const repos = await client.callTool({ name: 'list_repositories', arguments: {} });
      const repoPayload = JSON.parse(toolText(repos)) as { repositories: { repository: string }[] };
      expect(repoPayload.repositories.some((r) => r.repository === 'http-repo')).toBe(true);

      const started = await client.callTool({
        name: 'start_repo_task',
        arguments: {
          repository: 'http-repo',
          objective: 'HTTP end-to-end objective',
          idempotencyKey: 'http-e2e-1',
        },
      });
      const startPayload = JSON.parse(toolText(started)) as { taskId: string; status: string };
      expect(startPayload.status).toBe('QUEUED');
      expect(startPayload.taskId).toMatch(/^cldtask_/);

      // Idempotent retry through the MCP surface returns the same task.
      const retried = await client.callTool({
        name: 'start_repo_task',
        arguments: {
          repository: 'http-repo',
          objective: 'HTTP end-to-end objective',
          idempotencyKey: 'http-e2e-1',
        },
      });
      const retryPayload = JSON.parse(toolText(retried)) as { taskId: string; replayed: boolean };
      expect(retryPayload.taskId).toBe(startPayload.taskId);
      expect(retryPayload.replayed).toBe(true);

      const status = await client.callTool({
        name: 'get_task_status',
        arguments: { taskId: startPayload.taskId },
      });
      const statusPayload = JSON.parse(toolText(status)) as { status: string; running: boolean };
      expect(statusPayload.status).toBe('QUEUED');

      const cancelled = await client.callTool({
        name: 'cancel_task',
        arguments: { taskId: startPayload.taskId },
      });
      expect((JSON.parse(toolText(cancelled)) as { status: string }).status).toBe('CANCELLED');
    } finally {
      await client.close();
    }
  });

  it('returns machine-readable error codes for bad requests', async () => {
    const client = await mcpClient(TEST_STATIC_TOKEN);
    try {
      const result = await client.callTool({
        name: 'start_repo_task',
        arguments: { repository: 'not-a-repo', objective: 'x', idempotencyKey: 'http-err-1' },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(toolText(result)) as { error: { code: string } };
      expect(payload.error.code).toBe('REPOSITORY_NOT_FOUND');

      const missing = await client.callTool({ name: 'get_task_status', arguments: { taskId: 'cldtask_missing' } });
      expect(missing.isError).toBe(true);
      expect((JSON.parse(toolText(missing)) as { error: { code: string } }).error.code).toBe('TASK_NOT_FOUND');
    } finally {
      await client.close();
    }
  });

  it('never leaks server secrets through tool responses', async () => {
    const client = await mcpClient(TEST_STATIC_TOKEN);
    try {
      const repos = await client.callTool({ name: 'list_repositories', arguments: {} });
      const text = toolText(repos);
      expect(text).not.toContain(TEST_OPERATOR_KEY);
      expect(text).not.toContain('ANTHROPIC');
      expect(text).not.toContain('ghp_');
    } finally {
      await client.close();
    }
  });
});

describe('OAuth 2.1 authorization server (ChatGPT connector flow)', () => {
  let clientId: string;
  const redirectUri = 'http://localhost:9400/callback';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  it('serves authorization server metadata', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, string>;
    expect(meta.authorization_endpoint).toContain('/authorize');
    expect(meta.token_endpoint).toContain('/token');
    expect(meta.registration_endpoint).toContain('/register');
    expect(meta.code_challenge_methods_supported).toContain('S256');
  });

  it('serves protected resource metadata at the RFC 9728 path for /mcp', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { resource: string };
    expect(meta.resource).toContain('/mcp');
  });

  it('registers a public client via DCR and rejects confidential clients', async () => {
    const bad = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Bad Client',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });
    expect(bad.status).toBe(400);

    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT Test Connector',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; client_secret?: string };
    expect(body.client_id).toBeTruthy();
    expect(body.client_secret).toBeUndefined();
    clientId = body.client_id;
  });

  async function authorizeAndConsent(operatorKey: string): Promise<Response> {
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'state-xyz');
    const page = await fetch(authorizeUrl);
    expect(page.status).toBe(200);
    const html = await page.text();
    const pendingId = /name="pending_id" value="(pauth_[a-z0-9]+)"/.exec(html)?.[1];
    expect(pendingId).toBeTruthy();
    return fetch(`${baseUrl}/oauth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pending_id: pendingId!, operator_key: operatorKey, action: 'approve' }),
      redirect: 'manual',
    });
  }

  it('rejects consent with a wrong operator key', async () => {
    const res = await authorizeAndConsent('wrong-key');
    expect(res.status).toBe(401);
  });

  let accessToken: string;
  let refreshToken: string;
  let usedCode: string;

  it('completes authorize → consent → token with PKCE', async () => {
    const consent = await authorizeAndConsent(TEST_OPERATOR_KEY);
    expect(consent.status).toBe(302);
    const location = new URL(consent.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get('state')).toBe('state-xyz');
    usedCode = location.searchParams.get('code')!;
    expect(usedCode).toBeTruthy();

    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: usedCode,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tokens.token_type.toLowerCase()).toBe('bearer');
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
  });

  it('accepts the OAuth access token on the MCP endpoint', async () => {
    const client = await mcpClient(accessToken);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(10);
    } finally {
      await client.close();
    }
  });

  it('rejects authorization-code replay', async () => {
    const replay = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: usedCode,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
      }),
    });
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('rotates refresh tokens', async () => {
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).not.toBe(accessToken);

    // The old refresh token is dead after rotation.
    const reuse = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(reuse.status).toBe(400);
  });
});
