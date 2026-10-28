#!/usr/bin/env tsx
/**
 * Black-box tests for the Index 01 (Pebble) MCP endpoint: POST /mcp/<rose-api-key>.
 *
 * Invariants:
 *   - auth: no key, unknown key and the internal BACKEND_API_KEY are rejected (401);
 *     a Rose API key in the path or as `Authorization: Bearer` is accepted, with no
 *     subscription required (the key user here has none); waitlisted owners get 403
 *   - protocol: initialize + tools/list over Streamable HTTP expose `spawn_agent`
 *   - spawn: tools/call creates a root agent for the key's owner in plan mode on
 *     rose-labs/rose-1-ultra with the verbatim goal (or reports the start failure)
 *   - validation: an empty goal is a tool error, not an agent
 *   - GET is 405 (stateless, no SSE stream); request logs redact the key
 *
 * Usage: npx tsx src/tests/blackbox/mcp.blackbox.ts
 */

import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';
import { redactPathSecrets } from '../../providers/tracing';
import { assertLocalDatabase } from './assertLocalDatabase';

config();
assertLocalDatabase();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const INTERNAL_KEY = process.env.BACKEND_API_KEY || '';
const RUN = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const userId = `mcp-bb-${RUN}`;
const apiKey = randomUUID().replace(/-/g, '');
const gatedUserId = `mcp-bb-gated-${RUN}`;
const gatedKey = randomUUID().replace(/-/g, '');
const createdAgentIds: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function rpc(
  path: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
  };
}

const INIT_PARAMS = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'index-01-blackbox', version: '1' },
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: { agent_id: string; url: string };
};

const tests: Array<[string, () => Promise<void>]> = [
  [
    'no key → 401',
    async () => {
      const r = await rpc('/mcp', 'initialize', INIT_PARAMS);
      assert(r.status === 401, `expected 401, got ${r.status}`);
    },
  ],
  [
    'unknown key → 401',
    async () => {
      const r = await rpc(`/mcp/${randomUUID().replace(/-/g, '')}`, 'initialize', INIT_PARAMS);
      assert(r.status === 401, `expected 401, got ${r.status}`);
    },
  ],
  [
    'internal BACKEND_API_KEY is not a Rose key → 401',
    async () => {
      const r = await rpc(`/mcp/${INTERNAL_KEY}`, 'initialize', INIT_PARAMS);
      assert(r.status === 401, `expected 401, got ${r.status}`);
    },
  ],
  [
    'waitlisted key owner → 403',
    async () => {
      const r = await rpc(`/mcp/${gatedKey}`, 'initialize', INIT_PARAMS);
      assert(r.status === 403, `expected 403, got ${r.status}`);
    },
  ],
  [
    'initialize via path key and via Bearer header',
    async () => {
      for (const [path, headers] of [
        [`/mcp/${apiKey}`, {}],
        ['/mcp', { Authorization: `Bearer ${apiKey}` }],
      ] as const) {
        const r = await rpc(path, 'initialize', INIT_PARAMS, headers);
        assert(r.status === 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
        const result = r.body?.result as { serverInfo?: { name: string } } | undefined;
        assert(result?.serverInfo?.name === 'rose', `bad initialize: ${JSON.stringify(r.body)}`);
      }
    },
  ],
  [
    'tools/list exposes spawn_agent with a required goal',
    async () => {
      const r = await rpc(`/mcp/${apiKey}`, 'tools/list');
      assert(r.status === 200, `expected 200, got ${r.status}`);
      const tools = (
        r.body?.result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }
      ).tools;
      assert(tools.length === 1 && tools[0].name === 'spawn_agent', JSON.stringify(tools));
      assert(tools[0].inputSchema.required.includes('goal'), 'goal must be required');
    },
  ],
  [
    'tools/call spawn_agent creates a plan-mode rose-1-ultra agent for the key owner',
    async () => {
      const goal = `Index 01 blackbox ${RUN}: remind me to buy oat milk`;
      const r = await rpc(`/mcp/${apiKey}`, 'tools/call', {
        name: 'spawn_agent',
        arguments: { goal },
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      const result = r.body?.result as ToolResult;
      const agents = await prisma.agent.findMany({
        where: { userId, goal },
        select: { id: true, model: true, parentAgentId: true },
      });
      createdAgentIds.push(...agents.map((a) => a.id));
      if (result.isError === true) {
        // Temporal unavailable in this environment: the failure must be surfaced.
        assert(
          result.content[0].text.startsWith('Failed to start Rose agent'),
          result.content[0].text
        );
        return;
      }
      const agentId = result.structuredContent?.agent_id;
      assert(agentId !== undefined, `missing agent_id: ${JSON.stringify(result)}`);
      assert(result.content[0].text.includes(`agent-id=${agentId}`), result.content[0].text);
      const agent = agents.find((a) => a.id === agentId);
      assert(agent !== undefined, `agent ${agentId} not owned by key user`);
      assert(agent.model === 'rose-labs/rose-1-ultra', `model ${agent.model}`);
      assert(agent.parentAgentId === null, 'must be a root agent');
    },
  ],
  [
    'empty goal → tool error, no agent',
    async () => {
      const before = await prisma.agent.count({ where: { userId } });
      const r = await rpc(`/mcp/${apiKey}`, 'tools/call', {
        name: 'spawn_agent',
        arguments: { goal: '' },
      });
      assert((r.body?.result as ToolResult).isError === true, JSON.stringify(r.body));
      assert((await prisma.agent.count({ where: { userId } })) === before, 'agent was created');
    },
  ],
  [
    'GET → 405 and logged paths redact the key',
    async () => {
      const res = await fetch(`${BASE_URL}/mcp/${apiKey}`);
      assert(res.status === 405, `expected 405, got ${res.status}`);
      assert(redactPathSecrets(`/mcp/${apiKey}`) === '/mcp/:key', 'key not redacted');
      assert(redactPathSecrets('/api/agents') === '/api/agents', 'unrelated path changed');
    },
  ],
];

async function cleanup(): Promise<void> {
  for (const id of createdAgentIds) {
    await fetch(`${BASE_URL}/api/agents/${id}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': INTERNAL_KEY },
    }).catch(() => undefined);
  }
  await prisma.roseApiKey.deleteMany({ where: { userId: { in: [userId, gatedUserId] } } });
  await prisma.user.deleteMany({ where: { userId: { in: [userId, gatedUserId] } } });
}

async function main(): Promise<void> {
  await prisma.user.upsert({
    where: { userId },
    update: {},
    create: { userId, isAnonymous: false, usedInviteCode: 1 },
  });
  await prisma.user.upsert({
    where: { userId: gatedUserId },
    update: {},
    create: { userId: gatedUserId, isAnonymous: true },
  });
  await prisma.roseApiKey.create({ data: { userId, apiKey, name: 'mcp blackbox' } });
  await prisma.roseApiKey.create({ data: { userId: gatedUserId, apiKey: gatedKey } });
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`  PASS ${name}`);
      } catch (error) {
        failed++;
        console.log(`  FAIL ${name} - ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await cleanup();
  }
  console.log(`Results: ${tests.length - failed} passed, ${failed} failed, ${tests.length} total`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    console.error('MCP black-box suite crashed:', error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
