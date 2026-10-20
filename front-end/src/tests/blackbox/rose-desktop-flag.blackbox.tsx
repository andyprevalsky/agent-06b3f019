/**
 * Rose Desktop feature flag (lib/roseDesktop.ts): the new chrome is on only for
 * flagged accounts; every other account keeps the stock UI.
 *
 * Query box (UI ledger rows 23, 31, 40, 43, 53), flag on vs off:
 *  - #31 the toolbar lives on a Rose-gradient tab behind the box (4px lip,
 *        grows to 18px and slides sideways on hover/tap); no in-box row
 *  - #40 write lock = one bare lock icon that toggles; unlocked = rose
 *  - #43 every tab item has an instant tooltip with the ledger's exact text;
 *        the info item opens About / Privacy / Terms
 *  - #53 dark-only glass send button; its CSS is scoped to html.dark
 *  - #32 bottom row: bare paperclip at the model selector's 26px height
 *        (speed toggle states live in fast-mode-toggle.blackbox.tsx)
 *  - #23 new agents default to rose-flash for flagged accounts
 */
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import { PopularGoalsCarousel } from '@/features/terminal/components/PopularGoalsCarousel';
import { POPULAR_GOALS, ROSE_DESKTOP_POPULAR_GOALS } from '@/features/terminal/config';
import { ROSE_DESKTOP_USER_IDS, isRoseDesktopUser } from '@/lib/roseDesktop';
import {
  defaultModelForAccount,
  useSelectedAgentModel,
} from '@/features/terminal/hooks/useTerminalAgents';
import { renderHook } from '@testing-library/react';

import { renderWithProviders } from './test-wrapper';

const ANDY = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

const queryProps = {
  value: '',
  onChange: vi.fn(),
  onSubmit: vi.fn(),
  selectedModel: 'rose-labs/rose-1-flash',
  availableModels: [
    { id: 'rose-labs/rose-1-flash', name: 'rose-fast', provider: 'rose-labs', description: 'fast' },
  ],
};

function renderGoals(roseDesktop: boolean) {
  return renderWithProviders(
    <PopularGoalsCarousel
      tickerOffset={0}
      tickerRef={createRef<HTMLDivElement>()}
      onGoalClick={vi.fn()}
      dripStyles={{} as never}
      borderColor={0}
    />,
    { roseDesktop },
  );
}

describe('Rose Desktop flag', () => {
  it('is on only for the allowlisted account', () => {
    expect(ROSE_DESKTOP_USER_IDS).toEqual([ANDY]);
    expect(isRoseDesktopUser({ id: ANDY })).toBe(true);
    expect(isRoseDesktopUser({ id: '8283e892-b0a4-4298-9ef7-b95bcc67e46b' })).toBe(false);
    expect(isRoseDesktopUser({ id: '' })).toBe(false);
    expect(isRoseDesktopUser(null)).toBe(false);
    expect(isRoseDesktopUser(undefined)).toBe(false);
  });

  it('stock UI keeps the query toolbar visible with no nub', () => {
    renderWithProviders(<QueryInput {...queryProps} />, { roseDesktop: false });
    expect(screen.queryByTestId('query-toolbar-region')).not.toBeInTheDocument();
    expect(screen.queryByTestId('query-toolbar-nub')).not.toBeInTheDocument();
    // Stock row: Safe Writes pill inside the box; stock send button, no glass.
    const surface = screen.getByTestId('query-input-surface');
    expect(within(surface).getByText('Safe Writes')).toBeInTheDocument();
    expect(document.querySelector('.rose-dark-glass')).toBeNull();
    expect(document.getElementById('rose-dark-glass-refraction')).toBeNull();
    expect(screen.getByTestId('query-input-host').className).not.toContain('mt-[14px]');
  });

  it('Rose Desktop hides the query toolbar behind the nub', () => {
    renderWithProviders(<QueryInput {...queryProps} />, { roseDesktop: true });
    expect(screen.getByTestId('query-toolbar-nub')).toBeInTheDocument();
    expect(screen.getByTestId('query-toolbar-region')).toHaveAttribute('data-state', 'closed');
  });

  it('new popular goals appear only with the flag, first in the rotation', () => {
    const { unmount } = renderGoals(false);
    for (const goal of ROSE_DESKTOP_POPULAR_GOALS) {
      expect(screen.queryByText(goal)).not.toBeInTheDocument();
    }
    expect(screen.getAllByText(POPULAR_GOALS[0]).length).toBeGreaterThan(0);
    unmount();

    renderGoals(true);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent(ROSE_DESKTOP_POPULAR_GOALS[0]);
  });
});

// ─── Query box: nub tab (#31), write lock (#40), tooltips (#43) ─────────────

