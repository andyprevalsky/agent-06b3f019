/**
 * MCP server integrations.
 *
 * In-process, against a loopback fixture (mcp-servers.fixture.ts):
 *   - connect with no auth, with an API-key header, and with OAuth (DCR + PKCE);
 *   - agent list + proxied tool call;
 *   - access-token refresh with rotating refresh tokens;
 *   - expired sign-in → needs_auth.
 * Through the running backend's HTTP stack:
 *   - auth;
 *   - private-address refusal;
 *   - redirect allow-list;
 *   - owner isolation;
 *   - the sandbox `rose mcp` server listing the user's tools in two separate
 *     agent sessions (persistence across runs) and surfacing the backend's
 *     refusal to reach a loopback server.
 * MCP_LIVE_CONTEXT7=1 adds a live case against https://mcp.context7.com (public
 * network, real SSRF guard).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { prisma } from '../../providers/database';
import { mcpNetwork } from '../../providers/mcp/publicFetch';
import {
  callMcpTool,
  completeMcpServerOAuth,
  connectMcpServer,
  deleteMcpServer,
  listAgentMcpServers,
  listMcpServers,
  mcpAgentToolName,
} from '../../providers/mcp/servers';
import {
  BASE_URL,
  assert,
  call,
  codeToken,
  expectStatus,
  otherA,
  rootA,
  runSuite,
  userA,
  userB,
  type BlackboxTest,
} from './agent-tools.support';
import { KEY, startMcpFixture, type McpFixture } from './mcp-servers.fixture';

const REDIRECT = 'http://localhost:5173/integrations/mcp/callback';
let fixture: McpFixture;

async function inProcess<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { ...mcpNetwork };
  mcpNetwork.fetch = (url, init) => fetch(url, init);
  mcpNetwork.checkUrl = (value) => new URL(value);
  try {
    return await fn();
  } finally {
    Object.assign(mcpNetwork, saved);
  }
}

async function signIn(authorizeUrl: string): Promise<{ code: string; state: string }> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' });
  const location = new URL(response.headers.get('location') ?? '');
  assert(location.pathname === '/integrations/mcp/callback', 'redirected to the Rose callback');
  return { code: location.searchParams.get('code')!, state: location.searchParams.get('state')! };
}

function text(result: { content: unknown[] }): string {
  return (result.content as Array<{ text?: string }>).map((item) => item.text ?? '').join('');
}

interface RpcReply {
  id: number;
  result: {
    tools?: Array<{ name: string; description: string }>;
    isError?: boolean;
    content?: Array<{ text: string }>;
  };
}

/** JSON-RPC over the sandbox CLI's stdio MCP server, as Claude Code / Codex drive it. */
async function roseMcp(agentId: string, messages: object[]): Promise<RpcReply[]> {
  const cli = join(__dirname, '../../assets/rose-tools/rose.cjs');
  const child = spawn(process.execPath, [cli, 'mcp'], {
    env: {
      ...process.env,
      ROSE_TOOLS_URL: `${BASE_URL}/api/agent-tools/${agentId}`,
      ROSE_TOOLS_TOKEN: codeToken(agentId),
      HOME: '/nonexistent-rose-home',
    },
  });
  const replies: RpcReply[] = [];
  let buffer = '';
  const done = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        replies.push(JSON.parse(buffer.slice(0, i)) as RpcReply);
        buffer = buffer.slice(i + 1);
        if (replies.length === messages.length) resolve();
      }
    });
    child.on('exit', () => reject(new Error(`rose mcp exited after ${replies.length} replies`)));
  });
  for (const message of messages)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  try {
    await done;
  } finally {
    child.kill();
  }
  return replies;
}

