/**
 * Blackbox: History (one-click restore) and Publish in the full-screen app view,
 * through the real Terminal (Rose Desktop flag on, UI ledger row 10).
 *
 *   History → GET /api/user-ui/versions, rows = versions listing this app (Rose:
 *     every version), current one semibold; Restore → POST /versions/:id/activate
 *     → the Apps list refetches once, Preview reopens and the frame reloads.
 *   Publish (Rose) → POST /claude-code-session/:taskId/publish → toast
 *     "Opened PR #n" + link; 409/502 codes → one plain line; never anything
 *     deploy-like. Publish (user app) → show + copy its usercontent URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { PUBLISH_ERROR_TEXT } from '@/features/terminal-component-group/components/user-apps/publishErrors';

import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  API_BASE,
  GAME_MANIFEST_APP,
  ROSE_APP,
  ROSE_PREVIEW,
  USERCONTENT,
  appsBody,
  expandRoseBar,
  openAppFromBar,
  renderTerminal,
  requests,
  serveApps,
  serveHandoff,
  servePreview,
  serveTerminalBasics,
  signInRoseDesktop,
  userApp,
  version,
} from './user-apps.fixtures';

const V1_GAME_URL = `${USERCONTENT}/v1/apps/game/index.html`;

beforeEach(() => {
  localStorage.clear();
  clearCaptures();
  signInRoseDesktop();
  serveTerminalBasics();
  server.use(
    http.get(`${API_BASE}/user-ui/versions`, () =>
      HttpResponse.json({
        activeVersionId: 'v2',
        versions: [
          version('v2', GAME_MANIFEST_APP, true),
          version('v1', GAME_MANIFEST_APP),
          version('v0', {}),
        ],
      }),
    ),
    http.post(`${API_BASE}/user-ui/versions/:id/activate`, ({ params }) =>
      HttpResponse.json({ versionId: params.id, active: true }),
    ),
  );
});

afterEach(() => localStorage.clear());

async function openApp(appId: string) {
  renderTerminal();
  await screen.findByTestId('rose-sidebar');
  expandRoseBar();
  return await openAppFromBar(appId);
}

describe('History', () => {
  it("lists the app's versions, marks the current by weight, and one-click restore reloads the frame", async () => {
    const apps = serveApps(
      appsBody([ROSE_APP, userApp()], 'v2'),
      appsBody([ROSE_APP, userApp({ url: V1_GAME_URL, version_id: 'v1' })], 'v1'),
    );
    const view = await openApp('game');
    expect(within(view).getByTestId('user-app-frame')).toHaveAttribute(
      'src',
      `${USERCONTENT}/v2/apps/game/index.html`,
    );
    fireEvent.click(within(view).getByRole('tab', { name: 'History' }));

    const current = await within(view).findByTestId('user-app-version-v2');
    expect(current).toHaveAttribute('data-current', 'true');
    expect(current.className).toContain('font-semibold');
    expect(current).toHaveTextContent('Current');
    const older = within(view).getByTestId('user-app-version-v1');
    expect(older.className).not.toContain('font-semibold');
    // v0 does not list the Game app.
    expect(within(view).queryByTestId('user-app-version-v0')).not.toBeInTheDocument();
    expect(apps.calls()).toBe(1);

    fireEvent.click(within(older).getByRole('button', { name: /^Restore/ }));
    await waitFor(() => expect(requests('POST', '/user-ui/versions/v1/activate')).toHaveLength(1));
    await waitFor(() =>
      expect(within(view).getByTestId('user-app-frame')).toHaveAttribute('src', V1_GAME_URL),
    );
    expect(within(view).getByRole('tab', { name: 'Preview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(apps.calls()).toBe(2);
  });

  it('Rose: restore re-reads the preview and reloads the frame with a fresh sign-in code', async () => {
    serveApps(appsBody([ROSE_APP], 'v2'));
    servePreview('running');
    const handoff = serveHandoff();
    const view = await openApp('rose');
    expect(await within(view).findByTestId('user-app-frame')).toHaveAttribute(
      'src',
      `${ROSE_PREVIEW}#rose_preview_handoff=hc-1`,
    );
    fireEvent.click(within(view).getByRole('tab', { name: 'History' }));
    // Rose History = every version of the user's Rose UI.
    expect(await within(view).findByTestId('user-app-version-v0')).toBeInTheDocument();
    fireEvent.click(
      within(within(view).getByTestId('user-app-version-v1')).getByRole('button', {
        name: /^Restore/,
      }),
    );
    await waitFor(() =>
      expect(within(view).getByTestId('user-app-frame')).toHaveAttribute(
        'src',
        `${ROSE_PREVIEW}#rose_preview_handoff=hc-2`,
      ),
    );
    expect(handoff.calls()).toBe(2);
    expect(requests('GET', '/claude-code-session/t-rose/preview')).toHaveLength(2);
  });

  it('a failed restore keeps the list and shows one plain line', async () => {
    serveApps(appsBody([ROSE_APP, userApp()], 'v2'));
    server.use(
      http.post(`${API_BASE}/user-ui/versions/:id/activate`, () =>
        HttpResponse.json({ error: 'Version not found' }, { status: 404 }),
      ),
    );
    const view = await openApp('game');
    fireEvent.click(within(view).getByRole('tab', { name: 'History' }));
    fireEvent.click(
      within(await within(view).findByTestId('user-app-version-v1')).getByRole('button', {
        name: /^Restore/,
      }),
    );
    expect(await within(view).findByRole('alert')).toHaveTextContent(
      "Couldn't restore that version. Try again.",
    );
    expect(within(view).getByTestId('user-app-version-v1')).toBeInTheDocument();
  });
});

describe('Publish', () => {
  function publishPosts() {
    return capturedRequests.filter((r) => r.method === 'POST');
  }

  it('Rose: opens a PR and shows "Opened PR #n" with its link; never anything deploy-like', async () => {
    serveApps(appsBody([ROSE_APP]));
    servePreview('running');
    serveHandoff();
    server.use(
      http.post(`${API_BASE}/claude-code-session/t-rose/publish`, () =>
        HttpResponse.json({
          code_session_id: 'cs-rose',
          repo: 'Rose-Ai-Labs/rose',
          branch: 'rose-ui/header',
          base: 'main',
          head_sha: 'abc1234',
          pushed: true,
          pr: {
            number: 42,
            url: 'https://github.com/Rose-Ai-Labs/rose/pull/42',
            state: 'open',
            draft: false,
          },
          created: true,
          merged: false,
        }),
      ),
    );
    const view = await openApp('rose');
    await within(view).findByTestId('user-app-frame');
    clearCaptures();
    fireEvent.click(within(view).getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('Opened PR #42')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View pull request' })).toHaveAttribute(
      'href',
      'https://github.com/Rose-Ai-Labs/rose/pull/42',
    );
    const posts = publishPosts().map((r) => new URL(r.url).pathname);
    expect(posts).toEqual(['/api/claude-code-session/t-rose/publish']);
    expect(capturedRequests.some((r) => /deploy|merge/i.test(new URL(r.url).pathname))).toBe(false);
  });

  it.each([
    [409, 'NO_COMMITS'],
    [409, 'ON_MERGE_TARGET'],
    [502, 'PUSH_FAILED'],
    [502, 'GITHUB_UNAVAILABLE'],
  ])('Rose: %s %s maps to one plain line', async (status, code) => {
    serveApps(appsBody([ROSE_APP]));
    servePreview('running');
    serveHandoff();
    server.use(
      http.post(`${API_BASE}/claude-code-session/t-rose/publish`, () =>
        HttpResponse.json({ error: `raw backend text for ${code}`, code }, { status }),
      ),
    );
    const view = await openApp('rose');
    fireEvent.click(within(view).getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(PUBLISH_ERROR_TEXT[code])).toBeInTheDocument();
    expect(screen.queryByText(/raw backend text/)).not.toBeInTheDocument();
  });

  it('Rose: 403 ROSE_DEV_ONLY shows nothing', async () => {
    serveApps(appsBody([ROSE_APP]));
    servePreview('running');
    serveHandoff();
    server.use(
      http.post(`${API_BASE}/claude-code-session/t-rose/publish`, () =>
        HttpResponse.json({ error: 'dev only', code: 'ROSE_DEV_ONLY' }, { status: 403 }),
      ),
    );
    const view = await openApp('rose');
    fireEvent.click(within(view).getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(requests('POST', '/claude-code-session/t-rose/publish')).toHaveLength(1),
    );
    await waitFor(() =>
      expect(within(view).getByRole('button', { name: 'Publish' })).not.toBeDisabled(),
    );
    expect(screen.queryByText(/dev only|Couldn't publish/)).not.toBeInTheDocument();
  });

  it('user app: Publish shows its usercontent URL and Copy puts it on the clipboard', async () => {
    serveApps(appsBody([ROSE_APP, userApp()]));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = await openApp('game');
    fireEvent.click(within(view).getByRole('button', { name: 'Publish' }));
    const url = within(view).getByTestId('user-app-url');
    expect(url).toHaveTextContent(`${USERCONTENT}/v2/apps/game/index.html`);
    expect(url).toHaveAttribute('href', `${USERCONTENT}/v2/apps/game/index.html`);
    fireEvent.click(within(view).getByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${USERCONTENT}/v2/apps/game/index.html`),
    );
    expect(await within(view).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(requests('POST', '/claude-code-session/t-rose/publish')).toHaveLength(0);
  });
});
