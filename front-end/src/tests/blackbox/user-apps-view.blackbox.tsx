/**
 * Blackbox: the full-screen app view through the real Terminal (Rose Desktop
 * flag on, UI ledger rows 10/39).
 *
 *   left-bar app row → the chat column is replaced by the app in a frame:
 *     Rose  → GET /claude-code-session/:taskId/preview (open app only) →
 *             POST …/preview/handoff → <iframe src=preview_url#rose_preview_handoff=code>
 *     user  → <iframe sandbox="allow-scripts" src=usercontent url>
 *   thin header (title · Preview · History · Publish), the normal query box over
 *   the app with Popular Goals hidden; Escape or an agent row returns.
 *   The box steers the app's code session (POST …/turns) or, with no session,
 *   starts a normal agent (POST /api/agents). Quiet text replaces a broken frame.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';

import { clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  API_BASE,
  ROSE_APP,
  ROSE_PREVIEW,
  appsBody,
  expandRoseBar,
  openAppFromBar,
  pressEscape,
  renderTerminal,
  requests,
  serveApps,
  serveHandoff,
  servePreview,
  serveTerminalBasics,
  serveTurns,
  signInRoseDesktop,
  userApp,
} from './user-apps.fixtures';

beforeEach(() => {
  localStorage.clear();
  clearCaptures();
  resetCodeAgentLocalState();
  signInRoseDesktop();
  serveTerminalBasics();
  serveTurns();
});

afterEach(() => localStorage.clear());

async function openRose() {
  renderTerminal();
  await screen.findByTestId('rose-sidebar');
  expandRoseBar();
  return await openAppFromBar('rose');
}

describe('Rose app full screen', () => {
  it('replaces the chat with the live preview (sign-in handoff fragment) and hides Popular Goals', async () => {
    serveApps(appsBody([ROSE_APP, userApp()]));
    servePreview('running');
    const handoff = serveHandoff();
    renderTerminal();
    expect(await screen.findByText('Popular Goals')).toBeInTheDocument();
    expandRoseBar();
    const view = await openAppFromBar('rose');

    const frame = await within(view).findByTestId('user-app-frame');
    expect(frame).toHaveAttribute('src', `${ROSE_PREVIEW}#rose_preview_handoff=hc-1`);
    expect(frame.getAttribute('sandbox')).toContain('allow-same-origin');
    expect(handoff.calls()).toBe(1);
    // Preview status is read for the open app only (one task, one read).
    expect(requests('GET', '/claude-code-session/t-rose/preview')).toHaveLength(1);

    expect(within(view).getByRole('heading', { name: 'Rose' })).toBeInTheDocument();
    expect(within(view).getByRole('tab', { name: 'Preview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(view).getByRole('tab', { name: 'History' })).toBeInTheDocument();
    expect(within(view).queryByRole('tab', { name: 'Code' })).not.toBeInTheDocument();
    expect(within(view).getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    // The normal query box floats over the app; Popular Goals and the chat composer are gone.
    expect(within(view).getByTestId('query-input-surface')).toBeInTheDocument();
    expect(within(view).getByPlaceholderText('Message Rose directly…')).toBeInTheDocument();
    expect(screen.queryByText('Popular Goals')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Enter any goal')).not.toBeInTheDocument();
    // The open app is marked by color/weight in the left bar.
    expect(screen.getByTestId('rose-app-row-rose')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('rose-app-row-rose').className).toContain('font-semibold');
  });

  it('loads preview_url without a fragment when the handoff call fails', async () => {
    serveApps(appsBody([ROSE_APP]));
    servePreview('running');
    serveHandoff('fail');
    const view = await openRose();
    const frame = await within(view).findByTestId('user-app-frame');
    expect(frame).toHaveAttribute('src', ROSE_PREVIEW);
  });

  it('a message sent over Rose goes to its code session (steer route), never a new agent', async () => {
    serveApps(appsBody([ROSE_APP]));
    servePreview('running');
    serveHandoff();
    const user = userEvent.setup({ delay: null });
    const view = await openRose();
    const box = within(view).getByPlaceholderText('Message Rose directly…');
    await user.click(box);
    await user.type(box, 'Make the header sticky{Enter}');

    await waitFor(() =>
      expect(requests('POST', '/claude-code-session/t-rose/turns')).toHaveLength(1),
    );
    const [turn] = requests('POST', '/claude-code-session/t-rose/turns');
    expect(turn.body).toEqual(
      expect.objectContaining({
        text: 'Make the header sticky',
        client_message_id: expect.stringMatching(/^turn-/),
      }),
    );
    expect(requests('POST', '/agents')).toHaveLength(0);
    // The latest exchange sits just above the query box; the box is cleared.
    expect(await within(view).findByTestId('user-app-exchange')).toHaveTextContent(
      'You: Make the header sticky',
    );
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('Escape returns to the normal view; an agent row and the mobile close icon do too', async () => {
    serveApps(appsBody([ROSE_APP]));
    servePreview('running');
    serveHandoff();
    await openRose();
    pressEscape();
    await waitFor(() => expect(screen.queryByTestId('user-app-screen')).not.toBeInTheDocument());
    expect(await screen.findByPlaceholderText('Enter any goal')).toBeInTheDocument();
    expect(screen.getByTestId('rose-app-row-rose')).toHaveAttribute('data-selected', 'false');

    expandRoseBar();
    await openAppFromBar('rose');
    fireEvent.click(await screen.findByTestId('rose-agent-row-agent-001'));
    await waitFor(() => expect(screen.queryByTestId('user-app-screen')).not.toBeInTheDocument());

    // Below md (no left bar, no keyboard) the header's bare close icon returns too.
    expandRoseBar();
    const view = await openAppFromBar('rose');
    const close = within(view).getByRole('button', { name: 'Close Rose' });
    expect(close.className).toContain('md:hidden');
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId('user-app-screen')).not.toBeInTheDocument());
  });

  it.each([
    ['paused', ROSE_PREVIEW, 'Paused'],
    ['not_running', ROSE_PREVIEW, 'Preview is starting…'],
    ['unknown', null, 'Preview is starting…'],
  ])('preview status %s shows quiet text instead of a frame', async (status, url, text) => {
    serveApps(appsBody([ROSE_APP]));
    servePreview(status, { previewUrl: url });
    const handoff = serveHandoff();
    const view = await openRose();
    expect(await within(view).findByTestId('user-app-quiet')).toHaveTextContent(text);
    expect(within(view).queryByTestId('user-app-frame')).not.toBeInTheDocument();
    expect(handoff.calls()).toBe(0);
  });

  it('403 ROSE_DEV_ONLY on the preview renders nothing (no frame, no error text)', async () => {
    serveApps(appsBody([ROSE_APP]));
    server.use(
      http.get(`${API_BASE}/claude-code-session/t-rose/preview`, () =>
        HttpResponse.json({ error: 'dev only', code: 'ROSE_DEV_ONLY' }, { status: 403 }),
      ),
    );
    const view = await openRose();
    await waitFor(() =>
      expect(requests('GET', '/claude-code-session/t-rose/preview')).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(view).queryByTestId('user-app-frame')).not.toBeInTheDocument();
    expect(within(view).queryByTestId('user-app-quiet')).not.toBeInTheDocument();
    expect(screen.queryByText(/dev only|ROSE_DEV_ONLY/)).not.toBeInTheDocument();
  });

  it('Rose without a code session: quiet text, Publish disabled, the box starts a normal agent', async () => {
    serveApps(appsBody([{ ...ROSE_APP, preview_url: null, task_id: null, code_session_id: null }]));
    const view = await openRose();
    expect(within(view).getByTestId('user-app-quiet')).toHaveTextContent('No code session yet');
    expect(within(view).getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(within(view).getByPlaceholderText('Enter any goal')).toBeInTheDocument();
    expect(requests('GET', '/claude-code-session/t-rose/preview')).toHaveLength(0);
  });
});

describe('User apps full screen', () => {
  it('frames the published URL with sandbox "allow-scripts" only; no preview reads', async () => {
    serveApps(appsBody([ROSE_APP, userApp()]));
    const handoff = serveHandoff();
    renderTerminal();
    await screen.findByTestId('rose-sidebar');
    expandRoseBar();
    const view = await openAppFromBar('game');
    const frame = within(view).getByTestId('user-app-frame');
    expect(frame).toHaveAttribute(
      'src',
      'https://uc.rose.test/usercontent/v2/apps/game/index.html',
    );
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(within(view).getByRole('heading', { name: 'Game' })).toBeInTheDocument();
    expect(handoff.calls()).toBe(0);
    expect(requests('GET', '/claude-code-session/t-rose/preview')).toHaveLength(0);
  });

  it('no code session (older version): sending starts a normal new agent and the app stays open', async () => {
    serveApps(appsBody([userApp()]));
    const user = userEvent.setup({ delay: null });
    renderTerminal();
    await screen.findByTestId('rose-sidebar');
    expandRoseBar();
    const view = await openAppFromBar('game');
    const box = within(view).getByPlaceholderText('Enter any goal');
    await user.click(box);
    await user.type(box, 'Add a high score table{Enter}');

    await waitFor(() => expect(requests('POST', '/agents')).toHaveLength(1));
    expect(requests('POST', '/agents')[0].body).toEqual(
      expect.objectContaining({ goal: 'Add a high score table' }),
    );
    expect(requests('POST', '/claude-code-session/t-rose/turns')).toHaveLength(0);
    const exchange = await within(view).findByTestId('user-app-exchange');
    expect(exchange).toHaveTextContent('You: Add a high score table');
    expect(exchange).toHaveTextContent('Started a new agent');
    expect(screen.getByTestId('user-app-screen')).toBeInTheDocument();

    fireEvent.click(within(exchange).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.queryByTestId('user-app-screen')).not.toBeInTheDocument());
  });

  it('L-APPS2 task_id on the row: sending steers the code session that last published it', async () => {
    serveApps(appsBody([userApp({ task_id: 't-game', code_session_id: 'cs-game' })]));
    const user = userEvent.setup({ delay: null });
    renderTerminal();
    await screen.findByTestId('rose-sidebar');
    expandRoseBar();
    const view = await openAppFromBar('game');
    const box = within(view).getByPlaceholderText('Message Game directly…');
    await user.click(box);
    await user.type(box, 'Bigger buttons{Enter}');
    await waitFor(() =>
      expect(requests('POST', '/claude-code-session/t-game/turns')).toHaveLength(1),
    );
    expect(requests('POST', '/agents')).toHaveLength(0);
    // Still the usercontent frame: published apps never take a preview sign-in code.
    expect(within(view).getByTestId('user-app-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('+ New app opens a new Super Agent with "Make me an app" in the composer, not sent', async () => {
    serveApps(appsBody([ROSE_APP]));
    renderTerminal();
    await screen.findByTestId('rose-sidebar');
    expandRoseBar();
    fireEvent.click(await screen.findByRole('button', { name: '+ New app' }));
    expect(await screen.findByPlaceholderText('Enter any goal')).toHaveValue('Make me an app');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests('POST', '/agents')).toHaveLength(0);
  });
});
