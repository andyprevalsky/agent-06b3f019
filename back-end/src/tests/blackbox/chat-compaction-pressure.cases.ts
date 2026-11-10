import assert from 'node:assert/strict';
import { compressChatContext, shouldAutoCompactChat } from '../../providers/chat/chatCompaction';
import { estimateContextTokens } from '../../providers/chat/contextTokens';
import { COMPACTION_SUMMARY_PREFIX } from '../../providers/chat/chatCompactionPrompts';
import type { ChatMessage } from '../../providers/chat/initialContext';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import { replayCall } from './chat-search-escalation.network.support';

/**
 * Sanitized shape of ebb350db's seven pre-failure rows: an error round followed
 * by a 2,244,783-character result, protected by the recent-four-message floor.
 * Provider output is controlled: this proves compaction, not model quality.
 */
export async function testOversizedRecentToolCompaction(): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'USER', text: 'Find the saved credit justification and quote its source.' },
    { role: 'ASSISTANT', text: 'Search the available documents and email.' },
    { role: 'TOOL', text: '', metadata: { toolName: 'grep', toolStatus: 'IN_PROGRESS' } },
    { role: 'TOOL', text: 'Error: Pattern safety analysis did not complete.' },
    { role: 'ASSISTANT', text: 'Search using a simpler expression.' },
    { role: 'TOOL', text: '', metadata: { toolName: 'grep', toolStatus: 'IN_PROGRESS' } },
    {
      role: 'TOOL',
      text: 'Grep result with source pointers\n'.padEnd(2_244_783, 'x'),
      metadata: { toolName: 'grep', toolCallId: 'large-result', toolStatus: 'FINISHED' },
    },
  ];
  const original = structuredClone(messages);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert([CEREBRAS_API_URL, OPENROUTER_API_URL].includes(url), `unexpected network call ${url}`);
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[] };
    assert(body.messages.length > 0, 'the real summarizer request must be assembled');
    return replayCall(
      {
        model: body.model,
        content: `${COMPACTION_SUMMARY_PREFIX} Search evidence is stored in the grep result; retrieve the cited source before quoting.`,
      },
      init?.signal,
      () => {}
    );
  }) as typeof fetch;
  try {
    assert(shouldAutoCompactChat(messages), 'captured shape must exceed the trigger');
    const compressed = await compressChatContext({
      messages,
      model: 'rose-labs/rose-1-flash',
      agentId: 'blackbox-compaction-pressure',
    });
    assert(
      !shouldAutoCompactChat(compressed),
      `router context still oversized: ${estimateContextTokens(compressed)}`
    );
    assert.deepEqual(messages, original, 'raw persisted evidence must remain unchanged');
    assert.deepEqual(compressed[0], original[0], 'the original request stays verbatim');
    assert(calls > 0, 'the real compaction summary path must run');
    const tool = compressed.find((message) => message.metadata?.toolCallId === 'large-result');
    assert(tool, 'tool identity and terminal status survive compaction');
    assert.equal(tool.metadata?.toolStatus, 'FINISHED');
    assert(
      tool.text.startsWith(COMPACTION_SUMMARY_PREFIX),
      'large result is summarized explicitly'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}
