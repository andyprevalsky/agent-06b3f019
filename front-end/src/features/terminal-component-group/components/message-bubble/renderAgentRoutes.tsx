/**
 * Specialised routes for "agent-origin" tool events: general-purpose agent
 * spawns, spawn_agent (explore), wait_for, and request_user_signup.
 */
import type { ReactElement } from 'react';
import type { MessageBubbleProps } from './types';
import type { MessageRouting } from './useMessageRouting';
import { SubAgentBubble } from './SubAgentBubble';
import { ExploreBubble } from './ExploreBubble';
import { WaitForBubble } from './WaitForBubble';
import { SignupBubble } from './SignupBubble';

interface Args {
  props: MessageBubbleProps;
  routing: MessageRouting;
}

export function renderAgentRoutes({ props, routing }: Args): ReactElement | null | undefined {
  const {
    message,
    shouldType = false,
    onTypingComplete,
    onNavigateToAgent,
    agentId,
    onOpenAuthModal,
    exploreStepHistory,
    waitForChecks,
    thinkingStreamTokenCount,
    thinkingStreamStartedAtMs,
    hideSubAgentTreeHeader,
  } = props;

  if (routing.isSubAgentTool) {
    return (
      <SubAgentBubble
        message={message}
        onNavigateToAgent={onNavigateToAgent}
        hideSubAgentTreeHeader={hideSubAgentTreeHeader}
      />
    );
  }

  if (routing.isExploreAgent) {
    return (
      <ExploreBubble
        message={message}
        exploreStepHistory={exploreStepHistory}
        thinkingStreamTokenCount={thinkingStreamTokenCount}
        thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
        onTypingComplete={onTypingComplete}
      />
    );
  }

  if (routing.isWaitFor) {
    return (
      <WaitForBubble
        message={message}
        waitForChecks={waitForChecks}
        thinkingStreamTokenCount={thinkingStreamTokenCount}
        thinkingStreamStartedAtMs={thinkingStreamStartedAtMs}
        onTypingComplete={onTypingComplete}
      />
    );
  }

  if (routing.isSignupRequest && agentId) {
    return (
      <SignupBubble
        message={message}
        agentId={agentId}
        shouldType={shouldType}
        onTypingComplete={onTypingComplete}
        onOpenAuthModal={onOpenAuthModal}
      />
    );
  }

  return undefined;
}
