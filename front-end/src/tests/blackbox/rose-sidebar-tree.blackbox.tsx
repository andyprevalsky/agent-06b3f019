import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { subscribeToBus } from '@/lib/realtime';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { expandBar, mockProjectsApi, signedInUser, roseBar } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';
import { server } from './msw/server';
vi.mock('@/lib/realtime', async (original) => ({
  ...(await original<typeof import('@/lib/realtime')>()),
  subscribeToBus: vi.fn(async () => ({ state: 'joined' })),
  unsubscribe: vi.fn(),
}));

const API = 'http://localhost:3001/api';
function setup(activeChildren = true) {
  mockSession();
  mockProjectsApi([]);
  const status = activeChildren ? 'ACTIVE' : 'COMPLETED';
  server.use(
    http.get(`${API}/agents/tree`, () =>
      HttpResponse.json({
        agents: [
          {
            agent_id: 'root',
            parent_agent_id: null,
            goal: 'Launch report',
            status: 'ACTIVE',
            temporal_workflow_id: 'root-wf',
            progress: 0,
            tools_in_use: [],
            message_count: 1,
            tree_cost_cents: 0,
          },
          {
            agent_id: 'worker',
            parent_agent_id: 'root',
            goal: 'Research',
            status,
            progress: 0,
            tools_in_use: [],
            message_count: 1,
            tree_cost_cents: 0,
          },
          {
            agent_id: 'leaf',
            parent_agent_id: 'worker',
            goal: 'Check sources',
            status,
            progress: 0,
            tools_in_use: [],
            message_count: 1,
            tree_cost_cents: 0,
          },
          {
            agent_id: 'done',
            parent_agent_id: 'root',
            goal: 'Finished',
            status: 'COMPLETED',
            progress: 1,
            tools_in_use: [],
            message_count: 1,
            tree_cost_cents: 0,
          },
        ],
      }),
    ),
    http.get(`${API}/agents/code-agents`, () =>
      HttpResponse.json({
        code_agents: [
          {
            code_agent_id: 'code',
            owner_agent_id: 'worker',
            root_agent_id: 'root',
            provider: 'codex',
            title: 'Build charts',
            status,
            created_at: '2026-10-21T00:00:00Z',
          },
        ],
      }),
    ),
  );
  const onSelectAgent = vi.fn();
  renderWithProviders(
    <AppSidebar
      {...defaultProps({
        agents: [
          makeAgent({
            agent_id: 'root',
            goal: 'Launch report',
            status: 'ACTIVE',
            temporal_workflow_id: 'root-wf',
          }),
        ],
        user: signedInUser(),
        selectedAgentId: 'root',
        onSelectAgent,
      })}
    />,
  );
  return onSelectAgent;
}
describe('sidebar agent hierarchy', () => {
  it('updates the root ring directly from the shared tree bus', async () => {
    setup();
    await screen.findByTestId('rose-agent-count-root');
    const handlers = vi.mocked(subscribeToBus).mock.calls.at(-1)![1];
    act(() =>
      handlers.onUpdate?.({
        agentId: 'root',
        temporalWorkflowId: 'root-wf',
        progressEstimate: {
          progress: 0.8,
          etaSeconds: 60,
          sequence: 2,
          observedAt: '2026-10-21T01:00:00Z',
          model: 'jev',
          promptVersion: 'test',
        },
      }),
    );
    expect(
      screen.getByTestId('rose-agent-row-root').querySelector('[role="progressbar"]'),
    ).toHaveAttribute('aria-valuenow', '80');
  });
  it('opens one layer per disclosure and resets nested disclosures on parent collapse', async () => {
    const select = setup();
    await screen.findByTestId('rose-agent-count-root');
    expandBar();
    expect(screen.queryByTestId('rose-agent-row-worker')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Launch report' }));
    expect(screen.getByTestId('rose-agent-row-worker')).toBeInTheDocument();
    expect(screen.queryByTestId('rose-agent-row-leaf')).toBeNull();
    expect(screen.queryByTestId('rose-code-agent-row-code')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Research' }));
    expect(screen.getByTestId('rose-agent-row-leaf')).toBeInTheDocument();
    expect(screen.getByTestId('rose-code-agent-row-code')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rose-agent-row-worker'));
    expect(select).toHaveBeenCalledWith('worker');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Launch report' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand Launch report' }));
    expect(screen.queryByTestId('rose-agent-row-leaf')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand Research' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
  it('minimized: shows the actual active subtree count >1 on the robot, hiding child rows', async () => {
    setup();
    const badge = await screen.findByTestId('rose-agent-count-root');
    expect(roseBar()).toHaveAttribute('data-expanded', 'false');
    expect(badge).toHaveTextContent('4');
    expect(badge).toHaveClass('text-current');
    expect(badge).toHaveAttribute('aria-label', '4 active agents');
    expect(screen.queryByTestId('rose-agent-row-worker')).toBeNull();
    expect(screen.queryByTestId('rose-code-agent-row-code')).toBeNull();
    expandBar();
    expect(screen.queryByTestId('rose-agent-count-root')).toBeNull();
  });
  it('does not badge a root with just one active agent', async () => {
    setup(false);
    expandBar();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Expand Launch report' })).toBeInTheDocument(),
    );
    fireEvent.mouseLeave(roseBar());
    expect(screen.queryByTestId('rose-agent-count-root')).toBeNull();
  });
  it('updates counts from real tree events without counting paused/completed agents, cycles or replay twice', async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId('rose-agent-count-root')).toHaveTextContent('4'));
    const handlers = vi
      .mocked(subscribeToBus)
      .mock.calls.filter(([id]) => id === 'root')
      .at(-1)![1];
    const update = (
      agentId: string,
      status: 'ACTIVE' | 'PAUSED' | 'COMPLETED',
      parentAgentId: string,
    ) => {
      act(() =>
        handlers.onAgentStateChanged?.({
          agentId,
          parentAgentId,
          goal: agentId === 'worker' ? 'Research' : 'Check sources',
          status,
          progress: 0,
          toolsInUse: [],
          messageCount: 1,
          costCents: 0,
        }),
      );
    };
    update('worker', 'PAUSED', 'root');
    expect(screen.getByTestId('rose-agent-count-root')).toHaveTextContent('3');
    update('leaf', 'COMPLETED', 'worker');
    expect(screen.getByTestId('rose-agent-count-root')).toHaveTextContent('2');
    update('worker', 'ACTIVE', 'root');
    update('worker', 'ACTIVE', 'root');
    expect(screen.getByTestId('rose-agent-count-root')).toHaveTextContent('3');
    update('worker', 'ACTIVE', 'leaf');
    expect(screen.queryByTestId('rose-agent-count-root')).toBeNull();
    expandBar();
    expect(screen.queryByTestId('rose-agent-row-worker')).toBeNull();
  });
});
