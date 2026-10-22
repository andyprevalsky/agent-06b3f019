/**
 * STATE MACHINE: MessageBubble (dispatcher)
 *
 * Routes a Message to exactly one sub-bubble, checked in this order:
 *   - SubAgent tool      → SubAgentBubble (tree / chip / spawning placeholder)
 *   - Explore agent      → ExploreBubble (grouped step history)
 *   - WaitFor tool       → WaitForBubble
 *   - Signup request     → SignupBubble
 *   - Tool approval      → null (handled by ApprovalChip upstream)
 *   - set_plan tool      → PlanBubble (shows PlanChip)
 *   - call_phone_number  → PhoneCallBubble
 *   - Claude Code chip   → ClaudeCodeBubble
 *   - Completion summary → CompletionBubble
 *   - User attention     → AttentionMessageWrapper
 *   - Inbound agent rows (agent message / completion, USER or ASSISTANT)
 *                        → InboundAgentRow ("↓", left accent, robot icons)
 *   - Generic tool data  → ToolMessage (incl. outbound agent tools:
 *                          list_agents, send_message_to_agent, kill_agent — agentToolData.ts)
 *   - USER role          → UserBubble
 *   - ASSISTANT + file   → AssistantAttachmentBubble
 *   - Empty thought      → null
 *   - else               → DefaultBubble (SYSTEM / plain ASSISTANT)
 *
 * Each sub-bubble owns its own state machine; this file is stateless.
 */
import type { MessageBubbleProps } from './message-bubble/types';
import { useMessageRouting } from './message-bubble/useMessageRouting';
import { useToolData } from './message-bubble/useToolData';
import { renderSpecialisedBubble } from './message-bubble/renderSpecialisedBubble';
import { renderFallbackBubble } from './message-bubble/renderFallbackBubble';
import { normalizeWMHCodeMessage } from './wmhCodeMessage';

export default function MessageBubble(rawProps: MessageBubbleProps) {
  const props = { ...rawProps, message: normalizeWMHCodeMessage(rawProps.message) };
  const { message, isStreaming = false } = props;
  const routing = useMessageRouting(message);
  const toolData = useToolData({
    message,
    isStreaming,
    isAssistant: routing.isAssistant,
    isTool: routing.isTool,
  });

  const specialised = renderSpecialisedBubble({ props, routing });
  if (specialised !== undefined) return specialised;

  return renderFallbackBubble({ props, routing, toolData });
}