function renderFlagged(props: Partial<React.ComponentProps<typeof QueryInput>> = {}) {
  return renderWithProviders(<QueryInput {...queryProps} {...props} />, { roseDesktop: true });
}

function tab() {
  return screen.getByTestId('query-toolbar-nub');
}

async function expectTip(user: ReturnType<typeof userEvent.setup>, el: Element, text: string) {
  await user.hover(el);
  // A popover-backed item (e.g. Tools) may still be closing its previous tip.
  await waitFor(() =>
    expect(screen.getAllByTestId('nub-tip').map((tip) => tip.textContent)).toContain(text),
  );
  await user.unhover(el);
}

describe('Rose Desktop query box: nub tab (#31)', () => {
  it('sits behind the box, flush left: a closed 4px lip, 34px wide', () => {
    renderFlagged();
    const nub = tab();
    const surface = screen.getByTestId('query-input-surface');
    // A sibling before the box (never inside it), the box stacked above it.
    expect(surface.contains(nub)).toBe(false);
    expect(nub.nextElementSibling).toBe(surface);
    expect(surface.className).toContain('z-[1]');
    expect(nub.className).toContain('z-0');
    expect(nub.className).toContain('left-0');
    expect(nub).toHaveAttribute('data-state', 'closed');
    expect(nub.style.top).toBe('-4px');
    expect(nub.style.height).toBe('16px'); // 4px lip + 12px wrapped behind the box corner
    expect(nub.style.width).toBe('34px');
    expect(nub.getAttribute('style')).toContain('linear-gradient(120deg');
    // Mask: the band above the box + the corner outside its 12px curve only.
    expect(nub).toHaveClass('rose-nub-tab');
    const maskRule = ROSE_QUERY_BOX_CSS.slice(ROSE_QUERY_BOX_CSS.indexOf('.rose-nub-tab {'));
    const mask = maskRule.slice(0, maskRule.indexOf('}'));
    expect(mask).toContain('calc(100% - 12px)');
    expect(mask).toContain('radial-gradient(circle 12px at 12px 12px, transparent 11.5px');
    expect(mask).toContain('0 100% / 12px');
    expect(screen.getByTestId('query-toolbar-region')).toHaveStyle({ opacity: '0' });
    // 30px gap to Popular Goals: goals mb-4 (16px) + host mt-[14px].
    expect(screen.getByTestId('query-input-host').className).toContain('mt-[14px]');
  });

  it('removes the old in-box toolbar row: every item is on the tab', () => {
    renderFlagged();
    const surface = screen.getByTestId('query-input-surface');
    expect(within(surface).queryByText('Safe Writes')).toBeNull();
    expect(within(surface).queryByLabelText('View Rose system tools')).toBeNull();
    const nub = tab();
    expect(within(nub).getByTestId('nub-write-lock')).toBeInTheDocument();
    expect(within(nub).getByLabelText('Select a test prompt')).toBeInTheDocument();
    expect(within(nub).getByLabelText('View Rose system tools')).toBeInTheDocument();
    expect(within(nub).getByTestId('nub-budget')).toHaveTextContent('$0.00 / 10.00');
    expect(within(nub).getByTestId('nub-context')).toHaveTextContent('0%');
    expect(within(nub).getByLabelText('Agent settings')).toBeInTheDocument();
    expect(within(nub).getByTestId('query-info-trigger')).toBeInTheDocument();
    // White 12px icons and 10px mono numbers, bare (no pill/chip wrappers).
    expect(screen.getByTestId('query-toolbar-region')).toHaveClass('text-white', 'h-[18px]');
    for (const item of within(nub).getAllByRole('button')) {
      expect(item).toHaveClass('[&_svg]:h-3', '[&_svg]:w-3', 'bg-transparent', 'border-0');
    }
    expect(within(nub).getByTestId('nub-budget')).toHaveClass('text-[10px]', 'font-mono');
    expect(within(nub).getByTestId('nub-context')).toHaveClass('text-[10px]', 'font-mono');
  });

  it('hover grows it to 18px and slides it sideways; leaving closes it', async () => {
    renderFlagged();
    fireEvent.pointerEnter(tab(), { pointerType: 'mouse' });
    expect(tab()).toHaveAttribute('data-state', 'open');
    expect(tab().style.top).toBe('-18px');
    expect(tab().style.height).toBe('30px');
    expect(parseInt(tab().style.width, 10)).toBeGreaterThan(34);
    const strip = screen.getByTestId('query-toolbar-region');
    expect(strip).toHaveAttribute('data-state', 'open');
    expect(strip).toHaveStyle({ opacity: '1', pointerEvents: 'auto' });

    fireEvent.pointerLeave(tab(), { pointerType: 'mouse' });
    await waitFor(() => expect(tab()).toHaveAttribute('data-state', 'closed'));
    expect(tab().style.height).toBe('16px');
    expect(strip).toHaveStyle({ pointerEvents: 'none' });
  });

  it('a tap pins it open; tapping an item keeps it open; tapping the tab closes it', () => {
    renderFlagged();
    fireEvent.pointerDown(tab(), { pointerType: 'touch' });
    fireEvent.click(tab());
    expect(tab()).toHaveAttribute('data-state', 'open');

    const lock = screen.getByTestId('nub-write-lock');
    fireEvent.pointerDown(lock, { pointerType: 'touch' });
    fireEvent.click(lock);
    expect(tab()).toHaveAttribute('data-state', 'open');

    fireEvent.pointerDown(tab(), { pointerType: 'touch' });
    fireEvent.click(tab());
    expect(tab()).toHaveAttribute('data-state', 'closed');
  });

  it('keyboard focus on an item opens it', () => {
    renderFlagged();
    fireEvent.focus(screen.getByTestId('nub-write-lock'));
    expect(tab()).toHaveAttribute('data-state', 'open');
  });
  it('a tap inside a portaled item menu never unpins the tab', async () => {
    renderFlagged();
    fireEvent.pointerDown(tab(), { pointerType: 'touch' });
    fireEvent.click(tab());
    const info = screen.getByTestId('query-info-trigger');
    fireEvent.pointerDown(info, { pointerType: 'touch' });
    fireEvent.click(info);
    const menu = await screen.findByTestId('query-info-menu');
    const nav = within(menu).getByRole('navigation');
    // The menu is portaled outside the tab's DOM; its clicks still bubble to the
    // tab through the React tree and must not toggle the pin.
    expect(tab().contains(nav)).toBe(false);
    fireEvent.pointerDown(nav, { pointerType: 'touch' });
    fireEvent.click(nav);
    expect(tab()).toHaveAttribute('data-state', 'open');
  });
});

