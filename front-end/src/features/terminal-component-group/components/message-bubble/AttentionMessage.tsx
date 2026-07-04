/**
 * Raw-text "send_message_to_user" bubble with optional streaming animation
 * and an "enter Autonomous Execution" affordance while the agent is waiting.
 *
 * STATE MACHINE:
 *   [RENDERING]  <-- mount, MarkdownText animates in if shouldType && !hasAnimated
 *      |
 *      | (animation finishes)
 *      v
 *   [ANIMATED]   <-- hasAnimated=true, onComplete fired
 *
 * While isWaiting && !isStreaming:
 *   dashed yellow indicator + optional "Start Autonomous Execution" button.
 */
import { memo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MarkdownText } from '../MarkdownText';
import { StreamingText } from './StreamingText';
import { AutonomousExecutionIcon } from './AutonomousExecutionIcon';

interface AttentionMessageProps {
  attentionMessage: string;
  isWaiting: boolean;
  shouldType?: boolean;
  onComplete?: () => void;
  onStartExecution?: () => void;
  isStreaming?: boolean;
}

export const AttentionMessage = memo(function AttentionMessage({
  attentionMessage,
  isWaiting,
  onComplete,
  onStartExecution,
  isStreaming = false,
}: AttentionMessageProps) {
  const [hasAnimated, setHasAnimated] = useState(false);

  const handleAnimationComplete = () => {
    setHasAnimated(true);
    if (onComplete) {
      requestAnimationFrame(() => {
        onComplete();
      });
    }
  };

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1 min-w-0 space-y-3">
        <div className="text-sm">
          {isStreaming ? (
            <StreamingText text={attentionMessage} />
          ) : (
            <MarkdownText
              text={attentionMessage}
              shouldAnimate={isWaiting && !hasAnimated}
              onComplete={handleAnimationComplete}
            />
          )}
        </div>

        {isWaiting && !isStreaming && (
          <>
            <div className="flex items-center gap-2 text-amber-500">
              <div
                className="w-4 h-4 rounded-full border-2 border-dashed border-amber-500"
                style={{ animation: 'spin 3s linear infinite' }}
              />
              <span className="text-xs font-medium">
                Your Rose agent will continue working after your reply
              </span>
            </div>

            {onStartExecution && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onStartExecution}
                      className="flex items-center gap-2 text-muted-foreground hover:bg-muted/30 hover:text-muted-foreground"
                    >
                      <AutonomousExecutionIcon />
                      Start Autonomous Execution
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-left text-xs">
                    <p>
                      Once Rose enters <strong>Autonomous Execution</strong> mode they will not ask
                      you any more questions and will relentlessly explore all possible avenues in
                      order to accomplish your goal given the context at its disposal.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </>
        )}
      </div>
    </div>
  );
});
