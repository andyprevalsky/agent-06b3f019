/**
 * Blackbox: the full-screen app view through the real Terminal (Rose Desktop
 * flag on, UI ledger rows 10/39), opened from a code-agent session: the root
 * transcript's code-agent row → its code-agent view → "Open app".
 *
 *   Open app → the chat column is replaced by that code session's preview:
 *     GET /claude-code-session/:taskId/preview (open view only) →
 *     POST …/preview/handoff → <iframe src=preview_url#rose_preview_handoff=code>
 *   thin header (title · Publish; no tabs), the normal query box over the app
 *   (Popular Goals hidden) steering the session (POST …/turns); Escape, an agent
 *   row or the mobile close icon returns. Quiet text replaces a broken frame.
 *   No left-bar Apps section exists and no Apps list is ever read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';

import { clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  API_BASE,
  PREVIEW_URL,
  TASK_ID,
  findCodeAgentRow,
  openAppFromCodeAgentView,
  openAppView,
  openCodeAgentViewFromRow,
  pressEscape,
  requests,
  serveAgentWithChip,
  serveHandoff,
  servePreview,
  serveTerminalBasics,
  serveTurns,
  signInRoseDesktop,
} from './app-view.fixtures';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

beforeEach(() => {
  localStorage.clear();
  clearCaptures();
  resetCodeAgentLocalState();
  signInRoseDesktop();
  serveTerminalBasics();
  serveTurns();
  serveAgentWithChip();
});

afterEach(() => localStorage.clear());

describe('app view', () => {
  it('replaces the chat with the live preview (sign-in handoff fragment); no tabs, Publish on the right', async () => {
    servePreview('running');
    const handoff = serveHandoff();
    const view = await openAppView();

    const frame = await within(view).findByTestId('app-view-frame');
    expect(frame).toHaveAttribute('src', `${PREVIEW_URL}#rose_preview_handoff=hc-1`);
    expect(frame.getAttribute('sandbox')).toContain('allow-same-origin');
    expect(handoff.calls()).toBe(1);
    // Preview status is read for the open view only (one task, one read).
    expect(requests('GET', `/claude-code-session/${TASK_ID}/preview`)).toHaveLength(1);

    expect(within(view).getByRole('heading', { name: 'Snake game' })).toBeInTheDocument();
    expect(within(view).queryByRole('tab')).not.toBeInTheDocument();
    expect(within(view).queryByText('History')).not.toBeInTheDocument();
    expect(within(view).getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    // The normal query box floats over the app; the chat (and its composer) is gone.
    expect(screen.getByTestId('query-input-surface')).toBeInTheDocument();
    expect(screen.queryByTestId('query-toolbar-nub')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message Claude Code directly…')).toBeInTheDocument();
    expect(screen.queryByText('Popular Goals')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Type your message...')).not.toBeInTheDocument();
  });

  it("opens the mint response's preview_url with the encoded single-use code", async () => {
    const minted = 'https://5173-sbx-minted.e2b.test/app/';
    servePreview('running');
    serveHandoff(null, minted);
    const view = await openAppView();
    expect(await within(view).findByTestId('app-view-frame')).toHaveAttribute(
      'src',
      `${minted}#rose_preview_handoff=hc-1`,
    );
    expect(requests('POST', `/claude-code-session/${TASK_ID}/preview/handoff`)[0].body).toEqual({});
  });

  it.each([
    ['PREVIEW_UNAVAILABLE', 'Preview is starting…'],
    ['CODE_TASK_NOT_FOUND', 'Preview unavailable'],
  ] as const)('a %s mint shows quiet text, no frame', async (refusal, text) => {
    servePreview('running');
    serveHandoff(refusal);
    const view = await openAppView();
    expect(await within(view).findByTestId('app-view-quiet')).toHaveTextContent(text);
    expect(within(view).queryByTestId('app-view-frame')).not.toBeInTheDocument();
  });

  it.each(['USER_SESSION_REQUIRED', 'ROSE_DEV_ONLY'] as const)(
    'a 403 %s mint renders nothing (no frame, no error text)',
    async (refusal) => {
      servePreview('running');
      const handoff = serveHandoff(refusal);
      const view = await openAppView();
      await waitFor(() => expect(handoff.calls()).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(within(view).queryByTestId('app-view-frame')).not.toBeInTheDocument();
      expect(within(view).queryByTestId('app-view-quiet')).not.toBeInTheDocument();
      expect(screen.queryByText(/refused/)).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText('Message Claude Code directly…')).toBeInTheDocument();
    },
  );

  it("a message sent over the app goes to that code session's steer route, never a new agent", async () => {
    servePreview('running');
    serveHandoff();
    const user = userEvent.setup({ delay: null });
    const view = await openAppView();
    const box = screen.getByPlaceholderText('Message Claude Code directly…');
    await user.click(box);
    await user.type(box, 'Make the snake faster{Enter}');

    await waitFor(() =>
      expect(requests('POST', `/claude-code-session/${TASK_ID}/turns`)).toHaveLength(1),
    );
    expect(requests('POST', `/claude-code-session/${TASK_ID}/turns`)[0].body).toEqual(
      expect.objectContaining({
        text: 'Make the snake faster',
        client_message_id: expect.stringMatching(/^turn-/),
      }),
    );
    expect(requests('POST', '/agents')).toHaveLength(0);
    expect(requests('POST', '/agents/agent-001/messages')).toHaveLength(0);
    // The latest exchange sits just above the query box; the box is cleared.
    expect(await within(view).findByTestId('app-view-exchange')).toHaveTextContent(
      'You: Make the snake faster',
    );
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('a failed steer keeps the text and shows one line', async () => {
    servePreview('running');
    serveHandoff();
    server.use(
      http.post(`${API_BASE}/claude-code-session/:taskId/turns`, () =>
        HttpResponse.json({ error: 'Session is not running' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup({ delay: null });
    const view = await openAppView();
    const box = screen.getByPlaceholderText('Message Claude Code directly…');
    await user.click(box);
    await user.type(box, 'Add a score{Enter}');
    expect(await within(view).findByRole('alert')).toHaveTextContent(
      "Couldn't reach Claude Code: Session is not running",
    );
    expect(box).toHaveValue('Add a score');
  });

  it('keeps an app attachment after failed delivery and retries the same native turn', async () => {
    servePreview('running');
    serveHandoff();
    const file = {
      id: 'app-file',
      storage_path: 'user/notes.txt',
      original_filename: 'notes.txt',
      mime_type: 'text/plain',
      size_bytes: 5,
      created_at: '2026-10-20T12:00:00Z',
    };
    let attempts = 0;
    server.use(
      http.post(`${API_BASE}/upload`, () => HttpResponse.json({ file_pointer: file })),
      http.post(`${API_BASE}/claude-code-session/:taskId/turns`, () =>
        ++attempts === 1
          ? HttpResponse.json({ error: 'Native turn unavailable' }, { status: 503 })
          : HttpResponse.json({ status: 'delivered' }),
      ),
    );
    const user = userEvent.setup({ delay: null });
    const view = await openAppView();
    const box = screen.getByPlaceholderText('Message Claude Code directly…');
    await user.upload(
      screen
        .getByTestId('query-input-layer')
        .querySelector('input[type="file"]') as HTMLInputElement,
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    );
    await screen.findByText('notes.txt');
    await user.type(box, 'Read these notes{Enter}');
    await within(view).findByRole('alert');
    expect(box).toHaveValue('Read these notes');
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    await user.type(box, '{Enter}');
    await waitFor(() => expect(box).toHaveValue(''));
    const turns = requests('POST', `/claude-code-session/${TASK_ID}/turns`);
    expect(turns).toHaveLength(2);
    expect(turns[0].body).toEqual(turns[1].body);
    expect(turns[1].body).toEqual(expect.objectContaining({ attachments: [file] }));
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  });

  it('Escape returns to the code-agent view, then the chat; an agent row and the mobile close icon do too', async () => {
    servePreview('running');
    serveHandoff();
    await openAppView();
    pressEscape();
    await waitFor(() => expect(screen.queryByTestId('app-view-screen')).not.toBeInTheDocument());
    // The app was opened from the code-agent view: Escape lands back there.
    const codeView = await screen.findByTestId('code-agent-view');
    // A second Escape closes that view too: back to the owner's chat and its row.
    pressEscape();
    await waitFor(() => expect(screen.queryByTestId('code-agent-view')).not.toBeInTheDocument());
    expect(codeView).not.toBeInTheDocument();
    const row = await findCodeAgentRow();

    await openAppFromCodeAgentView(await openCodeAgentViewFromRow(row));
    fireEvent.click(screen.getByTestId('rose-agent-row-agent-001'));
    await waitFor(() => expect(screen.queryByTestId('app-view-screen')).not.toBeInTheDocument());
    // The agent row returns to the owner's chat (not the code-agent view).
    await waitFor(() => expect(screen.queryByTestId('code-agent-view')).not.toBeInTheDocument());

    // Below md (no left bar, no keyboard) the header's bare close icon returns too.
    const view = await openAppFromCodeAgentView(
      await openCodeAgentViewFromRow(await findCodeAgentRow()),
    );
    const close = within(view).getByRole('button', { name: 'Close Snake game' });
    expect(close.className).toContain('md:hidden');
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId('app-view-screen')).not.toBeInTheDocument());
  });

  it.each([
    ['paused', PREVIEW_URL, 'Paused'],
    ['not_running', PREVIEW_URL, 'Preview is starting…'],
    ['unknown', null, 'Preview is starting…'],
  ])('preview status %s shows quiet text instead of a frame', async (status, url, text) => {
    servePreview(status, { previewUrl: url });
    const handoff = serveHandoff();
    const view = await openAppView();
    expect(await within(view).findByTestId('app-view-quiet')).toHaveTextContent(text);
    expect(within(view).queryByTestId('app-view-frame')).not.toBeInTheDocument();
    expect(handoff.calls()).toBe(0);
  });

  it('403 ROSE_DEV_ONLY on the preview renders nothing (no frame, no error text)', async () => {
    server.use(
      http.get(`${API_BASE}/claude-code-session/${TASK_ID}/preview`, () =>
        HttpResponse.json({ error: 'dev only', code: 'ROSE_DEV_ONLY' }, { status: 403 }),
      ),
    );
    const view = await openAppView();
    await waitFor(() =>
      expect(requests('GET', `/claude-code-session/${TASK_ID}/preview`)).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(view).queryByTestId('app-view-frame')).not.toBeInTheDocument();
    expect(within(view).queryByTestId('app-view-quiet')).not.toBeInTheDocument();
    expect(screen.queryByText(/dev only|ROSE_DEV_ONLY/)).not.toBeInTheDocument();
  });

  it('a failed preview read shows "Preview unavailable"', async () => {
    server.use(
      http.get(`${API_BASE}/claude-code-session/${TASK_ID}/preview`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    const view = await openAppView();
    expect(await within(view).findByTestId('app-view-quiet')).toHaveTextContent(
      'Preview unavailable',
    );
  });

  it('the left bar has no Apps section and no Apps list is ever read', async () => {
    servePreview('running');
    serveHandoff();
    await openAppView();
    expect(screen.queryByText('Apps')).not.toBeInTheDocument();
    expect(screen.queryByText('+ New app')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^rose-app-row-/)).not.toBeInTheDocument();
    expect(requests('GET', '/user-ui/apps')).toHaveLength(0);
  });
});
