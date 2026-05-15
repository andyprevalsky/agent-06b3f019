import { Search, Lightbulb, Globe } from 'lucide-react';
import { TOOL_ICONS } from '@/lib/toolIcons';
import type { ExploreStep } from '../../types';

/** Format seconds to human-readable: "42s", "3m 42s", "1h 30m", "3d 2h" */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (s === 0) return `${m}m`;
    return `${m}m ${s}s`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  if (h === 0) return `${d}d`;
  return `${d}d ${h}h`;
}

/** Relative time: "3m ago", "1h ago" */
export function timeAgo(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return 'just now';
  return `${formatDuration(diffSec)} ago`;
}

/** Get icon component for an explore step */
export function getExploreStepIcon(toolName?: string) {
  if (!toolName) return Search;
  if (toolName === 'web_search') return Globe;
  if (toolName === 'spawn_agent') return Lightbulb;
  return TOOL_ICONS[toolName] || Search;
}

/** Check if a step is a thinking step (matches ExploreAgentBubble pattern) */
export function isThinkingStep(step: ExploreStep): boolean {
  return (
    step.toolName === 'spawn_agent' && (step.title === 'Explore agent thinking' || !step.title)
  );
}
