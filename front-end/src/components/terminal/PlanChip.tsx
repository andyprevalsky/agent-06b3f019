import { memo, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownText } from './MarkdownText';

interface PlanData {
  title: string;
  content: string;
  is_proximate: boolean;
  sub_tasks: string[];
  sub_goals: string[];
  join_modifier: '&&' | '||' | null;
  status: 'planning' | 'ready' | 'executing' | 'complete';
}

interface PlanChipProps {
  plan: PlanData;
  className?: string;
  /** Tool status - IN_PROGRESS shows shimmer effect on title */
  toolStatus?: 'IN_PROGRESS' | 'FINISHED';
}

/**
 * PlanChip - Expandable chip for displaying agent plans inline in the conversation.
 * 
 * Shows as a compact chip when collapsed, expands vertically to show full plan content.
 * Uses the two-axis planning framework:
 * - Proximate (atomic): Sequential sub_tasks
 * - Composite: Parallel sub_goals with join_modifier (AND/OR)
 */
export const PlanChip = memo(function PlanChip({ plan, className, toolStatus = 'FINISHED' }: PlanChipProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isStreaming = toolStatus === 'IN_PROGRESS';

  // Determine what items to show and the header text
  const { items, headerText, itemLabel } = useMemo(() => {
    if (plan.is_proximate) {
      // Proximate (atomic) - sequential sub_tasks
      return {
        items: plan.sub_tasks,
        headerText: `${plan.sub_tasks.length} To-dos · Completed in Order`,
        itemLabel: 'To-do',
      };
    } else if (plan.join_modifier === '||') {
      // OR composition - hypotheses
      return {
        items: plan.sub_goals,
        headerText: `${plan.sub_goals.length} Hypotheses`,
        itemLabel: 'Hypothesis',
      };
    } else {
      // AND composition - parallel work
      return {
        items: plan.sub_goals,
        headerText: `${plan.sub_goals.length} To-dos · Parallel`,
        itemLabel: 'To-do',
      };
    }
  }, [plan.is_proximate, plan.sub_tasks, plan.sub_goals, plan.join_modifier]);

  const toggleExpanded = () => {
    // Only toggle if there's content to show
    if (plan.content) {
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div className={cn('w-full max-w-md', className)}>
      {/* Chip Container */}
      <motion.div
        layout
        className={cn(
          'rounded-lg border overflow-hidden transition-colors',
          'bg-muted/30 border-border/60',
          'hover:bg-muted/50 hover:border-border'
        )}
      >
        {/* Header - Always visible, clickable if has content */}
        <button
          onClick={toggleExpanded}
          className={cn(
            "w-full flex items-center justify-between px-3 py-2.5 text-left",
            !plan.content && "cursor-default"
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            {/* Plan icon */}
            <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            
            {/* Title - shimmer effect when streaming */}
            <span className={cn(
              "text-sm font-medium truncate",
              isStreaming && "animate-shimmer bg-gradient-to-r from-foreground via-muted-foreground to-foreground bg-[length:200%_100%] bg-clip-text text-transparent",
              !isStreaming && "text-foreground"
            )}>
              {plan.title}
            </span>
          </div>

          {/* Chevron indicator - only show if there's content to expand */}
          {plan.content && (
            <ChevronDown
              className={cn(
                'h-4 w-4 text-muted-foreground transition-transform duration-200 flex-shrink-0',
                isExpanded && 'rotate-180'
              )}
            />
          )}
        </button>

        {/* Expandable Content - Plan description/content (appears between header and items) */}
        <AnimatePresence initial={false}>
          {isExpanded && plan.content && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-3">
                {/* Content Section */}
                <div className="text-sm text-muted-foreground border-t border-border/50 pt-3">
                  <MarkdownText
                    text={plan.content}
                    shouldAnimate={false}
                    className="prose-sm"
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Items Section - Always visible when FINISHED and has items */}
        {!isStreaming && items.length > 0 && (
          <div className="px-3 pb-3 border-t border-border/50">
            {/* Section Header */}
            <div className="flex items-center justify-between pt-2 mb-2">
              <span className="text-xs text-muted-foreground font-medium">
                {headerText}
              </span>
            </div>

            {/* Item List */}
            <ul className="space-y-2">
              {items.map((item, index) => (
                <li
                  key={index}
                  className="flex items-start gap-2.5"
                >
                  {/* Checkbox circle */}
                  <div
                    className={cn(
                      'flex-shrink-0 w-4 h-4 rounded-full border-2 mt-0.5',
                      'border-muted-foreground/40 bg-transparent',
                      'transition-colors'
                    )}
                  />
                  {/* Item text */}
                  <span className="text-sm text-foreground leading-snug">
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </motion.div>
    </div>
  );
});

export default PlanChip;

