#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Offline unit tests for the per-user AgentCard MCP runtime.
 *
 * The key assertion is that the runtime forwards the FULL live toolset: it points
 * the mock server at an ARBITRARY tools/list (including an invented future tool
 * the code has never seen) and asserts EVERY advertised tool is registered — never
 * a fixed/expected set of names. Also exercises the approval-required ->
 * approve_request passthrough path.
 */

import assert from 'node:assert';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { mcpCallTool, mcpListTools } from '../../providers/agentcard/runtime';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function jsonRpcResponse(id: string | number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ToolAdvert {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

function makeServer(opts: {
  tools: ToolAdvert[];
  onCall: (name: string, args: Record<string, unknown>) => unknown;
}): { fetch: FetchLike; authHeaders: string[] } {
  const authHeaders: string[] = [];
  const fetchLike: FetchLike = async (_input, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return new Response(null, { status: 405 });

    const headers = init?.headers as Headers;
    const auth = headers.get('authorization');
    if (auth !== null) authHeaders.push(auth);

    const request = JSON.parse(typeof init?.body === 'string' ? init.body : '') as JsonRpcRequest;
    switch (request.method) {
      case 'initialize':
        return jsonRpcResponse(request.id ?? 1, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-agentcard-mcp', version: '1.0.0' },
        });
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return jsonRpcResponse(request.id ?? 1, { tools: opts.tools });
      case 'tools/call': {
        const params = request.params ?? {};
        const name = String(params.name);
        const args =
          typeof params.arguments === 'object' && params.arguments !== null
            ? (params.arguments as Record<string, unknown>)
            : {};
        const payload = opts.onCall(name, args);
        return jsonRpcResponse(request.id ?? 1, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        });
      }
      default:
        return jsonRpcResponse(request.id ?? 1, {});
    }
  };
  return { fetch: fetchLike, authHeaders };
}

async function main(): Promise<void> {
  await test('forwards EVERY advertised tool, including an unseen future tool', async () => {
    // An arbitrary toolset the integration has never hardcoded — including a tool
    // invented for this test. The runtime must register all of them, unchanged.
    const advertised: ToolAdvert[] = [
      { name: 'create_card', description: 'Create a card', inputSchema: { type: 'object' } },
      { name: 'list_cards', description: 'List cards', inputSchema: { type: 'object' } },
      { name: 'buy', description: 'Buy something', inputSchema: { type: 'object' } },
      {
        name: 'teleport_card_v9',
        description: 'A future tool the code has never seen',
        inputSchema: {
          type: 'object',
          properties: { destination: { type: 'string' } },
          required: ['destination'],
        },
      },
    ];
    const server = makeServer({ tools: advertised, onCall: () => ({ ok: true }) });

    const tools = await mcpListTools('user-token-abc', server.fetch);

    // Assert the LIVE list is forwarded in full — compare against whatever the
    // server advertised, never a fixed/expected app-level allowlist.
    assert.deepStrictEqual(
      tools.map((t) => t.name).sort(),
      advertised.map((t) => t.name).sort()
    );
    // inputSchema is passed through verbatim (so future params work with no change).
    const future = tools.find((t) => t.name === 'teleport_card_v9');
    assert.deepStrictEqual(future?.inputSchema, advertised[3].inputSchema);
    assert.strictEqual(server.authHeaders[0], 'Bearer user-token-abc');
  });

  await test('empty toolset is forwarded as empty (no synthetic tools)', async () => {
    const server = makeServer({ tools: [], onCall: () => ({}) });
    const tools = await mcpListTools('tok', server.fetch);
    assert.deepStrictEqual(tools, []);
  });

  await test('approval-required -> approve_request -> success passthrough', async () => {
    const approvalId = 'appr-42';
    let approved = false;
    const server = makeServer({
      tools: [
        { name: 'create_card', inputSchema: { type: 'object' } },
        { name: 'approve_request', inputSchema: { type: 'object' } },
      ],
      onCall: (name) => {
        if (name === 'create_card') {
          return approved
            ? { card_id: 'card_123', last4: '4242', status: 'ACTIVE' }
            : { approval_required: true, approval_id: approvalId };
        }
        if (name === 'approve_request') {
          approved = true;
          return { approved: true, approval_id: approvalId };
        }
        return { ok: true };
      },
    });

    // 1) First create_card is gated on approval.
    const gated = (await mcpCallTool('tok', 'create_card', { amount_cents: 2500 }, server.fetch)) as {
      structuredContent?: Record<string, unknown>;
    };
    assert.strictEqual(gated.structuredContent?.approval_required, true);
    assert.strictEqual(gated.structuredContent?.approval_id, approvalId);

    // 2) Resolve via the dynamically-advertised approve_request tool.
    const resolved = (await mcpCallTool(
      'tok',
      'approve_request',
      { approval_id: approvalId },
      server.fetch
    )) as { structuredContent?: Record<string, unknown> };
    assert.strictEqual(resolved.structuredContent?.approved, true);

    // 3) Retry create_card now succeeds.
    const card = (await mcpCallTool('tok', 'create_card', { amount_cents: 2500 }, server.fetch)) as {
      structuredContent?: Record<string, unknown>;
    };
    assert.strictEqual(card.structuredContent?.card_id, 'card_123');
  });

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ ${passed} AgentCard MCP runtime tests passed`);
}

void main();
