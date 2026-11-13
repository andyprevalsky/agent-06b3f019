/**
 * Blackbox: Rose Desktop chrome inside an installed iPhone PWA (standalone,
 * 430x932 Pro Max, status bar drawn over the page: --safe-area-inset-top is
 * the 59px Dynamic Island inset, so the mobile header is 3.5rem + 59px tall).
 *
 * Every surface that floats over the chat on a phone must stay inside the
 * screen and clear of the status bar, and an open agent must be closable:
 *   - the header is an opaque bar (chat content never shows through it)
 *   - an open agent has a Back control (sub-agent -> parent, root -> home)
 *   - Agent Settings stays on screen, opaque, below the mobile header, and
 *     re-fits when the phone rotates
 *   - the bell's notification popover spans the screen below the header
 *   - the agents drawer's close X sits below the status bar, clear of the tabs
 *   - the sub-agent breadcrumb starts below the mobile header
 *   - the drawer's Logout row stays above the home indicator
 *   - an agent row's long-press menu stacks above the drawer (menus 220 > sheet 211)
 *     and opens from the row's left edge, not under the finger (a 345px menu
 *     anchored mid-row has room on neither side of a 430px screen); lifting the
 *     finger does not also open the agent
 *   - Rename chosen from that menu opens above the drawer (dialogs and sheets
 *     share one modal tier, so the later-opened one is on top)
 *   - toasts drop below the status bar
 * jsdom has no layout engine: JS-computed geometry is asserted numerically,
 * CSS geometry from the declared classes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Toaster } from '@/components/ui/toaster';
import AgentSettingsDialog from '@/features/terminal-component-group/components/AgentSettingsDialog';
import { toast } from '@/hooks/use-toast';
import { SubAgentBreadcrumb } from '@/features/terminal/components/SubAgentBreadcrumb';
import { TerminalHeader } from '@/features/terminal/components/TerminalHeader';
import type { Agent, AgentDetail } from '@/lib/api';

import { renderWithProviders } from './test-wrapper';

const PHONE = { width: 430, height: 932 };
const EDGE = 8;

const dripStyles = {
  blur: 0,
  bgOpacity: 0.8,
  borderOpacity: 0.5,
  shadowIntensity: 1,
  glow: 0,
  glowOpacity: 0,
  saturation: 1,
  brightness: 1,
  backgroundColorsScalar: 1,
  borderColorScalar: 1,
  borderRgb: '0,0,0',
};

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function signIn() {
  const user = { id: 'pwa-user', is_anonymous: false };
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

function makeAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  // Keep fixtures recent on the sidebar clock, including mocked test dates.
  const recentTimestamp = new Date(Date.now()).toISOString();
  return {
    agent_id: 'agent-1',
    goal: 'Get me 10 candidates to interview',
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 1,
    status: 'COMPLETED',
    status_message: null,
    temporal_workflow_id: 'wf-1',
    token_count: 1000,
    tokens_in: 500,
    tokens_out: 300,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 20_000,
    message_count: 7,
    price_limit_cents: 1000,
    tree_cost_cents: 45,
    created_at: recentTimestamp,
    updated_at: recentTimestamp,
    write_lock_enabled: true,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
    response_schema: null,
    ...overrides,
  } as AgentDetail;
}

function renderHeader(overrides: Partial<ComponentProps<typeof TerminalHeader>> = {}) {
  const props = {
    onCreateNewAgent: vi.fn(),
    onRefreshAgents: vi.fn(),
    onSelectAgent: vi.fn(),
    onLoginClick: vi.fn(),
    onLogout: vi.fn(),
    isSignedIn: true,
    clientSource: 'WEB',
    agents: [],
    isLoadingAgents: false,
    hasLoadedAgents: true,
    selectedAgentId: null,
    dripStyles,
    blur: 0,
    backgroundColors: 0,
    borderColor: 0,
    shadowIntensity: 0,
    ...overrides,
  } as ComponentProps<typeof TerminalHeader>;
  renderWithProviders(<TerminalHeader {...props} />, { roseDesktop: true });
  return props;
}

/** Tailwind arbitrary z-index declared on an element (`z-[211]` -> 211). */
function zLayer(el: Element): number {
  const match = /(?:^|\s)z-\[(\d+)\]/.exec(el.className);
  return match ? Number(match[1]) : Number.NaN;
}

/** Effective rendered width of an inline `width` capped by an inline `max-width` (px or vw). */
function inlineWidth(el: HTMLElement): number {
  const toPx = (value: string) =>
    value.endsWith('vw')
      ? (Number.parseFloat(value) / 100) * window.innerWidth
      : Number.parseFloat(value);
  const width = toPx(el.style.width);
  return el.style.maxWidth ? Math.min(width, toPx(el.style.maxWidth)) : width;
}

