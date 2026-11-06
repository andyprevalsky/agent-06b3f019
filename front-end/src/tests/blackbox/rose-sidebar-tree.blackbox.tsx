import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { subscribeToBus } from '@/lib/realtime';
import { noteTreeUserMessage } from '@/hooks/useAgentTree';
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
  it('orders sub-agents and code agents running first, then by the most recent user message', async () => {
    mockSession();
    mockProjectsApi([]);
    const child = (agent_id: string, status: string, created_at: string, last?: string) => ({
      agent_id,
      parent_agent_id: 'root',
      goal: agent_id,
      status,
      progress: 0,
      tools_in_use: [],
      message_count: 1,
      tree_cost_cents: 0,
      created_at,
      ...(last ? { last_user_message_at: last } : {}),
    });
    server.use(
      http.get(`${API}/agents/tree`, () =>
        HttpResponse.json({
          agents: [
            {
              ...child('root', 'ACTIVE', '2026-10-21T00:00:00Z'),
              parent_agent_id: null,
              goal: 'Launch report',
              temporal_workflow_id: 'root-wf',
            },
            child('done-messaged', 'COMPLETED', '2026-10-21T00:01:00Z', '2026-10-21T00:09:00Z'),
            child('run-old', 'ACTIVE', '2026-10-21T00:02:00Z'),
            child('run-messaged', 'ACTIVE', '2026-10-21T00:01:30Z', '2026-10-21T00:08:00Z'),
            child('paused', 'PAUSED', '2026-10-21T00:07:00Z'),
          ],
        }),
      ),
      http.get(`${API}/agents/code-agents`, () =>
        HttpResponse.json({
          code_agents: [
            {
              code_agent_id: 'code-done',
              owner_agent_id: 'root',
              root_agent_id: 'root',
              provider: 'codex',
              title: 'Old charts',
              status: 'COMPLETED',
              created_at: '2026-10-21T00:06:00Z',
            },
            {
              code_agent_id: 'code-run',
              owner_agent_id: 'root',
              root_agent_id: 'root',
              provider: 'claude',
              title: 'Build charts',
              status: 'ACTIVE',
              created_at: '2026-10-21T00:03:00Z',
            },
          ],
        }),
      ),
    );
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
        })}
      />,
    );
    await screen.findByTestId('rose-agent-count-root');
    expandBar();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Launch report' }));
    await screen.findByTestId('rose-code-agent-row-code-run');
    const rows = screen
      .getByTestId('rose-agent-children-root')
      .querySelectorAll<HTMLElement>(
        '[data-testid^="rose-agent-row-"], [data-testid^="rose-code-agent-row-"]',
      );
    expect(
      [...rows].map((el) => el.dataset.testid!.replace(/^rose-(code-)?agent-row-/, '')),
    ).toEqual(['run-messaged', 'code-run', 'run-old', 'paused', 'done-messaged', 'code-done']);
  });
  it('reorders siblings live: a messaged sub-agent and a realtime-spawned child', async () => {
    mockSession();
    mockProjectsApi([]);
    const node = (agent_id: string, parent_agent_id: string | null, created_at: string) => ({
      agent_id,
      parent_agent_id,
      goal: agent_id,
      status: 'ACTIVE',
      temporal_workflow_id: parent_agent_id ? null : 'root-wf',
      progress: 0,
      tools_in_use: [],
      message_count: 1,
      tree_cost_cents: 0,
      created_at,
    });
    server.use(
      http.get(`${API}/agents/tree`, () =>
        HttpResponse.json({
          agents: [
            { ...node('root', null, '2026-10-21T00:00:00Z'), goal: 'Launch report' },
            node('old-run', 'root', '2026-10-21T00:01:00Z'),
            node('new-run', 'root', '2026-10-21T00:02:00Z'),
          ],
        }),
      ),
      http.get(`${API}/agents/code-agents`, () => HttpResponse.json({ code_agents: [] })),
    );
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
        })}
      />,
    );
    await screen.findByTestId('rose-agent-count-root');
    expandBar();
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Launch report' }));
    const order = () =>
      [
        ...screen
          .getByTestId('rose-agent-children-root')
          .querySelectorAll<HTMLElement>('[data-testid^="rose-agent-row-"]'),
      ].map((el) => el.dataset.testid!.replace('rose-agent-row-', ''));
    await waitFor(() => expect(order()).toEqual(['new-run', 'old-run']));

    // The person messages the older sub-agent: it moves up without a refetch.
    act(() => noteTreeUserMessage('old-run', '2026-10-21T00:10:00Z'));
    expect(order()).toEqual(['old-run', 'new-run']);

    // A child spawned over realtime has no REST creation time; its event time
    // makes it the newest running row, not the oldest.
    const handlers = vi
      .mocked(subscribeToBus)
      .mock.calls.filter(([id]) => id === 'root')
      .at(-1)![1];
    act(() =>
      handlers.onAgentStateChanged?.({
        agentId: 'spawned',
        parentAgentId: 'root',
        goal: 'spawned',
        status: 'ACTIVE',
        progress: 0,
        toolsInUse: [],
        messageCount: 1,
        costCents: 0,
        updatedAt: '2026-10-21T00:20:00Z',
      }),
    );
    expect(order()).toEqual(['spawned', 'old-run', 'new-run']);
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
