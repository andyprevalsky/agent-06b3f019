/**
 * Blackbox: the code-agent chip's way into the app view (UI ledger rows 10/39)
 * through the real Terminal (Rose Desktop flag on).
 *
 *   metadata.code_agent.preview_url (dev cloud session) → the chip header shows a
 *   plain "Open app" button that opens the full-screen app view for that code
 *   session. The chip itself frames nothing (no live preview card, no handoff
 *   mint) even on screen (Andy 2026-10-26: no preview video in the root display).
 *   No preview_url / same-origin URL: no button. Flag off: stock chip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

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

describe('code-agent chip app entry', () => {
  it('on screen: no preview frame or card in the chip; "Open app" opens the app view', async () => {
    onScreenEverywhere();
    serveAgentWithChip();
    const handoff = serveHandoff();
    servePreview('running');
    const chip = await openAgentWithChip();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(chip).queryByTestId('code-agent-preview-card')).not.toBeInTheDocument();
    expect(within(chip).queryByTestId('code-agent-preview-frame')).not.toBeInTheDocument();
    expect(chip.querySelector('iframe, video')).toBeNull();
    // The chip reads nothing for the app: no mint, no preview status.
    expect(handoff.calls()).toBe(0);
    expect(requests('GET', `/claude-code-session/${TASK_ID}/preview`)).toHaveLength(0);

    fireEvent.click(within(chip).getByRole('button', { name: 'Open app' }));
    const view = await screen.findByTestId('app-view-screen');
    expect(within(view).getByRole('heading', { name: 'Snake game' })).toBeInTheDocument();
    expect(await within(view).findByTestId('app-view-frame')).toHaveAttribute(
      'src',
      `${PREVIEW_URL}#rose_preview_handoff=hc-1`,
    );
    expect(handoff.calls()).toBe(1);
  });

  it('a Codex session opens with its own steer label and the "Preview" title fallback', async () => {
    serveAgentWithChip({ provider: 'codex', title: undefined });
    serveHandoff();
    servePreview('running');
    const chip = await openAgentWithChip();
    fireEvent.click(await within(chip).findByRole('button', { name: 'Open app' }));
    const view = await screen.findByTestId('app-view-screen');
    expect(within(view).getByRole('heading', { name: 'Preview' })).toBeInTheDocument();
    expect(
      within(screen.getByTestId('query-input-layer')).getByPlaceholderText(
        'Message Codex directly…',
      ),
    ).toBeInTheDocument();
  });

  it('no preview_url: no button', async () => {
    serveAgentWithChip({ preview_url: undefined });
    const chip = await openAgentWithChip();
    expect(within(chip).queryByRole('button', { name: 'Open app' })).not.toBeInTheDocument();
  });

  it('a preview_url on the app origin is never offered', async () => {
    onScreenEverywhere();
    serveAgentWithChip({ preview_url: `${window.location.origin}/` });
    const handoff = serveHandoff();
    const chip = await openAgentWithChip();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(chip).queryByRole('button', { name: 'Open app' })).not.toBeInTheDocument();
    expect(handoff.calls()).toBe(0);
  });

  it('flag off: the stock chip renders and no app button exists', () => {
    renderChip(
      [chipMessage({ task_id: 'task-1', preview_url: PREVIEW_URL, target: 'cloud' })],
      false,
    );
    expect(screen.queryByTestId('code-agent-chip')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open app' })).not.toBeInTheDocument();
  });
});
