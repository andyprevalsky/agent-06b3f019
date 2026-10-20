/**
 * Shared fixtures for the AppSidebar blackbox suites.
 *
 * Split out so app-sidebar (chrome/nav/resize) and app-sidebar-rows (agent row
 * behaviour) can both use them without duplicating the agent factory — the two
 * files were one suite until it crossed the max-lines budget.
 */
import { vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import type AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import type { Agent } from '@/lib/api';
import { renderWithProviders } from './test-wrapper';

/**
 * Render the STOCK left bar (Rose Desktop flag off). The flag defaults on in
 * renderWithProviders; these suites pin the stock UI, which must stay unchanged.
 */
export function renderStockSidebar(ui: React.ReactElement): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(ui, { roseDesktop: false });
}

/** Current rendered width of the rail, read off its inline style. */
export function sidebarWidth(): number {
  const aside = document.querySelector('aside');
  return Number.parseInt((aside as HTMLElement).style.width, 10);
}

/**
 * Drive the resize handle end-to-end: pointerdown on the handle, then move and
 * release on window (the hook subscribes there so the drag survives the pointer
 * leaving the 6px handle).
 */
export function dragHandleTo(clientX: number): void {
  const handle = screen.getByLabelText('Resize sidebar');
  // Separate act() blocks on purpose: the window listeners are attached by an
  // effect that only runs once `isDragging` commits. Firing all three in one
  // act() would deliver the move before that effect had subscribed — which is
  // a test-harness artifact, not a real drag (real pointer moves land on later
  // frames, long after the commit).
  act(() => {
    fireEvent.pointerDown(handle);
  });
  act(() => {
    fireEvent.pointerMove(window, { clientX });
  });
  act(() => {
    fireEvent.pointerUp(window);
  });
}

/** Right-click a row and return its open context menu. */
export async function openRowMenu(rowText: string): Promise<HTMLElement> {
  fireEvent.contextMenu(screen.getByText(rowText));
  return await screen.findByRole('menu');
}

export function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1',
    goal: 'A test goal',
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0.25,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: null,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: 0,
    price_limit_cents: 100,
    tree_cost_cents: 0,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    write_lock_enabled: false,
    ...overrides,
  };
}

export function defaultProps(
  overrides: Partial<React.ComponentProps<typeof AppSidebar>> = {},
): React.ComponentProps<typeof AppSidebar> {
  return {
    currentView: 'agents' as const,
    onViewChange: vi.fn(),
    agents: [] as Agent[],
    isLoadingAgents: false,
    selectedAgentId: null,
    onSelectAgent: vi.fn(),
    onCreateAgent: vi.fn(),
    onRefreshAgents: vi.fn().mockResolvedValue(undefined),
    user: { id: 'test-user' },
    onLogout: vi.fn(),
    onLoginClick: vi.fn(),
    ...overrides,
  } as React.ComponentProps<typeof AppSidebar>;
}
