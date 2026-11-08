/**
 * Message builders for background-agents.blackbox.tsx: the rows a background
 * spawn posts (hidden "Started" row, live UI rows, completion notifications)
 * and canned spawns (general purpose, for_each, explore, a user-paused
 * browser), plus the dock render used by the dock cases.
 */
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import { BackgroundAgentsBanner } from '@/features/terminal-component-group/components/background-agents/BackgroundAgentsBanner';
import type { Message } from '@/lib/api';
import { makeAgentCtx } from './message-bubble.fixtures';
import { makeAgentTreeNode } from './terminal-component-chips.fixtures';

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
let seq = 0;
export function row(
  metadata: Record<string, unknown>,
  text = '',
  role: Message['role'] = 'TOOL',
): Message {
  seq += 1;
  return {
    message_id: `m-${seq}`,
    timestamp: new Date(T0 + seq * 1000).toISOString(),
    role,
    text,
    metadata,
  };
}

export function started(callId: string, type: string, path: string, goal: string): Message {
  return row(
    {
      toolCallId: callId,
      toolName: 'spawn_agent',
      toolStatus: 'FINISHED',
      hidden: true,
      runInBackground: true,
      backgroundAddress: path,
      backgroundPath: path,
      backgroundGoal: goal,
      backgroundAgentType: type,
    },
    'Started',
  );
}

export function live(callId: string, extra: Record<string, unknown>): Message {
  return row({
    toolCallId: callId,
    toolName: 'spawn_general_purpose_agent',
    toolStatus: 'IN_PROGRESS',
    excludeFromModel: true,
    busId: 'root-1',
    ...extra,
  });
}

export function done(callId: string, path: string, status: string, body: string): Message {
  return row(
    {
      agentNotification: true,
      toolName: 'agent_notification',
      fromAgentAddress: path,
      status,
      backgroundTaskId: callId,
    },
    `Message Type: ${status === 'failed' ? 'FAILED' : 'FINAL_ANSWER'}\nTask name: x\nSender: ${path}\nPayload:\n${body}`,
    'USER',
  );
}

export const gp = () => [
  started('call_gp', 'general_purpose', '/root/budget_planner', 'Draft a rough budget'),
  live('call_gp', { subAgentIds: ['child-1'], spawnGroupId: 'call_gp' }),
];
export const forEach = () => [
  started('call_fe', 'for_each', '/root/venue_capacities', 'Look up each venue'),
  live('call_fe:0', { subAgentIds: ['fe-a'] }),
  live('call_fe:1', { subAgentIds: ['fe-b'] }),
  live('call_fe:2', { subAgentIds: ['fe-c'] }),
];
export const explore = () => [
  started('call_ex', 'explore', '/root/hotel_price', 'Find the average hotel price'),
  row({
    toolCallId: 'call_ex',
    toolName: 'spawn_agent',
    toolStatus: 'IN_PROGRESS',
    excludeFromModel: true,
    agentType: 'explore',
    taskId: 't-ex',
    title: 'Exploring',
  }),
];

// The rows prod root 447576b9 posted for /root/order_breakfast_dd when Andy
// paused the root (2026-10-26 16:08:51Z): the activity's cancel row, local
// teardown, the manager's pause row (provider session id) and the
// notification whose workflow status is "paused".
export const pausedBrowser = () => [
  started('call_br', 'browser', '/root/order_breakfast_dd', 'Place a breakfast order'),
  row({
    toolCallId: 'call_br',
    toolName: 'spawn_browser_agent',
    toolStatus: 'IN_PROGRESS',
    excludeFromModel: true,
    title: 'Clicking <a "Continue">',
  }),
  row(
    {
      toolCallId: 'call_br',
      toolName: 'spawn_browser_agent',
      toolStatus: 'FINISHED',
      excludeFromModel: true,
      title: 'Browser Session Cancelled',
      action_type: 'task_complete',
      task_id: 't-br',
    },
    'Agent paused by user',
  ),
  row(
    {
      toolCallId: 'call_br',
      toolName: 'spawn_browser_agent',
      toolStatus: 'FINISHED',
      excludeFromModel: true,
      title: 'Browser Session Closed',
      action_type: 'task_complete',
      task_id: 't-br',
    },
    'Browser session closed after teardown',
  ),
  row(
    {
      toolCallId: 'call_br',
      toolName: 'spawn_browser_agent',
      toolStatus: 'ERROR',
      excludeFromModel: true,
      title: 'Browser Session Paused',
      action_type: 'task_complete',
      task_id: 't-br',
      session_id: 'kernel-sess-1',
    },
    'User paused the browser agent',
  ),
  row(
    {
      agentNotification: true,
      toolName: 'agent_notification',
      fromAgentAddress: '/root/order_breakfast_dd',
      agentType: 'browser',
      status: 'paused',
      messageType: 'FAILED',
      backgroundTaskId: 'call_br',
      sessionId: 'kernel-sess-1',
    },
    'Message Type: FAILED\nTask name: /root\nSender: /root/order_breakfast_dd\nPayload:\nUser paused the browser agent\n\nSession ID: kernel-sess-1',
    'USER',
  ),
];

/** Root tree node whose Agent.backgroundTasks holds the breakfast browser task. */
export const rootWithBrowserTask = (status: string) =>
  makeAgentTreeNode({
    agentId: 'root-1',
    status: status === 'paused' ? 'PAUSED' : 'ACTIVE',
    backgroundTasks: [
      {
        address: 'call_br',
        path: '/root/order_breakfast_dd',
        type: 'browser',
        goal: 'Place a breakfast order',
        status,
      },
    ],
  });

export function dockElement(messages: Message[], onNavigate: (agentId: string) => void = vi.fn()) {
  // Production mounts the dock inside the selected agent's AgentProvider.
  return (
    <AgentContext.Provider value={makeAgentCtx({ selectedAgentId: 'root-1', messages })}>
      <TooltipProvider>
        <BackgroundAgentsBanner
          selectedAgentId="root-1"
          messages={messages}
          onNavigate={onNavigate}
        />
      </TooltipProvider>
    </AgentContext.Provider>
  );
}

export function renderDock(messages: Message[], onNavigate = vi.fn()) {
  return render(dockElement(messages, onNavigate));
}
