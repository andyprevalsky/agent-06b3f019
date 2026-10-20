/**
 * integration-cookie-progress domain blackbox
 *
 * Surface under test:
 *   - main/domains/integration-progress/* via the main/services/integrationProgress shim
 *
 * Public entrypoints:
 *   - IntegrationProgress.cookieAccountId(browser, profile)
 *   - IntegrationProgress.countCookiesByProfile(cookies)
 *   - IntegrationProgress.reportCookieProfilesSyncing(browser, cookies, token, runId)
 *   - IntegrationProgress.reportCookieProfilesSynced(browser, cookies, token, runId)
 *
 * Observable behavior exercised here (the I6 "progress from known counts" wire):
 *   - account id is `<browser>:<profile>`; the legacy empty profile is `default`
 *   - one progress POST per browser profile, to
 *     POST /api/integrations/<browser>/accounts/<accountId>/progress, Bearer auth
 *   - total comes from the read cookie count; `done` rises 0 → total across the
 *     syncing → synced transition (never a fabricated percentage)
 *   - a space in a profile name (`Profile 1`) stays one URL-encoded segment
 *   - best-effort: 200/202 are ok; a 409 (stale) or a thrown fetch is not ok,
 *     and never throws to the caller
 *
 * Boundary: the backend progress endpoint (captured via fetch-capture). No
 * Electron / native deps — base/config is stubbed for config.apiUrl only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

vi.mock('../../main/base/config', () => ({
  config: { apiUrl: 'https://backend.test' },
}));

const { IntegrationProgress } = await import('../../main/services/integrationProgress');

const TOKEN = 'ACCESS_TOKEN';
const RUN = 'run-1';

function okResponder() {
  return new Response(JSON.stringify({ applied: true }), { status: 200 });
}

/** The progress write bodies captured for one provider, newest last. */
function progressBodies(): Array<Record<string, unknown>> {
  return fetchCaptures
    .filter((c) => c.url.includes('/progress') && c.body !== null)
    .map((c) => JSON.parse(c.body as string) as Record<string, unknown>);
}

function cookie(profile: string, name: string) {
  return { browserProfile: profile, name };
}

describe('integration-cookie-progress blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    restoreFetch = installFetchCapture({ '/accounts/': okResponder });
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  describe('account id + grouping (pure)', () => {
    it('spells a profile account as <browser>:<profile>', () => {
      expect(IntegrationProgress.cookieAccountId('chrome', 'Default')).toBe('chrome:Default');
      expect(IntegrationProgress.cookieAccountId('edge', 'Profile 1')).toBe('edge:Profile 1');
    });

    it('maps the legacy empty profile to the default account', () => {
      expect(IntegrationProgress.cookieAccountId('chrome', '')).toBe('default');
    });

    it('groups cookies into per-profile totals', () => {
      const counts = IntegrationProgress.countCookiesByProfile([
        cookie('Default', 'a'),
        cookie('Default', 'b'),
        cookie('Profile 1', 'c'),
      ]);
      const byProfile = new Map(counts.map((entry) => [entry.profile, entry.total]));
      expect(byProfile.get('Default')).toBe(2);
      expect(byProfile.get('Profile 1')).toBe(1);
    });

    it('treats a missing profile tag as the empty (legacy) profile', () => {
      const counts = IntegrationProgress.countCookiesByProfile([{ name: 'x' }]);
      expect(counts).toEqual([{ profile: '', total: 1 }]);
    });
  });

  describe('reportCookieProfilesSyncing', () => {
    it('opens one profile per account at syncing, done 0 of its known total', async () => {
      await IntegrationProgress.reportCookieProfilesSyncing(
        'edge',
        [cookie('Default', 'a'), cookie('Default', 'b'), cookie('Profile 1', 'c')],
        TOKEN,
        RUN
      );

      const urls = fetchCaptures.map((c) => c.url).sort();
      expect(urls).toEqual([
        'https://backend.test/api/integrations/edge/accounts/edge%3ADefault/progress',
        'https://backend.test/api/integrations/edge/accounts/edge%3AProfile%201/progress',
      ]);
      expect(fetchCaptures.every((c) => c.method === 'POST')).toBe(true);
      expect(fetchCaptures.every((c) => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);

      const bodies = progressBodies();
      const def = bodies.find((b) => b.total === 2);
      const p1 = bodies.find((b) => b.total === 1);
      expect(def).toMatchObject({ runId: RUN, state: 'syncing', done: 0, total: 2, unit: 'cookies' });
      expect(p1).toMatchObject({ runId: RUN, state: 'syncing', done: 0, total: 1, unit: 'cookies' });
    });
  });

  describe('reportCookieProfilesSynced', () => {
    it('closes each profile at synced with done = total', async () => {
      await IntegrationProgress.reportCookieProfilesSynced(
        'chrome',
        [cookie('Default', 'a'), cookie('Default', 'b')],
        TOKEN,
        RUN
      );
      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].url).toBe(
        'https://backend.test/api/integrations/chrome/accounts/chrome%3ADefault/progress'
      );
      expect(progressBodies()[0]).toMatchObject({
        runId: RUN,
        state: 'synced',
        done: 2,
        total: 2,
        unit: 'cookies',
      });
    });

    it('done rises 0 -> total across the syncing then synced writes of one run', async () => {
      const cookies = [cookie('Default', 'a'), cookie('Default', 'b'), cookie('Default', 'c')];
      await IntegrationProgress.reportCookieProfilesSyncing('brave', cookies, TOKEN, RUN);
      await IntegrationProgress.reportCookieProfilesSynced('brave', cookies, TOKEN, RUN);
      const bodies = progressBodies();
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toMatchObject({ state: 'syncing', done: 0, total: 3 });
      expect(bodies[1]).toMatchObject({ state: 'synced', done: 3, total: 3 });
      expect(bodies.every((b) => b.runId === RUN)).toBe(true);
    });
  });

  describe('best-effort transport', () => {
    it('reports ok for an accepted (200) write', async () => {
      const [result] = await IntegrationProgress.reportCookieProfilesSynced(
        'chrome',
        [cookie('Default', 'a')],
        TOKEN,
        RUN
      );
      expect(result).toEqual({ ok: true, status: 200 });
    });

    it('treats a 202 coalesced write as ok (the account is still progressing)', async () => {
      restoreFetch?.();
      restoreFetch = installFetchCapture({
        '/accounts/': () => new Response(JSON.stringify({ retryAfterMs: 600 }), { status: 202 }),
      });
      const [result] = await IntegrationProgress.reportCookieProfilesSyncing(
        'chrome',
        [cookie('Default', 'a')],
        TOKEN,
        RUN
      );
      expect(result).toEqual({ ok: true, status: 202 });
    });

    it('treats a 409 stale write as not ok but never throws', async () => {
      restoreFetch?.();
      restoreFetch = installFetchCapture({
        '/accounts/': () => new Response(JSON.stringify({ reason: 'stale' }), { status: 409 }),
      });
      const [result] = await IntegrationProgress.reportCookieProfilesSynced(
        'chrome',
        [cookie('Default', 'a')],
        TOKEN,
        RUN
      );
      expect(result).toEqual({ ok: false, status: 409 });
    });

    it('swallows a thrown fetch and reports status 0', async () => {
      restoreFetch?.();
      const original = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch;
      try {
        const [result] = await IntegrationProgress.reportCookieProfilesSynced(
          'chrome',
          [cookie('Default', 'a')],
          TOKEN,
          RUN
        );
        expect(result).toEqual({ ok: false, status: 0 });
      } finally {
        globalThis.fetch = original;
      }
    });
  });
});
