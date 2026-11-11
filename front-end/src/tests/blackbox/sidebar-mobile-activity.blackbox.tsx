import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import RoseAgentBranch from '@/features/terminal-component-group/components/rose-sidebar/RoseAgentBranch';
import type { CodeAgentListItem } from '@/lib/api/tree';
import { makeAgent, mockSession } from './app-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';
import { server } from './msw/server';

vi.mock('@/lib/realtime', async (original) => ({
  ...(await original<typeof import('@/lib/realtime')>()),
  subscribeToBus: vi.fn(async () => ({ state: 'joined' })),
  unsubscribe: vi.fn(),
}));

async function openBranch(mobile: boolean, dark: boolean) {
  mockSession();
  localStorage.setItem('rose-theme:signed-in-user', dark ? 'dark' : 'light');
  const root = makeAgent({
    agent_id: 'root',
    goal: 'Launch report',
    status: 'ACTIVE',
    temporal_workflow_id: 'root-wf',
  });
  server.use(
    http.get('http://localhost:3001/api/agents/tree', () =>
      HttpResponse.json({
        agents: [
          {
            agent_id: 'root',
            parent_agent_id: null,
            goal: root.goal,
            status: 'ACTIVE',
            temporal_workflow_id: 'root-wf',
            progress: 0,
            tools_in_use: [],
            message_count: 1,
            tree_cost_cents: 0,
            background_tasks: [
              {
                address: '/root/browser',
                type: 'browser',
                goal: 'Check booking',
                status: 'running',
              },
              {
                address: '/root/explore',
                type: 'explore',
                goal: 'Find sources',
                status: 'running',
              },
              {
                address: '/root/done',
                type: 'explore',
                goal: 'Finished research',
                status: 'completed',
              },
            ],
          },
        ],
      }),
    ),
  );
  const codes: CodeAgentListItem[] = ['claude', 'codex', 'done'].map((provider) => ({
    code_agent_id: provider,
    owner_agent_id: 'root',
    root_agent_id: 'root',
    provider: provider === 'codex' ? 'codex' : 'claude',
    title: `Build ${provider}`,
    status: provider === 'done' ? 'CLOSED' : 'ACTIVE',
    created_at: new Date().toISOString(),
  }));
  const { container } = renderWithProviders(
    <RoseAgentBranch
      agent={root}
      indented={false}
      mobile={mobile}
      sidebar={{
        isExpanded: true,
        selectedAgentId: 'root',
        selectedCodeAgentId: null,
        attentionAgentIds: new Set(),
        onSelectAgent: vi.fn(),
        actionsFor: () => ({
          onArchive: vi.fn(),
          onTogglePin: vi.fn(),
          onRename: vi.fn(),
          onCopyLink: vi.fn(),
          onCopyId: vi.fn(),
        }),
        onMenuOpenChange: vi.fn(),
        codeAgentsFor: () => codes,
        onOpenCodeAgent: vi.fn(),
        observeRoot: () => vi.fn(),
      }}
    />,
    { roseThemeUserId: 'signed-in-user' },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Expand Launch report' }));
  await screen.findByTestId('rose-task-agent-row-task:/root/browser');
  return container;
}

describe('sidebar activity follows the mobile presentation through every child row', () => {
  it.each([false, true])(
    'mobile uses static robots with provider and status labels (dark=%s)',
    async (dark) => {
      const container = await openBranch(true, dark);
      for (const [id, provider] of [
        ['claude', 'Claude Code'],
        ['codex', 'Codex'],
      ]) {
        const row = screen.getByTestId(`rose-code-agent-row-${id}`);
        expect(within(row).getByRole('img', { name: provider })).toBeInTheDocument();
        expect(
          within(row).getByRole('img', { name: 'Working' }).querySelector('svg.lucide-bot'),
        ).not.toBeNull();
      }
      for (const task of ['browser', 'explore']) {
        const row = screen.getByTestId(`rose-task-agent-row-task:/root/${task}`);
        expect(
          within(row).getByRole('img', { name: 'Working' }).querySelector('svg.lucide-bot'),
        ).not.toBeNull();
        expect(
          row.querySelector(`svg.lucide-${task === 'browser' ? 'globe' : 'search'}`),
        ).not.toBeNull();
      }
      expect(container.querySelectorAll('[data-letter]')).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Finished agents (2)' }));
      expect(
        within(screen.getByTestId('rose-code-agent-row-done')).queryByRole('img', {
          name: 'Working',
        }),
      ).toBeNull();
      expect(
        within(screen.getByTestId('rose-task-agent-row-task:/root/done')).getByRole('img', {
          name: 'Completed',
        }),
      ).toBeInTheDocument();
      expect(container.querySelectorAll('[data-letter]')).toHaveLength(0);
    },
  );

  it('desktop retains animated activity dots for code, browser and explore rows', async () => {
    const container = await openBranch(false, true);
    expect(container.querySelectorAll('[data-letter]')).toHaveLength(4);
    for (const id of [
      'rose-code-agent-row-claude',
      'rose-code-agent-row-codex',
      'rose-task-agent-row-task:/root/browser',
      'rose-task-agent-row-task:/root/explore',
    ]) {
      const row = screen.getByTestId(id);
      expect(
        within(row).getByRole('img', { name: 'Working' }).querySelector('[data-letter]'),
      ).not.toBeNull();
      expect(row.querySelector('svg.lucide-bot')).toBeNull();
    }
  });
});
