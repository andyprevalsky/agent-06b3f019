/**
 * Blackbox tests for AppSidebar agent rows: generated-title display with goal
 * fallback, pinned/run-state sorting, row chrome, the shared trailing slot
 * (duration at rest, actions on hover), the row context menu, the archive
 * button, and the archived-agents dialog. Sidebar chrome lives in
 * app-sidebar.blackbox.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import {
  SIDEBAR_WIDTH_EXPANDED,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from '@/features/terminal-component-group/config';
import { defaultProps, makeAgent, mockSession, openRowMenu, renderStockSidebar } from './app-sidebar.fixtures';

describe('AppSidebar rows', () => {
  beforeEach(() => {
    mockSession();
    // Row titles, search and actions are exercised in the expanded layout.
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(SIDEBAR_WIDTH_EXPANDED));
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders the generated title instead of the raw goal, falling back to goal', async () => {
    const agents = [
      makeAgent({
        agent_id: 'titled',
        goal: 'book me a table for four at a sushi place in soho on saturday',
        title: 'Soho Sushi Reservation',
      }),
      makeAgent({ agent_id: 'untitled', goal: 'Short raw goal', title: null }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    expect(await screen.findByText('Soho Sushi Reservation')).toBeInTheDocument();
    // The long goal is not rendered as the label...
    expect(
      screen.queryByText('book me a table for four at a sushi place in soho on saturday'),
    ).not.toBeInTheDocument();
    // ...but a title-less agent still shows its goal, so a failed generation is
    // cosmetic rather than a blank row.
    expect(screen.getByText('Short raw goal')).toBeInTheDocument();
  });

  it('preserves the full fallback goal and lets the row truncate only at its real edge', async () => {
    const longGoal =
      'Order another conditioner from Purador on Amazon and confirm the total and delivery date';
    renderStockSidebar(
      <AppSidebar
        {...defaultProps({
          agents: [makeAgent({ agent_id: 'long-fallback', goal: longGoal, title: null })],
        })}
      />,
    );

    const heading = await screen.findByRole('heading', { level: 3 });
    // The data must stay intact. CSS owns visual ellipsis at the actual row
    // boundary; a character-count cap creates empty space on wider sidebars.
    expect(heading).toHaveTextContent(longGoal);
    expect(heading.className).toContain('truncate');
    expect(heading.className).toContain('min-w-0');
  });

  it('sorts pinned agents above newer unpinned ones', async () => {
    const agents = [
      makeAgent({
        agent_id: 'newer',
        goal: 'Newer unpinned',
        status: 'ACTIVE',
        created_at: '2026-05-01T00:00:00Z',
      }),
      makeAgent({
        agent_id: 'pinned',
        goal: 'Older but pinned',
        status: 'ACTIVE',
        created_at: '2024-01-01T00:00:00Z',
        pinned_at: '2026-01-01T00:00:00Z',
      }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    const nodes = await screen.findAllByRole('heading', { level: 3 });
    expect(nodes.map((n) => n.textContent)[0]).toBe('Older but pinned');
    // The pinned marker IS the row's pin action: a pinned row offers "Unpin"
    // and keeps that control visible outside hover.
    expect(screen.getByLabelText('Unpin Older but pinned')).toBeInTheDocument();
    expect(screen.getByLabelText('Pin Newer unpinned')).toBeInTheDocument();
  });

  it('leaves rows unfilled at rest, colouring only on hover or selection', async () => {
    const agents = [
      makeAgent({ agent_id: 'a1', goal: 'Unselected row', status: 'ACTIVE' }),
      makeAgent({ agent_id: 'a2', goal: 'Selected row', status: 'ACTIVE' }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents, selectedAgentId: 'a2' })} />);

    const row = (text: string) =>
      screen.getByText(text).closest('div[class*="group/row"]') as HTMLElement;

    await screen.findByText('Unselected row');

    // At rest an unselected row carries no fill and no border — a list of filled
    // cards fights the content. Colour is reserved for hover.
    const idle = row('Unselected row').className;
    expect(idle).toContain('hover:bg-navi-white-dark');
    expect(idle).not.toMatch(/(^|\s)bg-/);
    expect(idle).not.toMatch(/(^|\s)border(\s|$)/);

    // Selection keeps a persistent fill so the current agent stays identifiable
    // once the pointer moves away.
    expect(row('Selected row').className).toMatch(/(^|\s)bg-navi-white-dark/);
  });

  it('keeps expanded agent rows compact', async () => {
    const agents = [makeAgent({ agent_id: 'a1', goal: 'Compact row', status: 'ACTIVE' })];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    const row = (await screen.findByText('Compact row')).closest(
      'div[class*="group/row"]',
    ) as HTMLElement;
    expect(row.className).toContain('py-1');
    expect(row.className).not.toContain('py-1.5');
  });

  it('styles the task name identically in every run state', async () => {
    const agents = [
      makeAgent({
        agent_id: 'running',
        goal: 'Running now',
        status: 'ACTIVE',
        temporal_workflow_id: 'wf-running',
      }),
      makeAgent({ agent_id: 'blocked', goal: 'Blocked now', status: 'OUT_OF_CREDITS' }),
      makeAgent({ agent_id: 'finished', goal: 'Finished now', status: 'COMPLETED' }),
      makeAgent({ agent_id: 'broken', goal: 'Broken now', status: 'FAILED' }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    // The indicator carries the state; the name must not. A title that changes
    // colour or weight as a run progresses makes the list feel unstable.
    const classes = (await screen.findAllByRole('heading', { level: 3 })).map((n) => n.className);
    expect(new Set(classes).size).toBe(1);
  });

  it('shows a live duration on active rows only', async () => {
    const agents = [
      makeAgent({
        agent_id: 'running',
        goal: 'Running now',
        status: 'ACTIVE',
        temporal_workflow_id: 'wf-running',
        created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
      }),
      makeAgent({
        agent_id: 'finished',
        goal: 'All done',
        status: 'COMPLETED',
        created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
      }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    // The active row carries its elapsed label; a finished row must not, since a
    // frozen timer reads as a stalled agent.
    expect(await screen.findByText('4m')).toBeInTheDocument();
    expect(screen.queryAllByText('4m')).toHaveLength(1);
  });

  it('parks the duration and the row actions in one shared trailing slot', async () => {
    const agents = [
      makeAgent({
        agent_id: 'running',
        goal: 'Running now',
        status: 'ACTIVE',
        temporal_workflow_id: 'wf-running',
        created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
      }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    const elapsed = await screen.findByText('4m');
    const archive = screen.getByLabelText('Archive Running now');

    // Same slot: the duration hides on hover and the actions take its place, so
    // the actions land identically on every row regardless of a duration.
    const slot = elapsed.closest('span.relative') as HTMLElement;
    expect(slot).toBeTruthy();
    expect(slot.contains(archive)).toBe(true);

    // At rest the slot is only as wide as the visible duration. Hover actions
    // overlay the right edge instead of permanently stealing 60px from titles.
    expect(slot.className).not.toContain('w-[3.75rem]');
    expect(archive.parentElement?.className).toContain('absolute');

    expect(elapsed.parentElement?.className).toContain('group-hover/row:opacity-0');
    expect(archive.parentElement?.className).toContain('group-hover/row:opacity-100');
  });

  it('keeps row actions focusable for keyboard users', async () => {
    const agents = [makeAgent({ agent_id: 'a1', goal: 'Keyboard row', status: 'ACTIVE' })];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    const archive = await screen.findByLabelText('Archive Keyboard row');
    // Hidden by opacity, never by `hidden`/display:none — the latter would drop
    // the button out of the tab order for anyone who never fires a hover event.
    expect(archive.parentElement?.className).toContain('group-focus-within/row:opacity-100');
    expect(archive.parentElement?.className).not.toContain('hidden');
    archive.focus();
    expect(document.activeElement).toBe(archive);
  });

  it('keeps a pinned row identifiable at rest, once the actions are hidden', async () => {
    const agents = [
      makeAgent({
        agent_id: 'pinned',
        goal: 'Pinned row',
        status: 'COMPLETED',
        pinned_at: '2026-01-01T00:00:00Z',
      }),
      makeAgent({ agent_id: 'plain', goal: 'Plain row', status: 'COMPLETED' }),
    ];
    const { container } = renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);
    await screen.findByText('Pinned row');

    // A resting pin marker, distinct from the hover-only pin BUTTON — without it
    // a pinned row reads exactly like an unpinned one until you hover it.
    const markers = container.querySelectorAll('svg[aria-hidden="true"].fill-current');
    expect(markers).toHaveLength(1);
  });

  it('formats a multi-day run compactly', async () => {
    const agents = [
      makeAgent({
        agent_id: 'long',
        goal: 'Long haul',
        status: 'ACTIVE',
        temporal_workflow_id: 'wf-long',
        created_at: new Date(Date.now() - (2 * 24 * 60 + 4 * 60) * 60_000).toISOString(),
      }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);
    expect(await screen.findByText('2d 4h')).toBeInTheDocument();
  });

  it('floats a needs-help row above active ones', async () => {
    const agents = [
      makeAgent({
        agent_id: 'active',
        goal: 'Still working',
        status: 'ACTIVE',
        temporal_workflow_id: 'wf-active',
        created_at: '2026-05-01T00:00:00Z',
      }),
      makeAgent({
        agent_id: 'blocked',
        goal: 'Waiting on you',
        status: 'OUT_OF_CREDITS',
        created_at: '2024-01-01T00:00:00Z',
      }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    const nodes = await screen.findAllByRole('heading', { level: 3 });
    // Older, but blocked on the user — a needs-help row buried under active runs
    // is one you never see.
    expect(nodes.map((n) => n.textContent)).toEqual(['Waiting on you', 'Still working']);
  });

  it('shows a checkmark for chat-mode agents that never started a cloud agent', async () => {
    const agents = [
      makeAgent({
        agent_id: 'chat-only',
        goal: '20g to floz',
        status: 'ACTIVE',
        temporal_workflow_id: null,
      }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    expect(await screen.findByText('20g to floz')).toBeInTheDocument();
    expect(screen.getByLabelText('Completed')).toBeInTheDocument();
    expect(document.querySelector('[data-letter]')).toBeNull();
  });

  it('groups pinned agents under a Pinned header', async () => {
    const agents = [
      makeAgent({
        agent_id: 'p1',
        goal: 'Pinned one',
        status: 'ACTIVE',
        pinned_at: '2026-01-01T00:00:00Z',
      }),
      makeAgent({ agent_id: 'u1', goal: 'Unpinned one', status: 'ACTIVE' }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    expect(await screen.findByText('Pinned')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((n) => n.textContent);
    expect(headings).toEqual(['Pinned one', 'Unpinned one']);
  });

  it('hides the Pinned header when nothing is pinned', async () => {
    const agents = [makeAgent({ agent_id: 'u1', goal: 'Unpinned one', status: 'ACTIVE' })];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);
    await screen.findByText('Unpinned one');
    // An empty "Pinned" label is just a wasted row.
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
  });

  it('filters the list by the search box, matching title or raw goal', async () => {
    const u = userEvent.setup();
    const agents = [
      makeAgent({ agent_id: 'a1', goal: 'Book a flight to Tokyo', title: 'Tokyo trip' }),
      makeAgent({ agent_id: 'a2', goal: 'Order groceries', title: 'Grocery run' }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);
    await screen.findByText('Tokyo trip');

    await u.type(screen.getByLabelText('Search agents'), 'grocer');
    await waitFor(() => expect(screen.queryByText('Tokyo trip')).not.toBeInTheDocument());
    expect(screen.getByText('Grocery run')).toBeInTheDocument();

    // A generated title is a lossy summary, so the raw goal must match too —
    // searching a word the user actually typed has to find their run.
    await u.clear(screen.getByLabelText('Search agents'));
    await u.type(screen.getByLabelText('Search agents'), 'flight');
    await waitFor(() => expect(screen.getByText('Tokyo trip')).toBeInTheDocument());
    expect(screen.queryByText('Grocery run')).not.toBeInTheDocument();
  });

  it('finds a chat when only its message content matches', async () => {
    const u = userEvent.setup();
    const contentMatch = makeAgent({
      agent_id: 'content-match',
      goal: 'Plan the quarterly offsite',
      title: 'Team offsite',
    });
    let requestedQuery = '';
    server.use(
      http.get('*/api/agents/search', ({ request }) => {
        requestedQuery = new URL(request.url).searchParams.get('q') ?? '';
        return HttpResponse.json({ agents: [contentMatch] });
      }),
    );
    renderStockSidebar(
      <AppSidebar
        {...defaultProps({
          agents: [makeAgent({ agent_id: 'other', goal: 'Order groceries' })],
        })}
      />,
    );

    await u.type(screen.getByLabelText('Search agents'), 'saxophone');

    expect(await screen.findByText('Team offsite', {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(requestedQuery).toBe('saxophone');
    expect(screen.queryByText('Order groceries')).not.toBeInTheDocument();
  });

  it('tells the user when a search matches nothing', async () => {
    const u = userEvent.setup();
    const agents = [makeAgent({ agent_id: 'a1', goal: 'Book a flight' })];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);
    await screen.findByText('Book a flight');

    await u.type(screen.getByLabelText('Search agents'), 'zzzz');
    // Distinct from the "No agents yet" empty state — the account is not empty.
    await waitFor(() => expect(screen.getByText('No matching agents')).toBeInTheDocument());
  });

  it('advertises no keyboard shortcut it does not bind', async () => {
    renderStockSidebar(<AppSidebar {...defaultProps()} />);
    const search = await screen.findByLabelText('Search agents');
    expect(search).toBeInTheDocument();
    expect(screen.queryByText(/⌘K|Ctrl\+K/i)).not.toBeInTheDocument();
  });

  it('opens a row context menu with Rename, Copy Link, Pin and Archive', async () => {
    renderStockSidebar(
      <AppSidebar {...defaultProps({ agents: [makeAgent({ goal: 'Row A' })] })} />,
    );

    const menu = await openRowMenu('Row A');
    expect(within(menu).getByText('Rename')).toBeInTheDocument();
    expect(within(menu).getByText('Copy Link')).toBeInTheDocument();
    expect(within(menu).getByText('Pin')).toBeInTheDocument();
    expect(within(menu).getByText('Archive')).toBeInTheDocument();
  });

  it('offers Unpin for an already-pinned row', async () => {
    const agents = [makeAgent({ goal: 'Row A', pinned_at: '2026-01-01T00:00:00Z' })];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    const menu = await openRowMenu('Row A');
    expect(within(menu).getByText('Unpin')).toBeInTheDocument();
    expect(within(menu).queryByText('Pin')).not.toBeInTheDocument();
  });

  it('labels the pin hover action with a tooltip', async () => {
    const u = userEvent.setup();
    renderStockSidebar(
      <AppSidebar {...defaultProps({ agents: [makeAgent({ goal: 'Row A' })] })} />,
    );

    await u.hover(await screen.findByLabelText('Pin Row A'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pin Agent');
  });

  it('labels the archive hover action with a tooltip', async () => {
    const u = userEvent.setup();
    renderStockSidebar(
      <AppSidebar {...defaultProps({ agents: [makeAgent({ goal: 'Row A' })] })} />,
    );

    await u.hover(await screen.findByLabelText('Archive Row A'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Archive Agent');
  });

  it('renames via the context menu and PATCHes the new title', async () => {
    const u = userEvent.setup();
    let patched: { id: string; body: Record<string, unknown> } | null = null;
    server.use(
      http.patch('*/api/agents/:agentId', async ({ params, request }) => {
        patched = {
          id: params.agentId as string,
          body: (await request.json()) as Record<string, unknown>,
        };
        return HttpResponse.json({ agent: makeAgent({ agent_id: 'a1', title: 'Renamed' }) });
      }),
    );
    const onRefreshAgents = vi.fn().mockResolvedValue(undefined);
    const agents = [makeAgent({ agent_id: 'a1', goal: 'Row A' })];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents, onRefreshAgents })} />);

    const menu = await openRowMenu('Row A');
    await u.click(within(menu).getByText('Rename'));

    const input = await screen.findByLabelText('Agent name');
    await u.clear(input);
    await u.type(input, 'Renamed');
    await u.click(screen.getByText('Save'));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched!.id).toBe('a1');
    expect(patched!.body).toEqual({ title: 'Renamed' });
    // The list has no query cache, so the row only updates via an explicit reload.
    await waitFor(() => expect(onRefreshAgents).toHaveBeenCalled());
  });

  it('toggles pin through the context menu', async () => {
    const u = userEvent.setup();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch('*/api/agents/:agentId', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ agent: makeAgent() });
      }),
    );
    renderStockSidebar(
      <AppSidebar {...defaultProps({ agents: [makeAgent({ goal: 'Row A' })] })} />,
    );

    const menu = await openRowMenu('Row A');
    await u.click(within(menu).getByText('Pin'));

    await waitFor(() => expect(body).toEqual({ pinned: true }));
  });

  it('copies a deep link to the agent without hitting the network', async () => {
    const u = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderStockSidebar(
      <AppSidebar {...defaultProps({ agents: [makeAgent({ agent_id: 'a1', goal: 'Row A' })] })} />,
    );

    const menu = await openRowMenu('Row A');
    await u.click(within(menu).getByText('Copy Link'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('?agent-id=a1');
  });

  // ── Archive (soft delete) ───────────────────────────────────────────────

  it('archives via the hover button, which soft-deletes and refreshes', async () => {
    const u = userEvent.setup();
    let deletedId: string | null = null;
    server.use(
      http.delete('*/api/agents/:agentId', ({ params }) => {
        deletedId = params.agentId as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const onRefreshAgents = vi.fn().mockResolvedValue(undefined);
    const agents = [makeAgent({ agent_id: 'a1', goal: 'Row A' })];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents, onRefreshAgents })} />);

    await u.click(await screen.findByLabelText('Archive Row A'));

    await waitFor(() => expect(deletedId).toBe('a1'));
    await waitFor(() => expect(onRefreshAgents).toHaveBeenCalled());
  });

  it('clears the selection when the archived agent was the selected one', async () => {
    const u = userEvent.setup();
    server.use(http.delete('*/api/agents/:agentId', () => new HttpResponse(null, { status: 204 })));
    const onSelectAgent = vi.fn();
    const agents = [makeAgent({ agent_id: 'a1', goal: 'Row A' })];
    renderStockSidebar(
      <AppSidebar {...defaultProps({ agents, onSelectAgent, selectedAgentId: 'a1' })} />,
    );

    await u.click(await screen.findByLabelText('Archive Row A'));

    // Otherwise the main pane stays pointed at a row that no longer renders.
    await waitFor(() => expect(onSelectAgent).toHaveBeenCalledWith(null));
  });

  it('archives from the context menu too', async () => {
    const u = userEvent.setup();
    let deletedId: string | null = null;
    server.use(
      http.delete('*/api/agents/:agentId', ({ params }) => {
        deletedId = params.agentId as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const agents = [makeAgent({ agent_id: 'a1', goal: 'Row A' })];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    const menu = await openRowMenu('Row A');
    await u.click(within(menu).getByText('Archive'));

    await waitFor(() => expect(deletedId).toBe('a1'));
  });

  it('opens the archived list from the bottom button and restores an agent', async () => {
    const u = userEvent.setup();
    let unarchivedId: string | null = null;
    server.use(
      http.get('*/api/agents/archived', () =>
        HttpResponse.json({
          agents: [
            makeAgent({
              agent_id: 'gone',
              goal: 'Archived row',
              archived_at: '2026-02-02T00:00:00Z',
            }),
          ],
        }),
      ),
      http.post('*/api/agents/:agentId/unarchive', ({ params }) => {
        unarchivedId = params.agentId as string;
        return HttpResponse.json({ success: true });
      }),
    );
    renderStockSidebar(<AppSidebar {...defaultProps()} />);

    await u.click(screen.getByLabelText('Show archived agents'));

    expect(await screen.findByText('Archived row')).toBeInTheDocument();
    await u.click(screen.getByLabelText('Restore Archived row'));

    await waitFor(() => expect(unarchivedId).toBe('gone'));
  });

  it('shows an empty state when nothing is archived', async () => {
    const u = userEvent.setup();
    server.use(http.get('*/api/agents/archived', () => HttpResponse.json({ agents: [] })));
    renderStockSidebar(<AppSidebar {...defaultProps()} />);

    await u.click(screen.getByLabelText('Show archived agents'));

    expect(await screen.findByText('Nothing archived')).toBeInTheDocument();
  });

  // ── Removed status chrome ───────────────────────────────────────────────

  it('renders no progress, out-of-credits or cost-limit chip in the sidebar', async () => {
    const agents = [
      makeAgent({ agent_id: 'p', goal: 'In progress', status: 'ACTIVE', progress: 0.42 }),
      makeAgent({ agent_id: 'c', goal: 'Out of credits', status: 'OUT_OF_CREDITS' }),
      makeAgent({ agent_id: 'l', goal: 'Cost limited', status: 'COST_LIMIT_REACHED' }),
    ];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    await screen.findByText('In progress');
    expect(screen.queryByText('42%')).not.toBeInTheDocument();
    expect(
      screen.queryByTitle('Agent ran out of credits - add more to continue'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTitle('Agent cost limit reached - increase limit to continue'),
    ).not.toBeInTheDocument();
  });

  it('offers no pause/resume control, even for a paused agent', async () => {
    const agents = [makeAgent({ agent_id: 'a1', goal: 'Paused row', status: 'PAUSED' })];
    renderStockSidebar(<AppSidebar {...defaultProps({ agents })} />);

    // Run control belongs to the agent view. A play button in a navigation list
    // sat right where you scan and invited mis-clicks.
    expect(await screen.findByText('Paused row')).toBeInTheDocument();
    expect(screen.queryByTitle('Resume agent')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Resuming agent...')).not.toBeInTheDocument();
    // The paused state is still legible — it just reads via the indicator.
    expect(screen.getByLabelText('Paused')).toBeInTheDocument();
  });
});
