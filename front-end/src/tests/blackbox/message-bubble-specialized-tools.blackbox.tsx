import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { baseMessage, makeAgentCtx, renderBubble } from './message-bubble.fixtures';

describe('MessageBubble', () => {
  it('renders set_plan tool as PlanChip (IN_PROGRESS)', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-8',
        toolName: 'set_plan',
        title: 'My plan',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/plan/i)).toBeInTheDocument());
  });

  it('renders set_plan tool as PlanChip (ERROR)', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'bad plan',
      metadata: {
        toolCallId: 'tc-9',
        toolName: 'set_plan',
        title: 'Plan Failed',
        toolStatus: 'ERROR',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/Plan Failed/)).toBeInTheDocument());
  });

  it('renders general-purpose spawn IN_PROGRESS as spawning line', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'starting',
      metadata: {
        toolCallId: 'tc-10',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() =>
      expect(screen.getByText(/Spawning general-purpose agents/)).toBeInTheDocument(),
    );
  });

  it('renders general-purpose pre-spawn ERROR as failed tree-node', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'DAG param failed',
      metadata: {
        toolCallId: 'tc-11',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'ERROR',
        title: 'General-purpose agent',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/DAG param failed/)).toBeInTheDocument());
  });

  it('renders wait_for tool as WaitForChip', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'waiting',
      metadata: {
        toolCallId: 'tc-13',
        toolName: 'wait_for',
        title: 'Wait for signal',
        toolStatus: 'IN_PROGRESS',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} waitForChecks={[]} />);
    await waitFor(() => expect(container.textContent).toMatch(/Waiting|Wait|signal/i));
  });

  it('renders explore agent as ExploreAgentBubble', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-14',
        toolName: 'spawn_agent',
        title: 'Explore foo',
        toolStatus: 'IN_PROGRESS',
        agentType: 'explore',
        taskId: 'task-1',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getAllByText(/Explore foo/).length).toBeGreaterThan(0));
    expect(screen.getByTestId('explore-thinking-icon')).toBeInTheDocument();
  });

  it('renders finished explore agent with state-only header and result body', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'The production deployment is ready. Status: READY. URL: https://roselabs.ai',
      metadata: {
        toolCallId: 'tc-14-finished',
        toolName: 'spawn_agent',
        title: 'Explore foo',
        fullGoal: 'Explore foo in detail',
        toolStatus: 'FINISHED',
        agentType: 'explore',
        taskId: 'task-1-finished',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText('Explored')).toBeInTheDocument());
    expect(screen.queryByText(/Explored -/)).not.toBeInTheDocument();
    expect(document.body.textContent).toContain('The production deployment is ready');
    expect(container.querySelector('.tool-message-markdown')).not.toBeNull();
  });

  it('hides Fast Mode / cached-trajectory copy from explore chips', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'Fast Mode parallel replay: explore started and will run its full cached trajectory before this agent completes.',
      metadata: {
        toolCallId: 'tc-fast-mode-explore',
        toolName: 'spawn_agent',
        title: 'Identify top creators',
        fullGoal: 'Identify top creators',
        toolStatus: 'FINISHED',
        agentType: 'explore',
        taskId: 'task-fast-mode',
        fastModeParallel: true,
      },
    });
    renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText('Explored')).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/fast\s*mode/i);
    expect(document.body.textContent).not.toMatch(/fast[\s-]*cache/i);
    expect(document.body.textContent).not.toMatch(/cached trajectory/i);
  });

  it('renders failed explore agent with state-only header and error result body', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'Activity task failed: web_search_activity failed: Parallel AI search returned HTTP 429 Too Many Requests',
      metadata: {
        toolCallId: 'tc-14-error',
        toolName: 'spawn_agent',
        title: 'Check deploy status',
        fullGoal: 'Check whether the production deployment finished',
        toolStatus: 'ERROR',
        agentType: 'explore',
        taskId: 'task-1-error',
      },
    });
    renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText('Explore Failed')).toBeInTheDocument());
    expect(screen.queryByText(/Explore Failed -/)).not.toBeInTheDocument();
    expect(document.body.textContent).toContain(
      'Parallel AI search returned HTTP 429 Too Many Requests',
    );
  });

  it('renders Claude Code tool message as ClaudeCodeChip', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-15',
        toolName: 'spawn_claude_code_agent',
        toolStatus: 'IN_PROGRESS',
        task_id: 'ccc-1',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    // ClaudeCodeChip renders an <img alt="Claude Code"> logo — unique to that branch.
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
  });

  it('renders Codex code tool message when provider metadata is codex', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-codex',
        toolName: 'spawn_claude_code_agent',
        toolStatus: 'IN_PROGRESS',
        task_id: 'codex-1',
        code_provider: 'codex',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => {
      expect(screen.getByText('Codex Spinning up...')).toBeInTheDocument();
    });
    expect(screen.getByAltText('Codex')).toBeInTheDocument();
  });

  it('renders phone call tool as PhoneCallCard', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-16',
        toolName: 'call_phone_number',
        title: '📞 +15551234567',
        toolStatus: 'IN_PROGRESS',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(container.textContent).toMatch(/555|Unknown|call/i));
  });

  it('renders phone call FINISHED with phoneCall metadata', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-17',
        toolName: 'call_phone_number',
        title: '✅ Call ended',
        toolStatus: 'FINISHED',
        phoneCall: {
          status: 'ended',
          to: '+15551234567',
          duration: 42,
          summary: 'Chat summary',
        },
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    // PhoneCallCard renders the target phone number as unique text.
    await waitFor(() => expect(screen.getByText('+15551234567')).toBeInTheDocument());
    // Duration is formatted as m:ss (42s -> 0:42) — confirms FINISHED branch specifically.
    expect(screen.getByText('0:42')).toBeInTheDocument();
  });

  it('renders set_plan FINISHED with planData producing populated PlanChip', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-18',
        toolName: 'set_plan',
        title: 'Plan title',
        toolStatus: 'FINISHED',
        data: {
          title: 'Deploy the thing',
          content: 'Ship it',
          tasks: [
            { goal: 'Gather release facts', tool_name: 'spawn_explore_agent' },
            { goal: 'Write deployment notes', tool_name: 'reasoning' },
          ],
          dependencies_graph: [{ task_idx: '1', depends_on: ['0'] }],
          join: 'all',
          status: 'planning',
        },
      },
    });
    renderBubble(<MessageBubble message={msg} planCharCount={123} />);
    await waitFor(() => expect(screen.getByText(/Deploy the thing/)).toBeInTheDocument());
    expect(screen.getByText('2 Tasks · Sequential')).toBeInTheDocument();
    expect(screen.getByText('→ after 1')).toBeInTheDocument();
  });

  it('renders set_plan dependencies from a dependencies record', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-plan-record',
        toolName: 'set_plan',
        toolStatus: 'FINISHED',
        data: {
          title: 'Record deps plan',
          content: 'Ship it',
          tasks: [
            { goal: 'Collect facts', tool_name: 'spawn_explore_agent' },
            { goal: 'Write summary', tool_name: 'reasoning' },
          ],
          dependencies: { '1': ['0'] },
          join: 'all',
          status: 'planning',
        },
      },
    });

    renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText(/Record deps plan/)).toBeInTheDocument());
    expect(screen.getByText('2 Tasks · Sequential')).toBeInTheDocument();
    expect(screen.getByText('→ after 1')).toBeInTheDocument();
  });

  it('renders set_plan dependencies from task depends_on fields', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-plan-task-deps',
        toolName: 'set_plan',
        toolStatus: 'FINISHED',
        data: {
          title: 'Task deps plan',
          content: 'Ship it',
          tasks: [
            { goal: 'Collect facts', tool_name: 'spawn_explore_agent', depends_on: [] },
            { goal: 'Write summary', tool_name: 'reasoning', depends_on: ['0'] },
          ],
          join: 'all',
          status: 'planning',
        },
      },
    });

    renderBubble(<MessageBubble message={msg} />);

    await waitFor(() => expect(screen.getByText(/Task deps plan/)).toBeInTheDocument());
    expect(screen.getByText('2 Tasks · Sequential')).toBeInTheDocument();
    expect(screen.getByText('→ after 1')).toBeInTheDocument();
  });

  it('renders claude_code_started branch as ClaudeCodeChip', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-20',
        toolName: 'spawn_claude_code_agent',
        action_type: 'claude_code_started',
        task_id: 'cc-started',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    // claude_code_started must render the ClaudeCodeChip (Claude logo).
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
  });

  it('renders task_complete branch for Claude Code tool', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-21',
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        task_id: 'cc-complete',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    // task_complete must still route through ClaudeCodeChip (Claude logo).
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
  });

  it('renders session_cancelled branch for Claude Code tool', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'User paused the agent',
      metadata: {
        toolCallId: 'tc-21b',
        toolName: 'spawn_claude_code_agent',
        action_type: 'session_cancelled',
        task_id: 'cc-cancelled',
        toolStatus: 'ERROR',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
  });

  it('recovers task_id from sibling when cancel anchor omits it (avoids Spinning up)', async () => {
    // toolCallId-dedupe can anchor the chip on handler cancel without task_id.
    // Full agent transcript still has claude_code_started + Session Cancelled
    // with the real task_id — bubble must recover it so the chip leaves Spinning up.
    const toolCallId = 'tc-21c-orphan-cancel';
    const started = baseMessage({
      message_id: 'm-cc-started',
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId,
        toolName: 'spawn_claude_code_agent',
        action_type: 'claude_code_started',
        task_id: 'cc-orphan-task',
        toolStatus: 'IN_PROGRESS',
        title: 'Claude Code Started',
      },
    });
    const cancelledWithId = baseMessage({
      message_id: 'm-cc-cancelled-id',
      role: 'TOOL',
      text: 'Agent paused by user',
      metadata: {
        toolCallId,
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        task_id: 'cc-orphan-task',
        toolStatus: 'FINISHED',
        title: 'Session Cancelled',
      },
    });
    const cancelWithoutId = baseMessage({
      message_id: 'm-cc-cancel-bare',
      role: 'TOOL',
      text: 'User paused the agent',
      metadata: {
        toolCallId,
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        toolStatus: 'ERROR',
        title: 'Claude Code Session Cancelled',
        success: false,
      },
    });
    const ctx = makeAgentCtx({ messages: [started, cancelledWithId, cancelWithoutId] });
    const { container } = renderBubble(<MessageBubble message={cancelWithoutId} />, ctx);
    await waitFor(() => {
      expect(container.querySelector('img[alt="Claude Code"]')).not.toBeNull();
    });
    expect(container.textContent).not.toMatch(/Spinning up/i);
    expect(container.textContent).toMatch(/Failed|Cancelled|Complete/i);
  });

  it('renders wait_for tool as WaitForChip (FINISHED)', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'done',
      metadata: {
        toolCallId: 'tc-wf-done',
        toolName: 'wait_for',
        title: 'Waiting for signal',
        toolStatus: 'FINISHED',
      },
    });
    renderBubble(<MessageBubble message={msg} waitForChecks={[]} />);
    // WaitForChip in FINISHED state renders "Waited for {condition}".
    await waitFor(() => expect(screen.getByText(/Waited for/i)).toBeInTheDocument());
  });

  it('calls onTypingComplete for set_plan IN_PROGRESS when shouldType=true', async () => {
    const onTypingComplete = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-sp-type',
        toolName: 'set_plan',
        title: 'P',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(
      <MessageBubble message={msg} shouldType={true} onTypingComplete={onTypingComplete} />,
    );
    await waitFor(() => expect(onTypingComplete).toHaveBeenCalled());
  });

  it('calls onTypingComplete immediately for claude code tool when shouldType=true', async () => {
    const onTypingComplete = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-cc-type',
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        task_id: 'x',
      },
    });
    renderBubble(
      <MessageBubble message={msg} shouldType={true} onTypingComplete={onTypingComplete} />,
    );
    await waitFor(() => expect(onTypingComplete).toHaveBeenCalled());
  });

  it('renders sub-agent tree view when subAgentIds + busId present', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-sat',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'FINISHED',
        title: '🚀 Spawning cluster',
        subAgentIds: ['a1', 'a2'],
        busId: 'bus-1',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    // The SubAgentTree branch renders a wrapper <div.flex.gap-3> hosting <SubAgentTree />.
    // SubAgentTree returns null when useAgentTree has no nodes for the bus, so the wrapper
    // may be empty in this harness — but the OTHER branches (SubAgentToolBubble chip /
    // "Spawning general-purpose agents..." fallback / ERROR red row) all emit distinctive text.
    // Assert none of those alternate branches fired, proving we went through the tree branch.
    expect(screen.queryByText(/Spawning cluster/)).toBeNull(); // SubAgentToolBubble title
    expect(screen.queryByText(/Spawning general-purpose agents\.\.\./)).toBeNull(); // isSpawningMessage
    expect(screen.queryByText(/Failed to spawn general-purpose agent/)).toBeNull(); // error branch
    // And the tree wrapper is present.
    const wrapper = container.querySelector('div.flex.gap-3') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
  });

  it('hides the parent for_each tree when a listed child is selected', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-sat-parent',
        toolName: 'spawn_general_purpose_agent_for_each',
        toolStatus: 'FINISHED',
        title: '🚀 Spawning cluster',
        subAgentIds: ['child-1', 'child-2'],
        busId: 'root-1',
      },
    });
    const { container } = renderBubble(
      <MessageBubble message={msg} />,
      makeAgentCtx({ selectedAgentId: 'child-1' }),
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText(/Spawning cluster/)).toBeNull();
    expect(screen.queryByText(/Spawning general-purpose agents\.\.\./)).toBeNull();
    expect(container.querySelector('div.flex.gap-3')).toBeNull();
  });

  it('still renders a child-owned spawn tree when that child is selected', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-sat-child',
        toolName: 'spawn_general_purpose_agent',
        toolStatus: 'FINISHED',
        title: 'Explore cluster',
        subAgentIds: ['explore-1'],
        busId: 'child-1',
      },
    });
    const { container } = renderBubble(
      <MessageBubble message={msg} />,
      makeAgentCtx({ selectedAgentId: 'child-1' }),
    );
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    expect(screen.queryByText(/Explore cluster/)).toBeNull();
    expect(container.querySelector('div.flex.gap-3')).not.toBeNull();
  });
});
