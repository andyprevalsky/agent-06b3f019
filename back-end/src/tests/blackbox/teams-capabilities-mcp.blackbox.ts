#!/usr/bin/env tsx
/**
 * A teammate's code agent lists and calls the owner's team-shared MCP server (mcp grant,
 * docs/plans/active/share-mcp-servers.md). The call runs with the OWNER's API-key header
 * server-side; the teammate never receives it. The shared server's tool names never
 * collide with the reader's own server. Unshare, the owner's server leaving CONNECTED,
 * an invited-only reader and a non-member all lose access on the next list or call.
 *
 * Network: the loopback MCP fixture (mcp-servers.fixture.ts) with the SSRF guard relaxed
 * in this process only, exactly as mcp-servers.blackbox.ts does; the HTTP list goes
 * through the running backend's real agent-tools route.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prisma } from '../../providers/database';
import { mintAgentToolsToken } from '../../providers/agentTools/token';
import { mcpNetwork } from '../../providers/mcp/publicFetch';
import {
  callMcpTool,
  connectMcpServer,
  listAgentMcpServers,
  McpServerError,
} from '../../providers/mcp/servers';
import * as teamsService from '../../domains/teams/service';
import { KEY, startMcpFixture, type McpFixture } from './mcp-servers.fixture';
import { call, expectStatus } from './projects-harness';
import { randomUUID, share, teamFixture, unshare } from './teams-capabilities.harness';

const REDIRECT = 'http://localhost:5173/integrations/mcp/callback';
let fixture: McpFixture;
const saved = { ...mcpNetwork };
const agentIds: string[] = [];

before(async () => {
  fixture = await startMcpFixture();
  mcpNetwork.fetch = (url, init) => fetch(url, init);
  mcpNetwork.checkUrl = (value) => new URL(value);
});
after(async () => {
  Object.assign(mcpNetwork, saved);
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await fixture.close();
});

function text(result: { content: unknown[] }): string {
  return (result.content as Array<{ text?: string }>).map((item) => item.text ?? '').join('');
}

async function refused(run: Promise<unknown>, status: number) {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught
  );
  assert.ok(error instanceof McpServerError, `expected McpServerError, got ${String(error)}`);
  assert.equal(error.status, status, error.message);
}

async function agentToken(userId: string) {
  const agentId = randomUUID();
  agentIds.push(agentId);
  await prisma.agent.create({
    data: { id: agentId, userId, goal: 'teams mcp', busId: agentId, status: 'ACTIVE' },
  });
  return { agentId, token: mintAgentToolsToken(userId, agentId).token };
}

test("a teammate lists and calls the owner's shared MCP server with the owner's key, never seeing it", async () => {
  const f = await teamFixture('mcp');
  const { server: owned } = await connectMcpServer(f.owner.userId, {
    url: `${fixture.base}/key-mcp`,
    name: 'Team Docs',
    headers: { 'X-Api-Key': KEY },
    redirectUri: REDIRECT,
  });
  // The reader's own server takes the same slug: the shared one must not collide.
  const { server: mine } = await connectMcpServer(f.reader.userId, {
    url: `${fixture.base}/open-mcp`,
    name: 'Team Docs',
    redirectUri: REDIRECT,
  });

  assert.deepEqual(
    (await listAgentMcpServers(f.reader.userId)).servers.map((row) => row.id),
    [mine.id],
    'nothing is shared yet'
  );
  await refused(callMcpTool(f.reader.userId, owned.id, 'echo', { text: 'x' }), 404);

  const shareable = await teamsService.listShareableIntegrations(f.owner.userId);
  const account = shareable.integrations.find((row) => row.provider === 'mcp');
  assert.equal(account?.id, owned.id);
  assert.equal(account?.accountId, `${fixture.base}/key-mcp`);
  assert.equal(account?.label, 'Team Docs');
  await share(f, owned.id);

  const servers = (await listAgentMcpServers(f.reader.userId)).servers;
  assert.deepEqual(
    servers.map((row) => row.id),
    [mine.id, owned.id]
  );
  const shared = servers[1];
  assert.deepEqual(shared.shared, {
    team_id: f.teamId,
    team_name: 'mcp team',
    owner_user_id: f.owner.userId,
    owner_name: 'mcp owner',
  });
  const names = servers.flatMap((row) => row.tools.map((tool) => tool.agent_name));
  assert.equal(new Set(names).size, names.length, `unique agent tool names: ${names.join()}`);
  assert.ok(names.includes('team-docs__echo') && names.includes('team-docs-2__echo'), names.join());
  assert.ok(!JSON.stringify(servers).includes(KEY), 'the owner key is never listed');

  // key-mcp refuses any call without the owner's X-Api-Key: success proves it was sent.
  const result = await callMcpTool(f.reader.userId, owned.id, 'echo', { text: 'shared' });
  assert.equal(text(result), 'echo:shared');
  assert.ok(!JSON.stringify(result).includes(KEY), 'the owner key is never returned');
  assert.equal(
    text(await callMcpTool(f.reader.userId, mine.id, 'echo', { text: 'own' })),
    'echo:own'
  );

  // The real agent-tools route (code-agent token) lists the shared server too.
  const reader = await agentToken(f.reader.userId);
  const res = await call(`/api/agent-tools/${reader.agentId}/mcp`, {
    headers: { Authorization: `Bearer ${reader.token}` },
  });
  expectStatus(res, 200, 'agent mcp list');
  const routed = res.data.servers as Array<{ id: string; shared?: { owner_user_id: string } }>;
  assert.equal(routed.find((row) => row.id === owned.id)?.shared?.owner_user_id, f.owner.userId);
  assert.ok(!JSON.stringify(res.data).includes(KEY), 'the route never returns the key');

  for (const other of [f.invited, f.outsider]) {
    assert.equal(
      (await listAgentMcpServers(other.userId)).servers.length,
      0,
      'no access without an accepted membership'
    );
    await refused(callMcpTool(other.userId, owned.id, 'echo', { text: 'x' }), 404);
  }

  // The owner's server needing sign-in ends the share for the teammate at once.
  await prisma.integration.update({
    where: { id: owned.id },
    data: { status: 'EXPIRED', isActive: false },
  });
  assert.deepEqual(
    (await listAgentMcpServers(f.reader.userId)).servers.map((row) => row.id),
    [mine.id]
  );
  await refused(callMcpTool(f.reader.userId, owned.id, 'echo', { text: 'x' }), 404);
  await prisma.integration.update({
    where: { id: owned.id },
    data: { status: 'CONNECTED', isActive: true },
  });
  assert.equal(
    text(await callMcpTool(f.reader.userId, owned.id, 'echo', { text: 'back' })),
    'echo:back'
  );

  await unshare(f, owned.id);
  assert.deepEqual(
    (await listAgentMcpServers(f.reader.userId)).servers.map((row) => row.id),
    [mine.id]
  );
  await refused(callMcpTool(f.reader.userId, owned.id, 'echo', { text: 'x' }), 404);
  // The owner's own use is unchanged throughout.
  assert.equal(
    text(await callMcpTool(f.owner.userId, owned.id, 'echo', { text: 'owner' })),
    'echo:owner'
  );
});
