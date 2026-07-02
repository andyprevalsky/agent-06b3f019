/**
 * Derives the boolean routing flags that MessageBubble uses to dispatch a
 * message to the correct sub-component. Kept separate so the dispatcher can
 * stay small and the logic is testable in isolation.
 */
import type { Message } from '../../hooks';

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
  const isWaitFor = isTool && metadata?.toolName === 'wait_for';
  const isSetPlanTool = isTool && metadata?.toolName === 'set_plan';
  const isPhoneCallTool = isTool && metadata?.toolName === 'call_phone_number';
  const isClaudeCodeToolMessage = isTool && metadata?.toolName === 'spawn_claude_code_agent';
  const isCompletionSummary = isTool && metadata?.isFinalSummary === true;

  const isClaudeCodeInProgress = isClaudeCodeToolMessage && metadata?.toolStatus === 'IN_PROGRESS';
  const isClaudeCodeStarted =
    isClaudeCodeToolMessage && metadata?.action_type === 'claude_code_started';
  const isClaudeCodeComplete = isClaudeCodeToolMessage && metadata?.action_type === 'task_complete';
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
  const isBrowserAgentChipMessage = Boolean(
    isTool &&
      metadata?.toolName === 'spawn_browser_agent' &&
      !metadata?.subAgentId &&
      (metadata?.toolStatus === 'FINISHED' || metadata?.toolStatus === 'ERROR'),
  );

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
  };
}
