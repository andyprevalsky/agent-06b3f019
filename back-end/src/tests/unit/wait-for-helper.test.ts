#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { FakeClock, WaitTimeoutError, waitFor } from '../helpers/waitFor';

async function main(): Promise<void> {
  // Resolves with the first value that is not undefined/null/false; backoff doubles.
  {
    const clock = new FakeClock();
    const values: Array<string | null | undefined | false> = [undefined, null, false, 'ready'];
    const result = await waitFor('ready', () => values.shift(), { timeoutMs: 5_000, clock });
    assert.equal(result, 'ready');
    assert.deepEqual(clock.sleeps, [10, 20, 40]);
  }

  // 0 and '' are real values, not "pending".
  {
    const clock = new FakeClock();
    assert.equal(await waitFor('zero', () => 0, { clock }), 0);
  }

  // Timeout carries the last observed value; backoff is capped; the final
  // sleep ends exactly at the deadline, and the probe runs once more there.
  {
    const clock = new FakeClock();
    const start = clock.now();
    let checks = 0;
    await assert.rejects(
      waitFor(
        'never',
        () => {
          checks += 1;
          return false;
        },
        { timeoutMs: 2_000, clock }
      ),
      (error: unknown) => {
        assert.ok(error instanceof WaitTimeoutError);
        assert.equal(error.lastValue, false);
        assert.equal(error.attempts, checks);
        assert.match(error.message, /Timed out after 2000ms waiting for never .*last value false/);
        return true;
      }
    );
    assert.equal(Math.max(...clock.sleeps), 250);
    assert.equal(clock.now() - start, 2_000);
  }

  {
    const clock = new FakeClock();
    const start = clock.now();
    const late = await waitFor('deadline', () => clock.now() - start >= 1_000 && 'late', {
      timeoutMs: 1_000,
      clock,
    });
    assert.equal(late, 'late');
  }

  // Ignored errors mean "not ready" and are reported; other errors reject at once.
  {
    const clock = new FakeClock();
    const notReady = () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.rejects(
      waitFor('server', notReady, { timeoutMs: 100, clock, ignoreError: () => true }),
      /last error Error: ECONNREFUSED/
    );
    await assert.rejects(
      waitFor('server', notReady, { timeoutMs: 100, clock }),
      /^Error: ECONNREFUSED$/
    );
  }

  // A number as the third argument is timeoutMs (the phone-hold call shape).
  {
    const clock = new FakeClock();
    await assert.rejects(
      waitFor('n', () => null, { timeoutMs: 30, clock }),
      /after 30ms/
    );
    await assert.rejects(
      waitFor('n', async () => undefined, 0),
      /after 0ms .*1 checks/
    );
  }

  // Real clock: waits for a condition another task makes true.
  {
    let flag = false;
    setImmediate(() => {
      flag = true;
    });
    assert.equal(await waitFor('flag set', () => flag, 60_000), true);
  }

  assert.throws(() => new FakeClock().advance(-1), /cannot move backwards/);
  process.stdout.write('wait-for-helper: all assertions passed\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
