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
import { estimateContextTokens, messageSummaryWeight } from '../../providers/chat/contextTokens';
import {
  getAutoCompactThreshold,
  shouldAutoCompactChat,
} from '../../providers/chat/chatCompaction';
import { loadChatModelMessages, type ChatMessage } from '../../providers/chat/initialContext';
import { splitHeadMiddleTail } from '../../providers/chat/splitHeadMiddleTail';
import {
  buildProdChatCompactionScenario,
  PROD_CHAT_COMPACTION_AGENT_ID,
  PROD_CHAT_COMPACTION_CONTINUE,
  PROD_CHAT_COMPACTION_FOLLOW_UP,
} from '../fixtures/chat-compaction-prod-3eb68a5c';
import {
  buildProdChatSubagentLeakScenario,
  PROD_CHAT_SUBAGENT_LEAK_AGENT_ID,
  PROD_CHAT_SUBAGENT_LEAK_FOLLOW_UP,
  PROD_CHAT_SUBAGENT_LEAK_SPAWN_RESULT_MARKER,
} from '../fixtures/chat-subagent-leak-prod-3b5c2813';
import { COMPACTION_SUMMARY_PREFIX } from '../../providers/chat/chatCompactionPrompts';
import {
  testCustomWindowToolCompaction,
  testIgnoredSubagentToolCompaction,
  testFailedToolSummaryContinues,
  testFailedToolSummaryAllowsOrdinaryPass,
  testOversizedRecentToolCompaction,
  testPressureCompactionSavings,
} from './chat-compaction-pressure.cases';
import {
  filterInternalSubagentMessages,
  isInternalSubagentMessage,
} from '../../providers/chat/contextScope';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const contextScopeFixtures = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'shared/context-scope/fixtures.json'), 'utf8')
) as {
  contract_version: number;
  cases: Array<{
    name: string;
    is_internal: boolean;
    message: ChatMessage;
  }>;
};

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
  const messages: ChatMessage[] = [{ role: 'USER', text: 'Original goal', metadata: {} }];
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
  ['custom windows trigger tool compaction', testCustomWindowToolCompaction],
  ['zero-weight subagent tools are not summarized', testIgnoredSubagentToolCompaction],
  ['failed tool summaries preserve other reductions', testFailedToolSummaryContinues],
  ['failed tool summaries allow ordinary compaction', testFailedToolSummaryAllowsOrdinaryPass],
  [
    'pressure-only savings below the guard still compact older history',
    testPressureCompactionSavings,
  ],
  [
    'oversized recent tool results can compact without changing raw history',
    testOversizedRecentToolCompaction,
  ],
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
  [
    'prod agent 3eb68a5c post-completion history exceeds auto-compact trigger',
    () => {
      const messages = buildProdChatCompactionScenario();
      assertEqual(shouldAutoCompactChat(messages), true, 'prod-shaped chat should compact');
      const tokens = estimateContextTokens(messages);
      if (tokens < getAutoCompactThreshold()) {
        throw new Error(
          `prod fixture too small (${tokens} < ${getAutoCompactThreshold()}); shrink cycleCount`
        );
      }
      if (messages.length < 500) {
        throw new Error(`prod fixture should mirror ~586 messages, got ${messages.length}`);
      }
    },
  ],
  [
    'prod agent 3eb68a5c history exceeds OpenRouter 262k context window without compaction',
    () => {
      const messages = buildProdChatCompactionScenario();
      const tokens = estimateContextTokens(messages);
      if (tokens < 262_144) {
        throw new Error(
          `prod fixture should exceed 262k OpenRouter window without compaction (${tokens})`
        );
      }
    },
  ],
  [
    'prod agent 3eb68a5c keeps failed follow-up asks in compaction tail',
    () => {
      const messages = buildProdChatCompactionScenario();
      const split = splitHeadMiddleTail(messages);
      if (!split) throw new Error('expected split for prod-shaped chat');

      const tailTexts = split.tailIndices.map((index) => messages[index].text ?? '');
      if (!tailTexts.some((text) => text.includes(PROD_CHAT_COMPACTION_FOLLOW_UP))) {
        throw new Error('follow-up ask must remain in protected tail');
      }
      if (!tailTexts.some((text) => text === PROD_CHAT_COMPACTION_CONTINUE)) {
        throw new Error('continue follow-up must remain in protected tail');
      }
    },
  ],
  [
    'prod agent 3eb68a5c simulated compaction shrinks metadata-heavy history below trigger',
    () => {
      const messages = buildProdChatCompactionScenario();
      const split = splitHeadMiddleTail(messages);
      if (!split) throw new Error('expected split for prod-shaped chat');

      const summary: ChatMessage = {
        role: 'USER',
        text: `${COMPACTION_SUMMARY_PREFIX} prior hotel research and option comparisons were summarized.`,
        metadata: { compactionSummary: true },
      };
      const compressed = [
        ...split.headIndices.map((index) => messages[index]),
        summary,
        ...split.tailIndices.map((index) => messages[index]),
      ];

      const before = estimateContextTokens(messages);
      const after = estimateContextTokens(compressed);
      if (after >= before) {
        throw new Error(`simulated compaction must shrink context (${before} -> ${after})`);
      }
      if (shouldAutoCompactChat(compressed)) {
        throw new Error(
          `simulated compaction must land below trigger (${after} >= ${getAutoCompactThreshold()})`
        );
      }
    },
  ],
  [
    'loadChatModelMessages invokes compaction for prod-shaped post-completion history',
    async () => {
      const fixture = buildProdChatCompactionScenario();
      let ensureCalls = 0;
      const messages = await loadChatModelMessages(
        {
          agentId: PROD_CHAT_COMPACTION_AGENT_ID,
          requestedModel: 'rose-labs/rose-1-flash',
        },
        {
          findMessages: async () =>
            fixture.map((message) => ({
              role: message.role,
              text: message.text,
              filePointer: message.filePointer ?? null,
              metadata: message.metadata ?? null,
            })),
          ensureWithinBudget: async (params) => {
            ensureCalls += 1;
            if (!shouldAutoCompactChat(projectModelContextAfterCompaction(params.rawMessages))) {
              throw new Error('prod fixture must require compaction before router');
            }
            const split = splitHeadMiddleTail(
              projectModelContextAfterCompaction(params.rawMessages)
            );
            if (!split) throw new Error('expected split for prod-shaped chat');
            return [
              ...split.headIndices.map((index) => params.rawMessages[index]),
              {
                role: 'USER' as const,
                text: `${COMPACTION_SUMMARY_PREFIX} summarized prior research.`,
                metadata: { compactionSummary: true },
              },
              ...split.tailIndices.map((index) => params.rawMessages[index]),
            ];
          },
        }
      );

      assertEqual(ensureCalls, 1, 'compaction hook invoked once');
      assertEqual(shouldAutoCompactChat(messages), false, 'router input must be under trigger');
      assertEqual(
        messages.some((message) => message.text?.includes(PROD_CHAT_COMPACTION_FOLLOW_UP)),
        true,
        'follow-up ask preserved after compaction'
      );
    },
  ],
  [
    'prod agent 3b5c2813 explore subAgentId flood undercounts estimate vs router payload',
    () => {
      const messages = buildProdChatSubagentLeakScenario();
      const estimated = estimateContextTokens(messages);
      assertEqual(
        shouldAutoCompactChat(messages),
        false,
        'estimator skips subAgentId rows so raw history must miss compact trigger'
      );
      if (estimated >= getAutoCompactThreshold()) {
        throw new Error(
          `fixture must undercount like prod (${estimated} >= ${getAutoCompactThreshold()})`
        );
      }

      // Mirror routerLlm.ts: TOOL text is forwarded regardless of subAgentId.
      let routerChars = 0;
      let routerCount = 1;
      for (const message of messages) {
        if (message.role === 'TOOL') {
          if (!message.text?.trim()) continue;
          routerChars += message.text.length;
          routerCount += 1;
        } else if (message.role === 'USER' && message.text) {
          routerChars += message.text.length;
          routerCount += 1;
        } else if (message.role === 'ASSISTANT') {
          routerChars += message.text.length;
          routerCount += 1;
        }
      }
      const routerTokensApprox = Math.floor(routerChars / 4);
      if (routerTokensApprox < 131_000) {
        throw new Error(
          `fixture must exceed Cerebras/OpenRouter 131k when subAgent rows are sent (${routerTokensApprox})`
        );
      }
      if (routerCount < 500) {
        throw new Error(`fixture should flood router like prod (~1866), got ${routerCount}`);
      }
    },
  ],
  [
    'shared/context-scope fixtures agree with isInternalSubagentMessage',
    () => {
      assertEqual(contextScopeFixtures.contract_version, 1, 'contract version');
      if (contextScopeFixtures.cases.length < 6) {
        throw new Error('shared context-scope fixtures missing cases');
      }
      for (const testCase of contextScopeFixtures.cases) {
        assertEqual(
          isInternalSubagentMessage(testCase.message),
          testCase.is_internal,
          testCase.name
        );
      }
      const filtered = filterInternalSubagentMessages(
        contextScopeFixtures.cases.map((testCase) => testCase.message)
      );
      const keptNames = new Set(
        contextScopeFixtures.cases
          .filter((testCase) => filtered.includes(testCase.message))
          .map((testCase) => testCase.name)
      );
      assertEqual(keptNames.has('parent_spawn_finished_result_kept'), true, 'spawn result kept');
      assertEqual(
        keptNames.has('explore_web_fetch_with_subAgentId_dropped'),
        false,
        'explore fetch dropped'
      );
    },
  ],
  [
    'filterInternalSubagentMessages drops explore work streams and keeps parent spawn results',
    () => {
      const messages = buildProdChatSubagentLeakScenario(20, 3);
      const filtered = filterInternalSubagentMessages(messages);
      assertEqual(
        filtered.some((message) => isInternalSubagentMessage(message)),
        false,
        'no internal subagent rows remain'
      );
      assertEqual(
        filtered.some((message) => message.text === PROD_CHAT_SUBAGENT_LEAK_FOLLOW_UP),
        true,
        'follow-up ask preserved'
      );
      assertEqual(
        filtered.some((message) => message.metadata?.toolName === 'completion_summary'),
        true,
        'root completion summary preserved'
      );
      const spawnFinished = filtered.filter(
        (message) =>
          message.metadata?.toolName === 'spawn_agent' &&
          message.metadata?.toolStatus === 'FINISHED' &&
          (message.text?.length ?? 0) > 0
      );
      if (spawnFinished.length < 3) {
        throw new Error(
          `parent spawn FINISHED results must survive filter, got ${spawnFinished.length}`
        );
      }
      assertEqual(
        spawnFinished.every((message) =>
          message.text?.includes(PROD_CHAT_SUBAGENT_LEAK_SPAWN_RESULT_MARKER)
        ),
        true,
        'parent spawn result bodies preserved'
      );
      if (filtered.length >= messages.length) {
        throw new Error(
          `filter must shrink explore flood (${messages.length} -> ${filtered.length})`
        );
      }
      const keptChars = filtered.reduce((total, message) => total + (message.text?.length ?? 0), 0);
      const keptTokens = Math.floor(keptChars / 4);
      if (keptTokens < 5_000) {
        throw new Error(
          `filtered parent context must retain spawn summaries, got ~${keptTokens} tokens`
        );
      }
    },
  ],
  [
    'loadChatModelMessages strips subAgentId flood before budget/router (agent 3b5c2813)',
    async () => {
      const fixture = buildProdChatSubagentLeakScenario();
      let ensureRawCount = -1;
      const messages = await loadChatModelMessages(
        {
          agentId: PROD_CHAT_SUBAGENT_LEAK_AGENT_ID,
          requestedModel: 'rose-labs/rose-1-ultra',
        },
        {
          findMessages: async () =>
            fixture.map((message) => ({
              role: message.role,
              text: message.text,
              filePointer: message.filePointer ?? null,
              metadata: message.metadata ?? null,
            })),
          ensureWithinBudget: async (params) => {
            ensureRawCount = params.rawMessages.length;
            if (params.rawMessages.some((message) => isInternalSubagentMessage(message))) {
              throw new Error('subAgentId explore rows must be stripped before ensureWithinBudget');
            }
            return params.rawMessages;
          },
        }
      );

      if (ensureRawCount < 0) throw new Error('ensureWithinBudget was not invoked');
      // 12 spawn IN_PROGRESS + 12 spawn FINISHED + goal/assistant/completion/follow-up
      if (ensureRawCount > 40) {
        throw new Error(
          `budget path must see parent-scoped history only, got ${ensureRawCount} rows`
        );
      }
      assertEqual(
        messages.some((message) => isInternalSubagentMessage(message)),
        false,
        'router input must not include internal subagent rows'
      );
      assertEqual(
        messages.some((message) => message.text === PROD_CHAT_SUBAGENT_LEAK_FOLLOW_UP),
        true,
        'follow-up ask preserved for chat'
      );
      assertEqual(
        messages.some((message) =>
          message.text?.includes(PROD_CHAT_SUBAGENT_LEAK_SPAWN_RESULT_MARKER)
        ),
        true,
        'parent spawn result bodies reach chat'
      );

      let routerChars = 0;
      for (const message of messages) {
        if (message.role === 'TOOL' && !message.text?.trim()) continue;
        if (message.text) routerChars += message.text.length;
      }
      const routerTokensApprox = Math.floor(routerChars / 4);
      if (routerTokensApprox < 5_000) {
        throw new Error(
          `filtered chat must keep spawn summaries (~tens of k tokens), got ${routerTokensApprox}`
        );
      }
      if (routerTokensApprox >= 131_000) {
        throw new Error(
          `filtered chat must fit Cerebras/OpenRouter 131k window (${routerTokensApprox})`
        );
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