/** The panel's horizontal extent from whichever fixed-position side is anchored. */
function panelX(el: HTMLElement): { left: number; right: number } {
  const width = inlineWidth(el);
  const left =
    el.style.left && el.style.left !== 'auto'
      ? Number.parseFloat(el.style.left)
      : window.innerWidth - Number.parseFloat(el.style.right) - width;
  return { left, right: left + width };
}

beforeEach(() => {
  localStorage.clear();
  signIn();
  setViewport(PHONE.width, PHONE.height);
});

afterEach(() => {
  vi.restoreAllMocks();
  setViewport(1024, 768);
  localStorage.clear();
});

describe('Rose mobile header in the installed PWA', () => {
  it('is an opaque bar that takes its own taps, so scrolled chat never shows through it', () => {
    renderHeader({ selectedAgentId: 'agent-1' });
    const header = screen.getByTestId('rose-mobile-header');
    expect(header.className).toMatch(/(^|\s)bg-background(\s|$)/);
    expect(header.className).not.toContain('pointer-events-none');
    expect(header.className).toContain('pt-[var(--safe-area-inset-top)]');
  });

  it('has no Back control on the home screen', () => {
    renderHeader({ selectedAgentId: null });
    expect(
      within(screen.getByTestId('rose-mobile-header')).queryByRole('button', { name: 'Back' }),
    ).toBeNull();
  });

  it('Back from an open root agent returns home', async () => {
    const user = userEvent.setup();
    const props = renderHeader({ selectedAgentId: 'root-1', selectedAgentParentId: null });
    await user.click(
      within(screen.getByTestId('rose-mobile-header')).getByRole('button', { name: 'Back' }),
    );
    expect(props.onCreateNewAgent).toHaveBeenCalledOnce();
    expect(props.onSelectAgent).not.toHaveBeenCalled();
  });

  it('Back from an open sub-agent opens its parent', async () => {
    const user = userEvent.setup();
    const props = renderHeader({ selectedAgentId: 'child-1', selectedAgentParentId: 'root-1' });
    await user.click(
      within(screen.getByTestId('rose-mobile-header')).getByRole('button', { name: 'Back' }),
    );
    expect(props.onSelectAgent).toHaveBeenCalledWith('root-1');
    expect(props.onCreateNewAgent).not.toHaveBeenCalled();
  });

  it('the bell popover spans the screen below the header instead of anchoring off-screen', async () => {
    const user = userEvent.setup();
    renderHeader({ selectedAgentId: 'agent-1' });
    await user.click(screen.getByRole('button', { name: 'Attention requests' }));
    const card = (await screen.findByText(/Congrats/)).closest('.shadow-lg') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.className).toContain('max-md:fixed');
    expect(card.className).toContain('max-md:inset-x-2');
    expect(card.className).toContain('max-md:top-[calc(var(--mobile-terminal-header-height)');
    expect(card.className).toContain('max-md:w-auto');
  });

  it('the agents drawer close X sits below the status bar and clear of the tabs', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog');
    const close = within(drawer).getByRole('button', { name: 'Close' });
    expect(close.className).toContain('var(--safe-area-inset-top)');
    expect(close.className).toMatch(/\bh-10\b/);
    expect(close.className).toMatch(/\bw-10\b/);
    const tabs = within(drawer).getByRole('button', { name: 'Agents' }).parentElement!;
    expect(tabs.className).toMatch(/\bpr-12\b/);
  });
});

describe('Agents drawer in the installed PWA', () => {
  it.each(['2040-01-01T12:00:00Z', '2099-07-01T12:00:00Z'])(
    'keeps fresh fixtures visible at %s while hiding agents older than four days',
    async (now) => {
      const epoch = Date.parse(now);
      vi.spyOn(Date, 'now').mockReturnValue(epoch);
      signIn();
      const fourDays = 4 * 24 * 60 * 60 * 1000;
      const agents = [
        makeAgent({ agent_id: 'fresh' }),
        makeAgent({
          agent_id: 'boundary',
          updated_at: new Date(epoch - fourDays).toISOString(),
        }),
        makeAgent({
          agent_id: 'old',
          updated_at: new Date(epoch - fourDays - 1).toISOString(),
        }),
      ] as Agent[];
      const user = userEvent.setup();
      renderHeader({ agents });
      await user.click(screen.getByRole('button', { name: 'Open menu' }));
      const drawer = within(await screen.findByRole('dialog'));
      expect(await drawer.findByTestId('rose-agent-row-fresh')).toBeInTheDocument();
      expect(drawer.getByTestId('rose-agent-row-boundary')).toBeInTheDocument();
      expect(drawer.queryByTestId('rose-agent-row-old')).toBeNull();
      await user.click(drawer.getByRole('button', { name: 'View 1 old agent' }));
      expect(drawer.getByTestId('rose-agent-row-old')).toBeInTheDocument();
    },
  );

  it('keeps the Logout row above the home indicator', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog');
    expect(drawer.className).toContain('pb-[var(--safe-area-inset-bottom)]');
    expect(drawer.className).toContain('pt-[var(--safe-area-inset-top)]');
  });

  it("an agent row's long-press menu stacks above the open drawer", async () => {
    const user = userEvent.setup();
    const agent = { ...makeAgent({ agent_id: 'row-1', goal: 'Halloween costume' }) } as Agent;
    renderHeader({ agents: [agent] });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog');
    const row = await within(drawer).findByTestId('rose-agent-row-row-1');
    fireEvent.contextMenu(row);
    const menu = await screen.findByTestId('rose-agent-menu');
    expect(zLayer(menu)).toBeGreaterThan(zLayer(drawer));
  });
});

