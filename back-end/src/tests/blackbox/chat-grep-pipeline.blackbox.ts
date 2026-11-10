#!/usr/bin/env tsx
/** Real chat -> data-domain grep -> reloaded model context, with isolated provider HTTP. */
import 'dotenv/config';
import './assertLocalDatabase';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { handleChatMessage } from '../../providers/chat/chatHandler';
import { registerUserDataGrep } from '../../providers/userDataSearch';
import { grep } from '../../domains/data/service';
import { __flushBroadcastQueueForTests } from '../../providers/chat/supabaseBroadcast';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import { replayCall, stalledResponse } from './chat-search-escalation.network.support';

async function main(): Promise<void> {
  process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = '1';
  process.env.CEREBRAS_API_KEY = 'blackbox-cerebras-key';
  process.env.OPENROUTER_API_KEY = 'blackbox-openrouter-key';
  const userId = randomUUID(),
    otherUserId = randomUUID(),
    agentId = randomUUID();
  const token = `laundry-${randomUUID()}`;
  const ownEvidence = `${token}: washer $4, dryer $1, one block from home.`;
  const foreignEvidence = `${token}: PRIVATE OTHER USER RECORD`;
  let routerCalls = 0;
  const generatorContexts: string[] = [];
  const originalFetch = globalThis.fetch;
  registerUserDataGrep(grep);
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/realtime/v1/api/broadcast')) return Response.json({});
    if (url === OPENROUTER_API_URL) return stalledResponse(init?.signal);
    assert.equal(
      url,
      CEREBRAS_API_URL,
      'private lookup must use the data service, never public search'
    );
    const body = JSON.parse(String(init?.body));
    const isRouter = body.response_format?.json_schema?.name === 'router_decision';
    const context = JSON.stringify(body.messages);
    assert.ok(!context.includes(foreignEvidence), 'foreign records must never reach a provider');
    let content: string;
    if (isRouter) {
      const actionEnum = body.response_format.json_schema.schema.properties.action.enum as string[];
      const initial = routerCalls++ === 0;
      const offersGrep = actionEnum.includes('grep');
      if (!initial)
        assert.ok(
          context.includes(ownEvidence),
          'next route must receive actual database evidence'
        );
      content = JSON.stringify(
        initial && offersGrep
          ? {
              action: 'grep',
              reasoning: 'Read the user’s laundry note.',
              grep: { pattern: token, sources: ['documents'], '-i': true, head_limit: 20 },
            }
          : { action: 'direct_answer', reasoning: 'Answer from available evidence.' }
      );
    } else {
      generatorContexts.push(context);
      content = JSON.stringify({
        reasoning: 'Scripted boundary test.',
        response: 'Fixture laundry answer.',
      });
    }
    return replayCall({ model: 'qwen-3.8-27b', content }, init?.signal, () => undefined);
  }) as typeof fetch;
  try {
    await prisma.user.createMany({
      data: [
        { userId, isAnonymous: true },
        { userId: otherUserId, isAnonymous: true },
      ],
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        goal: 'Find my saved laundry note',
        status: 'ACTIVE',
        source: 'MAC_APP',
        model: 'rose-labs/rose-1-flash',
        verifier: { create: {} },
      },
    });
    await prisma.message.create({
      data: { agentId, role: 'USER', text: 'Find my saved laundry note' },
    });
    await prisma.userDataDocument.createMany({
      data: [
        {
          userId,
          source: 'apple_notes',
          externalId: token,
          title: 'Laundry',
          content: ownEvidence,
          contentHash: token,
        },
        {
          userId: otherUserId,
          source: 'apple_notes',
          externalId: token,
          title: 'Laundry',
          content: foreignEvidence,
          contentHash: token,
        },
      ],
    });
    const result = await handleChatMessage({ agentId, userId, model: 'rose-labs/rose-1-flash' });
    assert.equal(result.status, 'complete');
    const rows = await prisma.message.findMany({
      where: { agentId },
      orderBy: { timestamp: 'asc' },
    });
    const grepRows = rows.filter(
      (x) => (x.metadata as Record<string, unknown>)?.toolName === 'grep'
    );
    assert.equal(grepRows.length, 2, 'grep must persist an IN_PROGRESS and a FINISHED row');
    assert.ok(
      grepRows[1].text.includes(ownEvidence),
      'the real data domain must return the owner’s stored document'
    );
    assert.ok(!grepRows[1].text.includes(foreignEvidence));
    assert.equal(
      routerCalls,
      2,
      'chat must route again after grep instead of replying from speculation'
    );
    assert.ok(
      generatorContexts.some((x) => x.includes(ownEvidence)),
      'answer generator must see the same retrieved evidence'
    );
    console.log(
      'PASS real chat grep reads owned documents, excludes foreign records, and re-routes with persisted evidence'
    );
  } finally {
    await __flushBroadcastQueueForTests();
    globalThis.fetch = originalFetch;
    await prisma.message.deleteMany({ where: { agentId } });
    await prisma.verifier.deleteMany({ where: { agentId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
