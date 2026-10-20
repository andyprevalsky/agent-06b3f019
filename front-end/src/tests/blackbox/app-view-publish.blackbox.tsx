/**
 * Blackbox: Publish in the full-screen app view (Rose Desktop flag on, UI ledger
 * row 10), through the real Terminal.
 *
 *   Publish → POST /claude-code-session/:taskId/publish → toast "Opened PR #n"
 *   (an existing PR: "Updated PR #n") with its link; 409/502/404 codes → one
 *   plain line; 403 ROSE_DEV_ONLY → nothing. Never anything deploy- or merge-like.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { PUBLISH_ERROR_TEXT } from '@/features/terminal-component-group/components/app-view/publishErrors';

import { capturedRequests, clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  API_BASE,
  TASK_ID,
  openAppView,
  requests,
  serveAgentWithChip,
  serveHandoff,
  servePreview,
  serveTerminalBasics,
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

const PUBLISH_PATH = `/claude-code-session/${TASK_ID}/publish`;

function servePublish(reply: () => Response) {
  server.use(http.post(`${API_BASE}${PUBLISH_PATH}`, reply));
}

function publishResult(created: boolean) {
  return {
    code_session_id: 'cs-1',
    repo: 'Rose-Ai-Labs/rose',
    branch: 'rose-ui/snake',
    base: 'main',
    head_sha: 'abc1234',
    pushed: true,
    pr: {
      number: 42,
      url: 'https://github.com/Rose-Ai-Labs/rose/pull/42',
      state: 'open',
      draft: false,
    },
    created,
    merged: false,
  };
}

beforeEach(() => {
  localStorage.clear();
  clearCaptures();
  signInRoseDesktop();
  serveTerminalBasics();
  serveAgentWithChip();
  servePreview('running');
  serveHandoff();
});

afterEach(() => localStorage.clear());

describe('Publish', () => {
  it('opens a PR and shows "Opened PR #n" with its link; never anything deploy-like', async () => {
    servePublish(() => HttpResponse.json(publishResult(true)));
    const view = await openAppView();
    await within(view).findByTestId('app-view-frame');
    clearCaptures();
    fireEvent.click(within(view).getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('Opened PR #42')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View pull request' })).toHaveAttribute(
      'href',
      'https://github.com/Rose-Ai-Labs/rose/pull/42',
    );
    const posts = capturedRequests
      .filter((r) => r.method === 'POST')
      .map((r) => new URL(r.url).pathname);
    expect(posts).toEqual([`/api${PUBLISH_PATH}`]);
    expect(requests('POST', PUBLISH_PATH)[0].body).toEqual({});
    expect(capturedRequests.some((r) => /deploy|merge/i.test(new URL(r.url).pathname))).toBe(false);
  });

  it('an already-open PR updated by the push reads "Updated PR #n"', async () => {
    servePublish(() => HttpResponse.json(publishResult(false)));
    const view = await openAppView();
    fireEvent.click(within(view).getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Updated PR #42')).toBeInTheDocument();
  });

  it.each([
    [409, 'NO_COMMITS'],
    [409, 'ON_MERGE_TARGET'],
    [409, 'UNSUPPORTED_TARGET'],
    [502, 'PUSH_FAILED'],
    [502, 'GITHUB_UNAVAILABLE'],
    [404, 'CODE_TASK_NOT_FOUND'],
  ])('%s %s maps to one plain line', async (status, code) => {
    servePublish(() =>
      HttpResponse.json({ error: `raw backend text for ${code}`, code }, { status }),
    );
    const view = await openAppView();
    fireEvent.click(within(view).getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(PUBLISH_ERROR_TEXT[code])).toBeInTheDocument();
    expect(screen.queryByText(/raw backend text/)).not.toBeInTheDocument();
  });

  it('403 ROSE_DEV_ONLY shows nothing', async () => {
    servePublish(() =>
      HttpResponse.json({ error: 'dev only', code: 'ROSE_DEV_ONLY' }, { status: 403 }),
    );
    const view = await openAppView();
    fireEvent.click(within(view).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(requests('POST', PUBLISH_PATH)).toHaveLength(1));
    await waitFor(() =>
      expect(within(view).getByRole('button', { name: 'Publish' })).not.toBeDisabled(),
    );
    expect(screen.queryByText(/dev only|Couldn't publish/)).not.toBeInTheDocument();
  });

  it('shows "Publishing…" while the request is in flight and ignores a second click', async () => {
    let release: () => void = () => {};
    servePublish(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(HttpResponse.json(publishResult(true)));
        }) as unknown as Response,
    );
    const view = await openAppView();
    fireEvent.click(within(view).getByRole('button', { name: 'Publish' }));
    const busy = await within(view).findByRole('button', { name: 'Publishing…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    await waitFor(() => expect(requests('POST', PUBLISH_PATH)).toHaveLength(1));
    release();
    expect(await screen.findByText('Opened PR #42')).toBeInTheDocument();
    expect(requests('POST', PUBLISH_PATH)).toHaveLength(1);
  });
});
