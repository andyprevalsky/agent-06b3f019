/**
 * Agent-to-agent rows → the generic ToolMessage card (main's tool-chip UI).
 *
 * Pattern: prime-agent pa-tui ("✉ Agent message · ↓ <counterpart>", body on
 * expand) and codex TUI collab cells ("• Sent input to X", details below).
 * Never a user bubble, never assistant prose.
 *
 *   agentMessage row (USER or ASSISTANT)  → "Message from /root/x"        [body]
 *   agentNotification row                 → not rendered (filtered from the
 *                                           trajectory; spawn UI + dock show it)
 *   list_agents (explore agents)          → "Listed agent tree · N agents" [tree]
 *   send_message_to_agent                 → "Messaged /root/x"             [message]
 *   kill_agent                            → "Killed /root/x"               [result]
 *   wait_for (agents mode)                → "Waiting for /root/x, /root/y" → "Waited for … · woken by <what>"
 *                                           [result]; timestamp/condition waits keep main's WaitForChip
 *
 * Keyed off metadata (agentMessage / messageType / toolName / waitForMode),
 * never off message text.
 */
import { isAgentMessageMetadata } from '@/lib/realtime-types';
import type { Message } from '../../hooks';
import { codexPayload } from '../../hooks/codexMessage';
import type { ToolMessageData } from './types';

export const AGENT_MESSAGE_TOOL_NAME = 'agent_message';

const AGENT_TOOLS = new Set(['list_agents', 'send_message_to_agent', 'kill_agent']);

type Metadata = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** True when this row renders as an agent-to-agent tool card. */
export function isAgentToolRow(message: Message): boolean {
  const metadata = message.metadata;
  if (!metadata) return false;
  if (message.role === 'USER' || message.role === 'ASSISTANT') {
    return isAgentMessageMetadata(metadata);
  }
  if (message.role !== 'TOOL') return false;
  return AGENT_TOOLS.has(String(metadata.toolName ?? '')) || isAgentWait(metadata);
}

/** wait_for in agents mode (wait on other agents rather than time/condition). */
export function isAgentWait(metadata: Metadata): boolean {
  return metadata.toolName === 'wait_for' && metadata.waitForMode === 'agents';
}

function targetOf(metadata: Metadata): string | null {
  return (
    str(metadata.toAgentPath) ??
    str(metadata.resolvedPath) ??
    str(metadata.targetPath) ??
    str(metadata.to) ??
    str(metadata.toAgentAddress) ??
    str(metadata.targetAgentId)
  );
}

function listAgentsTitle(metadata: Metadata, title: string | null): string {
  const count = title ? /(\d+)/.exec(title)?.[1] : undefined;
  const query = str(metadata.query);
  if (query) return `Searched agents: '${query}'${count ? ` · ${count} matches` : ''}`;
  return count ? `Listed agent tree · ${count} agents` : 'Listed agent tree';
}

/**
 * wait_for(agents=…) is a compact tool row (timestamp/condition waits keep
 * main's WaitForChip): "Waiting for /root/x, /root/y" while running, then
 * "Waited for /root/x, /root/y · woken by <what>" from the result's first line.
 */
function agentWaitTitle(message: Message, metadata: Metadata): string {
  const targets = waitTargets(metadata);
  if (metadata.toolStatus === 'IN_PROGRESS') return `Waiting for ${targets}`;
  const first = str(message.text.split('\n')[0])?.replace(/\.$/, '');
  if (!first) return `Waited for ${targets}`;
  return `Waited for ${targets} · ${first.charAt(0).toLowerCase()}${first.slice(1)}`;
}

function waitTargets(metadata: Metadata): string {
  const agents = metadata.agents;
  if (agents === 'any') return 'any agent';
  if (Array.isArray(agents) && agents.length > 0) return agents.map(String).join(', ');
  return str(metadata.description) ?? 'other agents';
}

const VERBS: Record<string, string> = {
  send_message_to_agent: 'Messaged',
  kill_agent: 'Killed',
};

function toolTitle(message: Message, metadata: Metadata, failed: boolean): string {
  const toolName = String(metadata.toolName ?? '');
  const backendTitle = str(metadata.title);
  if (failed) return backendTitle ?? `${toolName} failed`;
  if (toolName === 'list_agents') return listAgentsTitle(metadata, backendTitle);
  if (isAgentWait(metadata)) return agentWaitTitle(message, metadata);
  const target = targetOf(metadata);
  const verb = VERBS[toolName];
  return verb && target ? `${verb} ${target}` : (backendTitle ?? toolName);
}

function toolBody(message: Message, metadata: Metadata): string {
  const toolName = String(metadata.toolName ?? '');
  const text = message.text?.trim() ?? '';
  if (toolName === 'list_agents' && metadata.toolStatus !== 'ERROR' && text) {
    return `\`\`\`text\n${text}\n\`\`\``;
  }
  if (toolName === 'send_message_to_agent') {
    return str(metadata.message) ?? text;
  }
  return text;
}

/** ToolMessageData for an agent-to-agent row, or null when not one. */
export function buildAgentToolData(message: Message): ToolMessageData | null {
  if (!isAgentToolRow(message)) return null;
  const metadata = (message.metadata ?? {}) as Metadata;
  const toolCallId = str(metadata.toolCallId) ?? message.message_id;
  if (isAgentMessageMetadata(metadata)) {
    const from = str(metadata.fromAgentPath) ?? str(metadata.fromGoal) ?? str(metadata.fromAgentId);
    return {
      toolCallId,
      toolName: AGENT_MESSAGE_TOOL_NAME,
      title: from ? `Message from ${from}` : 'Message from agent',
      status: 'FINISHED',
      message: codexPayload(message.text),
    };
  }
  const failed = metadata.toolStatus === 'ERROR';
  return {
    toolCallId,
    toolName: String(metadata.toolName ?? ''),
    title: toolTitle(message, metadata, failed),
    status: metadata.toolStatus === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'FINISHED',
    message: toolBody(message, metadata),
    error: failed,
  };
}
