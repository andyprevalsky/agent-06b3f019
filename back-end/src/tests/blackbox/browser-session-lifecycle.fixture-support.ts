import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
export async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider lifecycle fixture timed out')), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export function spawnLifecycleWorker(
  taskId: string,
  provider: string,
  origin: string,
  joined?: () => void
) {
  const child = fork(
    fileURLToPath(new URL('./browser-session-provider-lifecycle.worker.ts', import.meta.url)),
    [taskId, provider, origin],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  let output = '';
  child.stdout?.on('data', (b) => {
    output += b;
  });
  child.stderr?.on('data', (b) => {
    output += b;
  });
  const result = new Promise<string>((resolve, reject) => {
    let done = false;
    child.on(
      'message',
      (message: { type?: string; ok?: boolean; sessionId?: string; error?: string }) => {
        if (message.type === 'joined') joined?.();
        if (message.type === 'result') {
          done = true;
          if (message.ok) resolve(message.sessionId!);
          else reject(new Error(message.error));
        }
      }
    );
    child.on('error', reject);
    child.on('close', (code) => {
      if (!done) reject(new Error(`worker exit ${code}: ${output}`));
    });
  });
  void result.catch(() => {});
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  return { result, closed, child };
}
export async function registerLifecycleServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/worker.js');
    await navigator.serviceWorker.ready;
    await new Promise<void>((resolve) => {
      const watcher = {
        worker: null as ServiceWorker | null,
        observe() {
          const current = navigator.serviceWorker.controller;
          if (current !== watcher.worker) {
            watcher.worker?.removeEventListener('statechange', watcher.observe);
            watcher.worker = current;
            watcher.worker?.addEventListener('statechange', watcher.observe);
          }
          if (current !== registration.active || current?.state !== 'activated') return;
          watcher.worker?.removeEventListener('statechange', watcher.observe);
          navigator.serviceWorker.removeEventListener('controllerchange', watcher.observe);
          resolve();
        },
      };
      navigator.serviceWorker.addEventListener('controllerchange', watcher.observe);
      watcher.observe();
    });
  });
}

export async function launchLifecycleNative() {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  // Exercise native storage partitioning; Playwright's default launch flags
  // disable it and would mask third-party origin checkpoint omissions.
  const profile = await mkdtemp(join(tmpdir(), 'logical-browser-native-'));
  let browser: Browser;
  try {
    browser = await chromium.launch({
      ignoreDefaultArgs: true,
      args: [
        '--headless',
        '--no-sandbox',
        '--remote-debugging-pipe',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
        '--disable-popup-blocking',
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${address.port}`,
        '--site-per-process',
      ],
    });
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
  let ownedClose: Promise<void> | undefined;
  const closeOwned = () =>
    (ownedClose ??= Promise.resolve().then(async () => {
      // Store the shared promise before close can notify another disconnect listener.
      try {
        await browser.close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }));
  // CDP attaches to the default context, as the production providers do.
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    const native = await chromium.connectOverCDP(endpoint);
    native.on('disconnected', () => {
      // Explicit close joins the retained promise and receives any cleanup failure.
      void closeOwned().catch(() => {});
    });
    return {
      browser: new Proxy(native, {
        get(target, key) {
          if (key === 'close')
            return async () => {
              await target.close();
              await closeOwned();
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
      endpoint,
    };
  } catch (error) {
    await closeOwned();
    throw error;
  }
}

export const lifecycleTransport = (browser: Browser, failHydration: () => boolean) => ({
  contexts: () =>
    browser.contexts().map(
      (context) =>
        new Proxy(context, {
          get(target, key) {
            if (key === 'setStorageState' && failHydration())
              return async () => {
                throw new Error('fixture hydration failed');
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
    ),
  close: async () => {},
});

export async function allocateLifecycleNative(
  natives: Map<string, Browser>,
  nativeEndpoints: Map<string, string>
) {
  const { browser: native, endpoint } = await launchLifecycleNative();
  const id = `native-${randomUUID()}`;
  natives.set(id, native);
  nativeEndpoints.set(id, endpoint);
  return { id, browser: native };
}

export function lifecycleNativeHealth(
  provider: string,
  sessionId: string,
  unknown: boolean,
  live: boolean,
  ttlMs: number
) {
  return {
    provider,
    sessionId,
    status: unknown ? null : live ? 'live' : provider === 'kernel' ? 'deleted' : 'released',
    ttlMs,
    createdAt: null,
    expiresAt: null,
    timeoutMs: 1800000,
    profileId: null,
  };
}
