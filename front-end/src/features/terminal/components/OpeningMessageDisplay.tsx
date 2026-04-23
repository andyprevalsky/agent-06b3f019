/**
 * STATE MACHINE: OpeningMessageDisplay
 *
 * REVEALING: Gradient sweep reveals text left-to-right.
 * PAUSED: Text fully visible.
 * FADING: Opacity drops to 0.
 */

import { OPENING_MESSAGES } from '../config';

interface OpeningMessageDisplayProps {
  currentMessageIndex: number;
  animationPhase: string;
  revealProgress: number;
}

export function OpeningMessageDisplay({
  currentMessageIndex,
  animationPhase,
  revealProgress,
}: OpeningMessageDisplayProps) {
  const maskGradient =
    animationPhase === 'revealing'
      ? `linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${Math.max(0, revealProgress - 20)}%, rgba(0,0,0,0.5) ${revealProgress}%, rgba(0,0,0,0) ${Math.min(100, revealProgress + 10)}%)`
      : 'linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 100%)';

  return (
    <div className="relative w-full md:min-w-[600px] h-8 flex items-center justify-center">
      <p
        className="text-muted-foreground absolute inset-0 flex items-center justify-center"
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
    </div>
  );
}
