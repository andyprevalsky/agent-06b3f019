/**
 * STATE MACHINE: OpeningMessageDisplay
 *
 * REVEALING: Gradient sweep reveals text left-to-right.
 * PAUSED: Text fully visible.
 * FADING: Opacity drops to 0.
 * FINAL_CTA: On the last message, a "Join Waitlist" button fades in place of
 *            the caption text and opens the phone-auth modal with waitlist copy.
 *
 * LAYOUT:
 * MOBILE: two-line-safe caption box so long opening messages do not clip.
 * DESKTOP: single-line-preferred caption width.
 */

import { OPENING_MESSAGES } from '../config';

interface OpeningMessageDisplayProps {
  currentMessageIndex: number;
  animationPhase: string;
  revealProgress: number;
  onJoinWaitlist: () => void;
}

export function OpeningMessageDisplay({
  currentMessageIndex,
  animationPhase,
  revealProgress,
  onJoinWaitlist,
}: OpeningMessageDisplayProps) {
  const isLastMessage = currentMessageIndex === OPENING_MESSAGES.length - 1;

  const maskGradient =
    animationPhase === 'revealing'
      ? `linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${Math.max(0, revealProgress - 20)}%, rgba(0,0,0,0.5) ${revealProgress}%, rgba(0,0,0,0) ${Math.min(100, revealProgress + 10)}%)`
      : 'linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 100%)';

  return (
    <div
      data-testid="opening-message-display"
      className="relative mx-auto flex min-h-16 w-full max-w-[24rem] items-center justify-center px-8 md:min-h-8 md:min-w-[600px] md:max-w-none md:px-0"
    >
      {isLastMessage ? (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            opacity: animationPhase === 'fading' ? 0 : Math.min(1, revealProgress / 100),
            transition: 'opacity 0.3s ease-out',
          }}
        >
          <button
            type="button"
            onClick={onJoinWaitlist}
            data-testid="opening-join-waitlist"
            className="pointer-events-auto mx-auto rounded-full bg-navi-black px-8 py-1.5 text-center text-sm font-medium text-white shadow-lg transition-all duration-200 hover:bg-navi-black-alt hover:shadow-xl md:text-base"
          >
            Join Waitlist
          </button>
        </div>
      ) : (
        <p
          className="absolute inset-0 flex items-center justify-center text-balance text-center leading-snug text-muted-foreground md:whitespace-nowrap"
          style={{
            WebkitMaskImage: maskGradient,
            maskImage: maskGradient,
            filter:
              animationPhase === 'revealing'
                ? `brightness(${0.3 + (revealProgress / 100) * 0.7})`
                : 'brightness(1)',
            opacity: animationPhase === 'fading' ? 0 : 1,
            transition: animationPhase === 'fading' ? 'opacity 0.3s ease-out' : 'none',
          }}
        >
          {OPENING_MESSAGES[currentMessageIndex]?.[0]}
        </p>
      )}
    </div>
  );
}
