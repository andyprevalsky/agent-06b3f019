/**
 * Blackbox: the trajectory live preview card (UI ledger rows 10/39) through the
 * real Terminal (Rose Desktop flag on).
 *
 *   metadata.code_agent.preview_url (dev cloud session) → the code-agent chip
 *   shows a small scaled live frame, only while the chip is on screen (each
 *   frame load takes a fresh POST …/preview/handoff code); clicking it opens
 *   the full-screen app view for that code session.
 *   Off screen: no frame, no reads. No preview_url: no card. Flag off: stock chip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';

import { chipMessage, renderChip } from './code-agent-steering.fixtures';
import { clearCaptures } from './msw/capture';
import {
  PREVIEW_URL,
  TASK_ID,
  openAgentWithChip,
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

function onScreenEverywhere() {
  window.IntersectionObserver =
    VisibleIntersectionObserver as unknown as typeof IntersectionObserver;
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
  it('on screen: a scaled live frame with a fresh sign-in code; clicking opens the app view', async () => {
    onScreenEverywhere();
    serveAgentWithChip();
    const handoff = serveHandoff();
    servePreview('running');
    await openAgentWithChip();

    // Every frame load (including a remount of the chip) uses the newest code.
    const cardFrame = () => screen.getByTestId('code-agent-preview-frame');
    await waitFor(() =>
      expect(cardFrame()).toHaveAttribute(
        'src',
        `${PREVIEW_URL}#rose_preview_handoff=hc-${handoff.calls()}`,
      ),
    );
    expect(cardFrame()).toHaveAttribute('loading', 'lazy');
    expect(cardFrame()).toHaveAttribute('tabindex', '-1');
    expect(cardFrame().getAttribute('style')).toContain('scale(0.1875)');
    expect(cardFrame().getAttribute('sandbox')).toContain('allow-same-origin');
    // The card reads nothing else: no preview status until the view is opened.
    expect(requests('GET', `/claude-code-session/${TASK_ID}/preview`)).toHaveLength(0);

    const cardCodes = handoff.calls();
    fireEvent.click(screen.getByRole('button', { name: 'Open Snake game preview' }));
    const view = await screen.findByTestId('app-view-screen');
    expect(within(view).getByRole('heading', { name: 'Snake game' })).toBeInTheDocument();
    // The full-screen frame takes its own fresh code (exactly one more mint).
    expect(await within(view).findByTestId('app-view-frame')).toHaveAttribute(
      'src',
      `${PREVIEW_URL}#rose_preview_handoff=hc-${cardCodes + 1}`,
    );
    expect(handoff.calls()).toBe(cardCodes + 1);
    expect(requests('GET', `/claude-code-session/${TASK_ID}/preview`)).toHaveLength(1);
  });

  it('a Codex session opens with its own steer label and the "Preview" title fallback', async () => {
    serveAgentWithChip({ provider: 'codex', title: undefined });
    serveHandoff();
    servePreview('running');
    const chip = await openAgentWithChip();
    fireEvent.click(await within(chip).findByRole('button', { name: 'Open app preview' }));
    const view = await screen.findByTestId('app-view-screen');
    expect(within(view).getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
    expect(
      within(screen.getByTestId('query-input-layer')).getByPlaceholderText(
        'Message Codex directly…',
      ),
    ).toBeInTheDocument();
  });

  it('off screen: the card holds no frame and makes no handoff call', async () => {
    serveAgentWithChip();
    const handoff = serveHandoff();
    const chip = await openAgentWithChip();
    expect(await within(chip).findByTestId('code-agent-preview-card')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(chip).queryByTestId('code-agent-preview-frame')).not.toBeInTheDocument();
    expect(handoff.calls()).toBe(0);
  });

  it.each(['PREVIEW_UNAVAILABLE', 'USER_SESSION_REQUIRED', 'CODE_TASK_NOT_FOUND'] as const)(
    'a %s mint leaves the card empty and still opens the view',
    async (refusal) => {
      onScreenEverywhere();
      serveAgentWithChip();
      const handoff = serveHandoff(refusal);
      servePreview('running');
      await openAgentWithChip();
      await screen.findByTestId('code-agent-preview-card');
      await waitFor(() => expect(handoff.calls()).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByTestId('code-agent-preview-frame')).not.toBeInTheDocument();
      expect(screen.queryByText(/refused/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Open Snake game preview' }));
      expect(await screen.findByTestId('app-view-screen')).toBeInTheDocument();
    },
  );

  it('no preview_url: no card', async () => {
    serveAgentWithChip({ preview_url: undefined });
    const chip = await openAgentWithChip();
    expect(within(chip).queryByTestId('code-agent-preview-card')).not.toBeInTheDocument();
  });

  it('a preview_url on the app origin is never framed', async () => {
    onScreenEverywhere();
    serveAgentWithChip({ preview_url: `${window.location.origin}/` });
    const handoff = serveHandoff();
    const chip = await openAgentWithChip();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(chip).queryByTestId('code-agent-preview-card')).not.toBeInTheDocument();
    expect(handoff.calls()).toBe(0);
  });

  it('flag off: the stock chip renders and no preview card exists', () => {
    renderChip(
      [chipMessage({ task_id: 'task-1', preview_url: PREVIEW_URL, target: 'cloud' })],
      false,
    );
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-agent-preview-card')).not.toBeInTheDocument();
  });
});
