/**
 * Fixtures for the Rose Desktop app view suites (a code-agent chip's live
 * preview card → the full-screen app view). Wire shapes follow the A1 backend
 * (feat/rose-user-ui @ 7826a2a6b) plus the pending L-APPS2 handoff:
 *
 *   metadata.code_agent { task_id, provider, preview_url, title, … } on the spawn row
 *   GET  /api/claude-code-session/:taskId/preview -> { preview_url, status, … }
 *   POST /api/claude-code-session/:taskId/preview/handoff -> { code, expires_at } (L-APPS2)
 *   POST /api/claude-code-session/:taskId/publish -> { pr: { number, url }, created, … }
 *   POST /api/claude-code-session/:taskId/turns (the existing steer route)
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { Toaster } from '@/components/ui/toaster';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import { chipMessage } from './code-agent-steering.fixtures';
import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

export const API_BASE = 'http://localhost:3001/api';
export const TASK_ID = 't-game';
export const PREVIEW_URL = 'https://5173-sbx-game.e2b.test/';

export function servePreview(
  status: string,
  { taskId = TASK_ID, previewUrl = PREVIEW_URL as string | null } = {},
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

/** agent-001's trajectory holds one code-agent chip (spawn row with code_agent). */
export function serveAgentWithChip(codeAgent: Record<string, unknown> = {}) {
  const message = chipMessage({
    task_id: TASK_ID,
    provider: 'claude',
    target: 'cloud',
    state: 'live',
    title: 'Snake game',
    preview_url: PREVIEW_URL,
    ...codeAgent,
  });
  server.use(
    http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
      HttpResponse.json({
        agent: {
          agent_id: params.agentId,
          goal: 'Make me a game',
          model: 'rose-1-flash',
          source: 'WEB',
          reasoning_effort: 'medium',
          progress: 50,
          status: 'ACTIVE',
          status_message: null,
          temporal_workflow_id: 'wf-001',
          token_count: 0,
          tokens_in: 0,
          tokens_out: 0,
          context_size: 0,
          message_count: 1,
          price_limit_cents: 100,
          tree_cost_cents: 0,
          created_at: '2026-10-20T12:00:00.000Z',
          updated_at: '2026-10-20T12:00:00.000Z',
          write_lock_enabled: false,
          parent_agent_id: null,
          parent_goal: null,
          verifier: null,
          tools: [],
        },
        messages: [message],
        pagination: { has_more: false, oldest_timestamp: null },
      }),
    ),
  );
}

/** IntersectionObserver that reports every observed element as on screen. */
export class VisibleIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

export function renderTerminal() {
  return renderWithProviders(
    <>
      <Terminal />
      <Toaster />
    </>,
  );
}

/** Open agent-001 in the real Terminal and return its code-agent chip. */
export async function openAgentWithChip(): Promise<HTMLElement> {
  renderTerminal();
  fireEvent.click(await screen.findByTestId('rose-agent-row-agent-001'));
  return await screen.findByTestId('code-agent-chip');
}

/** Chip → its live preview card → the full-screen app view. */
export async function openAppView(title = 'Snake game'): Promise<HTMLElement> {
  const chip = await openAgentWithChip();
  fireEvent.click(await within(chip).findByRole('button', { name: `Open ${title} preview` }));
  return await screen.findByTestId('app-view-screen');
}

export function pressEscape() {
  act(() => {
    fireEvent.keyDown(window, { key: 'Escape' });
  });
}
