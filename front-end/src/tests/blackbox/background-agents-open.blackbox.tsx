/**
 * Blackbox: clicking a running-agents dock row opens the agent it stands for.
 *
 *   general-purpose agent row     → onNavigate(agent id)
 *   browser task row              → owner's Browser drawer tab: openAgentBrowser(owner, id)
 *                                   when the task id is known, else
 *                                   openAgentBrowserTab(owner) (never an empty task id);
 *                                   a child's task navigates to the owner first
 *   code task row                 → its code-agent view: task id from the spawn rows, else
 *                                   the code-agents list (cache, then ONE fetch of the
 *                                   root's list); running row over finished, then newest
 *   no view for the task          → onNavigate(owning agent)
 *   nothing to open (a code
 *     agent's Task sub-agents)    → not clickable: no pointer, no chevron
 *   (explore rows unfold in place: background-agents.blackbox.tsx)
 *
 * RCA 2026-11-08-dock-task-rows-had-no-open-target: task rows were synthetic
 * `task:` nodes whose click only toggled an explore/browser trajectory, so a
 * code agent's row (and any child agent's task row) did nothing.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RoseDesktopContext } from '@/hooks/roseDesktopContext';
import { RoseAppsProvider } from '@/features/terminal-component-group';
import { BackgroundAgentsBannerView } from '@/features/terminal-component-group/components/background-agents/BackgroundAgentsBanner';
import {
  countAll,
  taskTreeNode,
} from '@/features/terminal-component-group/components/background-agents/agentsPanelGroups';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentViewContext } from '@/features/terminal-component-group/components/code-agent-view/codeAgentViewState';
import {
  RoseAppsContext,
  useRoseApps,
  type RoseAppsValue,
} from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import type { Message } from '@/lib/api';
import { makeAgentTreeNode } from './terminal-component-chips.fixtures';
import { dockElement, gp, row, started } from './background-agents.fixtures';
import { server } from './msw/server';

const CODE_AGENTS_URL = 'http://localhost:3001/api/agents/code-agents';

const tree = vi.hoisted(() => ({ nodes: new Map<string, unknown>() }));
vi.mock('@/hooks/useAgentTree', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/hooks/useAgentTree');
  return { ...actual, useAgentTree: (busId: string | null) => (busId ? tree.nodes : new Map()) };
});
vi.mock('@/components/ThinkingAnimation', () => ({ default: () => <div /> }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
});
beforeEach(() => {
  tree.nodes = new Map();
});

type Task = { address: string; path: string; type: string; goal: string; status: string };
const task = (type: string, path: string): Task => ({
  address: `call_${path.split('/').pop()}`,
  path,
  type,
  goal: 'Some task',
  status: 'running',
});

/** child-1 (a GP agent of root-1) owning in-activity tasks. */
function childWith(...tasks: Task[]) {
  tree.nodes.set(
    'child-1',
    makeAgentTreeNode({
      agentId: 'child-1',
      parentAgentId: 'root-1',
      goal: 'Draft budget',
      backgroundTasks: tasks,
    }),
  );
}

/** A background spawn of root-1; `taskId` is the task_id its in-progress row carries. */
function spawnRows(type: string, name: string, toolName: string, taskId?: string): Message[] {
  return [
    started(`call_${name}`, type, `/root/${name}`, `Do ${name}`),
    row({
      toolCallId: `call_${name}`,
      toolName,
      toolStatus: 'IN_PROGRESS',
      excludeFromModel: true,
      ...(taskId ? { task_id: taskId } : {}),
      title: 'Working',
    }),
  ];
}

interface Setup {
  codeView?: boolean;
  apps?: boolean;
  cached?: Array<Record<string, unknown>>;
}

async function openDock(messages: Message[], { codeView = true, apps = true, cached }: Setup = {}) {
  const onNavigate = vi.fn();
  const view = { openCodeAgent: null, open: vi.fn(), close: vi.fn() };
  const roseApps = { openAgentBrowser: vi.fn(), openAgentBrowserTab: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached) client.setQueryData(['rose-code-agents', 'root-1'], cached);
  let ui: ReactNode = dockElement(messages, onNavigate);
  if (codeView)
    ui = <CodeAgentViewContext.Provider value={view}>{ui}</CodeAgentViewContext.Provider>;
  if (apps)
    ui = (
      <RoseAppsContext.Provider value={roseApps as unknown as RoseAppsValue}>
        {ui}
      </RoseAppsContext.Provider>
    );
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  await userEvent.click(screen.getByRole('button', { name: /Running \d+ agents?/ }));
  const panel = screen.getByTestId('background-agents-panel');
  const click = (text: string) => userEvent.click(within(panel).getByText(text));
  return { onNavigate, view, roseApps, click };
}

const codeRow = (id: string, owner: string, status: string, createdAt: string) => ({
  code_agent_id: id,
  owner_agent_id: owner,
  root_agent_id: 'root-1',
  provider: 'claude',
  status,
  title: 'fix_css',
  created_at: createdAt,
});

