#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAgentPhoneNumber } from '../../providers/agentPhone';
import { prisma } from '../../providers/database';

const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
const previousAgentPhoneBaseUrl = process.env.AGENTPHONE_BASE_URL;
const previousFetch = globalThis.fetch;

async function main(): Promise<void> {
  let providerAgent: Record<string, unknown> | null = null;
  let agentCreates = 0;
  let numberCreates = 0;
  const pageSignals: AbortSignal[] = [];
  process.env.AGENTPHONE_API_KEY = 'test-agentphone-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.test/v1';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/agents?limit=100&offset=')) {
      if (init?.signal) pageSignals.push(init.signal);
      const offset = Number(new URL(url).searchParams.get('offset'));
      if (offset === 0) {
        return new Response(
          JSON.stringify({
            data: Array.from({ length: 100 }, (_, index) => ({
              id: `decoy-${index}`,
              description: `other-${index}`,
            })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return Response.json({ data: providerAgent ? [providerAgent] : [] });
    }
    if (method === 'POST' && url === 'https://agentphone.test/v1/agents') {
      agentCreates += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      providerAgent = { id: 'agt-concurrent', description: body.description, numbers: [] };
      return Response.json(providerAgent);
    }
    if (method === 'POST' && url === 'https://agentphone.test/v1/numbers') {
      numberCreates += 1;
      const number = { id: 'num-concurrent', phoneNumber: '+19125550177', status: 'active' };
      providerAgent = { ...providerAgent, numbers: [number] };
      return Response.json(number);
    }
    throw new Error(`unexpected AgentPhone fetch: ${method} ${url}`);
  }) as typeof fetch;

  const userId = `agentphone-concurrent-${randomUUID()}`;
  const [first, second] = await Promise.all([
    createAgentPhoneNumber({ userId }),
    createAgentPhoneNumber({ userId }),
  ]);
  assert.equal(agentCreates, 1, 'serialized callers must create one provider agent');
  assert.equal(numberCreates, 1, 'serialized callers must create one provider number');
  assert.equal(first?.agentId, second?.agentId, 'both callers must reuse the marker agent');
  assert.equal(first?.numberId, second?.numberId, 'both callers must reuse the provider number');
  assert.equal(pageSignals.length, 4, 'both scans must continue past a full page without total');
  assert.equal(
    new Set(pageSignals).size,
    pageSignals.length,
    'every reconciliation page must receive a fresh timeout signal'
  );
}

main()
  .then(() => process.stdout.write('PASS AgentPhone concurrent provisioning\n'))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    globalThis.fetch = previousFetch;
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    if (previousAgentPhoneBaseUrl === undefined) delete process.env.AGENTPHONE_BASE_URL;
    else process.env.AGENTPHONE_BASE_URL = previousAgentPhoneBaseUrl;
    await prisma.$disconnect();
  });
