/**
 * Derives the boolean routing flags that MessageBubble uses to dispatch a
 * message to the correct sub-component. Kept separate so the dispatcher can
 * stay small and the logic is testable in isolation.
 */
import { isAgentMessageMetadata, isAgentNotificationMetadata } from '@/lib/realtime-types';
import type { Message } from '../../hooks';
import { isBrowserAgentResult } from '../browserAgentResult';
import { isAgentWait } from './agentToolData';

const GENERAL_PURPOSE_AGENT_TOOLS = new Set([
  'spawn_general_purpose_agent',
  'spawn_general_purpose_agent_for_each',
  'spawn_sub_agent',
]);

export interface MessageRouting {
  isUser: boolean;
  isTool: boolean;
  isAssistant: boolean;
  isSystem: boolean;
  isUserAttentionMessage: boolean;
  isToolApproval: boolean;
  isSignupRequest: boolean;
  isSubAgentTool: boolean;
  isExploreAgent: boolean;
  isWaitFor: boolean;
  isSetPlanTool: boolean;
  isPhoneCallTool: boolean;
  isClaudeCodeToolMessage: boolean;
  isClaudeCodeChipMessage: boolean;
  isBrowserAgentChipMessage: boolean;
  isCompletionSummary: boolean;
  isGate: boolean;
  /** USER/ASSISTANT row carrying another agent's message (renders as a tool card). */
  isAgentMessage: boolean;
  /** USER/ASSISTANT row announcing a sub-agent finished (renders as a tool card). */
  isAgentNotification: boolean;
  /** list_agents result → structured agent-tree chip. */
  isListAgents: boolean;
}

export function useMessageRouting(message: Message): MessageRouting {
  const isUser = message.role === 'USER';
  const isTool = message.role === 'TOOL';
  const isAssistant = message.role === 'ASSISTANT';
  const isSystem = message.role === 'SYSTEM';
  const metadata = message.metadata;

  const isUserAttentionMessage = Boolean(isTool && metadata?.isUserAttentionMessage);
  const isToolApproval = Boolean(
    isTool &&
    (metadata?.requestUserApproval as { toolApproval?: unknown } | undefined)?.toolApproval,
  );
  const isSignupRequest = Boolean(isTool && metadata?.requestUserSignup);
  const isSubAgentTool = Boolean(
    metadata?.toolName && GENERAL_PURPOSE_AGENT_TOOLS.has(metadata.toolName),
  );
  const isExploreAgent =
    isTool && metadata?.toolName === 'spawn_agent' && metadata?.agentType === 'explore';
  // wait_for(agents=…) is a compact tool row; other waits keep WaitForChip.
  const isWaitFor = isTool && metadata?.toolName === 'wait_for' && !isAgentWait(metadata);
  const isListAgents = isTool && metadata?.toolName === 'list_agents';
  const isSetPlanTool = isTool && metadata?.toolName === 'set_plan';
  const isPhoneCallTool = isTool && metadata?.toolName === 'call_phone_number';
  const isClaudeCodeToolMessage = isTool && metadata?.toolName === 'spawn_claude_code_agent';
  const isCompletionSummary = isTool && metadata?.isFinalSummary === true;
  const isGate = Boolean(isTool && metadata?.gate);
  // Agent-origin rows may arrive as USER or ASSISTANT; both render as tool cards.
  const isAgentOriginRole = isUser || isAssistant;
  const isAgentNotification = isAgentOriginRole && isAgentNotificationMetadata(metadata);
  const isAgentMessage =
    isAgentOriginRole && !isAgentNotification && isAgentMessageMetadata(metadata);

  const isClaudeCodeInProgress = isClaudeCodeToolMessage && metadata?.toolStatus === 'IN_PROGRESS';
  const isClaudeCodeStarted =
    isClaudeCodeToolMessage && metadata?.action_type === 'claude_code_started';
  const isClaudeCodeComplete =
    isClaudeCodeToolMessage &&
    (metadata?.action_type === 'task_complete' || metadata?.action_type === 'session_cancelled');
  const isClaudeCodeChipMessage = Boolean(
    isClaudeCodeInProgress || isClaudeCodeStarted || isClaudeCodeComplete,
  );

  // Browser-agent terminal results shown in the main chat (no subAgentId — the
  // per-step messages carry one and stay in the browser panel). This covers both
  // the inner completion (action_type 'task_complete', with task_id) and the
  // outer tool result / session-init failure (no task_id, e.g. "Browser
  // automation failed"). All become a single chip; the chip derives recording +
  // trajectory from task_id-scoped messages when available, else shows the
  // result with Recording/Trajectory unavailable.
  //
  // A task-scoped message must declare terminality via action_type. Browser
  // sub-steps share the parent tool call's toolCallId and dedupByToolCallId is
  // last-wins, so a workflow-scope PROGRESS event ("Payment card ready",
  // "✓ Write permission granted") becomes the chip anchor mid-run; without this
  // check it renders the still-running browser agent as "Done"
  // (prod agent 7f354640-ffab-4098-b7ae-041ddf246c6f).
  const isBrowserAgentChipMessage = isBrowserAgentResult(message);

  return {
    isUser,
    isTool,
    isAssistant,
    isSystem,
    isUserAttentionMessage,
    isToolApproval,
    isSignupRequest,
    isSubAgentTool,
    isExploreAgent,
    isWaitFor,
    isSetPlanTool,
    isPhoneCallTool,
    isClaudeCodeToolMessage,
    isClaudeCodeChipMessage,
    isBrowserAgentChipMessage,
    isCompletionSummary,
    isGate,
    isAgentMessage,
    isAgentNotification,
    isListAgents,
  };
}
