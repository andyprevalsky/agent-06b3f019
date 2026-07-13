#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createGeneratorAttentionLifecycle } from '../../providers/chat/generatorAttentionStream';
import { createTransactionalStreamGate } from '../../providers/chat/earlyDirectGenerator';

interface Event {
  streamId: string;
  toolCallId: string;
  message: string;
  done: boolean;
  sequence: number;
}

async function testCommittedLifecycle(): Promise<void> {
  const events: Event[] = [];
  const gate = createTransactionalStreamGate();
  const lifecycle = createGeneratorAttentionLifecycle({
    agentId: 'agent-1',
    streamGate: gate,
    broadcast: async (event) => events.push(event),
  });

  const stableId = lifecycle.toolCallId;
  await lifecycle.start();
  await lifecycle.update('Hel');
  await lifecycle.update('Hello');
  await lifecycle.update('Hell');
  assert.deepEqual(events, [], 'precommit attention frames remain hidden');

  await gate.commit();
  await lifecycle.complete('Hello!');
  assert.equal(lifecycle.toolCallId, stableId);
  assert.deepEqual(
    events.map(({ toolCallId, message, done, sequence }) => ({
      toolCallId,
      message,
      done,
      sequence,
    })),
    [
      { toolCallId: stableId, message: '', done: false, sequence: 0 },
      { toolCallId: stableId, message: 'Hel', done: false, sequence: 1 },
      { toolCallId: stableId, message: 'Hello', done: false, sequence: 2 },
      { toolCallId: stableId, message: 'Hello!', done: true, sequence: 3 },
    ]
  );
}

async function testDiscardAndCancellation(): Promise<void> {
  const discardedEvents: Event[] = [];
  const discardedGate = createTransactionalStreamGate();
  const discarded = createGeneratorAttentionLifecycle({
    agentId: 'agent-discarded',
    streamGate: discardedGate,
    broadcast: async (event) => discardedEvents.push(event),
  });
  await discarded.start();
  await discarded.update('must not leak');
  await discarded.cancel();
  await discardedGate.discard();
  assert.deepEqual(discardedEvents, []);

  const cancelledEvents: Event[] = [];
  const committedGate = createTransactionalStreamGate();
  const cancelled = createGeneratorAttentionLifecycle({
    agentId: 'agent-cancelled',
    streamGate: committedGate,
    broadcast: async (event) => cancelledEvents.push(event),
  });
  await cancelled.start();
  await cancelled.update('partial answer');
  await committedGate.commit();
  await cancelled.cancel();
  assert.deepEqual(cancelledEvents.at(-1), {
    streamId: cancelled.streamId,
    toolCallId: cancelled.toolCallId,
    message: '',
    done: true,
    sequence: 2,
  });
}

async function main(): Promise<void> {
  await testCommittedLifecycle();
  await testDiscardAndCancellation();
  process.stdout.write('PASS Generator attention stream lifecycle\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