describe('Rose Desktop query box: bottom row (#32)', () => {
  function paperclip() {
    return document.querySelector('svg.lucide-paperclip')!.closest('button')!;
  }

  it('attach is a bare paperclip at the model selector height; the stock box keeps the chip', () => {
    const { unmount } = renderFlagged();
    const bare = paperclip();
    expect(bare).toHaveAccessibleName('Attach files');
    expect(bare).toHaveAttribute('data-bare', 'true');
    expect(bare.className).toContain('bg-transparent');
    expect(bare.className).toContain('h-[26px]');
    expect(bare.className).toContain('w-[26px]');
    expect(bare.className).not.toMatch(/(^|\s)(border|rounded-lg|bg-gray-100|shadow\S*)(\s|$)/);
    // The model chip is 26px tall: text-xs line (16px) + py-1 (8px) + 1px border x2.
    const model = screen.getByText('rose-labs/rose-fast').closest('button')!;
    expect(model.className).toMatch(/(^|\s)text-xs(\s|$)/);
    expect(model.className).toMatch(/(^|\s)py-1(\s|$)/);
    expect(model.className).toMatch(/(^|\s)border(\s|$)/);
    unmount();

    renderWithProviders(<QueryInput {...queryProps} />, { roseDesktop: false });
    const stock = paperclip();
    expect(stock).not.toHaveAttribute('data-bare');
    expect(stock.className).toContain('border-gray-300');
    expect(stock.className).toContain('bg-gray-100');
    expect(stock.className).toContain('w-8');
  });
});

