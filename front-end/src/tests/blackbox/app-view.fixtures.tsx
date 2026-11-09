/**
 * Fixtures for the Rose Desktop app view suites (the root transcript's
 * code-agent row → its code-agent view → the devbox usage popover's "Open app" link → the full-screen
 * app view). Wire shapes follow the A1 backend
 * (feat/rose-user-ui @ 7826a2a6b) and the L-APPS2 handoff (d0a33fefa):
 *
 *   metadata.code_agent { task_id, provider, preview_url, title, … } on the spawn row
 *   GET  /api/claude-code-session/:taskId/preview -> { preview_url, status, … }
 *   POST /api/claude-code-session/:taskId/preview/handoff -> 201 { code, expires_at, preview_url }
 *        403 USER_SESSION_REQUIRED | ROSE_DEV_ONLY · 404 CODE_TASK_NOT_FOUND · 409 PREVIEW_UNAVAILABLE
 *   POST /api/claude-code-session/:taskId/publish -> { pr: { number, url }, created, … }
 *   POST /api/claude-code-session/:taskId/turns (the existing steer route)
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect } from 'vitest';

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

/** The exact refusals of the mint route (back-end routes.previewHandoff.ts + handoff.ts). */
export type HandoffRefusal =
  'USER_SESSION_REQUIRED' | 'ROSE_DEV_ONLY' | 'CODE_TASK_NOT_FOUND' | 'PREVIEW_UNAVAILABLE';

const HANDOFF_REFUSAL_STATUS: Record<HandoffRefusal, number> = {
  USER_SESSION_REQUIRED: 403,
  ROSE_DEV_ONLY: 403,
  CODE_TASK_NOT_FOUND: 404,
  PREVIEW_UNAVAILABLE: 409,
};

/**
 * The mint: 201 { code: hc-1, hc-2, … per call, expires_at, preview_url } with
 * Cache-Control no-store, or one of the refusals above.
 */
export function serveHandoff(refusal: HandoffRefusal | null = null, previewUrl = PREVIEW_URL) {
  let calls = 0;
  server.use(
    http.post(`${API_BASE}/claude-code-session/:taskId/preview/handoff`, () => {
      calls += 1;
      if (refusal !== null) {
        return HttpResponse.json(
          { error: `refused: ${refusal}`, code: refusal },
          { status: HANDOFF_REFUSAL_STATUS[refusal] },
        );
      }
      return HttpResponse.json(
        {
          code: `hc-${calls}`,
          expires_at: '2026-10-20T22:01:00.000Z',
          preview_url: previewUrl,
        },
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
      );
    }),
  );
  return { calls: () => calls };
}

export function serveTurns() {
  server.use(
    http.post(`${API_BASE}/claude-code-session/:taskId/turns`, () =>
      HttpResponse.json({ status: 'delivered' }, { status: 200 }),
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

export function renderTerminal() {
  return renderWithProviders(
    <>
      <Terminal />
      <Toaster />
    </>,
  );
}

/**
 * The code-agent row in the root transcript: it folds into a "Worked for …"
 * work group; expand the group that holds it (its first button) and return it.
 */
export async function findCodeAgentRow(): Promise<HTMLElement> {
  const groups = await screen.findAllByTestId('trajectory-work-group');
  for (const group of groups) {
    const toggle = within(group).getAllByRole('button')[0];
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
  return await screen.findByTestId('code-agent-chip');
}

/** Open agent-001 in the real Terminal and return its code-agent row. */
export async function openAgentWithChip(): Promise<HTMLElement> {
  renderTerminal();
  fireEvent.click(await screen.findByTestId('rose-agent-row-agent-001'));
  return await findCodeAgentRow();
}

/** Code-agent row → its code-agent view (the row has no "Open app" of its own). */
export async function openCodeAgentViewFromRow(row: HTMLElement): Promise<HTMLElement> {
  expect(within(row).queryByRole('button', { name: 'Open app' })).not.toBeInTheDocument();
  fireEvent.click(row);
  return await screen.findByTestId('code-agent-view');
}

/**
 * Open the view's devbox usage popover (CodeResourcesIndicator, at its query
 * box's top-right corner, never over the transcript) and return it.
 */
export async function openUsagePopover(view: HTMLElement): Promise<HTMLElement> {
  expect(within(view).queryByTestId('code-resources')).not.toBeInTheDocument();
  const corner = await screen.findByTestId('query-input-corner-status');
  fireEvent.click(await within(corner).findByTestId('code-resources'));
  return await screen.findByTestId('code-resources-popover');
}

/** Code-agent view → its devbox usage popover → the "Open app" link → the full-screen app view. */
export async function openAppFromCodeAgentView(view: HTMLElement): Promise<HTMLElement> {
  const popover = await openUsagePopover(view);
  fireEvent.click(within(popover).getByRole('button', { name: 'Open app' }));
  return await screen.findByTestId('app-view-screen');
}

/** Row → code-agent view → usage popover → "Open app" → the full-screen app view. */
export async function openAppView(): Promise<HTMLElement> {
  const row = await openAgentWithChip();
  return await openAppFromCodeAgentView(await openCodeAgentViewFromRow(row));
}

/** Escape as the browser delivers it: at the focused element, bubbling to document and window. */
export function pressEscape() {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  });
}
