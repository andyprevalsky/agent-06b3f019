/**
 * STATE MACHINE: CompletionSummaryCard
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- toolsExpanded: false (shows total count only)
 *     |
 *     | (click tools header)
 *     v
 * [EXPANDED] <-- toolsExpanded: true (shows tool breakdown)
 *     |
 *     | (click tools header)
 *     v
 * [COLLAPSED]
 *
 * States:
 * - toolsExpanded: boolean - Whether tool breakdown list is visible
 * - copiedField: string | null - Key of field currently showing "copied" feedback
 */

import { memo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, Copy } from 'lucide-react';
import { FilePointer } from '@/lib/api';
import { isFilePointer, FilePointerDisplay } from './ClaudeCodeChip';

// Tool name → Human-readable label mapping (mirrors backend TOOL_DISPLAY_NAMES)
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  web_search: 'Web Searches',
  spawn_agent: 'Agents Spawned',
  spawn_sub_agent: 'Sub Agents Spawned',
  spawn_browser_agent: 'Browser Agents Spawned',
  spawn_claude_code_agent: 'Code Agents Spawned',
  send_sms_as_user: "SMS's Sent",
  deep_research: 'Deep Research Runs',
  find_all: 'Find All Queries',
  enrich: 'Enrichments',
  monitor: 'Monitors Created',
  check_monitor_events: 'Monitor Checks',
  message_person: 'Messages Sent',
  read_message_history_with_person: 'Message Histories Read',
  search_user_network_for_people: 'Network Searches',
  send_message_to_user: 'User Messages',
  wait_seconds: 'Wait Operations',
  set_plan: 'Plans Set',
  query_blueprints: 'Query Blueprints',
  search_x402_bazaar: 'Bazaar Searches',
  pay_for_x402_bazaar_service: 'Bazaar Payments',
};

interface OutputField {
  key: string;
  label: string;
  value: string | number | string[] | FilePointer | FilePointer[] | Record<string, unknown>;
}

interface ToolUsage {
  name: string;
  count: number;
}

export interface CompletionSummaryData {
  /** Brief summary of what was accomplished */
  summary: string;
  /** Structured output fields extracted from the agent */
  outputs?: OutputField[];
  /** Tool usage breakdown */
  toolUsage?: ToolUsage[];
  /** Total tool calls */
  totalToolCalls?: number;
  /** Duration in seconds */
  durationSeconds?: number;
  /** Cost in dollars */
  costDollars?: number;
  /** Whether the task failed */
  error?: boolean;
  /** Reason for failure (e.g., "max_iterations", "error") */
  errorReason?: string;
}

interface CompletionSummaryCardProps {
  data: CompletionSummaryData;
  className?: string;
}

/**
 * CompletionSummaryCard - Displays agent completion summary with structured output and tool stats
 */
export const CompletionSummaryCard = memo(function CompletionSummaryCard({
  data,
  className,
}: CompletionSummaryCardProps) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const { summary, outputs, toolUsage, totalToolCalls, durationSeconds, costDollars } = data;

  const handleCopy = async (value: string, fieldKey: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedField(fieldKey);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const formatValue = (value: OutputField['value']): string => {
    // FilePointers are rendered as components, not text
    if (isFilePointer(value)) {
      return value.original_filename;
    }
    // Array of FilePointers
    if (Array.isArray(value) && value.length > 0 && isFilePointer(value[0])) {
      return value.map((fp) => (fp as FilePointer).original_filename).join(', ');
    }
    // Regular array
    if (Array.isArray(value)) {
      return value.join(', ');
    }
    // Object (but not FilePointer) - JSON stringify
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value);
    }
    return String(value);
  };

  // Check if value is a FilePointer or array of FilePointers
  const isFilePointerValue = (value: OutputField['value']): boolean => {
    if (isFilePointer(value)) return true;
    if (Array.isArray(value) && value.length > 0 && isFilePointer(value[0])) return true;
    return false;
  };

  const getToolDisplayName = (toolName: string): string => {
    return (
      TOOL_DISPLAY_NAMES[toolName] ||
      toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    );
  };

  const totalTools = totalToolCalls || toolUsage?.reduce((sum, t) => sum + t.count, 0) || 0;

  return (
    <div className={cn('w-full', className)}>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className={cn(
          'rounded-lg border overflow-hidden transition-colors',
          'bg-[#EEEFF2]/60 dark:bg-[#1a1a1a]/60 border-border/60',
        )}
        style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/60">
          {data.error ? (
            <>
              <svg
                className="w-4 h-4 text-red-600 dark:text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
              <span className="text-sm font-medium text-red-600 dark:text-red-400">
                Task Failed
              </span>
            </>
          ) : (
            <>
              <svg
                className="w-4 h-4 text-emerald-600 dark:text-emerald-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm font-medium text-foreground">Task Complete</span>
            </>
          )}
        </div>

        {/* Summary */}
        <div className="px-3 py-3">
          <p className="text-sm text-muted-foreground leading-relaxed">{summary}</p>
        </div>

        {/* Outputs Section */}
        {outputs && outputs.length > 0 && (
          <div className="px-3 pb-3">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
              Output
            </div>
            <div className="space-y-1.5">
              {outputs.map((output) => (
                <div
                  key={output.key}
                  className="group bg-card rounded-md px-3 py-2 border border-border/60 hover:border-border transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-muted-foreground mb-0.5">{output.label}</div>
                      <div className="text-sm text-foreground font-medium break-words">
                        {/* Render FilePointers with download chip */}
                        {isFilePointer(output.value) ? (
                          <FilePointerDisplay file={output.value} />
                        ) : Array.isArray(output.value) &&
                          output.value.length > 0 &&
                          isFilePointer(output.value[0]) ? (
                          <div className="flex flex-wrap gap-1.5">
                            {output.value.map((fp, idx) => (
                              <FilePointerDisplay key={idx} file={fp as FilePointer} />
                            ))}
                          </div>
                        ) : (
                          formatValue(output.value)
                        )}
                      </div>
                    </div>
                    {/* Only show copy button for non-FilePointer values */}
                    {!isFilePointerValue(output.value) && (
                      <button
                        onClick={() => handleCopy(formatValue(output.value), output.key)}
                        className="flex-shrink-0 p-1 text-muted-foreground/50 hover:text-muted-foreground opacity-0 group-hover:opacity-100 transition-all"
                        title="Copy to clipboard"
                      >
                        {copiedField === output.key ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tool Usage Section - Collapsible */}
        {toolUsage && toolUsage.length > 0 && (
          <div className="px-3 pb-3 border-t border-border/60">
            <button
              onClick={() => setToolsExpanded(!toolsExpanded)}
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
                      .sort((a, b) => b.count - a.count)
                      .map((tool) => (
                        <div key={tool.name} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">
                            {getToolDisplayName(tool.name)}
                          </span>
                          <span className="text-muted-foreground tabular-nums">{tool.count}</span>
                        </div>
                      ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Footer Stats */}
        {(durationSeconds !== undefined || costDollars !== undefined) && (
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
        )}
      </motion.div>
    </div>
  );
});

export default CompletionSummaryCard;
