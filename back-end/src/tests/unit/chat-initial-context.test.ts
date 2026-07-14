#!/usr/bin/env tsx

import assert from 'node:assert';
import {
  resolveGeneratorMessages,
  startInitialChatContext,
  type ChatDatabaseMessage,
  type ChatMessage,
} from '../../providers/chat/initialContext';

async function testMessagesIgnorePendingComputeAuth(): Promise<void> {
  const pendingCredential = new Promise<never>(() => undefined);
  const starts: string[] = [];
  let credentialCalls = 0;

  const dependencies = {
    fetchComputeAuth: async (userId: string) => {
      credentialCalls += 1;
      starts.push(`auth:${userId}`);
      return pendingCredential;
    },
    findMessages: async (agentId: string) => {
      starts.push(`messages:${agentId}`);
      return [];
    },
  };
  const context = startInitialChatContext({ agentId: 'agent-1' }, dependencies);

  assert.strictEqual(credentialCalls, 0, 'chat startup must not read compute credentials');
  assert.deepStrictEqual(starts, ['messages:agent-1']);
  assert.deepStrictEqual(await context.messages, []);
}

async function testPreservesMessageOrderAndMapping(): Promise<void> {
  const dbMessages: ChatDatabaseMessage[] = [
    {
      role: 'USER',
      text: 'first',
      filePointer: { path: '/first.txt' },
      metadata: { sequence: 1 },
    },
    {
      role: 'TOOL',
      text: 'second',
      filePointer: null,
      metadata: { sequence: 2 },
    },
  ];

  const context = startInitialChatContext(
    { agentId: 'agent-2' },
    {
      findMessages: async () => dbMessages,
    }
  );

  assert.deepStrictEqual(await context.messages, [
    {
      role: 'USER',
      text: 'first',
      filePointer: { path: '/first.txt' },
      metadata: { sequence: 1 },
    },
    {
      role: 'TOOL',
      text: 'second',
      filePointer: null,
      metadata: { sequence: 2 },
    },
  ]);
}

async function testMessageQueryFailurePropagates(): Promise<void> {
  const expected = new Error('message query failed');
  const context = startInitialChatContext(
    { agentId: 'agent-3' },
    {
      findMessages: async () => {
        throw expected;
      },
    }
  );

  await assert.rejects(context.messages, (error: unknown) => error === expected);
}

async function testWebAndEscalationNeverReadChatCredentials(): Promise<void> {
  let credentialCalls = 0;
  const dependencies = {
    fetchComputeAuth: async () => {
      credentialCalls += 1;
      throw new Error('chat credential loader must remain unreachable');
    },
    findMessages: async () => [],
  };

  const webContext = startInitialChatContext({ agentId: 'web-agent' }, dependencies);
  const webMessages = await webContext.messages;
  await resolveGeneratorMessages({
    action: 'web_search',
    initialMessages: webMessages,
    refreshMessages: async () => webMessages,
  });

  const escalationContext = startInitialChatContext({ agentId: 'escalation-agent' }, dependencies);
  await escalationContext.messages;
  assert.strictEqual(credentialCalls, 0, 'web and escalation chat paths read no credentials');
}

async function testDirectAnswerReusesExactInitialMessages(): Promise<void> {
  const initialMessages: ChatMessage[] = [
    {
      role: 'USER',
      text: 'initial message',
      filePointer: { storage_path: 'initial/file.txt' },
      metadata: { source: 'initial', nested: { retained: true } },
    },
  ];
  let refreshCalls = 0;

  const resolved = await resolveGeneratorMessages({
    action: 'direct_answer',
    initialMessages,
    refreshMessages: async () => {
      refreshCalls += 1;
      return [];
    },
  });

  assert.strictEqual(resolved, initialMessages, 'direct_answer should reuse the exact array');
  assert.strictEqual(refreshCalls, 0, 'direct_answer must not refresh messages');
  assert.deepStrictEqual(
    resolved[0],
    initialMessages[0],
    'full initial message shape is preserved'
  );
}

async function testMessageWritingAndFutureActionsRefreshMessages(): Promise<void> {
  const initialMessages: ChatMessage[] = [{ role: 'USER', text: 'stale' }];
  const refreshedMessages: ChatMessage[] = [
    {
      role: 'TOOL',
      text: 'fresh tool result',
      filePointer: { storage_path: 'fresh/result.json' },
      metadata: { toolName: 'web_search', sources: ['source-a'] },
    },
  ];
  let refreshCalls = 0;
  const refreshMessages = async (): Promise<ChatMessage[]> => {
    refreshCalls += 1;
    return refreshedMessages;
  };

  const webSearch = await resolveGeneratorMessages({
    action: 'web_search',
    initialMessages,
    refreshMessages,
  });
  assert.strictEqual(webSearch, refreshedMessages, 'web_search should use the refreshed array');
  assert.strictEqual(refreshCalls, 1, 'web_search refresh count');
  assert.deepStrictEqual(webSearch[0], refreshedMessages[0], 'full refreshed shape is preserved');

  const futureAction = await resolveGeneratorMessages({
    action: 'future_message_writing_action',
    initialMessages,
    refreshMessages,
  });
  assert.strictEqual(futureAction, refreshedMessages, 'unknown actions should default to refresh');
  assert.strictEqual(refreshCalls, 2, 'unknown action refresh count');
}

async function main(): Promise<void> {
  await testMessagesIgnorePendingComputeAuth();
  await testPreservesMessageOrderAndMapping();
  await testMessageQueryFailurePropagates();
  await testWebAndEscalationNeverReadChatCredentials();
  await testDirectAnswerReusesExactInitialMessages();
  await testMessageWritingAndFutureActionsRefreshMessages();
  process.stdout.write('PASS pending credential loaders cannot gate chat messages\n');
  process.stdout.write('PASS chat initial context preserves DB order and message mapping\n');
  process.stdout.write('PASS chat initial context propagates message-query failures\n');
  process.stdout.write('PASS web and escalation chat paths read zero credentials\n');
  process.stdout.write(
    'PASS direct answers reuse the exact initial message array without refresh\n'
  );
  process.stdout.write('PASS message-writing and future actions refresh full message shapes\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
