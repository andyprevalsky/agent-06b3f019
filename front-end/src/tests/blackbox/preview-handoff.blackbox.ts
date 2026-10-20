/**
 * Rose-in-Rose preview sign-in (lib/previewHandoff.ts, L-APPS2):
 * `#rose_preview_handoff=<code>` is stripped before analytics, redeemed once,
 * and the session stored with storeSession(); without the fragment nothing
 * happens.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { server } from './msw/server';
import { getSession } from '@/lib/supabase';
import { startPreviewHandoff } from '@/lib/previewHandoff';

const REDEEM_URL = 'http://localhost:3001/api/preview-handoff/redeem';
const USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

function token(): string {
  const payload = btoa(JSON.stringify({ sub: USER_ID, amr: [{ method: 'preview_handoff' }] }));
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature-signature`;
}

let redeemBodies: unknown[] = [];

beforeEach(() => {
  localStorage.clear();
  redeemBodies = [];
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

function redeemReturns(status: number, body: Record<string, unknown>) {
  server.use(
    http.post(REDEEM_URL, async ({ request }) => {
      redeemBodies.push(await request.json());
      return HttpResponse.json(body, { status });
    }),
  );
}

it('redeems the fragment code once, stores the session and strips the fragment first', async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 8 * 3600;
  redeemReturns(200, {
    access_token: token(),
    refresh_token: 'refresh-preview',
    expires_at: expiresAt,
    expires_in: 8 * 3600,
    token_type: 'bearer',
    user: { id: USER_ID, phone: '+19729777432' },
  });
  window.history.replaceState(
    { router: 'kept' },
    '',
    '/agents?agent-id=abc#rose_preview_handoff=code-123_ABC&tab=chat',
  );

  const pending = startPreviewHandoff();

  // Stripped synchronously, before dev logging / analytics could read the URL.
  expect(window.location.hash).toBe('#tab=chat');
  expect(window.location.search).toBe('?agent-id=abc');
  expect(window.location.pathname).toBe('/agents');
  expect(window.location.href).not.toContain('code-123_ABC');
  expect(window.history.state).toEqual({ router: 'kept' });
  expect(pending).not.toBeNull();

  await expect(pending).resolves.toBe(true);
  expect(redeemBodies).toEqual([{ code: 'code-123_ABC' }]);
  const session = getSession();
  expect(session?.access_token).toBe(token());
  expect(session?.refresh_token).toBe('refresh-preview');
  expect(session?.expires_at).toBe(expiresAt);
  expect(session?.user.id).toBe(USER_ID);
  expect(session?.user.is_anonymous).toBe(false);
});

it('is a no-op without the fragment', async () => {
  redeemReturns(200, { access_token: token(), user: { id: USER_ID }, expires_at: 1 });
  window.history.replaceState({}, '', '/agents#tab=chat');

  expect(startPreviewHandoff()).toBeNull();
  await Promise.resolve();

  expect(redeemBodies).toEqual([]);
  expect(window.location.hash).toBe('#tab=chat');
  expect(getSession()).toBeNull();
});

it('a refused code stores nothing, keeps an existing session and still strips the fragment', async () => {
  const existing = {
    access_token: 'existing-token',
    refresh_token: 'existing-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: 'existing-user', is_anonymous: true, aud: 'authenticated', app_metadata: {} },
  };
  localStorage.setItem('rose-session', JSON.stringify(existing));
  redeemReturns(401, { error: 'Unknown or already used code', code: 'PREVIEW_HANDOFF_INVALID' });
  window.history.replaceState({}, '', '/#rose_preview_handoff=used-code-456');

  await expect(startPreviewHandoff()).resolves.toBe(false);

  expect(redeemBodies).toEqual([{ code: 'used-code-456' }]);
  expect(window.location.hash).toBe('');
  expect(getSession()?.access_token).toBe('existing-token');
});

it('main.tsx strips the fragment before dev logging and analytics, and renders after the redeem', () => {
  const main = readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8');
  const handoff = main.indexOf('startPreviewHandoff();');
  expect(handoff).toBeGreaterThan(-1);
  expect(handoff).toBeLessThan(main.indexOf('initDevLogging();'));
  expect(handoff).toBeLessThan(main.indexOf('initAmplitude();'));
  expect(main).toMatch(/previewHandoff\.finally\(renderApp\)/);
});
