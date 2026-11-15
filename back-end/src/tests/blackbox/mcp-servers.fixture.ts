/**
 * Loopback MCP servers for mcp-servers.blackbox.ts:
 *   /open-mcp   no auth
 *   /key-mcp    requires X-Api-Key: <KEY>
 *   /oauth-mcp  Bearer tokens from the fake authorization server below
 *               (RFC 9728 metadata, RFC 8414 metadata, RFC 7591 /register,
 *               /authorize → 302 with code, /token with PKCE S256 + rotating refresh)
 *   /dup-mcp    no auth; tools search.docs + search_docs (agent names collide)
 *   /redirect   307 → /open-mcp (the redirect guard must refuse the loopback hop)
 *   /loop-mcp   raw JSON-RPC: tools/list pages forever with fresh cursors
 * Tools: echo {text} → "echo:<text>", whoami → the bearer token the call used.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const KEY = 'test-key-123';

export interface McpFixture {
  base: string;
  /** Lifetime the token endpoint reports, in seconds. */
  expiresIn: number;
  tokens: Set<string>;
  refreshes: number;
  close(): Promise<void>;
}

function mcpFor(token: string | null, duplicates = false) {
  const server = new McpServer({
    name: duplicates ? 'dup-docs' : 'fixture-docs',
    version: '1.0.0',
  });
  if (duplicates)
    for (const name of ['search.docs', 'search_docs'])
      server.registerTool(name, { description: name }, async () => ({
        content: [{ type: 'text', text: name }],
      }));
  server.registerTool(
    'echo',
    { description: 'Echo text back', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] })
  );
  server.registerTool('whoami', { description: 'Which token was used' }, async () => ({
    content: [{ type: 'text', text: token ?? 'anonymous' }],
  }));
  return server;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMcpFixture(): Promise<McpFixture> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const refresh = new Set<string>();
  let server: Server | null = null;
  const fixture: McpFixture = {
    base: '',
    expiresIn: 3600,
    tokens: new Set(),
    refreshes: 0,
    close: () => new Promise((resolve) => server?.close(() => resolve())),
  };
  const issue = () => {
    const access = `at-${randomUUID()}`;
    const rotated = `rt-${randomUUID()}`;
    fixture.tokens.add(access);
    refresh.add(rotated);
    return {
      access_token: access,
      refresh_token: rotated,
      token_type: 'Bearer',
      expires_in: fixture.expiresIn,
    };
  };
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', fixture.base);
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === '/.well-known/oauth-protected-resource/oauth-mcp')
        return json(200, {
          resource: `${fixture.base}/oauth-mcp`,
          authorization_servers: [fixture.base],
        });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return json(200, {
          issuer: fixture.base,
          authorization_endpoint: `${fixture.base}/authorize`,
          token_endpoint: `${fixture.base}/token`,
          registration_endpoint: `${fixture.base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      if (url.pathname === '/register' && req.method === 'POST')
        return json(201, { ...JSON.parse(await body(req)), client_id: `client-${randomUUID()}` });
      if (url.pathname === '/authorize') {
        const code = `code-${randomUUID()}`;
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirect });
        const target = new URL(redirect);
        target.searchParams.set('code', code);
        target.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { Location: target.toString() });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await body(req));
        if (form.get('grant_type') === 'authorization_code') {
          const pending = codes.get(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const digest = createHash('sha256').update(verifier).digest('base64url');
          if (
            !pending ||
            pending.challenge !== digest ||
            pending.redirect !== form.get('redirect_uri')
          )
            return json(400, { error: 'invalid_grant' });
          codes.delete(form.get('code') ?? '');
          return json(200, issue());
        }
        const old = form.get('refresh_token') ?? '';
        if (!refresh.delete(old)) return json(400, { error: 'invalid_grant' });
        fixture.refreshes += 1;
        return json(200, issue());
      }
      if (url.pathname === '/redirect') {
        res.writeHead(307, { Location: `${fixture.base}/open-mcp` });
        return res.end();
      }
      if (url.pathname === '/loop-mcp' && req.method === 'POST') {
        // Answers initialize, then pages tools/list forever with an empty page.
        const message = JSON.parse(await body(req)) as { id?: number; method: string };
        if (message.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'loop', version: '1' },
              }
            : { tools: [], nextCursor: `again-${randomUUID()}` };
        return json(200, { jsonrpc: '2.0', id: message.id, result });
      }
      let token: string | null = null;
      if (url.pathname === '/key-mcp' && req.headers['x-api-key'] !== KEY)
        return json(401, { error: 'bad key' });
      if (url.pathname === '/oauth-mcp') {
        token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!fixture.tokens.has(token))
          return json(
            401,
            { error: 'unauthorized' },
            {
              'WWW-Authenticate': `Bearer resource_metadata="${fixture.base}/.well-known/oauth-protected-resource/oauth-mcp"`,
            }
          );
      }
      if (!['/open-mcp', '/key-mcp', '/oauth-mcp', '/dup-mcp'].includes(url.pathname))
        return json(404, {});
      const raw = req.method === 'POST' ? await body(req) : '';
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcp = mcpFor(token, url.pathname === '/dup-mcp');
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  fixture.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fixture;
}
