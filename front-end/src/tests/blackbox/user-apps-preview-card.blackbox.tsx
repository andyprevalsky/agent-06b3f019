/**
 * Blackbox: the trajectory live preview card (UI ledger rows 10/39) through the
 * real Terminal (Rose Desktop flag on).
 *
 *   metadata.code_agent.preview_url (dev cloud session) → the code-agent chip
 *   shows a small scaled live frame, only while the chip is on screen (each
 *   frame load takes a fresh POST …/preview/handoff code); clicking it opens
 *   the full-screen app view for that task (Rose when it is Rose's session).
 *   Off screen: no frame, no reads. Flag off: the stock chip, no card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';

import { chipMessage, renderChip } from './code-agent-steering.fixtures';
import { clearCaptures } from './msw/capture';
import { server } from './msw/server';
import {
  API_BASE,
  ROSE_APP,
  ROSE_PREVIEW,
  appsBody,
  renderTerminal,
  requests,
  serveApps,
  serveHandoff,
  servePreview,
  serveTerminalBasics,
  signInRoseDesktop,
} from './user-apps.fixtures';

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

const CARD_PREVIEW = 'https://5173-sbx-card.e2b.test/';

/** IntersectionObserver that reports every observed element as on screen. */
class VisibleIntersectionObserver {
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

const originalObserver = window.IntersectionObserver;

function serveAgentWithChip(codeAgent: Record<string, unknown>) {
  const message = chipMessage({
    task_id: 't-card',
    provider: 'claude',
    target: 'cloud',
    state: 'live',
    title: 'Snake game',
    preview_url: CARD_PREVIEW,
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

async function openAgentWithChip() {
  renderTerminal();
  fireEvent.click(await screen.findByTestId('rose-agent-row-agent-001'));
  return await screen.findByTestId('code-agent-chip');
}

beforeEach(() => {
  localStorage.clear();
  clearCaptures();
  resetCodeAgentLocalState();
  signInRoseDesktop();
  serveTerminalBasics();
});

afterEach(() => {
  window.IntersectionObserver = originalObserver;
  localStorage.clear();
});

describe('trajectory live preview card', () => {
  it('on screen: a scaled live frame with a fresh sign-in code; clicking opens the app view for that task', async () => {
    window.IntersectionObserver =
      VisibleIntersectionObserver as unknown as typeof IntersectionObserver;
    serveApps(appsBody([ROSE_APP]));
    serveAgentWithChip({});
    const handoff = serveHandoff();
    servePreview('running', { taskId: 't-card', previewUrl: CARD_PREVIEW });
    const chip = await openAgentWithChip();

    const frame = await within(chip).findByTestId('code-agent-preview-frame');
    expect(frame).toHaveAttribute('src', `${CARD_PREVIEW}#rose_preview_handoff=hc-1`);
    expect(frame).toHaveAttribute('loading', 'lazy');
    expect(frame.getAttribute('style')).toContain('scale(0.1875)');
    expect(handoff.calls()).toBe(1);
    // The card reads nothing else: no preview status until an app is opened.
    expect(requests('GET', '/claude-code-session/t-card/preview')).toHaveLength(0);

    fireEvent.click(within(chip).getByRole('button', { name: 'Open Snake game preview' }));
    const view = await screen.findByTestId('user-app-screen');
    expect(view).toHaveAttribute('data-app-kind', 'session');
    expect(within(view).getByRole('heading', { name: 'Snake game' })).toBeInTheDocument();
    expect(await within(view).findByTestId('user-app-frame')).toHaveAttribute(
      'src',
      `${CARD_PREVIEW}#rose_preview_handoff=hc-2`,
    );
    // A bare session has no published versions: Preview only, and the box steers it.
    expect(within(view).queryByRole('tab', { name: 'History' })).not.toBeInTheDocument();
    expect(within(view).getByPlaceholderText('Message Snake game directly…')).toBeInTheDocument();
  });

  it("a card for Rose's own session opens the Rose app view", async () => {
    window.IntersectionObserver =
      VisibleIntersectionObserver as unknown as typeof IntersectionObserver;
    serveApps(appsBody([ROSE_APP]));
    serveAgentWithChip({ task_id: 't-rose', preview_url: ROSE_PREVIEW, title: 'Sticky header' });
    serveHandoff();
    servePreview('running');
    const chip = await openAgentWithChip();
    fireEvent.click(
      await within(chip).findByRole('button', { name: 'Open Sticky header preview' }),
    );
    const view = await screen.findByTestId('user-app-screen');
    expect(view).toHaveAttribute('data-app-kind', 'builtin');
    expect(within(view).getByRole('heading', { name: 'Rose' })).toBeInTheDocument();
    expect(screen.getByTestId('rose-app-row-rose')).toHaveAttribute('data-selected', 'true');
  });

  it('off screen: the card holds no frame and makes no handoff call', async () => {
    serveApps(appsBody([ROSE_APP]));
    serveAgentWithChip({});
    const handoff = serveHandoff();
    const chip = await openAgentWithChip();
    expect(await within(chip).findByTestId('code-agent-preview-card')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(chip).queryByTestId('code-agent-preview-frame')).not.toBeInTheDocument();
    expect(handoff.calls()).toBe(0);
  });

  it('no preview_url: no card', async () => {
    serveApps(appsBody([ROSE_APP]));
    serveAgentWithChip({ preview_url: undefined });
    const chip = await openAgentWithChip();
    expect(within(chip).queryByTestId('code-agent-preview-card')).not.toBeInTheDocument();
  });

  it('flag off: the stock chip renders and no preview card exists', () => {
    renderChip(
      [chipMessage({ task_id: 'task-1', preview_url: CARD_PREVIEW, target: 'cloud' })],
      false,
    );
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-agent-preview-card')).not.toBeInTheDocument();
  });
});
