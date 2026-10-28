/** Real Chromium ownership: disconnect and explicit close must join one complete cleanup. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import type { Browser } from 'playwright';

const local = createRequire(import.meta.url);
const fs: typeof import('node:fs/promises') = local('node:fs/promises');
const cp: typeof import('node:child_process') = local('node:child_process');
const { chromium }: typeof import('playwright') = local('playwright');
const {
  launchLifecycleNative,
  within,
}: typeof import('./browser-session-lifecycle.fixture-support') = local(
  './browser-session-lifecycle.fixture-support'
);

type Mode =
  'normal' | 'concurrent' | 'disconnect-first' | 'cleanup-failure' | 'reentrant-disconnect';
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function checkCleanup(mode: Mode) {
  const original = {
    launch: chromium.launch,
    connect: chromium.connectOverCDP,
    spawn: cp.spawn,
    rm: fs.rm,
  };
  const ownerEntered = barrier();
  const ownerAllowed = barrier();
  const removeEntered = barrier();
  const removeAllowed = barrier();
  const processClosed = barrier();
  const ownerOperations: Promise<unknown>[] = [];
  const removeOperations: Promise<unknown>[] = [];
  const publicOperations: Promise<unknown>[] = [];
  const unhandled: unknown[] = [];
  const cleanupFailure = new Error('owned profile removal failed');
  let profile: string | undefined;
  let child: ChildProcess | undefined;
  let childClosed = false;
  let exitReceipt:
    { pid: number | undefined; code: number | null; signal: NodeJS.Signals | null } | undefined;
  let launched: Browser | undefined;
  let cdp: Browser | undefined;
  let ownerCalls = 0;
  let removeCalls = 0;
  let publicSettled = 0;
  let reentered = false;
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', onUnhandled);
  const trackPublic = (promise: Promise<unknown>) => {
    publicOperations.push(promise);
    void promise.then(
      () => {
        publicSettled++;
      },
      () => {
        publicSettled++;
      }
    );
    return promise;
  };
  try {
    cp.spawn = new Proxy(original.spawn, {
      apply(target, receiver, args) {
        const spawned = Reflect.apply(target, receiver, args) as ChildProcess;
        if (profile && Array.isArray(args[1]) && args[1].includes(`--user-data-dir=${profile}`)) {
          assert.equal(child, undefined, 'one exact native child per owned profile');
          child = spawned;
          child.once('close', (code, signal) => {
            exitReceipt = { pid: spawned.pid, code, signal };
            childClosed = true;
            processClosed.release();
          });
        }
        return spawned;
      },
    });
    chromium.launch = async (...args) => {
      profile = args[0]?.args
        ?.find((arg) => arg.startsWith('--user-data-dir='))
        ?.slice('--user-data-dir='.length);
      assert(profile, 'actual helper must declare its owned profile');
      launched = await original.launch.apply(chromium, args);
      assert(child?.pid, 'capture exact Chromium child at spawn, without scanning other processes');
      return new Proxy(launched, {
        get(target, key) {
          if (key === 'close')
            return (...closeArgs: Parameters<Browser['close']>) => {
              ownerCalls++;
              ownerEntered.release();
              if (mode === 'reentrant-disconnect' && !reentered) {
                reentered = true;
                // EventEmitter notifications are synchronous. Reenter before cleanup I/O returns.
                cdp!.emit('disconnected', cdp!);
              }
              const closing = (async () => {
                await ownerAllowed.promise;
                await target.close(...closeArgs);
              })();
              ownerOperations.push(closing);
              void closing.catch(() => {});
              return closing;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    chromium.connectOverCDP = async (...args) => {
      cdp = await original.connect.apply(chromium, args);
      return cdp;
    };
    fs.rm = (...args) => {
      if (String(args[0]) !== profile) return original.rm(...args);
      removeCalls++;
      const removing = (async () => {
        removeEntered.release();
        assert(childClosed, 'owned profile removal must follow exact native child close receipt');
        await removeAllowed.promise;
        if (mode === 'cleanup-failure') throw cleanupFailure;
        await original.rm(...args);
      })();
      removeOperations.push(removing);
      void removing.catch(() => {});
      return removing;
    };

    const owned = await launchLifecycleNative();
    if (mode === 'disconnect-first') {
      await cdp!.close();
      await within(ownerEntered.promise);
    }
    trackPublic(owned.browser.close());
    if (mode === 'concurrent') trackPublic(owned.browser.close());
    await within(ownerEntered.promise);
    assert.equal(publicSettled, 0, 'public close must join native retirement');
    ownerAllowed.release();
    await within(removeEntered.promise);
    assert(childClosed, 'removal may not race native exit');
    assert.equal(removeCalls, 1, 'disconnect and close must share one profile removal');
    assert.equal(ownerCalls, 1, 'disconnect and close must share one native retirement');
    assert.equal(publicSettled, 0, 'public close must join profile removal');
    removeAllowed.release();
    const results = await within(Promise.allSettled(publicOperations));
    if (mode === 'cleanup-failure') {
      for (const result of results) {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') assert.equal(result.reason, cleanupFailure);
      }
      await assert.rejects(owned.browser.close(), (error) => error === cleanupFailure);
    } else {
      for (const result of results) assert.equal(result.status, 'fulfilled');
      await owned.browser.close();
    }
    await nextTurn();
    assert.equal(ownerCalls, 1, 'settled cleanup is retained for repeated close');
    assert.equal(removeCalls, 1, 'repeated close must not remove the profile again');
    assert.deepEqual(unhandled, [], 'event-triggered cleanup rejection must be observed');
    if (mode !== 'cleanup-failure') {
      await assert.rejects(fs.stat(profile!), { code: 'ENOENT' });
    }
    console.log(
      `PASS native cleanup ${mode}: ${JSON.stringify({ exitReceipt, ownerCalls, removeCalls })}`
    );
  } finally {
    try {
      ownerAllowed.release();
      removeAllowed.release();
      await within(Promise.allSettled(publicOperations));
      await within(Promise.allSettled(ownerOperations));
      await nextTurn();
      await within(Promise.allSettled(removeOperations));
      if (launched && !childClosed) await launched.close();
      if (child) await within(processClosed.promise);
      // Delete only the profile allocated by this invocation, after its captured child retired.
      if (profile && childClosed) await original.rm(profile, { recursive: true, force: true });
    } finally {
      chromium.launch = original.launch;
      chromium.connectOverCDP = original.connect;
      cp.spawn = original.spawn;
      fs.rm = original.rm;
      await nextTurn();
      process.removeListener('unhandledRejection', onUnhandled);
    }
  }
}

(async () => {
  for (const mode of [
    'normal',
    'concurrent',
    'disconnect-first',
    'cleanup-failure',
    'reentrant-disconnect',
  ] as const) {
    await checkCleanup(mode);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
