#!/usr/bin/env tsx
/**
 * Black-box tests for chat-mode context compaction.
 *
 * Mirrors agents/tests/blackbox/messages.blackbox.py compaction projection
 * and agents/helpers/summarize.py head/tail split contracts.
 */

import {
  buildContextCompactionMetadata,
  projectModelContextAfterCompaction,
} from '../../providers/chat/contextCompaction';
import {
  estimateContextTokens,
  messageSummaryWeight,
} from '../../providers/chat/contextTokens';
import {
  getAutoCompactThreshold,
  shouldAutoCompactChat,
} from '../../providers/chat/chatCompaction';
import type { ChatMessage } from '../../providers/chat/initialContext';
import { splitHeadMiddleTail } from '../../providers/chat/splitHeadMiddleTail';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function runTest(name: string, fn: () => Promise<void> | void): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      duration: Date.now() - start,
    };
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function makeMessages(count: number, textSize = 2_000): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'USER', text: 'Original goal', metadata: {} },
  ];
  for (let index = 0; index < count; index += 1) {
    messages.push({
      role: 'TOOL',
      text: 'x'.repeat(textSize),
      metadata: {
        toolName: 'web_fetch',
        toolStatus: 'FINISHED',
        toolCallId: `tool-${index}`,
        structured_response: { body: 'y'.repeat(500) },
      },
    });
  }
  messages.push({ role: 'USER', text: 'Latest follow-up', metadata: {} });
  return messages;
}

const tests: Array<[string, () => Promise<void> | void]> = [
  [
    'projection keeps checkpoint tail and hides raw pre-checkpoint rows',
    () => {
      const compressedContext: ChatMessage[] = [
        { role: 'USER', text: 'Original goal', metadata: {} },
        {
          role: 'USER',
          text: 'Compaction summary: earlier work was summarized.',
          metadata: { compactionSummary: true },
        },
      ];
      const rawMessages: ChatMessage[] = [
        { role: 'USER', text: 'Original goal', metadata: {} },
        { role: 'TOOL', text: 'Very large raw tool output', metadata: {} },
        {
          role: 'TOOL',
          text: 'Context compressed — continuing with summarized history.',
          metadata: {
            toolName: 'context_reset',
            toolStatus: 'FINISHED',
            contextCompaction: buildContextCompactionMetadata(compressedContext),
          },
        },
        { role: 'ASSISTANT', text: 'Continuing after reset', metadata: {} },
      ];

      const projected = projectModelContextAfterCompaction(rawMessages);
      const visibleText = projected
        .filter((message) => message.text && !message.metadata?.excludeFromModel)
        .map((message) => message.text);

      assertEqual(
        JSON.stringify(visibleText),
        JSON.stringify([
          'Original goal',
          'Compaction summary: earlier work was summarized.',
          'Continuing after reset',
        ]),
        'projected visible text'
      );
      assertEqual(
        projected.some((message) => message.metadata?.excludeFromModel === true),
        true,
        'boundary marker present'
      );
    },
  ],
  [
    'token estimator counts metadata-heavy tool rows',
    () => {
      const emptyTextTool: ChatMessage = {
        role: 'TOOL',
        text: '',
        metadata: {
          structured_response: { payload: 'z'.repeat(4_000) },
        },
      };
      const textOnly = messageSummaryWeight({ role: 'USER', text: 'hello', metadata: {} });
      const metadataHeavy = messageSummaryWeight(emptyTextTool);
      if (metadataHeavy <= textOnly) {
        throw new Error('metadata-heavy tool row should weigh more than short user text');
      }
    },
  ],
  [
    'auto-compact trigger matches Claude Code buffer math',
    () => {
      assertEqual(getAutoCompactThreshold(200_000), 167_000, '167k trigger for 200k window');
      const small = [{ role: 'USER', text: 'hi', metadata: {} }];
      const large = makeMessages(120, 8_000);
      assertEqual(shouldAutoCompactChat(small), false, 'small chat should not compact');
      assertEqual(shouldAutoCompactChat(large), true, 'large chat should compact');
      assertEqual(
        estimateContextTokens(large) >= getAutoCompactThreshold(),
        true,
        'large fixture exceeds trigger'
      );
    },
  ],
  [
    'head/tail split preserves first user and recent tail',
    () => {
      const messages = makeMessages(100, 3_000);
      const split = splitHeadMiddleTail(messages);
      if (!split) throw new Error('expected split for large context');
      assertEqual(split.headIndices.includes(0), true, 'first user kept in head');
      assertEqual(
        split.tailIndices.includes(messages.length - 1),
        true,
        'latest user kept in tail'
      );
      if (split.middleIndices.length === 0) {
        throw new Error('expected non-empty middle');
      }
    },
  ],
];

async function main(): Promise<void> {
  const results: TestResult[] = [];
  for (const [name, fn] of tests) {
    results.push(await runTest(name, fn));
  }

  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`${status} ${result.name} (${result.duration}ms)\n`);
    if (result.error) process.stderr.write(`${result.error}\n`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
