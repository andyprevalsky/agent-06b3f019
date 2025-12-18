/**
 * @deprecated This component is deprecated. Use PlanChip.tsx instead.
 * 
 * PlanChip renders plans inline in the conversation as an expandable chip,
 * replacing this fixed right-pane approach.
 * 
 * Migration:
 * - Import PlanChip from './PlanChip' instead
 * - PlanChip uses the unified DAG planning schema:
 *   - title, content, tasks, dependencies, join
 * - PlanChip is automatically rendered in MessageBubble for set_plan tool messages
 */

import React, { memo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MarkdownText } from './MarkdownText';
import { cn } from '@/lib/utils';
import { postMessage } from '@/lib/api';

interface SubGoal {
  goal: string;
  context: string;
}

interface PlanData {
  markdown_text: string;
  is_parallelizable: boolean;
  sub_tasks: string[];
  sub_goals?: SubGoal[];
  status: 'planning' | 'ready' | 'executing' | 'complete';
}

interface PlanArtifactProps {
  plan: PlanData;
  agentId: string;
  onExecute?: () => void;
  className?: string;
}

/**
 * @deprecated Use PlanChip instead. This component is kept for backwards compatibility only.
 * 
 * PlanArtifact - Fixed right-pane component displaying the agent's plan
 * Similar to Cursor's plan mode UI
 */
export const PlanArtifact = memo(function PlanArtifact({
  plan,
  agentId,
  onExecute,
  className
}: PlanArtifactProps) {
  const [isExecuting, setIsExecuting] = useState(false);
  const [isParallelizable, setIsParallelizable] = useState(plan.is_parallelizable);
  
  const handleExecute = async () => {
    setIsExecuting(true);
    try {
      // Send "start autonomous execution" message to trigger phase transition
      await postMessage(agentId, "start autonomous execution");
      onExecute?.();
    } catch (error) {
      console.error('Failed to execute plan:', error);
    } finally {
      setIsExecuting(false);
    }
  };

  const toggleParallelizable = () => {
    setIsParallelizable(!isParallelizable);
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className={cn(
        'flex flex-col h-full max-h-[calc(100vh-8rem)]',
        'bg-slate-900/95 backdrop-blur-sm',
        'border border-slate-700/50 rounded-xl',
        'shadow-2xl shadow-black/20',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-sm font-medium text-slate-200">Plan</span>
        </div>
        
        {/* Parallelizable indicator - clickable toggle with tooltip */}
        <button
          onClick={toggleParallelizable}
          className="group relative"
          title={isParallelizable 
            ? "Will spawn parallel sub-agents" 
            : "Sequential execution (causally dependent tasks)"
          }
        >
          <div className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors',
            isParallelizable 
              ? 'bg-violet-500/20 text-violet-400 hover:bg-violet-500/30' 
              : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
          )}>
            {isParallelizable ? (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                <span>Parallel</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                <span>Sequential</span>
              </>
            )}
          </div>
          
          {/* Tooltip on hover */}
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-800 text-slate-300 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            {isParallelizable 
              ? "Click to toggle: Parallel sub-agents for independent work" 
              : "Click to toggle: Sequential execution for dependent tasks"
            }
          </div>
        </button>
      </div>
      
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Plan markdown content */}
        <div className="text-slate-300">
          <MarkdownText 
            text={plan.markdown_text} 
            shouldAnimate={false}
            className="prose-sm"
          />
        </div>
        
        {/* Sub-tasks section */}
        {plan.sub_tasks.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-slate-700/50">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Steps
            </span>
            <ul className="space-y-2">
              {plan.sub_tasks.map((task, index) => (
                <motion.li
                  key={index}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="flex items-start gap-3"
                >
                  {/* Large circle that will become checkmark */}
                  <div className={cn(
                    'flex-shrink-0 w-5 h-5 rounded-full border-2 mt-0.5',
                    'border-slate-600 bg-slate-800/50',
                    'transition-colors'
                  )} />
                  <span className="text-sm text-slate-300">{task}</span>
                </motion.li>
              ))}
            </ul>
          </div>
        )}
      </div>
      
      {/* Footer with Execute button */}
      <div className="px-4 py-3 border-t border-slate-700/50">
        <button
          onClick={handleExecute}
          disabled={isExecuting || plan.status === 'executing'}
          className={cn(
            'w-full py-2 px-4 rounded-lg font-medium text-sm',
            'bg-gradient-to-r from-emerald-500 to-teal-500',
            'hover:from-emerald-400 hover:to-teal-400',
            'text-white shadow-lg shadow-emerald-500/25',
            'transition-all duration-200',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'flex items-center justify-center gap-2'
          )}
        >
          {isExecuting ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span>Executing...</span>
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Start Autonomous Execution</span>
            </>
          )}
        </button>
      </div>
    </motion.div>
  );
});

export default PlanArtifact;

