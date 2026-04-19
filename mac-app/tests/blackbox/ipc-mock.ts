import { vi } from 'vitest';
import type { IPC } from '../../shared/types/ipc';

/**
 * Installs a mock `window.api` (the preload bridge) for renderer blackbox tests.
 *
 * Pass any subset of IPC methods you need for a test; everything else falls back
 * to a `vi.fn()` that returns `undefined`. Missing-method errors are surfaced
 * loudly so tests can't silently pass when they need an IPC method they forgot
 * to mock.
 */
export function installIpcMock(overrides: Partial<IPC> = {}): IPC {
  // Cache fallback mocks per property so repeated access to `window.api.foo`
  // returns the same `vi.fn()` — otherwise `expect(window.api.foo).toHaveBeenCalled()`
  // would assert against a brand-new spy each access.
  const fallbacks = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const proxy = new Proxy(
    {},
    {
      get(_target, prop: PropertyKey) {
        if (typeof prop === 'string' && prop in overrides) {
          return overrides[prop as keyof IPC];
        }
        let fn = fallbacks.get(prop);
        if (!fn) {
          // Unmocked IPC methods throw loudly so tests can't silently pass when
          // they hit a preload boundary they forgot to stub.
          fn = vi.fn(() => {
            throw new Error(`Unmocked IPC method called: ${String(prop)}`);
          });
          fallbacks.set(prop, fn);
        }
        return fn;
      },
    }
  ) as IPC;

  (globalThis as unknown as { window: Window & typeof globalThis }).window = Object.assign(
    (globalThis as unknown as { window?: Window }).window ?? {},
    { api: proxy }
  ) as Window & typeof globalThis;

  return proxy;
}

export function clearIpcMock(): void {
  const globalWindow = (globalThis as unknown as { window?: { api?: IPC } }).window;
  if (globalWindow && 'api' in globalWindow) {
    delete globalWindow.api;
  }
}
