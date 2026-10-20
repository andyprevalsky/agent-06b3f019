/**
 * Fixtures for the Rose Desktop Apps suites (left-bar Apps section, full-screen
 * app view, trajectory preview card). Wire shapes follow the A1/A2 backend
 * (feat/rose-user-ui @ 7826a2a6b) plus the pending L-APPS2 additions:
 *
 *   GET  /api/user-ui/apps -> { activeVersionId, apps } (Rose first, dev accounts only)
 *   GET  /api/user-ui/versions -> { activeVersionId, versions: [{ versionId, manifest… }] }
 *   POST /api/user-ui/versions/:id/activate
 *   GET  /api/claude-code-session/:taskId/preview -> { preview_url, status, … }
 *   POST /api/claude-code-session/:taskId/preview/handoff -> { code, expires_at } (L-APPS2)
 *   POST /api/claude-code-session/:taskId/publish -> { pr: { number, url }, created, … }
 *   POST /api/claude-code-session/:taskId/turns (the existing steer route)
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { Toaster } from '@/components/ui/toaster';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

export const API_BASE = 'http://localhost:3001/api';
export const ROSE_PREVIEW = 'https://5173-sbx-rose.e2b.test/';
export const USERCONTENT = 'https://uc.rose.test/usercontent';

export const ROSE_APP = {
  id: 'rose',
  kind: 'builtin',
  title: 'Rose',
  url: null,
  preview_url: ROSE_PREVIEW,
  task_id: 't-rose',
  code_session_id: 'cs-rose',
  publish: 'pull_request',
};

/** A published user app as the 7826a2a6b backend lists it (no task fields yet). */
export function userApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'game',
    kind: 'user',
    title: 'Game',
    url: `${USERCONTENT}/v2/apps/game/index.html`,
    icon_url: `${USERCONTENT}/v2/apps/game/icon.png`,
    version_id: 'v2',
    publish: 'usercontent',
    ...overrides,
  };
}

export function appsBody(apps: unknown[], activeVersionId: string | null = 'v2') {
  return { activeVersionId, apps };
}

/** GET /apps answers with each body in turn (the last one repeats). */
export function serveApps(...bodies: unknown[]) {
  let calls = 0;
  server.use(
    http.get(`${API_BASE}/user-ui/apps`, () => {
      const body = bodies[Math.min(calls, bodies.length - 1)];
      calls += 1;
      return HttpResponse.json(body);
    }),
  );
  return { calls: () => calls };
}

export function servePreview(
  status: string,
  { taskId = 't-rose', previewUrl = ROSE_PREVIEW as string | null } = {},
) {
  server.use(
    http.get(`${API_BASE}/claude-code-session/${taskId}/preview`, () =>
      HttpResponse.json({
        task_id: taskId,
        code_session_id: 'cs-1',
        target: 'cloud',
        preview_url: previewUrl,
        port: previewUrl ? 5173 : null,
        status,
        checked_at: '2026-10-20T22:00:00.000Z',
      }),
    ),
  );
}

/** Handoff codes hc-1, hc-2, … per call; `fail` answers 404 (before L-APPS2 ships). */
export function serveHandoff(mode: 'ok' | 'fail' = 'ok') {
  let calls = 0;
  server.use(
    http.post(`${API_BASE}/claude-code-session/:taskId/preview/handoff`, () => {
      calls += 1;
      if (mode === 'fail') return HttpResponse.json({ error: 'Not found' }, { status: 404 });
      return HttpResponse.json({ code: `hc-${calls}`, expires_at: '2026-10-20T22:01:00.000Z' });
    }),
  );
  return { calls: () => calls };
}

export function serveTurns() {
  server.use(
    http.post(`${API_BASE}/claude-code-session/:taskId/turns`, () =>
      HttpResponse.json({ ok: true }, { status: 202 }),
    ),
  );
}

export function version(versionId: string, apps: Record<string, unknown>, active = false) {
  return {
    versionId,
    manifest: { version: 1, apps },
    fileCount: 3,
    totalBytes: 2048,
    createdAt: `2026-10-${versionId === 'v2' ? '20' : '19'}T20:00:00.000Z`,
    active,
  };
}

export const GAME_MANIFEST_APP = { game: { title: 'Game', entry: 'apps/game/index.html' } };

/** Requests captured by MSW for one method + /api path. */
export function requests(method: string, path: string) {
  return capturedRequests.filter(
    (r) => r.method === method && new URL(r.url).pathname === `/api${path}`,
  );
}

function signInAs(userId: string) {
  const user = { id: userId, is_anonymous: false };
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user,
    }),
  );
  localStorage.setItem('app-user', JSON.stringify(user));
}

/** The flagged Rose Desktop (dev) account; the Terminal derives the flag from it. */
export function signInRoseDesktop() {
  signInAs(ROSE_DESKTOP_USER_IDS[0]);
}

/** A signed-in account without the Rose Desktop flag (stock UI). */
export function signInStock() {
  signInAs('stock-user-1');
}

export function serveTerminalBasics() {
  server.use(
    http.get(`${API_BASE}/user/profile`, () => HttpResponse.json({ name: 'Test User' })),
    http.get(`${API_BASE}/user/subscription`, () => HttpResponse.json({ tier: 10 })),
    http.get(`${API_BASE}/user/customization`, () =>
      HttpResponse.json({ systemPrompt: '', contextGates: {} }),
    ),
    http.get(`${API_BASE}/credits/stats`, () =>
      HttpResponse.json({ totalTokens: 0, topModels: [] }),
    ),
  );
}

export function renderTerminal() {
  return renderWithProviders(
    <>
      <Terminal />
      <Toaster />
    </>,
  );
}

export function expandRoseBar() {
  act(() => {
    fireEvent.mouseEnter(screen.getByTestId('rose-sidebar'));
  });
}

/** Open an app from the left bar and return the full-screen app view. */
export async function openAppFromBar(appId: string): Promise<HTMLElement> {
  const row = await screen.findByTestId(`rose-app-row-${appId}`);
  fireEvent.click(row);
  return await screen.findByTestId('user-app-screen');
}

export function pressEscape() {
  act(() => {
    fireEvent.keyDown(window, { key: 'Escape' });
  });
}