describe('Long-press row menus on a phone', () => {
  it('open from the row left edge at the touch height, not under the finger', async () => {
    const user = userEvent.setup();
    const agent = { ...makeAgent({ agent_id: 'row-1', goal: 'Halloween costume' }) } as Agent;
    renderHeader({ agents: [agent] });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog');
    const row = await within(drawer).findByTestId('rose-agent-row-row-1');
    const anchors: Array<[number, number]> = [];
    const record = (event: MouseEvent) => anchors.push([event.clientX, event.clientY]);
    document.addEventListener('contextmenu', record, true);
    try {
      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 216, clientY: 300 });
      await screen.findByTestId('rose-agent-menu', {}, { timeout: 2000 });
      const left = row.getBoundingClientRect().left;
      expect(anchors).toEqual([[left + EDGE, 300]]);
    } finally {
      document.removeEventListener('contextmenu', record, true);
    }
  });
});

describe('Long-press on iOS', () => {
  it('never starts a text selection or callout on the row it opens the menu for', async () => {
    const user = userEvent.setup();
    const agent = { ...makeAgent({ agent_id: 'row-1', goal: 'Halloween costume' }) } as Agent;
    renderHeader({ agents: [agent] });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog');
    const row = await within(drawer).findByTestId('rose-agent-row-row-1');
    // WebKit ignores pointerdown preventDefault for its long-press; only CSS stops it.
    expect(row.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['select-none', '[-webkit-touch-callout:none]']),
    );
    const selection = window.getSelection()!;
    selection.selectAllChildren(row);
    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 216, clientY: 300 });
    // Finger jitter while holding still is not a drag.
    fireEvent.pointerMove(row, { pointerType: 'touch', clientX: 219, clientY: 303 });
    await screen.findByTestId('rose-agent-menu', {}, { timeout: 2000 });
    expect(selection.toString()).toBe('');
  });

  it('a real drag still cancels the long-press', () => {
    // Fake timers own the 700ms long-press timer, so passing it is deterministic.
    vi.useFakeTimers();
    try {
      renderWithProviders(
        <ContextMenu>
          <ContextMenuTrigger data-testid="row">Halloween costume</ContextMenuTrigger>
          <ContextMenuContent data-testid="menu">
            <ContextMenuItem>Rename agent</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>,
      );
      const row = screen.getByTestId('row');
      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 216, clientY: 300 });
      fireEvent.pointerMove(row, { pointerType: 'touch', clientX: 216, clientY: 330 });
      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(screen.queryByTestId('menu')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Native long-press contextmenu on Android', () => {
  it('opens once, from the trigger left edge, never under the finger', async () => {
    const opens: Array<[number, number]> = [];
    renderWithProviders(
      <ContextMenu>
        <ContextMenuTrigger
          data-testid="row"
          onContextMenu={(event) => opens.push([event.clientX, event.clientY])}
        >
          Halloween costume
        </ContextMenuTrigger>
        <ContextMenuContent data-testid="menu">
          <ContextMenuItem>Rename agent</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const row = screen.getByTestId('row');
    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 216, clientY: 300 });
    // Android Chrome fires its own contextmenu at the finger mid-press.
    fireEvent.contextMenu(row, { clientX: 216, clientY: 300 });
    await screen.findByTestId('menu');
    // Past the 700ms long-press timer: no second, re-anchoring open.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const left = row.getBoundingClientRect().left;
    expect(opens).toEqual([[left + EDGE, 300]]);
  });
});

