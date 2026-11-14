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

/** Pressure relief must also satisfy the existing minimum-savings contract. */
export async function testPressureCompactionSavings(): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'USER', text: 'Original request' },
    { role: 'ASSISTANT', text: 'A'.repeat(150_000) },
    { role: 'USER', text: 'U'.repeat(150_000) },
    { role: 'ASSISTANT', text: 'A'.repeat(150_000) },
    { role: 'USER', text: 'U'.repeat(5_000) },
    { role: 'ASSISTANT', text: 'A'.repeat(1_000) },
    { role: 'TOOL', text: '' },
    {
      role: 'TOOL',
      text: 'T'.repeat(58_000),
      metadata: { toolCallId: 'savings-edge', toolStatus: 'FINISHED' },
    },
  ];
  const original = structuredClone(messages);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert([CEREBRAS_API_URL, OPENROUTER_API_URL].includes(url), `unexpected network call ${url}`);
    const body = JSON.parse(String(init?.body)) as { model: string };
    return replayCall({ model: body.model, content: 'S'.repeat(8_000) }, init?.signal, () => {});
  }) as typeof fetch;
  try {
    const compressed = await compressChatContext({
      messages,
      model: 'rose-labs/rose-1-flash',
      agentId: 'blackbox-compaction-savings',
    });
    assert(!shouldAutoCompactChat(compressed), 'router context must fit after compaction');
    assert(
      estimateContextTokens(compressed) <= estimateContextTokens(messages) * 0.9,
      'minimum savings remains enforced'
    );
    assert.deepEqual(messages, original, 'raw history must remain unchanged');
    assert.deepEqual(compressed[0], original[0], 'original request retained');
    assert(
      compressed.some((message) => message.text === original[4].text),
      'latest user instructions retained'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Exercise the real summary client with a transport that cannot leave this process. */
async function withSummaryTransport(
  response: (prompt: string) => string,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert([CEREBRAS_API_URL, OPENROUTER_API_URL].includes(url), `unexpected network call ${url}`);
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    return replayCall(
      { model: body.model, content: response(body.messages[0].content) },
      init?.signal,
      () => {}
    );
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function reviewTool(id: string, size: number): ChatMessage {
  return {
    role: 'TOOL',
    text: id.padEnd(size, 'x'),
    metadata: { toolCallId: id, toolName: 'grep', toolStatus: 'FINISHED' },
  };
}

export async function testCustomWindowToolCompaction(): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'USER', text: 'Keep this request verbatim' },
    reviewTool('custom-window', 180_000),
  ];
  const original = structuredClone(messages);
  let calls = 0;
  await withSummaryTransport(
    () => {
      calls += 1;
      return 'Small summary';
    },
    async () => {
      assert(shouldAutoCompactChat(messages, 90_000));
      assert(!shouldAutoCompactChat(messages));
      const compressed = await compressChatContext({
        messages,
        model: 'rose-labs/rose-1-flash',
        agentId: 'blackbox-custom-window',
        ...{ maxContextTokens: 90_000 },
      });
      assert.equal(calls, 1, 'custom window must trigger the tool summary');
      assert(!shouldAutoCompactChat(compressed, 90_000));
      assert.deepEqual(compressed[0], original[0]);
      assert.equal(compressed[1].metadata?.toolStatus, 'FINISHED');
      assert.deepEqual(messages, original);
    }
  );
}

export async function testIgnoredSubagentToolCompaction(): Promise<void> {
  const ignored = reviewTool('ignored-subagent', 900_000);
  ignored.metadata = { ...ignored.metadata, subAgentId: 'child' };
  const messages: ChatMessage[] = [
    { role: 'USER', text: 'Keep the parent request' },
    ignored,
    reviewTool('parent-result', 800_000),
  ];
  const original = structuredClone(messages);
  const prompts: string[] = [];
  await withSummaryTransport(
    (prompt) => {
      prompts.push(prompt);
      return 'Parent summary';
    },
    async () => {
      const compressed = await compressChatContext({
        messages,
        model: 'rose-labs/rose-1-flash',
        agentId: 'blackbox-ignored-subagent',
      });
      assert.equal(prompts.length, 1, 'zero-weight subagent row must not spend a summary call');
      assert(!prompts[0].includes('ignored-subagent'));
      assert.deepEqual(compressed[1], original[1], 'ignored row stays untouched');
      assert.deepEqual(messages, original);
    }
  );
}

export async function testFailedToolSummaryContinues(): Promise<void> {
  // The failed row is largest in one run and smallest in the other: both
  // later attempts and earlier successful reductions must survive a failure.
  for (const failedSize of [900_000, 700_000]) {
    for (const failure of ['empty', 'no-reduction']) {
      const failed = reviewTool('failed-result', failedSize);
      const messages: ChatMessage[] = [
        { role: 'USER', text: 'Keep the request' },
        failed,
        reviewTool('good-result', 800_000),
      ];
      const original = structuredClone(messages);
      const prompts: string[] = [];
      await withSummaryTransport(
        (prompt) => {
          prompts.push(prompt);
          return prompt.includes('failed-result')
            ? failure === 'empty'
              ? ' '
              : 'z'.repeat(failedSize + 100)
            : 'Good summary';
        },
        async () => {
          const compressed = await compressChatContext({
            messages,
            model: 'rose-labs/rose-1-flash',
            agentId: 'blackbox-failed-tool',
          });
          assert.equal(prompts.length, 2, 'both candidates must be attempted');
          assert.deepEqual(compressed[1], failed, 'failed row remains unchanged');
          assert(compressed[2].text.startsWith(COMPACTION_SUMMARY_PREFIX));
          assert.equal(compressed[2].metadata?.toolCallId, 'good-result');
          assert.equal(compressed[2].metadata?.toolStatus, 'FINISHED');
          assert(estimateContextTokens(compressed) <= estimateContextTokens(messages) * 0.9);
          assert.deepEqual(messages, original);
        }
      );
    }
  }
}

export async function testFailedToolSummaryAllowsOrdinaryPass(): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'USER', text: 'Original request' },
    reviewTool('failed-middle', 800_000),
    { role: 'ASSISTANT', text: 'a'.repeat(200_000) },
    { role: 'ASSISTANT', text: 'b'.repeat(200_000) },
    { role: 'USER', text: 'Latest instructions' },
    { role: 'ASSISTANT', text: 'Recent answer' },
    reviewTool('recent-small', 70_000),
    reviewTool('recent-tiny', 100),
  ];
  const original = structuredClone(messages);
  const prompts: string[] = [];
  await withSummaryTransport(
    (prompt) => {
      prompts.push(prompt);
      return prompt.includes('message_index=2') ? 'Ordinary history summary' : ' ';
    },
    async () => {
      const compressed = await compressChatContext({
        messages,
        model: 'rose-labs/rose-1-flash',
        agentId: 'blackbox-failed-middle',
      });
      assert(
        prompts.some((prompt) => prompt.includes('message_index=2')),
        'ordinary pass runs'
      );
      assert(!shouldAutoCompactChat(compressed));
      assert(estimateContextTokens(compressed) <= estimateContextTokens(messages) * 0.9);
      assert.deepEqual(compressed[0], original[0]);
      assert.deepEqual(compressed.slice(-4), original.slice(-4), 'protected tail stays verbatim');
      assert.deepEqual(messages, original);
    }
  );
}
