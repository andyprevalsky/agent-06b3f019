/**
 * set_plan tool → PlanChip.
 *
 * Calls onTypingComplete immediately (PlanChip does not animate text) so the
 * Terminal message queue is not blocked. Handles ERROR, IN_PROGRESS, and
 * FINISHED statuses by feeding the PlanChip with either the streamed data
 * payload or the fallback error/loading state.
 */
import type { Message } from '../../hooks';
import { PlanChip } from '../PlanChip';
import type { PlanTask } from '../../hooks';

interface PlanDataShape {
  title?: string;
  content?: string;
  tasks?: PlanTask[];
  dependencies?: Record<string, string[]> | null;
  join?: 'all' | 'any';
  status?: 'planning' | 'ready' | 'executing' | 'complete' | 'error';
}

interface PlanBubbleProps {
  message: Message;
  shouldType?: boolean;
  onTypingComplete?: () => void;
  planCharCount?: number;
}

export function PlanBubble({
  message,
  shouldType,
  onTypingComplete,
  planCharCount,
}: PlanBubbleProps) {
  const toolStatus = message.metadata?.toolStatus as
    | 'IN_PROGRESS'
    | 'FINISHED'
    | 'ERROR'
    | undefined;
  const planData = message.metadata?.data as PlanDataShape | undefined;

  // Unblock the animation queue for all terminal statuses.
  if (
    (toolStatus === 'FINISHED' || toolStatus === 'IN_PROGRESS' || toolStatus === 'ERROR') &&
    shouldType &&
    onTypingComplete
  ) {
    requestAnimationFrame(() => onTypingComplete());
  }

  if (toolStatus === 'ERROR') {
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <div className="flex-1">
          <PlanChip
            plan={{
              title: (message.metadata?.title as string) || 'Plan Failed',
              content: message.text || '',
              tasks: [],
              dependencies: null,
              join: 'all',
              status: 'error',
            }}
            toolStatus="ERROR"
          />
        </div>
      </div>
    );
  }

  const title = planData?.title || (message.metadata?.title as string) || 'Plan';

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1">
        <PlanChip
          plan={{
            title,
            content: planData?.content || '',
            tasks: planData?.tasks || [],
            dependencies: planData?.dependencies || null,
            join: planData?.join || 'all',
            status: planData?.status || 'planning',
          }}
          toolStatus={toolStatus}
          charCount={planCharCount}
        />
      </div>
    </div>
  );
}
