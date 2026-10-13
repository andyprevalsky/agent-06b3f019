#!/usr/bin/env tsx

import 'dotenv/config';
import './assertLocalDatabase';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { postMessage } from '../../domains/agents/agentMessageService';
import { getAgentDetail } from '../../domains/agents/agentQueryService';
import { __flushBroadcastQueueForTests } from '../../providers/chat/supabaseBroadcast';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import { replayCall, stalledResponse } from './chat-search-escalation.network.support';

type Action = 'direct_answer' | 'web_search' | 'start_superintelligence';
type Stream = { agentId?: string; stream_id?: string; delta?: string; sequence?: number };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runCase(name: string, actions: Action[]) {
  const userId = randomUUID();
  const agentId = randomUUID();
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: `Reasoning identity ${name}`,
      status: 'ACTIVE',
      source: 'MAC_APP',
      model: 'rose-labs/rose-1-ultra',
      verifier: { create: {} },
    },
  });
  const originalFetch = globalThis.fetch;
  const streams = new Map<string, string>();
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let routed = 0;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/realtime/v1/api/broadcast')) {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ event: string; payload: { record: Stream } }>;
      };
      for (const row of body.messages) {
        const record = row.payload.record;
        if (row.event === 'ASSISTANT_STREAM' && record.agentId === agentId && record.stream_id) {
          streams.set(
            record.stream_id,
            (streams.get(record.stream_id) ?? '') + (record.delta ?? '')
          );
        }
      }
      return new Response('{}', { status: 202 });
    }
    if (url === 'https://api.parallel.ai/v1/search') {
      return Response.json({
        results: [
          {
            title: 'Evidence',
            url: 'https://example.com/evidence',
            excerpts: ['Search evidence.'],
          },
        ],
      });
    }
    if (url === OPENROUTER_API_URL) return stalledResponse(init?.signal);
    assert.equal(
      url,
      CEREBRAS_API_URL,
      'the test must isolate only the existing provider boundary'
    );
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
      response_format: { json_schema: { name: string } };
    };
    requests.push({ messages: body.messages });
    let content: string;
    if (body.response_format.json_schema.name === 'router_decision') {
      const action = actions[routed];
      const reasoning = `${name} router reasoning ${routed++}`;
      assert(action, 'unexpected extra router round');
      content = JSON.stringify({
        reasoning,
        action,
        ...(action === 'web_search' ? { queries: [`${name} query ${routed}`] } : {}),
        ...(action === 'start_superintelligence'
          ? { goal: `Identity escalation ${name}`, mode: 'plan' }
          : {}),
      });
    } else {
      assert.equal(body.response_format.json_schema.name, 'generator_response');
      content = JSON.stringify({
        reasoning: `${name} generator reasoning`,
        response: `${name} answer`,
      });
    }
    return replayCall({ model: 'qwen-3.8-27b', content }, init?.signal, () => undefined);
  }) as typeof fetch;
  try {
    const posted = await postMessage(
      agentId,
      { message: `Reasoning identity ${name}` },
      false,
      userId
    );
    assert(!('error' in posted));
    const deadline = Date.now() + 15_000;
    let finished = false;
    while (Date.now() < deadline) {
      const rows = await prisma.message.findMany({ where: { agentId } });
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      finished =
        rows.some(
          (row) =>
            row.role === 'TOOL' &&
            (row.metadata as { toolName?: string } | null)?.toolName === 'send_message_to_user'
        ) || agent.temporalFirstExecutionRunId !== null;
      if (finished) break;
      await sleep(25);
    }
    assert(finished, 'the public chat turn must complete or accept escalation');
    await sleep(100);
    await __flushBroadcastQueueForTests();
    const detail = await getAgentDetail(agentId);
    assert(!('error' in detail));
    const reasoningRows = detail.messages.filter((row) => row.role === 'ASSISTANT');
    assert(reasoningRows.length > 0, 'the API detail must expose persisted reasoning');
    for (const row of reasoningRows) {
      const producerIds = [...streams]
        .filter(([, text]) => text.includes(row.text))
        .map(([id]) => id);
      assert.equal(
        producerIds.length,
        1,
        `the recorded reasoning must have one producer: ${row.text}`
      );
      assert.equal(
        (row.metadata as { streamId?: string } | null)?.streamId,
        producerIds[0],
        'persisted reasoning must retain its producing ASSISTANT_STREAM identity'
      );
    }
    assert(
      requests.every((request) =>
        request.messages.every((message) =>
          Object.keys(message).every(
            (key) => key === 'role' || key === 'content' || key === 'cache_control'
          )
        )
      ),
      'UI stream identity must not be passed to the model'
    );
    assert.equal(routed, actions.length);
  } finally {
    await __flushBroadcastQueueForTests();
    globalThis.fetch = originalFetch;
    await prisma.toolUsage.deleteMany({ where: { agentId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function main() {
  process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = '1';
  process.env.BLACKBOX_TEST_FAKE_TEMPORAL = '1';
  process.env.CEREBRAS_API_KEY = 'blackbox-cerebras-key';
  process.env.OPENROUTER_API_KEY = 'blackbox-openrouter-key';
  process.env.PARRALLEL_API_KEY = 'blackbox-parallel-key';
  const cases: Array<[string, Action[]]> = [
    ['direct', ['direct_answer']],
    ['search-again', ['web_search', 'web_search', 'direct_answer']],
    ['initial-escalation', ['start_superintelligence']],
    ['search-escalation', ['web_search', 'start_superintelligence']],
  ];
  let failed = 0;
  for (const [name, actions] of cases) {
    try {
      await runCase(name, actions);
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`FAIL ${name}: ${String(error)}\n`);
    }
  }
  await prisma.$disconnect();
  process.stdout.write(`RESULTS: ${cases.length - failed}/${cases.length} passed\n`);
  process.exitCode = failed ? 1 : 0;
}
void main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
