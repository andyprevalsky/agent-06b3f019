/**
 * Blackbox tests for agent-to-agent rows in the transcript.
 *
 *  - INBOUND agent messages (`agentMessage` / Codex `messageType` MESSAGE,
 *    role USER or ASSISTANT) render as InboundAgentRow ("↓", left accent),
 *    showing only the Codex Payload — never the human's chat bubble, never an
 *    assistant "Thought".
 *  - Child completions (`agentNotification` / FINAL_ANSWER|FAILED)
 *    never render in the trajectory (model context + dock only).
 *  - OUTBOUND agent tools render in main's tool-chip style: send_message_to_agent
 *    ("Messaged /root/x", message on expand), kill_agent ("Killed /root/x").
 *    list_agents (explore-only) expands to a structured tree, also inside an
 *    explore agent's steps. wait_for(agents) is a compact tool row; other
 *    waits keep main's WaitForChip.
 *  - Background spawns post main's row shapes under the original toolCallId;
 *    the "Started…" row carries `hidden: true` and never renders.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Info } from 'lucide-react';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { buildAgentToolData } from '@/features/terminal-component-group/components/message-bubble/agentToolData';
import { useFilteredMessages } from '@/features/terminal-component-group/components/useMessageFiltering';
import { ExploreAgentSteps } from '@/features/terminal-component-group/components/ExploreAgentSteps';
import { getToolIcon } from '@/lib/toolIcons';
import { isAgentMessageMetadata, isAgentNotificationMetadata } from '@/lib/realtime-types';
import type { Message } from '@/lib/api';
import { baseMessage, renderBubble } from './message-bubble.fixtures';

const codex = (type: string, payload: string) =>
  `Message Type: ${type}\nTask name: budget_planner\nSender: /root/budget_planner\nPayload:\n${payload}`;

function agentMessageRow(role: 'USER' | 'ASSISTANT'): Message {
  return baseMessage({
    role,
    text: codex('MESSAGE', 'Please only contact the Austin venues.'),
    metadata: {
      agentMessage: true,
      messageType: 'MESSAGE',
      fromAgentId: 'agent-root',
      fromAgentPath: '/root',
      fromGoal: 'Plan the offsite',
    },
  });
}

function notificationRow(role: 'USER' | 'ASSISTANT', status = 'completed'): Message {
  return baseMessage({
    role,
    text: codex('FINAL_ANSWER', 'Drafted a $5.5k budget.'),
    metadata: {
      agentNotification: true,
      toolName: 'agent_notification',
      messageType: status === 'failed' ? 'FAILED' : 'FINAL_ANSWER',
      fromAgentAddress: '/root/budget_planner',
      status,
    },
  });
}

function toolRow(toolName: string, metadata: Record<string, unknown>, text = ''): Message {
  return baseMessage({
    role: 'TOOL',
    text,
    metadata: { toolCallId: `tc-${toolName}`, toolName, toolStatus: 'FINISHED', ...metadata },
  });
}

async function expand(title: string) {
  await userEvent.click(screen.getByText(title));
}

describe('inbound agent message rows (never a user bubble)', () => {
  it.each(['USER', 'ASSISTANT'] as const)(
    'renders a %s agentMessage row as "Message from <path>" and expands to the text',
    async (role) => {
      renderBubble(<MessageBubble message={agentMessageRow(role)} />);
      expect(screen.getByText('Message from /root')).toBeInTheDocument();
      const row = screen.getByTestId('inbound-agent-row');
      expect(row).toHaveAttribute('data-direction', 'inbound');
      expect(row).toHaveTextContent('↓');
      expect(screen.queryByText('Thought')).not.toBeInTheDocument();
      expect(screen.queryByText('Please only contact the Austin venues.')).not.toBeInTheDocument();
      await expand('Message from /root');
      expect(screen.getByText('Please only contact the Austin venues.')).toBeInTheDocument();
    },
  );

  it('falls back to the sender goal when no path is known', () => {
    const msg = baseMessage({
      role: 'USER',
      text: 'hi',
      metadata: { agentMessage: true, fromAgentId: 'a1', fromGoal: 'Plan the offsite' },
    });
    renderBubble(<MessageBubble message={msg} />);
    expect(screen.getByText('Message from Plan the offsite')).toBeInTheDocument();
  });

  it('still renders a plain human USER row as the chat bubble', () => {
    renderBubble(<MessageBubble message={baseMessage({ role: 'USER', text: 'hi rose' })} />);
    expect(screen.getByText('hi rose')).toBeInTheDocument();
  });

  it('exposes metadata guards for both row kinds', () => {
    expect(isAgentMessageMetadata({ agentMessage: true, fromAgentId: 'a' })).toBe(true);
    expect(isAgentMessageMetadata({ agentMessage: true })).toBe(false);
    expect(isAgentNotificationMetadata({ agentNotification: true, status: 'failed' })).toBe(true);
    expect(isAgentNotificationMetadata(undefined)).toBe(false);
  });
});

describe('child completion rows never render', () => {
  it.each([
    ['USER', 'completed'],
    ['ASSISTANT', 'failed'],
  ] as const)(
    '%s %s completion renders nothing and is filtered from the trajectory',
    (role, status) => {
      const row = notificationRow(role, status);
      const { container } = renderBubble(<MessageBubble message={row} />);
      expect(container.textContent).toBe('');
      const { result } = renderHook(() => useFilteredMessages([row], undefined));
      expect(result.current.filteredMessagesRaw).toHaveLength(0);
    },
  );

  it('recognizes Codex completion rows by messageType alone', () => {
    expect(isAgentNotificationMetadata({ messageType: 'FAILED' })).toBe(true);
    // A kill is a failure: there is no separate KILLED / STOPPED completion type.
    expect(isAgentNotificationMetadata({ messageType: 'KILLED' })).toBe(false);
    expect(isAgentNotificationMetadata({ messageType: 'STOPPED' })).toBe(false);
    expect(isAgentMessageMetadata({ messageType: 'NEW_TASK' })).toBe(true);
  });
});

describe('agent tool chips', () => {
  it.each(['send_message_to_agent', 'list_agents', 'kill_agent', 'agent_message'])(
    '%s has an icon',
    (toolName) => {
      expect(getToolIcon(toolName)).not.toBe(Info);
    },
  );

  it('list_agents: "Listed agent tree · N agents" and the tree text on expand', async () => {
    const tree = '/root (you)\n  /root/outreach  agent  running';
    renderBubble(
      <MessageBubble message={toolRow('list_agents', { title: 'Listed 7 agents' }, tree)} />,
    );
    await expand('Listed agent tree · 7 agents');
    expect(document.body.textContent).toContain('/root/outreach  agent  running');
  });

  it('list_agents with a query reads as a search', () => {
    const msg = toolRow('list_agents', { title: 'Listed 2 agents', query: 'outreach' }, 'x');
    renderBubble(<MessageBubble message={msg} />);
    expect(screen.getByText("Searched agents: 'outreach' · 2 matches")).toBeInTheDocument();
  });

  it.each([
    [
      'send_message_to_agent',
      { toAgentPath: '/root/x', message: 'Only Austin.' },
      'Messaged /root/x',
      'Only Austin.',
    ],
    ['kill_agent', { to: '/root/x' }, 'Killed /root/x', 'Killed /root/x and everything below it.'],
  ])('%s → "%s" with real output on expand', async (toolName, metadata, title, body) => {
    renderBubble(<MessageBubble message={toolRow(toolName, metadata, body)} />);
    await expand(title);
    expect(screen.getByText(body)).toBeInTheDocument();
  });

  it('keeps the backend failure title for errored agent tools', () => {
    const msg = toolRow(
      'send_message_to_agent',
      { toolStatus: 'ERROR', title: 'send_message_to_agent failed' },
      'no such agent',
    );
    renderBubble(<MessageBubble message={msg} />);
    expect(screen.getByText('send_message_to_agent failed')).toBeInTheDocument();
  });

  it('wait_for(agents) is a compact tool row: "Waiting for …" then what woke it', async () => {
    const waiting = toolRow(
      'wait_for',
      { toolStatus: 'IN_PROGRESS', waitForMode: 'agents', agents: ['/root/x', '/root/y'] },
      'Waiting up to 10m for /root/x, /root/y',
    );
    const { unmount } = renderBubble(<MessageBubble message={waiting} />);
    expect(screen.getByTestId('wait-agent-targets')).toHaveTextContent(/^Waiting for X, Y$/);
    // Not main's bulky WaitForChip card (that stays for timestamp/condition waits).
    expect(screen.queryByText('Checking')).not.toBeInTheDocument();
    unmount();
    const done = toolRow(
      'wait_for',
      { waitForMode: 'agents', agents: ['/root/x', '/root/y'], wokenBy: 'agent_notification' },
      'Woken by agent finished (/root/x) after 2m.\nAgents:\n- /root/x completed',
    );
    renderBubble(<MessageBubble message={done} />);
    // Task titles (each with its agent icon when known) + what woke the wait.
    const title = screen.getByTestId('wait-agent-targets');
    expect(title).toHaveTextContent(
      /^Waited for X, Y · woken by agent finished \(\/root\/x\) after 2m$/,
    );
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
    await userEvent.click(title);
    expect(screen.getByText('/root/x completed')).toBeInTheDocument();
  });

  it("keeps main's WaitForChip for condition waits", () => {
    const condition = toolRow(
      'wait_for',
      {
        toolStatus: 'IN_PROGRESS',
        waitForMode: 'condition',
        title: 'Waiting for the price to drop',
      },
      '',
    );
    renderBubble(<MessageBubble message={condition} />);
    expect(screen.getByText('Waiting for the price to drop')).toBeInTheDocument();
    expect(screen.getByText('Checking')).toBeInTheDocument();
  });

  it('only maps agent rows (plain tools and human rows return null)', () => {
    expect(buildAgentToolData(toolRow('web_search', {}, 'x'))).toBeNull();
    expect(buildAgentToolData(baseMessage({ role: 'USER', text: 'hi' }))).toBeNull();
    expect(buildAgentToolData(toolRow('wait_for', { waitForMode: 'timestamp' }))).toBeNull();
    expect(
      buildAgentToolData(toolRow('wait_for', { waitForMode: 'agents', agents: ['/root/x'] })),
    ).not.toBeNull();
  });
});

describe('background spawn rows', () => {
  it('hides the "Started … in background" row the backend marks hidden', () => {
    const started = toolRow(
      'spawn_agent',
      { hidden: true, runInBackground: true },
      'Started general_purpose agent in background.',
    );
    const { result } = renderHook(() => useFilteredMessages([started], undefined));
    expect(result.current.filteredMessagesRaw).toHaveLength(0);
  });
});

describe('list_agents structured tree (metadata.agentTree)', () => {
  const node = (
    agent_id: string,
    path: string,
    parent_agent_id: string | null,
    status: string,
    goal: string,
    extra: Record<string, unknown> = {},
  ) => ({ agent_id, path, parent_agent_id, status, goal, type: 'agent', child_count: 0, ...extra });

  const view = {
    self_agent_id: 'a-out',
    root_agent_id: 'a-root',
    caller_path: [
      { agent_id: 'a-root', path: '/root', goal: 'Plan', status: 'ACTIVE', depth: 0 },
      { agent_id: 'a-out', path: '/root/outreach', goal: 'Outreach', status: 'ACTIVE', depth: 1 },
    ],
    node_path: [],
    nodes: [
      node('a-root', '/root', null, 'ACTIVE', 'Plan the offsite'),
      node('a-budget', '/root/budget', 'a-root', 'COMPLETED', 'Draft a budget'),
      node('a-out', '/root/outreach', 'a-root', 'ACTIVE', 'Outreach'),
      node('a-draft', '/root/outreach/draft_a', 'a-out', 'FAILED', 'Draft email A'),
      node('a-venues', '/root/venues', 'a-root', 'ACTIVE', 'Venues', {
        child_count: 4,
        active_child_count: 1,
      }),
    ],
    own_tasks: [
      { address: '/root/outreach/scan', type: 'browser', status: 'running', goal: 'Scan sites' },
    ],
  };

  function renderTree(agentTree: unknown, onNavigate = vi.fn()) {
    const msg = toolRow('list_agents', { title: 'Listed 5 agents', agentTree }, 'text fallback');
    renderBubble(<MessageBubble message={msg} onNavigateToAgent={onNavigate} />);
    return onNavigate;
  }

  it('renders rows with relationships, highlights you, and navigates', async () => {
    const onNavigate = renderTree(view);
    await expand('Listed agent tree · 5 agents');
    const rows = screen.getAllByTestId('agent-listing-row');
    const byName = (name: string) => rows.find((row) => row.textContent?.includes(name))!;
    expect(rows.map((r) => r.querySelector('.font-mono.text-foreground')?.textContent)).toEqual([
      'root',
      'budget',
      'outreach',
      'draft_a',
      'scan',
      'venues',
    ]);
    expect(byName('outreach')).toHaveAttribute('data-self', 'true');
    expect(byName('outreach')).toHaveTextContent('you are here');
    expect(byName('root')).toHaveTextContent('parent · root');
    expect(byName('budget')).toHaveTextContent('sibling');
    expect(byName('draft_a')).toHaveTextContent('child');
    expect(byName('scan')).toHaveTextContent('your task');
    expect(byName('draft_a').textContent).toContain('│ ├─');
    expect(byName('scan').textContent).toContain('│ └─');
    expect(screen.queryByText('text fallback')).not.toBeInTheDocument();
    await userEvent.click(within(byName('venues')).getByTestId('agent-listing-hidden-children'));
    expect(within(byName('venues')).getByTestId('agent-listing-hidden-children')).toHaveTextContent(
      '4 children · 1 active',
    );
    expect(onNavigate).toHaveBeenCalledWith('a-venues');
    await userEvent.click(byName('budget'));
    expect(onNavigate).toHaveBeenCalledWith('a-budget');
  });

  it('opens navigable rows from the keyboard (Enter/Space) and leaves others inert', async () => {
    const onNavigate = renderTree(view);
    await expand('Listed agent tree · 5 agents');
    const rows = screen.getAllByTestId('agent-listing-row');
    const byName = (name: string) => rows.find((row) => row.textContent?.includes(name))!;
    const budget = byName('budget');
    expect(budget).toHaveAttribute('role', 'button');
    expect(budget).toHaveAttribute('tabindex', '0');
    for (const inert of [byName('outreach'), byName('scan')]) {
      expect(inert).not.toHaveAttribute('role');
      expect(inert).not.toHaveAttribute('tabindex');
    }
    budget.focus();
    await userEvent.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenLastCalledWith('a-budget');
    byName('draft_a').focus();
    await userEvent.keyboard(' ');
    expect(onNavigate).toHaveBeenLastCalledWith('a-draft');
    expect(onNavigate).toHaveBeenCalledTimes(2);
    onNavigate.mockClear();
    within(byName('venues')).getByTestId('agent-listing-hidden-children').focus();
    await userEvent.keyboard('{Enter}');
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('a-venues');
    onNavigate.mockClear();
    fireEvent.keyDown(byName('scan'), { key: 'Enter' });
    fireEvent.keyDown(byName('outreach'), { key: ' ' });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('shows search matches with breadcrumbs', async () => {
    renderTree({
      ...view,
      nodes: [],
      matches: [
        {
          agent_id: 'a-v1',
          path: '/root/venues/venues_1',
          status: 'ACTIVE',
          goal: 'Brazos Hall',
          ancestor_ids: ['a-root', 'a-venues'],
          child_count: 0,
        },
      ],
    });
    await expand('Listed agent tree · 5 agents');
    const row = screen.getByTestId('agent-listing-row');
    expect(row).toHaveTextContent('root › venues ›');
    expect(row).toHaveTextContent('venues_1');
  });

  it('falls back to the text for older rows without agentTree', async () => {
    renderTree(undefined);
    await expand('Listed agent tree · 5 agents');
    expect(screen.queryByTestId('agent-tree-listing')).not.toBeInTheDocument();
    expect(screen.getByText('text fallback')).toBeInTheDocument();
  });
});

describe('list_agents inside an explore agent', () => {
  it('renders the structured tree inside the explore step list', async () => {
    const agentTree = {
      self_agent_id: '/root/outreach/scan',
      root_agent_id: 'a-root',
      caller_path: [
        { agent_id: 'a-root', path: '/root' },
        { agent_id: 'a-out', path: '/root/outreach' },
        { agent_id: '/root/outreach/scan', path: '/root/outreach/scan' },
      ],
      nodes: [
        {
          agent_id: 'a-root',
          path: '/root',
          parent_agent_id: null,
          status: 'ACTIVE',
          goal: 'Plan',
          type: 'agent',
        },
        {
          agent_id: 'a-out',
          path: '/root/outreach',
          parent_agent_id: 'a-root',
          status: 'ACTIVE',
          goal: 'Outreach',
          type: 'agent',
        },
        {
          agent_id: '/root/outreach/scan',
          path: '/root/outreach/scan',
          parent_agent_id: 'a-out',
          status: 'running',
          goal: 'Scan',
          type: 'explore',
        },
      ],
    };
    let expanded = new Set<number>();
    const steps = [
      {
        title: 'Listed 3 agents',
        status: 'FINISHED' as const,
        toolName: 'list_agents',
        message: 'text',
        agentTree,
      },
    ];
    const { rerender } = renderBubble(
      <ExploreAgentSteps
        steps={steps}
        expandedSteps={expanded}
        onToggleStep={(index) => {
          expanded = new Set([index]);
        }}
      />,
    );
    await userEvent.click(screen.getByText('Listed 3 agents'));
    rerender(<ExploreAgentSteps steps={steps} expandedSteps={expanded} onToggleStep={() => {}} />);
    const tree = screen.getByTestId('explore-step-agent-tree');
    const scan = within(tree)
      .getAllByTestId('agent-listing-row')
      .find((row) => row.textContent?.includes('scan'))!;
    expect(scan).toHaveAttribute('data-self', 'true');
    expect(within(tree).getAllByTestId('agent-listing-row')[1]).toHaveTextContent('parent');
  });
});
