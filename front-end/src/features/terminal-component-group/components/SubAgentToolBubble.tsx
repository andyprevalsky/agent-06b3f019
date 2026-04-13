/**
 * STATE MACHINE: SubAgentToolBubble
 *
 * This component is stateless - receives all state via props.
 * Renders a sub-agent tool call with progress indicator.
 *
 * Props-driven visual states:
 * - status: 'IN_PROGRESS' | 'FINISHED'
 * - progress: 0.0-1.0 (for progress bar)
 *
 * Click handler navigates to sub-agent via onNavigate callback.
 */

import { ChevronRight } from 'lucide-react';
import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';

interface SubAgentToolBubbleProps {
  toolCallId: string;
  title: string;
  message: string;
  status: 'IN_PROGRESS' | 'FINISHED';
  progress: number; // Progress from metadata (0.0-1.0)
  agentId?: string; // Sub-agent ID from metadata
  onNavigate: (agentId: string) => void;
}

// Extract emoji from start of text and return {emoji, text}
function extractEmoji(text: string): { emoji: string; text: string } {
  const emojiRegex =
    /^([\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+)\s*/gu;
  const match = text.match(emojiRegex);

  if (match) {
    const emoji = match[0];
    const remainingText = text.slice(emoji.length).trim();
    return { emoji, text: remainingText };
  }

  return { emoji: '', text };
}

const SubAgentToolBubble = memo(function SubAgentToolBubble({
  toolCallId,
  title,
  message,
  status,
  progress,
  agentId,
  onNavigate,
}: SubAgentToolBubbleProps) {
  const isComplete = status === 'FINISHED';

  // Extract emoji from title (memoized)
  const { emoji, text: titleText } = useMemo(() => extractEmoji(title), [title]);

  // Memoize progress calculations to prevent recalculation on every render
  const progressData = useMemo(() => {
    const radius = 10;
    const circumference = 2 * Math.PI * radius;
    const progressOffset = circumference - progress * circumference;
    const progressPercent = Math.round(progress * 100);

    return { radius, circumference, progressOffset, progressPercent };
  }, [progress]);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('SubAgentToolBubble clicked, agentId:', agentId);
    if (agentId) {
      onNavigate(agentId);
    }
  };

  return (
    <button
      onClick={handleClick}
      type="button"
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors cursor-pointer"
    >
      {/* Progress Ring (small) - no percentage text */}
      <div className="flex-shrink-0" style={{ width: 20, height: 20 }}>
        <svg className="transform -rotate-90" viewBox="0 0 24 24" width="20" height="20">
          {/* Background circle */}
          <circle
            className="fill-none stroke-gray-300 dark:stroke-gray-600"
            cx="12"
            cy="12"
            r={progressData.radius}
            strokeWidth="2.5"
          />
          {/* Progress circle */}
          <circle
            className="fill-none"
            cx="12"
            cy="12"
            r={progressData.radius}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={progressData.circumference}
            strokeDashoffset={progressData.progressOffset}
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

      {/* Content */}
      <span
        className={cn(
          'text-sm font-medium inline-flex items-center gap-1',
          status === 'IN_PROGRESS' &&
            'animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent',
          status === 'FINISHED' && 'text-gray-700 dark:text-gray-300',
        )}
      >
        {/* Emoji with grayscale filter (but shimmer still applies via parent) */}
        {emoji && <span style={{ filter: 'grayscale(1) brightness(0)' }}>{emoji}</span>}
        {/* Text without filter (shimmer applies via parent) */}
        <span>{titleText}</span>
      </span>

      {/* Chevron (always show) */}
      <ChevronRight className="h-4 w-4 text-gray-400 dark:text-gray-500" />
    </button>
  );
});

export default SubAgentToolBubble;
