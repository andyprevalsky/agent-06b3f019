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

  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const first = withClaudeCodeCreateSlot(async () => {
    events.push('first-enter');
    firstEntered();
    await firstGate;
    events.push('first-exit');
    return 1;
  });

  // The slot is a cross-instance lock (a DB lease), so wait for the real entry.
  await entered;

  const second = withClaudeCodeCreateSlot(async () => {
    events.push('second-enter');
    events.push('second-exit');
    return 2;
  });

  // Second must not enter while first is held.
  await new Promise((resolve) => setTimeout(resolve, 300));
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