/** Reads the real RoseApps state; registers child-1's tab as its BrowserStatusBar would. */
function BrowserProbe() {
  const apps = useRoseApps()!;
  return (
    <div>
      <output data-testid="probe">
        {JSON.stringify({
          openApp: apps.openApp,
          agent: apps.browserTabAgentId,
          task: apps.browserTabTaskId,
          tasks: apps.tabs.map((t) => `${t.agentId}:${t.taskId}`),
          inDrawer: apps.isTaskInDrawer('child-1', 't-scan'),
        })}
      </output>
      <button
        type="button"
        onClick={() =>
          apps.registerAgentBrowser({ agentId: 'child-1', taskId: 't-scan', live: true })
        }
      >
        register child tab
      </button>
    </div>
  );
}

/** The real RoseAppsProvider; dock navigation selects the agent like the terminal does. */
function RealAppsHost({ messages }: { messages: Message[] }) {
  const [selected, setSelected] = useState('root-1');
  return (
    <RoseAppsProvider selectedAgentId={selected} onSelectAgent={setSelected}>
      <BrowserProbe />
      {dockElement(messages, setSelected)}
    </RoseAppsProvider>
  );
}

const probe = () => JSON.parse(screen.getByTestId('probe').textContent ?? '{}');

describe('running-agents dock: row click opens its agent', () => {
  it('a general-purpose agent row navigates to that agent', async () => {
    childWith();
    const { onNavigate, click } = await openDock(gp());
    await click('Draft budget');
    expect(onNavigate).toHaveBeenCalledWith('child-1');
  });

  it("an own browser task opens the selected agent's Browser drawer tab", async () => {
    const { onNavigate, roseApps, click } = await openDock(
      spawnRows('browser', 'order_breakfast', 'spawn_browser_agent', 't-br'),
    );
    await click('browser · order_breakfast');
    expect(roseApps.openAgentBrowser).toHaveBeenCalledWith('root-1', 't-br');
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('agent-panel-trajectory')).toBeNull();
  });

  it("an own browser task without a task id opens the agent's tab, never an empty one", async () => {
    const { roseApps, click } = await openDock(
      spawnRows('browser', 'order_lunch', 'spawn_browser_agent'),
    );
    await click('browser · order_lunch');
    expect(roseApps.openAgentBrowserTab).toHaveBeenCalledWith('root-1');
    expect(roseApps.openAgentBrowser).not.toHaveBeenCalled();
  });

  it("a child's browser task selects the owner; its real tab takes over the drawer (real RoseApps)", async () => {
    childWith(task('browser', '/root/budget_planner/scan'));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <RoseDesktopContext.Provider value>
            <TooltipProvider>
              <RealAppsHost messages={gp()} />
            </TooltipProvider>
          </RoseDesktopContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Running \d+ agents?/ }));
    await userEvent.click(
      within(screen.getByTestId('background-agents-panel')).getByText('browser · scan'),
    );
    // Browser opens on the owner with no invented tab (no `child-1:` empty task id).
    expect(probe()).toMatchObject({ openApp: 'browser', agent: null, task: null, tasks: [] });

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'register child tab' }));
    });
    expect(probe()).toMatchObject({
      openApp: 'browser',
      agent: 'child-1',
      task: 't-scan',
      tasks: ['child-1:t-scan'],
      inDrawer: true,
    });
  });

  it('an own code task opens its code-agent view', async () => {
    const { onNavigate, view, click } = await openDock(
      spawnRows('code', 'remove_rose_card_border', 'spawn_claude_code_agent', 'cc-1'),
    );
    await click('code · remove_rose_card_border');
    await waitFor(() => expect(view.open).toHaveBeenCalled());
    expect(view.open).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'cc-1',
        ownerAgentId: 'root-1',
        title: 'remove_rose_card_border',
      }),
    );
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("a child's code task opens its code-agent view via the cached code-agents row", async () => {
    childWith(task('code', '/root/budget_planner/fix_css'));
    const cached = [
      {
        code_agent_id: 'cc-old',
        owner_agent_id: 'child-1',
        root_agent_id: 'root-1',
        provider: 'claude',
        status: 'COMPLETED',
        title: 'fix_css',
        created_at: '2026-11-08T01:00:00Z',
      },
      {
        code_agent_id: 'cc-2',
        owner_agent_id: 'child-1',
        root_agent_id: 'root-1',
        provider: 'codex',
        status: 'ACTIVE',
        title: 'fix_css',
        created_at: '2026-11-08T02:00:00Z',
      },
      {
        code_agent_id: 'cc-x',
        owner_agent_id: 'other',
        root_agent_id: 'root-1',
        provider: 'claude',
        status: 'ACTIVE',
        title: 'fix_css',
        created_at: '2026-11-08T03:00:00Z',
      },
    ];
    const { onNavigate, view, click } = await openDock(gp(), { cached });
    await click('code · fix_css');
    await waitFor(() => expect(view.open).toHaveBeenCalled());
    expect(view.open).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'cc-2', ownerAgentId: 'child-1', provider: 'codex' }),
    );
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('an own code task before claude_code_started (no id, no cached row) opens its owner', async () => {
    const { onNavigate, view, click } = await openDock(
      spawnRows('code', 'lint_fix', 'spawn_claude_code_agent'),
    );
    await click('code · lint_fix');
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('root-1'));
    expect(view.open).not.toHaveBeenCalled();
  });

  it('an own task known only from the tree opens its target, else its owner', async () => {
    tree.nodes.set(
      'root-1',
      makeAgentTreeNode({
        agentId: 'root-1',
        backgroundTasks: [task('code', '/root/tree_only'), task('explore', '/root/look_up')],
      }),
    );
    const cached = [
      {
        code_agent_id: 'cc-3',
        owner_agent_id: 'root-1',
        root_agent_id: 'root-1',
        provider: 'claude',
        status: 'ACTIVE',
        title: 'tree_only',
        created_at: '2026-11-08T02:00:00Z',
      },
    ];
    const { onNavigate, view, click } = await openDock(gp(), { cached });
    await click('code · tree_only');
    await waitFor(() => expect(view.open).toHaveBeenCalled());
    expect(view.open).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'cc-3', ownerAgentId: 'root-1' }),
    );
    await click('explore · look_up');
    expect(onNavigate).toHaveBeenCalledWith('root-1');
  });

  it('without a code view or Browser drawer, code and browser rows open their owner', async () => {
    childWith(
      task('code', '/root/budget_planner/fix_css'),
      task('browser', '/root/budget_planner/scan'),
    );
    const { onNavigate, click } = await openDock(
      [...gp(), ...spawnRows('code', 'own_code', 'spawn_claude_code_agent', 'cc-1')],
      { codeView: false, apps: false },
    );
    await click('code · own_code');
    expect(onNavigate).toHaveBeenLastCalledWith('root-1');
    await click('code · fix_css');
    expect(onNavigate).toHaveBeenLastCalledWith('child-1');
    onNavigate.mockClear();
    await click('browser · scan');
    expect(onNavigate).toHaveBeenLastCalledWith('child-1');
  });

  it('on a title collision the running row wins over a newer finished one', async () => {
    childWith(task('code', '/root/budget_planner/fix_css'));
    const cached = [
      codeRow('cc-running', 'child-1', 'ACTIVE', '2026-11-08T01:00:00Z'),
      codeRow('cc-done', 'child-1', 'COMPLETED', '2026-11-08T02:00:00Z'),
    ];
    const { view, click } = await openDock(gp(), { cached });
    await click('code · fix_css');
    await waitFor(() =>
      expect(view.open).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'cc-running' })),
    );
  });

  it("a cache miss fetches the root's code-agents list once, then joins", async () => {
    childWith(task('code', '/root/budget_planner/fix_css'));
    const requests: string[] = [];
    server.use(
      http.get(CODE_AGENTS_URL, ({ request }) => {
        requests.push(new URL(request.url).searchParams.get('root_ids') ?? '');
        return HttpResponse.json({
          code_agents: [codeRow('cc-new', 'child-1', 'ACTIVE', '2026-11-08T03:00:00Z')],
        });
      }),
    );
    const session = { access_token: 'test-token', expires_at: Date.now() / 1000 + 3600 };
    localStorage.setItem('rose-session', JSON.stringify(session));
    const { onNavigate, view, click } = await openDock(gp());
    await click('code · fix_css');
    await waitFor(() =>
      expect(view.open).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'cc-new', ownerAgentId: 'child-1' }),
      ),
    );
    expect(requests).toEqual(['root-1']);
    localStorage.removeItem('rose-session');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("a code agent's own Task sub-agent rows are not clickable (no pointer, no chevron)", async () => {
    const sub = taskTreeNode({
      address: 'tool-1',
      parentAgentId: 'cc-1',
      type: 'agent',
      goal: 'Audit the CSS',
      path: null,
      status: 'ACTIVE',
      activity: null,
    });
    const groups = [{ key: 'children', header: null, roots: [sub] }];
    const getChildren = () => [];
    const model = {
      groups,
      getChildren,
      counts: countAll(groups, getChildren),
      trajectories: new Map(),
    };
    const onNavigate = vi.fn();
    render(
      <TooltipProvider>
        <BackgroundAgentsBannerView model={model} onNavigate={onNavigate} />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Running 1 agent/ }));
    const label = within(screen.getByTestId('background-agents-panel')).getByText(
      'agent · Audit the CSS',
    );
    const rowEl = label.closest('[data-navigable]') as HTMLElement;
    expect(rowEl).toHaveAttribute('data-navigable', 'false');
    expect(rowEl.className).not.toContain('cursor-pointer');
    expect(rowEl.querySelector('.lucide-chevron-right')).toBeNull();
    await userEvent.click(label);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
