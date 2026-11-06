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
import { registerUserDataGrepTool } from '../../providers/userDataSearch';
import { executeGrepTool } from '../../domains/data/grepTool';
import { replayCall, stalledResponse } from './chat-search-escalation.network.support';

type Action = 'direct_answer' | 'web_search' | 'grep' | 'start_superintelligence';

/** Every chat grep call, recorded on its way into the real shared executor. */
const grepCalls: Array<{ userId: string; args: Record<string, unknown> }> = [];
registerUserDataGrepTool(async (userId, args) => {
  grepCalls.push({ userId, args });
  return executeGrepTool(userId, args);
});
type Stream = { agentId?: string; stream_id?: string; delta?: string; sequence?: number };
type Frame = { topic: string; event: string; record: Record<string, unknown> };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `followUp`: the agent's cloud run already COMPLETED (chat mode is restored in
 * the client, which still holds status COMPLETED). Posting a message reactivates
 * the row for chat; clients only learn that from an UPDATE frame, and the chat
 * Start agent button is gated on ACTIVE (docs/rca/cases/
 * 2026-10-28-chat-start-agent-button-stale-status-and-no-pending-state.md).
 */
async function runCase(name: string, actions: Action[], followUp = false) {
  const userId = randomUUID();
  const agentId = randomUUID();
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: `Reasoning identity ${name}`,
      status: followUp ? 'COMPLETED' : 'ACTIVE',
      temporalWorkflowId: followUp ? `finished-run-${agentId}` : null,
      source: 'MAC_APP',
      model: 'rose-labs/rose-1-ultra',
      verifier: { create: {} },
    },
  });
  const originalFetch = globalThis.fetch;
  const streams = new Map<string, string>();
  const frames: Frame[] = [];
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let routed = 0;
  grepCalls.length = 0;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/realtime/v1/api/broadcast')) {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ topic: string; event: string; payload: { record: Stream } }>;
      };
      for (const row of body.messages) {
        const record = row.payload.record;
        if (row.topic === `agent:${agentId}`) {
          frames.push({ topic: row.topic, event: row.event, record });
        }
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
        ...(action === 'grep'
          ? { grep: { pattern: `${name} pattern ${routed}`, sources: ['messages'], filters: null } }
          : {}),
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
    const grepRounds = actions.filter((action) => action === 'grep').length;
    assert.equal(grepCalls.length, grepRounds, 'each grep route runs the shared executor once');
    for (const call of grepCalls) {
      assert.equal(call.userId, userId, 'chat grep searches the chat owner’s data');
      assert.equal(call.args.agent_id, agentId, 'agent_network is scoped to this chat agent');
      assert.deepEqual(call.args.sources, ['messages']);
      assert.equal('filters' in call.args, false, 'strict-provider nulls never reach the executor');
    }
    if (grepRounds > 0) {
      const rows = await prisma.message.findMany({
        where: { agentId },
        orderBy: { createdAt: 'asc' },
      });
      const finished = rows.filter((row) => {
        const metadata = row.metadata as { toolName?: string; toolStatus?: string } | null;
        return metadata?.toolName === 'grep' && metadata.toolStatus === 'FINISHED';
      });
      assert.equal(finished.length, grepRounds, 'every grep chip reaches a FINISHED row');
      assert(
        requests.some((request) =>
          request.messages.some(
            (message) =>
              typeof message.content === 'string' &&
              message.content.startsWith('[Tool Result]\nGrep {"pattern":')
          )
        ),
        'the route after grep reads its result'
      );
    }
    if (followUp) {
      const reactivated = frames.findIndex(
        (frame) =>
          frame.event === 'UPDATE' &&
          frame.record.status === 'ACTIVE' &&
          frame.record.temporalWorkflowId === null
      );
      const answered = frames.findIndex(
        (frame) =>
          frame.event === 'INSERT' &&
          (frame.record.metadata as { toolName?: string } | null)?.toolName ===
            'send_message_to_user'
      );
      assert(
        reactivated !== -1,
        `the chat reactivation of a finished run must broadcast UPDATE {status: ACTIVE, temporalWorkflowId: null}; saw ${JSON.stringify(frames.map((frame) => frame.event))}`
      );
      assert(answered !== -1, 'the follow-up answer must be broadcast');
      assert(reactivated < answered, 'clients must see the reactivation before the answer');
    }
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
  const cases: Array<[string, Action[], boolean?]> = [
    ['direct', ['direct_answer']],
    ['follow-up-after-completed-run', ['direct_answer'], true],
    ['search-again', ['web_search', 'web_search', 'direct_answer']],
    ['initial-escalation', ['start_superintelligence']],
    ['search-escalation', ['web_search', 'start_superintelligence']],
    ['grep-then-answer', ['grep', 'direct_answer']],
    ['grep-then-search', ['grep', 'web_search', 'direct_answer']],
  ];
  let failed = 0;
  for (const [name, actions, followUp] of cases) {
    try {
      await runCase(name, actions, followUp);
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
