import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resetClaudeCodeCreateSlotForTests,
  withClaudeCodeCreateSlot,
} from '../../providers/e2bCreateSlot';

test('withClaudeCodeCreateSlot runs creates one at a time', async () => {
  resetClaudeCodeCreateSlotForTests();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withClaudeCodeCreateSlot(async () => {
    events.push('first-enter');
    await firstGate;
    events.push('first-exit');
    return 1;
  });

  // Let the first slot claim the chain before starting the second.
  await Promise.resolve();
  await Promise.resolve();

  const second = withClaudeCodeCreateSlot(async () => {
    events.push('second-enter');
    events.push('second-exit');
    return 2;
  });

  // Second must not enter while first is held.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ['first-enter']);

  releaseFirst();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter', 'second-exit']);
});

test('withClaudeCodeCreateSlot still advances after a failure', async () => {
  resetClaudeCodeCreateSlotForTests();
  await assert.rejects(
    () =>
      withClaudeCodeCreateSlot(async () => {
        throw new Error('boom');
      }),
    /boom/
  );
  assert.equal(await withClaudeCodeCreateSlot(async () => 7), 7);
});
