import express, { type Express, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { BridgeAuthProvider } from '../auth/provider.js';
import { renderConsentPage } from '../auth/consent-page.js';
import { bearerKey, clientIpKey, createRateLimiter } from '../auth/rate-limit.js';
import type { BridgeConfig } from '../config.js';
import { countTasksByStatus } from '../db/tasks.js';
import { countWorkflowRunsByStatus } from '../db/workflow-runs.js';
import { listWorkers } from '../db/workers.js';
import type { Db } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { GitHubClient } from '../github/types.js';
import type { WorkflowRegistry } from '../workflows/registry.js';
import { registerBridgeTools, type McpDeps } from './tools.js';

export interface HttpAppDeps {
  db: Db;
  config: BridgeConfig;
  logger: Logger;
  github: GitHubClient;
  workflows: WorkflowRegistry;
  authProvider: BridgeAuthProvider;
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'operava-claude-bridge', version: '1.0.0' });
  registerBridgeTools(server, deps);
  return server;
}

/**
 * The API service: MCP endpoint (Streamable HTTP, stateless JSON mode),
 * built-in OAuth 2.1 authorization server, health and metrics.
 */
export function createHttpApp(deps: HttpAppDeps): Express {
  const { config, logger, authProvider } = deps;
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  /* --------------------------- health (public) --------------------------- */
  app.get('/healthz', async (_req: Request, res: Response) => {
    try {
      await deps.db.query('SELECT 1');
      res.json({ ok: true, service: 'claude-bridge-api', uptimeSeconds: Math.round(process.uptime()) });
    } catch (err) {
      logger.error({ err }, 'health check failed');
      res.status(503).json({ ok: false });
    }
  });

  /* ------------------------------- OAuth --------------------------------- */
  if (config.oauthEnabled) {
    const issuerUrl = new URL(config.publicBaseUrl);
    app.use(
      mcpAuthRouter({
        provider: authProvider,
        issuerUrl,
        resourceServerUrl: new URL('/mcp', issuerUrl),
        resourceName: 'Operava Claude Bridge',
        scopesSupported: ['bridge'],
      }),
    );

    const consentLimiter = createRateLimiter({
      requestsPerMinute: config.authRateLimitRpm,
      keyFor: clientIpKey,
      name: 'oauth consent',
    });
    app.post('/oauth/consent', consentLimiter, express.urlencoded({ extended: false }), async (req, res) => {
      try {
        const pendingId = String(req.body.pending_id ?? '');
        const operatorKey = String(req.body.operator_key ?? '');
        const action = String(req.body.action ?? 'deny');
        if (!/^pauth_[a-z0-9]+$/.test(pendingId)) {
          res.status(400).type('html').send('<p>Invalid request.</p>');
          return;
        }
        if (action !== 'approve') {
          const redirect = await authProvider.denyConsent(pendingId);
          if (redirect) res.redirect(302, redirect);
          else res.status(400).type('html').send('<p>This authorization request has expired. Restart the connection from the client.</p>');
          return;
        }
        const redirect = await authProvider.approveConsent(pendingId, operatorKey);
        if (!redirect) {
          logger.warn({ ip: req.ip }, 'oauth consent rejected (bad operator key or expired request)');
          res
            .status(401)
            .type('html')
            .send(
              renderConsentPage({
                clientName: 'the client',
                redirectHost: 'unknown',
                pendingId,
                errorMessage:
                  'Wrong operator key, or the request expired. Enter the key again or restart the connection from the client.',
              }),
            );
          return;
        }
        res.redirect(302, redirect);
      } catch (err) {
        logger.error({ err }, 'consent handling failed');
        res.status(500).type('html').send('<p>Internal error.</p>');
      }
    });
  }

  /* ------------------------------ MCP endpoint --------------------------- */
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL('/mcp', config.publicBaseUrl));
  const mcpAuth = requireBearerAuth({
    verifier: authProvider,
    resourceMetadataUrl: config.oauthEnabled ? resourceMetadataUrl : undefined,
  });
  const mcpLimiter = createRateLimiter({
    requestsPerMinute: config.rateLimitRpm,
    keyFor: bearerKey,
    name: 'mcp',
  });

  app.post('/mcp', mcpLimiter, mcpAuth, express.json({ limit: '4mb' }), async (req, res) => {
    // Stateless Streamable HTTP: one server+transport per request, JSON responses.
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, 'mcp request handling failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no server-initiated stream and no session to delete.
  app.get('/mcp', mcpAuth, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server runs in stateless mode. Use POST.' },
      id: null,
    });
  });
  app.delete('/mcp', mcpAuth, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server runs in stateless mode.' },
      id: null,
    });
  });

  /* ------------------------------- metrics ------------------------------- */
  app.get('/metrics', mcpAuth, async (_req, res) => {
    try {
      const [tasks, workflowRuns, workers] = await Promise.all([
        countTasksByStatus(deps.db),
        countWorkflowRunsByStatus(deps.db),
        listWorkers(deps.db),
      ]);
      res.json({
        tasksByStatus: tasks,
        workflowRunsByStatus: workflowRuns,
        queueDepth: (tasks.QUEUED ?? 0) + (workflowRuns.QUEUED ?? 0),
        running: (tasks.RUNNING ?? 0) + (tasks.PREPARING ?? 0),
        workers: workers.map((w) => ({
          id: w.id,
          kind: w.kind,
          lastHeartbeatAt: w.lastHeartbeatAt.toISOString(),
        })),
      });
    } catch (err) {
      logger.error({ err }, 'metrics failed');
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'metrics unavailable' } });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } });
  });

  return app;
}
