/**
 * Streamable-HTTP MCP endpoint for Index 01 (Pebble): `POST /mcp/<rose-api-key>`.
 * The key in the path (or `Authorization: Bearer <rose-api-key>`) selects the
 * user, so the device needs no header configuration. Stateless: one transport
 * and server per request.
 */

import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { getClientIP } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildAgentMcpServer } from './agentMcpService';

const log = createLogger('AgentMcp');
const router = Router();

function roseApiKeyFrom(req: Request): string | undefined {
  const fromPath = req.params.apiKey;
  if (typeof fromPath === 'string' && fromPath !== '') return fromPath;
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  return undefined;
}

// Only Rose API keys authenticate here: rewrite the credential into X-API-Key
// and reject every other hybridAuth outcome (internal key, JWT, x402).
const mcpAuth = asyncHandler<HybridAuthRequest>(async (req, res, next) => {
  const apiKey = roseApiKeyFrom(req);
  if (apiKey === undefined) {
    res.status(401).json({ error: 'Rose API key required: use /mcp/<key>' });
    return;
  }
  delete req.headers.authorization;
  req.headers['x-api-key'] = apiKey;
  await hybridAuth(req, res, () => {
    if (req.isRoseApiKey !== true || req.userId === undefined) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    next();
  });
});

const handleMcp = asyncHandler<HybridAuthRequest>(async (req, res) => {
  const server = buildAgentMcpServer(req.userId as string, getClientIP(req));
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
    await transport.handleRequest(req, res as Response, req.body);
  } catch (error) {
    log.error('MCP request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  });
}

router.post('/:apiKey', mcpAuth, handleMcp);
router.post('/', mcpAuth, handleMcp);
router.get(['/', '/:apiKey'], methodNotAllowed);
router.delete(['/', '/:apiKey'], methodNotAllowed);

export default router;
