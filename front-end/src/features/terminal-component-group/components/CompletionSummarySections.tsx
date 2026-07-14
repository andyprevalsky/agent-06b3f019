import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

import { TOOL_DISPLAY_NAMES } from '../config';
import type { ToolUsage } from '../types';

function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function CompletionHeader({ error }: { error: boolean }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/60">
      <svg
        className={cn(
          'h-4 w-4',
          error ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400',
        )}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d={error ? 'M6 18L18 6M6 6l12 12' : 'M5 13l4 4L19 7'}
        />
      </svg>
      <span
        className={cn(
          'text-sm font-medium',
          error ? 'text-red-600 dark:text-red-400' : 'text-foreground',
        )}
      >
        {error ? 'Task Failed' : 'Task Complete'}
      </span>
    </div>
  );
}

interface ToolUsageSectionProps {
  toolUsage: ToolUsage[];
  totalTools: number;
  toolsExpanded: boolean;
  onToggle: () => void;
}

export function ToolUsageSection({
  toolUsage,
  totalTools,
  toolsExpanded,
  onToggle,
}: ToolUsageSectionProps) {
  return (
    <div className="px-3 pb-3 border-t border-border/60">
      <button
        onClick={onToggle}
        className="w-full py-2.5 flex items-center justify-between hover:opacity-80 transition-opacity"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Tools
          </span>
          <span className="text-xs text-muted-foreground">{totalTools}</span>
        </div>
        <ChevronDown
          className={cn(
            'w-4 h-4 text-muted-foreground transition-transform duration-200',
            toolsExpanded && 'rotate-180',
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {toolsExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-1.5">
              {toolUsage
                .sort((left, right) => right.count - left.count)
                .map((tool) => (
                  <div key={tool.name} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {TOOL_DISPLAY_NAMES[tool.name] || humanizeKey(tool.name)}
                    </span>
                    <span className="text-muted-foreground tabular-nums">{tool.count}</span>
                  </div>
                ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function FooterStats({
  durationSeconds,
  costDollars,
}: {
  durationSeconds?: number;
  costDollars?: number;
}) {
  if (durationSeconds === undefined && costDollars === undefined) return null;
  return (
    <div className="px-3 py-2 border-t border-border/60 flex items-center gap-3 text-xs text-muted-foreground">
      {durationSeconds !== undefined && (
        <span>
          {durationSeconds < 60
            ? `${durationSeconds}s`
            : `${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`}
        </span>
      )}
      {durationSeconds !== undefined && costDollars !== undefined && <span>·</span>}
      {costDollars !== undefined && <span>${costDollars.toFixed(3)}</span>}
    </div>
  );
}
