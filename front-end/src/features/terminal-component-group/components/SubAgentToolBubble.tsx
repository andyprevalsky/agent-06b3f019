/**
 * STATE MACHINE: SubAgentToolBubble
 *
 * This component is stateless - receives all state via props.
 * Renders a sub-agent tool call with progress indicator.
 *
 * Props-driven visual states:
 * - status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR'
 * - progress: 0.0-1.0 (for progress bar)
 *
 * Click handler navigates to sub-agent via onNavigate callback.
 */

import { ChevronRight } from 'lucide-react';
import { memo, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';

interface SubAgentToolBubbleProps {
  toolCallId: string;
  title: string;
  message: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  progress: number; // Progress from metadata (0.0-1.0)
  agentId?: string; // Sub-agent ID from metadata
  onNavigate: (agentId: string) => void;
}

// Extract leading emoji from text using Unicode property escape.
// Uses \p{Extended_Pictographic} to reliably detect emoji (including ZWJ sequences, VS16 selectors).
function extractEmoji(text: string): { emoji: string; text: string } {
  const emojiRegex =
    /^(?:\p{Extended_Pictographic}(?:\u{FE0F}|\u{200D}\p{Extended_Pictographic})*)+\s*/u;
  const match = emojiRegex.exec(text);

  if (match) {
    const emoji = match[0].trimEnd();
    const remainingText = text.slice(match[0].length).trim();
    return { emoji, text: remainingText };
  }

  return { emoji: '', text };
}

const PROGRESS_RADIUS = 10;
const PROGRESS_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RADIUS;

function ProgressRing({
  progressOffset,
  isComplete,
}: {
  progressOffset: number;
  isComplete: boolean;
}) {
  return (
    <div className="flex-shrink-0" style={{ width: 20, height: 20 }}>
      <svg className="transform -rotate-90" viewBox="0 0 24 24" width="20" height="20">
        <circle
          className="fill-none stroke-gray-300 dark:stroke-gray-600"
          cx="12"
          cy="12"
          r={PROGRESS_RADIUS}
          strokeWidth="2.5"
        />
        <circle
          className="fill-none"
          cx="12"
          cy="12"
          r={PROGRESS_RADIUS}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={PROGRESS_CIRCUMFERENCE}
          strokeDashoffset={progressOffset}
          style={{
            transition: 'stroke-dashoffset 500ms ease',
            stroke: isComplete ? '#10b981' : 'url(#progress-gradient-small)',
          }}
        />
        <defs>
          <linearGradient id="progress-gradient-small" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FE7503" />
            <stop offset="20%" stopColor="#FC585C" />
            <stop offset="40%" stopColor="#FD5776" />
            <stop offset="60%" stopColor="#E062CC" />
            <stop offset="80%" stopColor="#A76CED" />
            <stop offset="100%" stopColor="#7A6BEC" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

const SubAgentToolBubble = memo(function SubAgentToolBubble({
  toolCallId: _toolCallId,
  title,
  message: _message,
  status,
  progress,
  agentId,
  onNavigate,
}: SubAgentToolBubbleProps) {
  const isComplete = status === 'FINISHED';
  const { emoji, text: titleText } = useMemo(() => extractEmoji(title), [title]);
  const progressOffset = useMemo(
    () => PROGRESS_CIRCUMFERENCE - progress * PROGRESS_CIRCUMFERENCE,
    [progress],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (agentId) {
        onNavigate(agentId);
      }
    },
    [agentId, onNavigate],
  );

  return (
    <button
      onClick={handleClick}
      type="button"
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.09] bg-gray-50 dark:bg-[#2f2f2c] hover:bg-gray-100 dark:hover:bg-[#383835] transition-colors cursor-pointer max-w-full"
    >
      <ProgressRing progressOffset={progressOffset} isComplete={isComplete} />
      <span
        className={cn(
          'text-sm font-medium inline-flex items-center gap-1',
          status === 'IN_PROGRESS' &&
            'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent',
          status === 'FINISHED' && 'text-gray-700 dark:text-gray-300',
        )}
      >
        {emoji && <span style={{ filter: 'grayscale(1) brightness(0)' }}>{emoji}</span>}
        <span className="truncate">{titleText}</span>
      </span>
      <ChevronRight className="h-4 w-4 text-gray-400 dark:text-gray-500" />
    </button>
  );
});

export default SubAgentToolBubble;
