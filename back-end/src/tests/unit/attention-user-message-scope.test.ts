import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { Message, Prisma } from '@prisma/client';

async function main(): Promise<void> {
  await mock.module('../../providers/database', { namedExports: { prisma: {} } });
  const written: Array<{ agentId: string; text: string; metadata: Record<string, unknown> }> = [];
  const events: string[] = [];
  await mock.module('../../providers/messages', {
    namedExports: {
      createUserMessageInTransaction: async (_tx: unknown, data: (typeof written)[number]) => {
        events.push('write');
        written.push(data);
        return { ...data, role: 'USER', id: 'authored' } as unknown as Message;
      },
      broadcastCreatedMessage: () => {
        throw new Error('broadcast before commit');
      },
    },
  });
  const { persistAttentionUserMessages } = await import('../../providers/attentionUserMessages');
  const text = '  Keep only venue_prices\nExact bytes: 🦋  ';
  const cases = [
    [
      { browserTaskId: 'native-task', authAssistance: { browserSessionId: 'other' } },
      'native-task',
    ],
    [
      {
        authAssistance: {
          browserSessionId: 'native-auth-task',
          steelSessionId: 'provider-session',
        },
      },
      'native-auth-task',
    ],
    [
      { requestUserAuthentication: { browserSessionId: 'native-legacy-task' } },
      'native-legacy-task',
    ],
    [{ gate: { kind: 'payment' } }, undefined],
    [{ authAssistance: { steelSessionId: 'provider-session-only' } }, undefined],
    [
      { browserTaskId: '', authAssistance: { browserSessionId: 'native-fallback' } },
      'native-fallback',
    ],
  ] as const;
  for (const [metadata, expected] of cases) {
    written.length = 0;
    events.length = 0;
    const tx = {
      $queryRaw: async () => {
        events.push('lock');
        return [
          {
            userId: 'owner',
            agentId: 'parent',
            workflowId: 'parent',
            metadata,
          },
        ];
      },
      agent: {
        findMany: async () => {
          events.push('ownership');
          return [
            {
              id: 'parent',
              userId: 'owner',
              temporalWorkflowId: 'parent',
              staleTemporalWorkflowId: null,
            },
          ];
        },
      },
      message: { findFirst: async () => null },
    } as unknown as Prisma.TransactionClient;
    const result = await persistAttentionUserMessages(tx, {
      requestId: 'request',
      agentId: 'parent',
      userMessage: text,
    });
    assert.equal(result.userMessage, text);
    assert.equal(written[0].text, text);
    assert.deepEqual(
      written[0].metadata,
      {
        source: 'attention_response',
        attentionRequestId: 'request',
        ...(expected === undefined ? {} : { browserTaskId: expected }),
      },
      'scope must come from the actual locked request, using the native task id'
    );
    assert.deepEqual(events, ['lock', 'ownership', 'ownership', 'write']);
  }
  process.stdout.write('PASS locked attention request browser scope and authored bytes\n');
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