describe('Long-press release on a phone', () => {
  it('does not also open the agent the finger lifts off', async () => {
    const user = userEvent.setup();
    const agent = { ...makeAgent({ agent_id: 'row-1', goal: 'Halloween costume' }) } as Agent;
    const props = renderHeader({ agents: [agent] });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog');
    const row = await within(drawer).findByTestId('rose-agent-row-row-1');
    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 216, clientY: 300 });
    await screen.findByTestId('rose-agent-menu', {}, { timeout: 2000 });
    fireEvent.pointerUp(row, { pointerType: 'touch', clientX: 216, clientY: 300 });
    fireEvent.click(row);
    expect(props.onSelectAgent).not.toHaveBeenCalled();
    expect(screen.getByTestId('rose-agent-menu')).toBeInTheDocument();
  });
});

describe('Rename from the mobile drawer', () => {
  it('opens its dialog above the still-open drawer', async () => {
    const user = userEvent.setup();
    const agent = { ...makeAgent({ agent_id: 'row-1', goal: 'Halloween costume' }) } as Agent;
    renderHeader({ agents: [agent] });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.contextMenu(await within(drawer).findByTestId('rose-agent-row-row-1'));
    await user.click(await screen.findByRole('menuitem', { name: /Rename agent/ }));
    const rename = await screen.findByRole('dialog', { name: /Rename/ });
    expect(rename).not.toBe(drawer);
    // Same layer, later in the document: the rename dialog paints over the drawer.
    expect(zLayer(rename)).toBeGreaterThanOrEqual(zLayer(drawer));
    expect(drawer.compareDocumentPosition(rename) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Toasts in the installed PWA', () => {
  it('drop below the status bar', async () => {
    renderWithProviders(<Toaster />, { roseDesktop: true });
    act(() => {
      toast({ title: 'Price limit updated' });
    });
    const title = await screen.findByText('Price limit updated');
    const viewport = title.closest('ol')!;
    expect(viewport).not.toBeNull();
    expect(viewport.className).toContain('pt-[calc(1rem+var(--safe-area-inset-top))]');
  });
});

describe('Agent Settings on a 430px phone', () => {
  it('opens on screen, opaque and below the mobile header, from the query-box nub gear', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog variant="nub" agent={makeAgent()} />, {
      roseDesktop: true,
    });
    const trigger = screen.getByRole('button', { name: 'Agent settings' });
    // Measured in the PWA: the nub gear sits at x 142-154, y 730-748.
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 142,
      right: 154,
      top: 730,
      bottom: 748,
      width: 12,
      height: 18,
      x: 142,
      y: 730,
      toJSON: () => ({}),
    });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');

    await waitFor(() => expect(dialog.style.right).not.toBe('16px'));
    const x = panelX(dialog);
    expect(x.left).toBeGreaterThanOrEqual(EDGE);
    expect(PHONE.width - x.right).toBeGreaterThanOrEqual(EDGE);

    expect(dialog.style.maxHeight).toContain('var(--mobile-terminal-header-height)');
    expect(dialog.style.backgroundColor).not.toBe('transparent');
    expect(dialog.className).toMatch(/(^|\s)bg-\[#EEEFF2\](\s|$)/);
  });

  it('re-fits the open panel when the phone rotates', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog variant="nub" agent={makeAgent()} />, {
      roseDesktop: true,
    });
    const trigger = screen.getByRole('button', { name: 'Agent settings' });
    const rect = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 142,
      right: 154,
      top: 730,
      bottom: 748,
      width: 12,
      height: 18,
      x: 142,
      y: 730,
      toJSON: () => ({}),
    });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.style.width).toBe(`${PHONE.width - 2 * EDGE}px`));

    // Landscape: 932x430, the gear moves with the query box.
    setViewport(PHONE.height, PHONE.width);
    rect.mockReturnValue({
      left: 142,
      right: 154,
      top: 330,
      bottom: 348,
      width: 12,
      height: 18,
      x: 142,
      y: 330,
      toJSON: () => ({}),
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(dialog.style.width).toBe('420px'));
    const x = panelX(dialog);
    expect(x.left).toBeGreaterThanOrEqual(EDGE);
    expect(PHONE.height - x.right).toBeGreaterThanOrEqual(EDGE);
    expect(dialog.style.bottom).toBe(`${PHONE.width - 330 + EDGE}px`);
  });
});

describe('Sub-agent breadcrumb under the mobile header', () => {
  it('starts below the safe-area-aware mobile header, keeping the desktop offset', () => {
    renderWithProviders(
      <SubAgentBreadcrumb
        ancestors={[]}
        agentDetail={makeAgent({ parent_agent_id: 'root-1', parent_goal: 'Parent goal' })}
        onSelectAgent={vi.fn()}
        dripStyles={dripStyles}
        blur={0}
      />,
    );
    const crumbRow = screen.getByRole('button', { name: 'Parent goal' }).closest('.absolute');
    expect(crumbRow).not.toBeNull();
    expect(crumbRow!.className).toContain('top-[calc(var(--mobile-terminal-header-height)');
    expect(crumbRow!.className).toContain('md:top-20');
  });
});