describe('Rose Desktop query box: write lock (#40) and tooltips (#43)', () => {
  it('the lock is one bare icon that toggles; unlocked turns rose', async () => {
    const user = userEvent.setup();
    renderFlagged();
    await user.hover(tab());
    const lock = screen.getByTestId('nub-write-lock');
    expect(lock).toHaveAttribute('data-state', 'locked');
    expect(lock).toHaveAccessibleName('Safe writes on');
    expect(lock.textContent).toBe('');
    expect(lock.className).not.toMatch(/(^|\s)(border|rounded-md|bg-muted\/50)(\s|$)/);
    expect(lock.querySelector('svg.lucide-lock')).not.toBeNull();

    await user.click(lock);
    expect(lock).toHaveAttribute('data-state', 'unlocked');
    expect(lock).toHaveAccessibleName('Writes unlocked');
    expect(lock.querySelector('svg.lucide-lock-open, svg.lucide-unlock')).not.toBeNull();
    expect(lock.style.color).toBe('rgb(200, 16, 79)');

    await user.click(lock);
    expect(lock).toHaveAttribute('data-state', 'locked');
    expect(lock.style.color).toBe('');
  });

  it('every item shows its instant tooltip with the exact text', async () => {
    const user = userEvent.setup();
    renderFlagged({ pendingPriceLimitCents: 250, contextPercentage: 12 });
    // Pin the tab open (tap) so moving between items never races the leave grace.
    fireEvent.pointerDown(tab(), { pointerType: 'touch' });
    fireEvent.click(tab());
    const nub = tab();
    const lock = within(nub).getByTestId('nub-write-lock');
    await expectTip(user, lock, 'Safe writes on · click to unlock');
    await user.click(lock);
    await user.unhover(lock);
    await expectTip(user, lock, 'Writes unlocked · click to lock');
    await expectTip(user, within(nub).getByLabelText('Select a test prompt'), 'Context files');
    await expectTip(user, within(nub).getByLabelText('View Rose system tools'), 'Tools');
    await expectTip(user, within(nub).getByTestId('nub-budget'), 'Budget used · $0.00 of $2.50');
    await expectTip(user, within(nub).getByTestId('nub-context'), 'Context window used');
    await expectTip(user, within(nub).getByLabelText('Agent settings'), 'Agent settings');
    await expectTip(user, within(nub).getByTestId('query-info-trigger'), 'About · Privacy · Terms');
  });

  it('tab items carry no native title (the tooltip never doubles up)', () => {
    renderFlagged();
    for (const el of within(tab()).getAllByRole('button')) {
      expect(el).not.toHaveAttribute('title');
    }
  });

  it('the info item opens a small menu linking About, Privacy and Terms', async () => {
    const user = userEvent.setup();
    renderFlagged();
    await user.hover(tab());
    await user.click(screen.getByTestId('query-info-trigger'));
    const menu = await screen.findByTestId('query-info-menu');
    const links = within(menu).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['About', '/about'],
      ['Privacy', '/privacy'],
      ['Terms', '/terms'],
    ]);
    // Using the menu keeps the tab open (portaled events bubble through React).
    expect(tab()).toHaveAttribute('data-state', 'open');
  });
});

// ─── Send button (#53) and new-agent model default (#23) ────────────────────

const ROSE_QUERY_BOX_CSS = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../features/terminal-component-group/components/query-input/roseQueryBox.css',
  ),
  'utf8',
);

function cssSelectorsMentioning(css: string, needle: string): string[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((block) => block.split('{')[0]!.trim())
    .filter((selector) => selector.includes(needle));
}

describe('Rose Desktop query box: dark-only glass send (#53)', () => {
  it('marks the send and stop buttons and renders the refraction filter', () => {
    const { unmount } = renderFlagged({ value: 'go' });
    const send = document.querySelector('button.liquid-metal-wrapper');
    expect(send).toHaveClass('rose-dark-glass');
    expect(document.getElementById('rose-dark-glass-refraction')?.tagName).toBe('filter');
    for (const layer of ['liquid-white-shader', 'liquid-white-chrome', 'liquid-white-face']) {
      expect(send?.querySelector(`.${layer}`)).not.toBeNull();
    }
    unmount();

    renderFlagged({ canSubmit: false, onPause: vi.fn() });
    expect(document.querySelector('button.liquid-metal-wrapper')).toHaveClass('rose-dark-glass');
  });

  it('every glass rule is scoped to html.dark, so light mode keeps the stock button', () => {
    const selectors = cssSelectorsMentioning(ROSE_QUERY_BOX_CSS, 'rose-dark-glass');
    expect(selectors.length).toBeGreaterThanOrEqual(5);
    for (const selector of selectors) {
      for (const part of selector.split(',')) expect(part.trim()).toMatch(/^html\.dark /);
    }
    expect(ROSE_QUERY_BOX_CSS).toContain('url(#rose-dark-glass-refraction)');
  });
});

describe('Rose Desktop new-agent defaults (#23)', () => {
  const signedIn = (id: string) => ({ isAnonymous: false, isFullySignedIn: true, user: { id } });

  it('defaults new agents to rose-flash for flagged accounts only', () => {
    expect(defaultModelForAccount(signedIn(ANDY))).toBe('rose-labs/rose-1-flash');
    expect(defaultModelForAccount(signedIn('8283e892-b0a4-4298-9ef7-b95bcc67e46b'))).toBe(
      'rose-labs/rose-1-ultra',
    );
    expect(
      defaultModelForAccount({ isAnonymous: true, isFullySignedIn: false, user: { id: ANDY } }),
    ).toBe('rose-labs/rose-1-ultra');
  });

  it('a new conversation (or an agent without a model) selects that default', () => {
    const setSelectedModel = vi.fn();
    const ref = { current: false };
    renderHook(() =>
      useSelectedAgentModel(
        null,
        undefined,
        undefined,
        setSelectedModel,
        ref,
        'rose-labs/rose-1-flash',
      ),
    );
    expect(setSelectedModel).toHaveBeenLastCalledWith('rose-labs/rose-1-flash');
  });
});
