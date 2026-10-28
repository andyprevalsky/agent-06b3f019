/** Permanent real-child controls, called by the normal browser-session E2E case. */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  OwnedTestChild,
  TestChildProcesses,
  runOwnedTestChild,
  withTestDeadline,
} from './browser-session-e2e-process.support';

const stubborn =
  "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";

export async function runBrowserE2EProcessCases(): Promise<void> {
  const owner = new TestChildProcesses();
  try {
    const child = owner.spawn(process.execPath, ['-e', stubborn]);
    await withTestDeadline(once(child.child.stdout!, 'data'), 3000, 'Child readiness');
    // Reproduce the old timer: SIGTERM alone never settles this child's exit.
    child.child.kill('SIGTERM');
    await assert.rejects(
      withTestDeadline(once(child.child, 'exit'), 100, 'Legacy SIGTERM-only wait'),
      /Legacy SIGTERM-only wait timed out/
    );
    assert.equal(child.exited, false);
    const exit = await child.stop({ gracefulMs: 50, killMs: 1000 });
    assert.equal(exit.signal, 'SIGKILL');
    assert.ok(child.exited);
    assert.equal(await child.stop(), exit, 'Repeated cleanup must reuse terminal receipt');

    let failedConnectionChild: OwnedTestChild | undefined;
    await assert.rejects(
      owner.acquire(process.execPath, ['-e', stubborn], {}, async (owned) => {
        failedConnectionChild = owned;
        await withTestDeadline(
          once(owned.child.stdout!, 'data'),
          3000,
          'Connect fixture readiness'
        );
        throw new Error('fixture CDP connection failed');
      }),
      /fixture CDP connection failed/
    );
    assert.ok(failedConnectionChild?.exited, 'Failed connect must reap its registered child');

    await assert.rejects(
      runOwnedTestChild(process.execPath, ['-e', stubborn], {
        timeoutMs: 200,
        stopOptions: { gracefulMs: 50, killMs: 1000 },
      }),
      /timed out after 200ms/
    );

    // No OS process can ignore SIGKILL. Model missing exit acknowledgement to
    // prove the final deadline rejects instead of leaving a promise pending.
    const silent = new EventEmitter() as ChildProcess;
    Object.defineProperty(silent, 'pid', { value: 424242 });
    const signals: string[] = [];
    silent.kill = (signal) => {
      signals.push(String(signal));
      return true;
    };
    await assert.rejects(
      new OwnedTestChild(silent).stop({ gracefulMs: 10, killMs: 10 }),
      /did not report exit/
    );
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    for (const pid of [0, 1]) {
      const unsafe = new EventEmitter() as ChildProcess;
      Object.defineProperty(unsafe, 'pid', { value: pid });
      unsafe.kill = () => {
        throw new Error('Unsafe PID was signalled');
      };
      await assert.rejects(new OwnedTestChild(unsafe).stop(), /Refusing unsafe child PID/);
    }
  } finally {
    await owner.stopAll();
  }
  console.log(
    'PASS exact-child cleanup: legacy timeout reproduced; SIGTERM resistance, failed connect, run timeout, missing exit receipt, unsafe PID rejection'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runBrowserE2EProcessCases().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
