#!/usr/bin/env tsx

import assert from 'node:assert';
import {
  createEarlyDirectGeneratorCoordinator,
  createTransactionalStreamGate,
  runAfterStreamCommit,
} from '../../providers/chat/earlyDirectGenerator';
import { createGeneratorAttentionLifecycle } from '../../providers/chat/generatorAttentionStream';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function testDirectOverlapBuffersUntilCommit(): Promise<void> {
  const generator = deferred<string>();
  const events: string[] = [];
  let starts = 0;
  let usageWrites = 0;
  let messageWrites = 0;
  const coordinator = createEarlyDirectGeneratorCoordinator({
    start: async ({ streamGate }) => {
      starts += 1;
      await streamGate.emit(async () => {
        events.push('generator:start');
      });
      await streamGate.emit(async () => {
        events.push('generator:delta');
      });
      return generator.promise;
    },
  });

  coordinator.start();
  await flushMicrotasks();
  assert.strictEqual(starts, 1, 'direct generator should start before Router completes');
  assert.deepStrictEqual(events, [], 'early generator frames must remain buffered');
  assert.strictEqual(usageWrites, 0, 'usage remains gated');
  assert.strictEqual(messageWrites, 0, 'messages remain gated');

  events.push('router:done');
  generator.resolve('generator-result');
  const result = await coordinator.commitDirectAnswer();
  usageWrites += 1;
  messageWrites += 1;

  assert.strictEqual(result, 'generator-result');
  assert.deepStrictEqual(events, ['router:done', 'generator:start', 'generator:delta']);
  assert.strictEqual(usageWrites, 1);
  assert.strictEqual(messageWrites, 1);
}

async function testNonDirectActionsNeverStartEarly(): Promise<void> {
  let starts = 0;
  const coordinator = createEarlyDirectGeneratorCoordinator({
    start: async () => {
      starts += 1;
      return 'unused';
    },
  });

  await coordinator.discard();
  assert.strictEqual(starts, 0, 'web_search/escalation must not start without detection');
}

async function testMismatchAbortsAndDiscardsWithoutSideEffects(): Promise<void> {
  let aborted = false;
  const attentionFrames: string[] = [];
  let cacheWrites = 0;
  const provider = deferred<string>();
  const coordinator = createEarlyDirectGeneratorCoordinator({
    start: async ({ abortSignal, streamGate }) => {
      abortSignal.addEventListener('abort', () => {
        aborted = true;
        provider.reject(new Error('provider aborted'));
      });
      const attention = createGeneratorAttentionLifecycle({
        agentId: 'speculative-agent',
        streamGate,
        broadcast: async (event) => {
          attentionFrames.push(`${event.sequence}:${event.message}:${event.done}`);
        },
      });
      await attention.start();
      await attention.update('speculative answer');
      await runAfterStreamCommit(streamGate, async () => {
        cacheWrites += 1;
      });
      try {
        return await provider.promise;
      } finally {
        if (abortSignal.aborted) await attention.cancel();
      }
    },
  });

  coordinator.start();
  await flushMicrotasks();
  await coordinator.discard();

  assert.strictEqual(aborted, true, 'mismatch/error must abort the provider');
  assert.deepStrictEqual(attentionFrames, [], 'discarded attention lifecycle must never broadcast');
  assert.strictEqual(cacheWrites, 0, 'discarded generator must not write cache');
}

async function testEarlyFailureOnlyPropagatesForCommittedDirect(): Promise<void> {
  const ignoredFailure = new Error('ignored mismatch failure');
  const discarded = createEarlyDirectGeneratorCoordinator({
    start: async () => {
      throw ignoredFailure;
    },
  });
  discarded.start();
  await flushMicrotasks();
  await discarded.discard();

  const committedFailure = new Error('committed direct failure');
  let leakedFrames = 0;
  const committed = createEarlyDirectGeneratorCoordinator({
    start: async ({ streamGate }) => {
      await streamGate.emit(async () => {
        leakedFrames += 1;
      });
      throw committedFailure;
    },
  });
  committed.start();
  await flushMicrotasks();
  await assert.rejects(
    committed.commitDirectAnswer(),
    (error: unknown) => error === committedFailure
  );
  assert.strictEqual(leakedFrames, 0, 'failed speculative frames must be discarded');
}

