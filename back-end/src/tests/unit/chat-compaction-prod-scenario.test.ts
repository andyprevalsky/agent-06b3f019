#!/usr/bin/env tsx
/**
 * Cemented regression for prod agent 3eb68a5c (2026-08-24):
 * post-completion chat follow-ups failed because ~586 messages (~339k estimated tokens)
 * were sent to Router/Generator without compaction, exceeding OpenRouter's 262k window.
 *
 * This test drives the real ensureChatContextWithinBudget path with mocked Rose +
 * message persistence so deploy proves compaction runs before chat routing.
 */

import assert from 'node:assert/strict';
import { mock } from 'node:test';

import {
  buildProdChatCompactionScenario,
  PROD_CHAT_COMPACTION_AGENT_ID,
  PROD_CHAT_COMPACTION_FOLLOW_UP,
} from '../fixtures/chat-compaction-prod-3eb68a5c';

async function main(): Promise<void> {
  const dumpBindings: unknown[] = [];
  await mock.module('../../providers/rose', {
    namedExports: {
      createStreamingCompletion: async (options: { dump_context?: unknown }) => {
        dumpBindings.push(options.dump_context);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              choices: [
                {
                  delta: {
                    content:
                      '<summary>[CONTEXT SUMMARY]: summarized prior hotel research, candidate comparisons, and remaining user asks.</summary>',
                  },
                },
              ],
            };
          },
        };
      },
    },
  });

  const checkpointWrites: Array<{ agentId: string; compressedCount: number }> = [];

  await mock.module('../../providers/messages', {
    namedExports: {
      createMessage: async (params: {
        agentId: string;
        metadata?: { contextCompaction?: { compressedContext?: unknown[] } };
      }) => {
        checkpointWrites.push({
          agentId: params.agentId,
          compressedCount: params.metadata?.contextCompaction?.compressedContext?.length ?? 0,
        });
        return { id: 'checkpoint-message' };
      },
    },
  });

  const { ensureChatContextWithinBudget, shouldAutoCompactChat } =
    await import('../../providers/chat/chatCompaction');
  const { loadChatModelMessages } = await import('../../providers/chat/initialContext');

  const rawMessages = buildProdChatCompactionScenario();
  assert.equal(
    shouldAutoCompactChat(rawMessages),
    true,
    'fixture must exceed auto-compact trigger'
  );

  const projected = await ensureChatContextWithinBudget({
    agentId: PROD_CHAT_COMPACTION_AGENT_ID,
    rootAgentId: PROD_CHAT_COMPACTION_AGENT_ID,
    requestedModel: 'rose-labs/rose-1-flash',
    rawMessages,
  });

  assert.equal(shouldAutoCompactChat(projected), false, 'compacted chat must fit router budget');
  assert.ok(
    projected.some((message) => message.text?.includes(PROD_CHAT_COMPACTION_FOLLOW_UP)),
    'follow-up ask must survive compaction'
  );
  assert.equal(checkpointWrites.length, 1, 'compaction must persist one context_reset checkpoint');
  assert.equal(checkpointWrites[0]?.agentId, PROD_CHAT_COMPACTION_AGENT_ID);
  assert.ok(
    (checkpointWrites[0]?.compressedCount ?? 0) > 0,
    'checkpoint must store compressed tail'
  );

  const startupMessages = await loadChatModelMessages(
    {
      agentId: PROD_CHAT_COMPACTION_AGENT_ID,
      rootAgentId: PROD_CHAT_COMPACTION_AGENT_ID,
      requestedModel: 'rose-labs/rose-1-flash',
    },
    {
      findMessages: async () =>
        rawMessages.map((message) => ({
          role: message.role,
          text: message.text,
          filePointer: message.filePointer ?? null,
          metadata: message.metadata ?? null,
        })),
      ensureWithinBudget: ensureChatContextWithinBudget,
    }
  );

  assert.equal(
    shouldAutoCompactChat(startupMessages),
    false,
    'chat startup must compact before router'
  );
  assert.equal(
    checkpointWrites.length,
    2,
    'both startup paths should persist compaction checkpoints'
  );

  assert.deepEqual(
    dumpBindings,
    Array.from({ length: 2 }, () => ({
      call_site: 'chat_compaction',
      agent_id: PROD_CHAT_COMPACTION_AGENT_ID,
      root_agent_id: PROD_CHAT_COMPACTION_AGENT_ID,
    })),
    'both compaction startup paths retain the explicit archive root'
  );

  process.stdout.write(
    'PASS ensureChatContextWithinBudget compacts prod-shaped post-completion chat history\n'
  );
  process.stdout.write(
    'PASS loadChatModelMessages uses ensureChatContextWithinBudget on prod-shaped history\n'
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
