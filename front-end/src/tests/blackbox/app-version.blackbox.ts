/**
 * Stale-build auto refresh (lib/appVersion.ts + the vite `rose-build-version`
 * plugin + vercel.json caching). An installed iPhone PWA resumes the page it
 * launched days ago instead of loading it again, so users kept old builds.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { productionBuildId, roseBuildVersion } from '@/lib/buildVersion';
import {
  APP_VERSION_IDLE_BEFORE_RELOAD_MS,
  APP_VERSION_MIN_CHECK_INTERVAL_MS,
  APP_VERSION_POLL_INTERVAL_MS,
  APP_VERSION_URL,
  hasUnsentText,
  initAppVersionWatch,
} from '@/lib/appVersion';

const RUNNING = 'aaaa-1';
const DEPLOYED = 'bbbb-2';

let clock = 1_000_000;
let cleanup: () => void = () => {};
let visibility: DocumentVisibilityState = 'visible';

function versionFetch(buildId: string | null, ok = true) {
  return vi.fn(async () =>
    ok
      ? new Response(JSON.stringify(buildId === null ? {} : { buildId }), { status: 200 })
      : new Response('gone', { status: 404 }),
  );
}

function watch(fetchImpl: typeof fetch, buildId = RUNNING) {
  const reload = vi.fn();
  cleanup = initAppVersionWatch({ buildId, fetchImpl, reload, now: () => clock });
  return reload;
}

function resume() {
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  visibility = 'visible';
  clock += APP_VERSION_MIN_CHECK_INTERVAL_MS;
  document.dispatchEvent(new Event('visibilitychange'));
}

const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  window.sessionStorage.clear();
  document.body.innerHTML = '';
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  vi.restoreAllMocks();
});

describe('stale build auto refresh', () => {
  it('checks the deployed build on load without caching the answer', async () => {
    const fetchImpl = versionFetch(RUNNING);
    const reload = watch(fetchImpl);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(`${APP_VERSION_URL}?t=`)).toBe(true);
    expect(init).toEqual({ cache: 'no-store' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads a resumed PWA onto a newer deploy', async () => {
    const fetchImpl = versionFetch(RUNNING);
    const reload = watch(fetchImpl);
    await settle();
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ buildId: DEPLOYED })));
    resume();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads a page restored from the back-forward cache onto a newer deploy', async () => {
    const fetchImpl = versionFetch(RUNNING);
    const reload = watch(fetchImpl);
    await settle();
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ buildId: DEPLOYED })));
    clock += APP_VERSION_MIN_CHECK_INTERVAL_MS;
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the same build', versionFetch(RUNNING)],
    ['a missing build id', versionFetch(null)],
    ['a failed request', versionFetch(DEPLOYED, false)],
    ['a network error', vi.fn(async () => Promise.reject(new TypeError('offline')))],
    ['an HTML fallback page', vi.fn(async () => new Response('<!doctype html>'))],
  ])('keeps the page on %s', async (_label, fetchImpl) => {
    const reload = watch(fetchImpl as unknown as typeof fetch);
    await settle();
    resume();
    await settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it('never throws away a typed draft: waits for the next resume after it is sent', async () => {
    const draft = document.createElement('textarea');
    draft.value = 'Book me a table for two';
    document.body.appendChild(draft);
    const fetchImpl = versionFetch(DEPLOYED);
    const reload = watch(fetchImpl);
    await settle();
    expect(reload).not.toHaveBeenCalled();

    draft.value = '';
    // A deferred update is rechecked on the very next resume, even inside the interval.
    clock -= APP_VERSION_MIN_CHECK_INTERVAL_MS;
    resume();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload a page that is in the background', async () => {
    visibility = 'hidden';
    const reload = watch(versionFetch(DEPLOYED));
    await settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads at most once per session for a build, so a lagging CDN cannot loop', async () => {
    const first = watch(versionFetch(DEPLOYED));
    await settle();
    expect(first).toHaveBeenCalledTimes(1);
    cleanup();
    // The reloaded page still sees the old build (stale edge) and the same target.
    const second = watch(versionFetch(DEPLOYED));
    await settle();
    resume();
    await settle();
    expect(second).not.toHaveBeenCalled();
  });

  it('shares one request between resumes inside the check interval', async () => {
    const fetchImpl = versionFetch(RUNNING);
    watch(fetchImpl);
    await settle();
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reloads once when a code chunk of the replaced deploy is gone', async () => {
    const reload = watch(versionFetch(RUNNING));
    await settle();
    const failure = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(failure);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(failure.defaultPrevented).toBe(true);

    const again = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(again);
    expect(reload).toHaveBeenCalledTimes(1);
    // The second failure surfaces normally instead of reloading in a loop.
    expect(again.defaultPrevented).toBe(false);
  });

  it('keeps a typed draft when a chunk fails to load: no reload, the error surfaces', async () => {
    const reload = watch(versionFetch(RUNNING));
    await settle();
    document.body.innerHTML = '<input type="email" value="me@example.com">';
    const failure = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(failure);
    expect(reload).not.toHaveBeenCalled();
    expect(failure.defaultPrevented).toBe(false);
  });

  describe('an open, visible page', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
    afterEach(() => vi.useRealTimers());

    async function tick() {
      clock += APP_VERSION_POLL_INTERVAL_MS;
      vi.advanceTimersByTime(APP_VERSION_POLL_INTERVAL_MS);
      await settle();
    }

    it('learns of a later deploy and reloads once the user has been idle', async () => {
      const fetchImpl = versionFetch(RUNNING);
      const reload = watch(fetchImpl);
      await settle();
      fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ buildId: DEPLOYED })));
      await tick();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('never reloads under an active user: waits for 2 idle minutes', async () => {
      const fetchImpl = versionFetch(RUNNING);
      const reload = watch(fetchImpl);
      await settle();
      fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ buildId: DEPLOYED })));
      clock += APP_VERSION_POLL_INTERVAL_MS - APP_VERSION_IDLE_BEFORE_RELOAD_MS / 2;
      window.dispatchEvent(new Event('pointerdown'));
      clock -= APP_VERSION_POLL_INTERVAL_MS - APP_VERSION_IDLE_BEFORE_RELOAD_MS / 2;
      await tick();
      expect(reload).not.toHaveBeenCalled();
      await tick();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('skips periodic checks while hidden and stops them on cleanup', async () => {
      const fetchImpl = versionFetch(RUNNING);
      watch(fetchImpl);
      await settle();
      visibility = 'hidden';
      await tick();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      visibility = 'visible';
      cleanup();
      cleanup = () => {};
      await tick();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  it('stays off without a production build id (dev server, tests)', async () => {
    const fetchImpl = versionFetch(DEPLOYED);
    cleanup = initAppVersionWatch({ buildId: '', fetchImpl, reload: vi.fn() });
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('counts only non-empty fields as unsent text', () => {
    document.body.innerHTML =
      '<input type="checkbox" value="on"><input type="hidden" value="csrf"><input type="text" value="  "><textarea></textarea>';
    expect(hasUnsentText()).toBe(false);
    for (const type of ['email', 'url', 'tel', 'password', 'number', 'search']) {
      document.body.innerHTML = `<input type="${type}" value="7">`;
      expect(hasUnsentText()).toBe(true);
    }
    document.body.innerHTML = '';
    document.body.insertAdjacentHTML('beforeend', '<div contenteditable="true">hi</div>');
    expect(hasUnsentText()).toBe(true);
  });
});

describe('build version publishing', () => {
  it('publishes the baked build id as /version.json from production builds only', () => {
    const buildId = productionBuildId();
    expect(buildId).toMatch(/^\w+-[0-9a-z]+$/);
    const plugin = roseBuildVersion(buildId);
    expect(plugin.apply).toBe('build');

    const emitFile = vi.fn();
    const generateBundle = plugin.generateBundle as unknown as (this: unknown) => void;
    generateBundle.call({ emitFile });
    expect(emitFile).toHaveBeenCalledWith({
      type: 'asset',
      fileName: 'version.json',
      source: `${JSON.stringify({ buildId })}\n`,
    });
  });

  it('bakes the same id into the bundle that the plugin publishes', () => {
    const config = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/const buildId = command === 'build' \? productionBuildId\(\) : '';/);
    expect(config).toMatch(/plugins: \[react\(\), roseBuildVersion\(buildId\)\]/);
    expect(config).toMatch(/'import\.meta\.env\.VITE_ROSE_BUILD_ID': JSON\.stringify\(buildId\)/);
  });

  it('serves hashed assets as immutable and the version file uncached', () => {
    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const header = (source: string) =>
      vercel.headers
        .find((entry) => entry.source === source)
        ?.headers.find((entry) => entry.key === 'Cache-Control')?.value;
    expect(header('/assets/(.*)')).toBe('public, max-age=31536000, immutable');
    expect(header('/version.json')).toBe('no-store');
  });
});
