#!/usr/bin/env tsx

import assert from 'node:assert';
import {
  startInitialChatContext,
  type ChatDatabaseMessage,
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
  const context = startInitialChatContext(
    { agentId: 'agent-1', requestedModel: 'rose-labs/rose-1-flash' },
    dependencies
  );

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
    { agentId: 'agent-2', requestedModel: 'rose-labs/rose-1-flash' },
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
    { agentId: 'agent-3', requestedModel: 'rose-labs/rose-1-flash' },
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

  const webContext = startInitialChatContext(
    { agentId: 'web-agent', requestedModel: 'rose-labs/rose-1-flash' },
    dependencies
  );
  await webContext.messages;

  const escalationContext = startInitialChatContext(
    { agentId: 'escalation-agent', requestedModel: 'rose-labs/rose-1-flash' },
    dependencies
  );
  await escalationContext.messages;
  assert.strictEqual(credentialCalls, 0, 'web and escalation chat paths read no credentials');
}

async function main(): Promise<void> {
  await testMessagesIgnorePendingComputeAuth();
  await testPreservesMessageOrderAndMapping();
  await testMessageQueryFailurePropagates();
  await testWebAndEscalationNeverReadChatCredentials();
  process.stdout.write('PASS pending credential loaders cannot gate chat messages\n');
  process.stdout.write('PASS chat initial context preserves DB order and message mapping\n');
  process.stdout.write('PASS chat initial context propagates message-query failures\n');
  process.stdout.write('PASS web and escalation chat paths read zero credentials\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