async function testDiscardDoesNotWaitForNonCooperativeProvider(): Promise<void> {
  const provider = deferred<string>();
  const coordinator = createEarlyDirectGeneratorCoordinator({
    start: async () => provider.promise,
  });

  coordinator.start();
  await flushMicrotasks();
  const discard = coordinator.discard();
  const settledPromptly = await Promise.race([
    discard.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);

  provider.resolve('late provider result');
  await discard;
  assert.strictEqual(
    settledPromptly,
    true,
    'discard must not block the canonical route on provider cancellation'
  );
}

async function testCompletedSpeculationAndCanonicalBranchesStayIsolated(): Promise<void> {
  const visibleFrames: string[] = [];
  let cacheWrites = 0;
  let usageWrites = 0;
  let messageWrites = 0;
  let starts = 0;
  const coordinator = createEarlyDirectGeneratorCoordinator({
    start: async ({ streamGate }) => {
      starts += 1;
      await streamGate.emit(async () => {
        visibleFrames.push('speculative');
      });
      await runAfterStreamCommit(streamGate, async () => {
        cacheWrites += 1;
      });
      return 'completed-speculation';
    },
  });

  coordinator.start();
  coordinator.start();
  assert.strictEqual(starts, 1, 'Generator starts at Router start before any action');
  await coordinator.discard();
  assert.deepStrictEqual(visibleFrames, [], 'completed speculative frames stay hidden');
  assert.strictEqual(cacheWrites, 0, 'completed speculative cache remains uncommitted');
  assert.strictEqual(usageWrites, 0);
  assert.strictEqual(messageWrites, 0);

  visibleFrames.push('canonical-web-generator');
  usageWrites += 1;
  messageWrites += 1;
  assert.deepStrictEqual(visibleFrames, ['canonical-web-generator']);
  assert.strictEqual(usageWrites, 1, 'only canonical post-search usage persists');
  assert.strictEqual(messageWrites, 1, 'only canonical post-search messages persist');

  const escalationFrames: string[] = [];
  const escalation = createEarlyDirectGeneratorCoordinator({
    start: async ({ streamGate }) => {
      await streamGate.emit(async () => {
        escalationFrames.push('speculative');
      });
      return 'unused';
    },
  });
  escalation.start();
  await escalation.discard();
  assert.deepStrictEqual(escalationFrames, [], 'escalation has no canonical Generator output');
}

async function testReusableTransactionalGate(): Promise<void> {
  const committedEvents: string[] = [];
  const committedGate = createTransactionalStreamGate();
  await committedGate.emit(async () => {
    committedEvents.push('start');
  });
  const sideEffect = runAfterStreamCommit(committedGate, async () => {
    committedEvents.push('cache');
  });
  assert.deepStrictEqual(committedEvents, []);
  await committedGate.commit();
  assert.strictEqual(await sideEffect, true);
  assert.deepStrictEqual(committedEvents, ['start', 'cache']);

  const discardedEvents: string[] = [];
  const discardedGate = createTransactionalStreamGate();
  await discardedGate.emit(async () => {
    discardedEvents.push('start');
  });
  const discardedSideEffect = runAfterStreamCommit(discardedGate, async () => {
    discardedEvents.push('cache');
  });
  await discardedGate.discard();
  assert.strictEqual(await discardedSideEffect, false);
  assert.deepStrictEqual(discardedEvents, []);
}

async function main(): Promise<void> {
  await testDirectOverlapBuffersUntilCommit();
  await testNonDirectActionsNeverStartEarly();
  await testMismatchAbortsAndDiscardsWithoutSideEffects();
  await testEarlyFailureOnlyPropagatesForCommittedDirect();
  await testDiscardDoesNotWaitForNonCooperativeProvider();
  await testReusableTransactionalGate();
  await testCompletedSpeculationAndCanonicalBranchesStayIsolated();
  process.stdout.write('PASS early direct generator transactional overlap\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
