/**
 * STATE MACHINE: SignupPromptBubble
 *
 * Displays a signup prompt from the agent when request_user_signup tool is called.
 * Shows the reason text, a "Login / Signup" button, and a "Continue as Guest" option.
 * The agent blocks waiting for the user's choice.
 *
 * ACTION STATE:
 * [WAITING] <-- isWaiting: true (prop), neither button clicked
 *     |
 *     +--> (click signup) --> [SIGNALING_SIGNUP] <-- isSignalingSignup: true
 *     |         |
 *     |         v (API call complete)
 *     |         --> opens auth modal
 *     |
 *     +--> (click continue as guest) --> [SIGNALING_DISMISS] <-- isSignalingDismiss: true
 *               |
 *               v (API call complete)
 *               --> agent continues without signup
 *
 * TYPING ANIMATION:
 * [TYPING] <-- typing animation in progress
 *     |
 *     v
 * [COMPLETE] --> calls onComplete
 *
 * States:
 * - isSignalingSignup: boolean
 * - isSignalingDismiss: boolean
 * - typingComplete: boolean
 */

import { useState, useEffect, useRef, memo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { signalSignupCompleted, signalSignupDismissed } from '../hooks';
import { useAuth } from '../hooks';
import { MarkdownText } from './MarkdownText';

interface SignupPromptBubbleProps {
  reason: string;
  agentId: string;
  isWaiting: boolean;
  shouldType?: boolean;
  onComplete?: () => void;
  onOpenAuthModal?: () => void;
}

interface WaitingActionsProps {
  agentId: string;
  onSignup: () => void;
}

function WaitingActions({ agentId, onSignup }: WaitingActionsProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleContinueAsGuest = useCallback(() => {
    setIsLoading(true);
    signalSignupDismissed(agentId)
      .catch((error: unknown) => {
        console.error('Failed to signal signup dismissed:', error);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [agentId]);

  return (
    <>
      <div className="flex items-center gap-3">
        <Button
          onClick={onSignup}
          disabled={isLoading}
          className="bg-navi-black hover:bg-navi-black/90 text-white"
        >
          Login / Signup
        </Button>
        <Button
          variant="ghost"
          onClick={handleContinueAsGuest}
          disabled={isLoading}
          className="text-muted-foreground hover:text-foreground"
        >
          {isLoading ? 'Continuing...' : 'Continue as Guest'}
        </Button>
      </div>

      {/* Yellow pulsing indicator while agent is blocked */}
      <div className="flex items-center gap-2 text-amber-500">
        <div
          className="w-4 h-4 rounded-full border-2 border-dashed border-amber-500"
          style={{ animation: 'spin 3s linear infinite' }}
        />
        <span className="text-xs font-medium">Your agent is waiting for your choice</span>
      </div>
    </>
  );
}

const SignupPromptBubble = memo(function SignupPromptBubble({
  reason,
  agentId,
  isWaiting,
  shouldType: _shouldType = false,
  onComplete,
  onOpenAuthModal,
}: SignupPromptBubbleProps) {
  const [hasAnimated, setHasAnimated] = useState(false);
  const { isAnonymous } = useAuth();
  const hasSignaledRef = useRef(false);

  const handleAnimationComplete = useCallback(() => {
    setHasAnimated(true);
    if (onComplete) {
      requestAnimationFrame(() => {
        onComplete();
      });
    }
  }, [onComplete]);

  const handleSignup = useCallback(() => {
    if (onOpenAuthModal) {
      onOpenAuthModal();
    }
  }, [onOpenAuthModal]);

  // If user is already authenticated (not anonymous), auto-signal completion
  // This handles the case where user signed up in another tab or the state changed
  useEffect(() => {
    if (!isAnonymous && isWaiting && !hasSignaledRef.current) {
      hasSignaledRef.current = true;
      signalSignupCompleted(agentId).catch((error: unknown) => {
        console.error('Failed to signal signup completed:', error);
        // Don't reset hasSignaledRef - avoid infinite retry loop on persistent errors
      });
    }
  }, [isAnonymous, isWaiting, agentId]);

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1 space-y-3">
        <div className="text-sm">
          <MarkdownText
            text={reason}
            shouldAnimate={isWaiting && !hasAnimated}
            onComplete={handleAnimationComplete}
          />
        </div>

        {isWaiting && isAnonymous && (
          <WaitingActions agentId={agentId} onSignup={handleSignup} />
        )}

        {!isWaiting && (
          <div className="text-xs text-muted-foreground">
            {isAnonymous ? 'Continued as guest' : 'Signed in'}
          </div>
        )}
      </div>
    </div>
  );
});

export default SignupPromptBubble;
