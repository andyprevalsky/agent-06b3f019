/**
 * request_user_signup tool → SignupPromptBubble.
 *
 * Returns null if there's no agentId (SignupPromptBubble requires it).
 */
import type { Message } from '../../hooks';
import SignupPromptBubble from '../SignupPromptBubble';

interface SignupRequestShape {
  reason?: string;
}

interface SignupBubbleProps {
  message: Message;
  agentId?: string;
  shouldType?: boolean;
  onTypingComplete?: () => void;
  onOpenAuthModal?: () => void;
}

export function SignupBubble({
  message,
  agentId,
  shouldType,
  onTypingComplete,
  onOpenAuthModal,
}: SignupBubbleProps) {
  if (!agentId) return null;
  const signupReason =
    (message.metadata?.requestUserSignup as SignupRequestShape | undefined)?.reason ||
    message.text ||
    'Please sign up to continue.';
  const isWaiting = message.metadata?.toolStatus === 'IN_PROGRESS';

  return (
    <SignupPromptBubble
      reason={signupReason}
      agentId={agentId}
      isWaiting={isWaiting}
      shouldType={shouldType}
      onComplete={onTypingComplete}
      onOpenAuthModal={onOpenAuthModal}
    />
  );
}
