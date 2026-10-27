/**
 * Blackbox: Rose Desktop chrome inside an installed iPhone PWA (standalone,
 * 430x932 Pro Max, status bar drawn over the page: --safe-area-inset-top is
 * the 59px Dynamic Island inset, so the mobile header is 3.5rem + 59px tall).
 *
 * Every surface that floats over the chat on a phone must stay inside the
 * screen and clear of the status bar, and an open agent must be closable:
 *   - the header is an opaque bar (chat content never shows through it)
 *   - an open agent has a Back control (sub-agent -> parent, root -> home)
 *   - Agent Settings stays on screen, opaque, below the mobile header
 *   - the bell's notification popover spans the screen below the header
 *   - the agents drawer's close X sits below the status bar, clear of the tabs
 *   - the sub-agent breadcrumb starts below the mobile header
 *   - the drawer's Logout row stays above the home indicator
 *   - an agent row's long-press menu stacks above the drawer (menus 220 > sheet 210)
 *     and opens from the row's left edge, not under the finger (a 345px menu
 *     anchored mid-row has room on neither side of a 430px screen)
 *   - Rename chosen from that menu opens above the drawer (dialogs and sheets
 *     share one modal layer, so the later-opened one is on top)
 *   - toasts drop below the status bar
 * jsdom has no layout engine: JS-computed geometry is asserted numerically,
 * CSS geometry from the declared classes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';

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
    created_at: '2026-10-27T00:00:00Z',
    updated_at: '2026-10-27T00:00:00Z',
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
    const right = Number.parseFloat(dialog.style.right);
    const width = inlineWidth(dialog);
    expect(right).toBeGreaterThanOrEqual(EDGE);
    expect(PHONE.width - right - width).toBeGreaterThanOrEqual(EDGE);

    expect(dialog.style.maxHeight).toContain('var(--mobile-terminal-header-height)');
    expect(dialog.style.backgroundColor).not.toBe('transparent');
    expect(dialog.className).toMatch(/(^|\s)bg-\[#EEEFF2\](\s|$)/);
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
