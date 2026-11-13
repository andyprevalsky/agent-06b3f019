#!/usr/bin/env tsx

/**
 * Stored profile -> real chat handler -> serialized provider requests.
 * Only provider/realtime HTTP is replaced. Scripted completions select the
 * branches under test; they do not replay or prove a model's answer quality.
 */
import 'dotenv/config';
import './assertLocalDatabase';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { handleChatMessage } from '../../providers/chat/chatHandler';
import { __flushBroadcastQueueForTests } from '../../providers/chat/supabaseBroadcast';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import { replayCall, stalledResponse } from './chat-search-escalation.network.support';

interface ProviderRequest {
  messages: Array<{ role: string; content: unknown }>;
  response_format: { json_schema: { name: string } };
}

const userId = randomUUID();
const otherUserId = randomUUID();
const agentId = randomUUID();
const ignoredSystemText = 'PERSISTED_SYSTEM_CONTEXT_MUST_STAY_IGNORED';
const profile = {
  name: 'Profile Fixture Owner',
  email: `profile-${userId}@example.test`,
  phone: `+1${userId.replace(/\D/g, '').slice(0, 10).padEnd(10, '0')}`,
  deliveryRecipientName: 'Profile Fixture Recipient',
  addressLine1: '812 Profile Fixture Avenue',
  addressLine2: 'Apartment Profile-42',
  city: 'Profile Fixture City',
  state: 'Profile Fixture State',
  postalCode: '94301',
  country: 'Profile Fixture Country',
};
const revisedProfile = {
  ...profile,
  addressLine1: '926 Updated Fixture Street',
  city: 'Updated Fixture City',
  postalCode: '10011',
};

async function main(): Promise<void> {
  process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND = '1';
  process.env.CEREBRAS_API_KEY = 'blackbox-cerebras-key';
  process.env.OPENROUTER_API_KEY = 'blackbox-openrouter-key';
  process.env.PARRALLEL_API_KEY = 'blackbox-parallel-key';
  const originalFetch = globalThis.fetch;
  const requests: ProviderRequest[] = [];
  let searchTurn = false;
  let routerCalls = 0;
  const failures: string[] = [];
  const handlerFailures: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/realtime/v1/api/broadcast')) return Response.json({});
    if (url === 'https://api.parallel.ai/v1/search') {
      return Response.json({
        results: [
          {
            title: 'Fixture laundromat',
            url: 'https://example.test/laundry',
            excerpts: ['Fixture search result.'],
          },
        ],
      });
    }
    if (url === OPENROUTER_API_URL) return stalledResponse(init?.signal);
    assert.equal(url, CEREBRAS_API_URL, 'unexpected outbound request in isolated profile test');
    const request = JSON.parse(String(init?.body)) as ProviderRequest;
    requests.push(request);
    const isRouter = request.response_format.json_schema.name === 'router_decision';
    const content = isRouter
      ? JSON.stringify(
          searchTurn && routerCalls++ === 0
            ? {
                reasoning: 'Exercise the after-search profile boundary.',
                action: 'web_search',
                queries: ['fixture laundry'],
              }
            : { reasoning: 'Exercise the direct-answer profile boundary.', action: 'direct_answer' }
        )
      : JSON.stringify({ reasoning: 'Scripted boundary fixture.', response: 'Fixture answer.' });
    return replayCall({ model: 'qwen-3.8-27b', content }, init?.signal, () => undefined);
  }) as typeof fetch;

  try {
    await prisma.user.create({
      data: { userId, isAnonymous: true, ...profile },
      select: { userId: true },
    });
    await prisma.user.create({
      data: {
        userId: otherUserId,
        isAnonymous: true,
        name: 'Other User Must Stay Private',
        addressLine1: 'Other User Secret Street',
      },
      select: { userId: true },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        goal: 'whats the cheapest easiest laundromat near me',
        status: 'ACTIVE',
        source: 'MAC_APP',
        model: 'rose-labs/rose-1-flash',
        verifier: { create: {} },
      },
      select: { id: true },
    });
    await prisma.message.create({
      data: { agentId, role: 'USER', text: 'whats the cheapest easiest laundromat near me' },
      select: { id: true },
    });
    await prisma.message.create({
      data: { agentId, role: 'SYSTEM', text: ignoredSystemText },
      select: { id: true },
    });

    const checkRequests = (label: string, expected: typeof profile, start: number): void => {
      const current = requests.slice(start);
      assert(
        current.some((request) => request.response_format.json_schema.name === 'router_decision'),
        `${label}: router did not run`
      );
      assert(
        current.some(
          (request) => request.response_format.json_schema.name === 'generator_response'
        ),
        `${label}: generator did not run`
      );
      for (const [index, request] of current.entries()) {
        const text = JSON.stringify(request.messages);
        const phase = request.response_format.json_schema.name;
        assert(!text.includes(ignoredSystemText), 'persisted SYSTEM rows must remain excluded');
        const missing = Object.entries(expected)
          .filter(([, value]) => !text.includes(value))
          .map(([key]) => key);
        if (missing.length)
          failures.push(
            `${label} ${phase}[${index}] missing stored profile fields: ${missing.join(', ')}`
          );
        assert(
          !text.includes('Other User Must Stay Private') &&
            !text.includes('Other User Secret Street'),
          'another user profile leaked into chat'
        );
        if (label === 'updated/search') {
          assert(
            !text.includes(profile.addressLine1),
            'previous profile address survived a fresh chat turn'
          );
        }
      }
    };

    const runTurn = async (label: string): Promise<void> => {
      try {
        await handleChatMessage({ agentId, userId, model: 'rose-labs/rose-1-flash' });
      } catch (error) {
        // Preserve late handler failures separately: an unavailable DB column
        // must not hide a profile assertion on requests already captured.
        handlerFailures.push(`${label} handler failed: ${String(error)}`);
      }
    };

    await runTurn('initial/direct');
    checkRequests('initial/direct', profile, 0);

    await prisma.user.update({ where: { userId }, data: revisedProfile, select: { userId: true } });
    await prisma.message.create({
      data: { agentId, role: 'USER', text: 'Check nearby options again.' },
      select: { id: true },
    });
    searchTurn = true;
    const start = requests.length;
    await runTurn('updated/search');
    checkRequests('updated/search', revisedProfile, start);
    assert.equal(routerCalls, 2, 'must exercise initial and after-search router requests');
    const persisted = await prisma.message.findMany({
      where: { agentId },
      select: { text: true, role: true },
    });
    assert.equal(
      persisted.filter((message) => message.role === 'SYSTEM').length,
      1,
      'profile context must not create persistent SYSTEM messages'
    );
    for (const message of persisted) {
      for (const value of [profile.name, profile.addressLine1, revisedProfile.addressLine1]) {
        assert(
          !message.text.includes(value),
          'profile context must not be persisted in conversation history'
        );
      }
    }
    assert.equal(
      failures.length + handlerFailures.length,
      0,
      [...failures, ...handlerFailures].join('\n')
    );
    process.stdout.write(
      'PASS profile reaches every direct/search Router and Generator request, refreshes on the next turn, and stays user-scoped\n'
    );
  } finally {
    await __flushBroadcastQueueForTests();
    globalThis.fetch = originalFetch;
    await prisma.toolUsage.deleteMany({ where: { agentId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
