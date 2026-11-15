/** Cleanup ownership allows exact target close to unblock its own CDP detach. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Browser } from 'playwright';
import { checkpointCaptureOwner } from '../../providers/browser/checkpointCapture';
import { within } from './browser-session-lifecycle.fixture-support';
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function assertDetachAndPageCloseCanDependOnEachOther() {
  const controller = new AbortController();
  const session = new EventEmitter();
  const retired = deferred<void>();
  const detachStarted = deferred<void>();
  const pageClosed = deferred<void>();
  let disconnected = false;
  Object.assign(session, {
    detach: async () => {
      detachStarted.resolve();
      await retired.promise;
    },
  });
  const page = {
    close: async () => {
      session.emit('close');
      retired.resolve();
      pageClosed.resolve();
    },
    isClosed: () => false,
  };
  const browser = {
    close: async () => {
      disconnected = true;
    },
    isConnected: () => !disconnected,
  };
  const capture = checkpointCaptureOwner(browser as unknown as Browser, controller.signal);
  await capture.pages.create(async () => page as unknown as import('playwright').Page);
  await capture.pages.session(async () => session as unknown as import('playwright').CDPSession);
  controller.abort(new Error('fixture dependent detach abort'));
  try {
    await within(detachStarted.promise);
    await within(pageClosed.promise);
    await assert.rejects(within(capture.dispose()), /dependent detach abort/);
    assert.equal(
      disconnected,
      true,
      'transport closes after both dependent cleanup operations settle'
    );
  } finally {
    session.emit('close');
    retired.resolve();
    await capture.dispose().catch(() => {});
  }
}
