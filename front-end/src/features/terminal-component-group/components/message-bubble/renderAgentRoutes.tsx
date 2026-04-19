/**
 * Specialised routes for "agent-origin" tool events: spawn_sub_agent,
 * spawn_agent (explore), wait_for, and request_user_signup.
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
        onTypingComplete={onTypingComplete}
      />
    );
  }

  if (routing.isWaitFor) {
    return (
      <WaitForBubble
        message={message}
        waitForChecks={waitForChecks}
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