const tests: BlackboxTest[] = [
  {
    name: 'setup: loopback MCP fixture',
    fn: async () => {
      fixture = await startMcpFixture();
    },
  },
  {
    name: 'no-auth server connects with its tools cached and callable by agents',
    fn: () =>
      inProcess(async () => {
        const { server, authorize_url } = await connectMcpServer(userA, {
          url: `${fixture.base}/open-mcp`,
          redirectUri: REDIRECT,
        });
        assert(authorize_url === undefined, 'no sign-in for an open server');
        assert(server.status === 'connected' && server.auth === 'none', JSON.stringify(server));
        assert(server.name === 'fixture-docs', `server name from serverInfo: ${server.name}`);
        assert(server.tools.map((t) => t.name).join() === 'echo,whoami', 'tools cached');
        const listed = (await listAgentMcpServers(userA)).servers.find((s) => s.id === server.id)!;
        const echo = listed.tools.find((t) => t.name === 'echo')!;
        assert(echo.agent_name === 'fixture-docs__echo', `agent name ${echo.agent_name}`);
        assert(
          JSON.stringify(echo.input_schema).includes('"text"'),
          'full input schema for agents'
        );
        const result = await callMcpTool(userA, server.id, 'echo', { text: 'hi' });
        assert(text(result) === 'echo:hi' && !result.isError, `call result ${text(result)}`);
      }),
  },
  {
    name: 'API-key header server: wrong key refused, right key connected and sent on calls',
    fn: () =>
      inProcess(async () => {
        const url = `${fixture.base}/key-mcp`;
        const wrong = await connectMcpServer(userA, {
          url,
          headers: { 'X-Api-Key': 'nope' },
          redirectUri: REDIRECT,
        }).catch((error: Error) => error);
        assert(
          wrong instanceof Error && /rejected these credentials/.test(wrong.message),
          'wrong key'
        );
        const { server } = await connectMcpServer(userA, {
          url,
          name: 'Keyed Docs',
          headers: { 'X-Api-Key': KEY },
          redirectUri: REDIRECT,
        });
        assert(server.status === 'connected' && server.auth === 'headers', JSON.stringify(server));
        const row = await prisma.integration.findUniqueOrThrow({ where: { id: server.id } });
        assert(!JSON.stringify(row.config).includes(KEY), 'header value stored encrypted only');
        const result = await callMcpTool(userA, server.id, 'echo', { text: 'k' });
        assert(text(result) === 'echo:k', 'header sent on proxied calls');
      }),
  },
  {
    name: 'OAuth server: discovery + registration + PKCE sign-in, then refresh rotates tokens',
    fn: () =>
      inProcess(async () => {
        fixture.expiresIn = 30; // inside the 60 s refresh margin: every call refreshes
        const url = `${fixture.base}/oauth-mcp`;
        const begun = await connectMcpServer(userA, { url, redirectUri: REDIRECT });
        assert(begun.server.status === 'needs_auth' && begun.authorize_url, 'sign-in required');
        const authorize = new URL(begun.authorize_url!);
        assert(authorize.searchParams.get('code_challenge_method') === 'S256', 'PKCE S256');
        assert(authorize.searchParams.get('resource') === url, 'audience-bound resource');
        const { code, state } = await signIn(begun.authorize_url!);
        const wrongUser = await completeMcpServerOAuth(userB, state, code).catch((e: Error) => e);
        assert(wrongUser instanceof Error, 'another user cannot finish this sign-in');
        const { server } = await completeMcpServerOAuth(userA, state, code);
        assert(server.status === 'connected' && server.auth === 'oauth', JSON.stringify(server));
        const replay = await completeMcpServerOAuth(userA, state, code).catch((e: Error) => e);
        assert(replay instanceof Error, 'a used state cannot be replayed');
        const first = text(await callMcpTool(userA, server.id, 'whoami', {}));
        const second = text(await callMcpTool(userA, server.id, 'whoami', {}));
        assert(fixture.refreshes >= 2 && first !== second, 'refreshed + rotated access tokens');
        assert(first.startsWith('at-') && second.startsWith('at-'), 'bearer reached the server');
        fixture.tokens.clear(); // provider revoked everything; refresh still works once
        assert(text(await callMcpTool(userA, server.id, 'whoami', {})).startsWith('at-'), 'retry');
      }),
  },
  {
    name: 'OAuth refresh failure marks the server needs_auth instead of failing silently',
    fn: () =>
      inProcess(async () => {
        const server = (await listMcpServers(userA)).servers.find((s) => s.auth === 'oauth')!;
        const row = await prisma.integration.findUniqueOrThrow({ where: { id: server.id } });
        await fixture.close();
        const failed = await callMcpTool(userA, server.id, 'whoami', {}).catch((e: Error) => e);
        assert(failed instanceof Error && /sign in again/.test(failed.message), String(failed));
        const after = (await listMcpServers(userA)).servers.find((s) => s.id === server.id)!;
        assert(after.status === 'needs_auth', `status ${after.status}`);
        await prisma.integration.update({ where: { id: row.id }, data: { status: row.status } });
        fixture = await startMcpFixture();
        await deleteMcpServer(userA, server.id);
      }),
  },
  {
    name: 'agent tool names are unique per server slug and at most 64 characters',
    fn: async () => {
      assert(
        mcpAgentToolName('context7', 'resolve-library-id') === 'context7__resolve-library-id',
        'plain'
      );
      const long = mcpAgentToolName('a'.repeat(24), 'b'.repeat(80));
      assert(
        long.length === 64 && long !== mcpAgentToolName('a'.repeat(24), `${'b'.repeat(79)}c`),
        'hashed'
      );
    },
  },
  {
    name: 'HTTP: auth, private-address refusal, redirect allow-list and owner isolation',
    fn: async () => {
      expectStatus(
        await call('GET', '/api/integrations/mcp', undefined, { noAuth: true }),
        401,
        'auth'
      );
      const loopback = await call(
        'POST',
        '/api/integrations/mcp',
        { url: `${fixture.base}/open-mcp`, redirect_uri: REDIRECT },
        { apiKeyUser: userA }
      );
      expectStatus(loopback, 400, 'loopback refused');
      assert(/public host/.test(String(loopback.data.error)), JSON.stringify(loopback.data));
      expectStatus(
        await call(
          'POST',
          '/api/integrations/mcp',
          {
            url: 'https://mcp.example.com/mcp',
            redirect_uri: 'https://evil.example/integrations/mcp/callback',
          },
          { apiKeyUser: userA }
        ),
        400,
        'foreign redirect refused'
      );
      expectStatus(
        await call(
          'POST',
          '/api/integrations/mcp',
          { url: 'https://mcp.example.com/mcp', headers: { Host: 'x' }, redirect_uri: REDIRECT },
          { apiKeyUser: userA }
        ),
        400,
        'reserved header refused'
      );
      const mine = (await call('GET', '/api/integrations/mcp', undefined, { apiKeyUser: userA }))
        .data.servers as Array<{ id: string; name: string }>;
      assert(
        mine.some((s) => s.name === 'fixture-docs'),
        'owner sees their servers'
      );
      const theirs = (await call('GET', '/api/integrations/mcp', undefined, { apiKeyUser: userB }))
        .data.servers as unknown[];
      assert(theirs.length === 0, 'other users see none');
      const id = mine[0].id;
      expectStatus(
        await call('DELETE', `/api/integrations/mcp/${id}`, undefined, { apiKeyUser: userB }),
        404,
        'isolation'
      );
      const agentList = await call('GET', `/api/agent-tools/${rootA}/mcp`, undefined, {
        bearer: codeToken(rootA),
      });
      expectStatus(agentList, 200, 'agent list');
      expectStatus(
        await call(
          'POST',
          `/api/agent-tools/${rootA}/mcp/${randomUUID()}/call`,
          { tool: 'echo' },
          { bearer: codeToken(rootA) }
        ),
        404,
        'unknown server'
      );
    },
  },
  {
    name: 'sandbox rose mcp lists the connected tools in every new agent session',
    fn: async () => {
      for (const agentId of [rootA, otherA]) {
        const [, list, called] = await roseMcp(agentId, [
          { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
          { id: 2, method: 'tools/list' },
          {
            id: 3,
            method: 'tools/call',
            params: { name: 'fixture-docs__echo', arguments: { text: 'x' } },
          },
        ]);
        const names = (list.result.tools ?? []).map((t) => t.name);
        assert(names.includes('display') && names.includes('fixture-docs__echo'), names.join());
        assert(names.includes('keyed-docs__echo'), 'header-auth server listed too');
        // The running backend never reaches loopback: the guard's refusal comes back as a tool error.
        assert(called.result.isError === true, JSON.stringify(called));
        assert(
          /public|non-public/.test(called.result.content?.[0]?.text ?? ''),
          called.result.content?.[0]?.text ?? ''
        );
      }
    },
  },
  ...(process.env.MCP_LIVE_CONTEXT7 === '1'
    ? [
        {
          name: 'live Context7: guarded network, no-auth tools + call, OAuth endpoint discovery',
          fn: async () => {
            const { server } = await connectMcpServer(userA, {
              url: 'https://mcp.context7.com/mcp',
              redirectUri: REDIRECT,
            });
            const names = server.tools.map((tool) => tool.name);
            assert(
              server.status === 'connected' && names.includes('resolve-library-id'),
              names.join()
            );
            const resolved = text(
              await callMcpTool(userA, server.id, 'resolve-library-id', {
                query: 'React useEffect cleanup',
                libraryName: 'react',
              })
            );
            assert(/\/[\w.-]+\/[\w.-]+/.test(resolved), `library ids: ${resolved.slice(0, 200)}`);
            const oauth = await connectMcpServer(userA, {
              url: 'https://mcp.context7.com/mcp/oauth',
              redirectUri: REDIRECT,
            });
            assert(oauth.server.status === 'needs_auth', oauth.server.status);
            const authorize = new URL(oauth.authorize_url ?? '');
            assert(authorize.searchParams.get('client_id'), 'dynamically registered client');
            assert(authorize.searchParams.get('code_challenge_method') === 'S256', 'PKCE');
            console.log(`    authorize host ${authorize.host}; resolved ${resolved.slice(0, 120)}`);
          },
        },
      ]
    : []),
  {
    name: 'cleanup',
    fn: async () => {
      await prisma.integration.deleteMany({
        where: { userId: { in: [userA, userB] }, name: 'mcp' },
      });
      await fixture.close();
    },
  },
];

runSuite(tests).catch((error) => {
  console.error(error);
  process.exit(1);
});
