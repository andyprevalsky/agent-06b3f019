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
import { fireEvent, screen, within } from '@testing-library/react';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';

import { chipMessage, renderChip } from './code-agent-steering.fixtures';
import { clearCaptures } from './msw/capture';
import {
  PREVIEW_URL,
  TASK_ID,
  VisibleIntersectionObserver,
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
    const chip = await openAgentWithChip();

    const frame = await within(chip).findByTestId('code-agent-preview-frame');
    expect(frame).toHaveAttribute('src', `${PREVIEW_URL}#rose_preview_handoff=hc-1`);
    expect(frame).toHaveAttribute('loading', 'lazy');
    expect(frame).toHaveAttribute('tabindex', '-1');
    expect(frame.getAttribute('style')).toContain('scale(0.1875)');
    expect(frame.getAttribute('sandbox')).toContain('allow-same-origin');
    expect(handoff.calls()).toBe(1);
    // The card reads nothing else: no preview status until the view is opened.
    expect(requests('GET', `/claude-code-session/${TASK_ID}/preview`)).toHaveLength(0);

    fireEvent.click(within(chip).getByRole('button', { name: 'Open Snake game preview' }));
    const view = await screen.findByTestId('app-view-screen');
    expect(within(view).getByRole('heading', { name: 'Snake game' })).toBeInTheDocument();
    // The full-screen frame takes its own fresh code.
    expect(await within(view).findByTestId('app-view-frame')).toHaveAttribute(
      'src',
      `${PREVIEW_URL}#rose_preview_handoff=hc-2`,
    );
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
    expect(within(view).getByPlaceholderText('Message Codex directly…')).toBeInTheDocument();
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
