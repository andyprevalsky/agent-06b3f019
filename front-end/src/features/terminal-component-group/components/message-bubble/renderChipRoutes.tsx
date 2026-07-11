/**
 * Specialised routes for "chip"-style tool events: approval, set_plan,
 * call_phone_number, spawn_claude_code_agent, completion summaries, and the
 * send_message_to_user attention UI.
 */
import type { ReactElement } from 'react';
import type { MessageBubbleProps } from './types';
import type { MessageRouting } from './useMessageRouting';
import { PlanBubble } from './PlanBubble';
import { PhoneCallBubble } from './PhoneCallBubble';
import { ClaudeCodeBubble } from './ClaudeCodeBubble';
import BrowserAgentChip from '../BrowserAgentChip';
import { CompletionBubble } from './CompletionBubble';
import { AttentionMessageWrapper } from './AttentionMessageWrapper';

interface Args {
  props: MessageBubbleProps;
  routing: MessageRouting;
}

export function renderChipRoutes({ props, routing }: Args): ReactElement | null | undefined {
  const {
    message,
    shouldType = false,
    onTypingComplete,
    isStreaming = false,
    onSendMessage,
    compact = false,
    onSubmitFeedback,
    planCharCount,
    planStreamStartedAtMs,
  } = props;

  if (routing.isToolApproval) {
    if (shouldType && onTypingComplete) {
      requestAnimationFrame(() => onTypingComplete());
    }
    return null;
  }

  if (routing.isSetPlanTool) {
    return (
      <PlanBubble
        message={message}
        shouldType={shouldType}
        onTypingComplete={onTypingComplete}
        planCharCount={planCharCount}
        planStreamStartedAtMs={planStreamStartedAtMs}
      />
    );
  }

  if (routing.isPhoneCallTool) {
    return <PhoneCallBubble message={message} onTypingComplete={onTypingComplete} />;
  }

  if (routing.isClaudeCodeChipMessage) {
    return (
      <ClaudeCodeBubble
        message={message}
        shouldType={shouldType}
        onTypingComplete={onTypingComplete}
      />
    );
  }

  if (routing.isBrowserAgentChipMessage) {
    if (shouldType && onTypingComplete) {
      requestAnimationFrame(() => onTypingComplete());
    }
    return <BrowserAgentChip message={message} />;
  }

  if (routing.isCompletionSummary && message.metadata?.completionSummary) {
    return (
      <CompletionBubble
        message={message}
        shouldType={shouldType}
        compact={compact}
        onTypingComplete={onTypingComplete}
        onSubmitFeedback={onSubmitFeedback}
      />
    );
  }

  if (routing.isGate) {
    if (shouldType && onTypingComplete) {
      requestAnimationFrame(() => onTypingComplete());
    }
    return null;
  }

  if (routing.isUserAttentionMessage) {
    return (
      <AttentionMessageWrapper
        message={message}
        shouldType={shouldType}
        isStreaming={isStreaming}
        onTypingComplete={onTypingComplete}
        onSendMessage={onSendMessage}
      />
    );
  }

  return undefined;
}
