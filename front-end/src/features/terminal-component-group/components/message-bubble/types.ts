/**
 * Shared types for MessageBubble sub-components.
 *
 * MessageBubble is a dispatcher that routes the Message object to one of a
 * handful of sub-bubble components (see `../MessageBubble.tsx`). Each sub-
 * bubble needs a slightly different slice of the original props, so we keep
 * a single `MessageBubbleProps` interface here and narrow as needed.
 */

import type { FeedbackData } from '../../types';
import type { CodeProvider, ExploreStep, WaitForCheck } from '../../types';
import type { Message } from '../../hooks';
import type { SubAgentStreamingMetrics } from '../useMessageFiltering';

export interface MessageBubbleProps {
  message: Message;
  shouldType?: boolean;
  onTypingComplete?: () => void;
  onNavigateToAgent?: (agentId: string) => void;
  /** Indicates this is a streaming bubble (in-progress LLM response) */
  isStreaming?: boolean;
  /** Agent ID for sending messages */
  agentId?: string;
  /** Callback to send a message */
  onSendMessage?: (message: string) => void | Promise<void>;
  /** Compact mode - removes left spacers for tighter layouts */
  compact?: boolean;
  /** Callback to open the auth modal (for signup prompts) */
  onOpenAuthModal?: () => void;
  /** Callback to submit feedback (for completion summary) */
  onSubmitFeedback?: (feedback: FeedbackData) => Promise<void>;
  /** Streaming plan char count (for set_plan IN_PROGRESS PlanChip) */
  planCharCount?: number;
  /** Planner LLM request start timestamp for set_plan IN_PROGRESS PlanChip */
  planStreamStartedAtMs?: number;
  /** Streaming token estimate for in-progress explore thinking carousel item */
  thinkingStreamTokenCount?: number;
  /** Local timestamp from the first observed LLM stream event */
  thinkingStreamStartedAtMs?: number;
  /** Per-sub-agent streaming metrics for wait_for embedded explore checks */
  streamingMetricsBySubAgentId?: Map<string, SubAgentStreamingMetrics>;
  /** Explore agent step history (passed from MessageList grouping) */
  exploreStepHistory?: ExploreStep[];
  /** Wait_for check history (passed from MessageList grouping) */
  waitForChecks?: WaitForCheck[];
  /** Hide sub-agent tree header (when grouped with preceding tree) */
  hideSubAgentTreeHeader?: boolean;
}

/** Flattened metadata used to render a generic tool card. */
export interface ToolMessageData {
  toolCallId: string;
  toolName?: string;
  title: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  message: string;
  error?: boolean;
  /** 0-100 or 0-1, optional - if present shows progress bar */
  progressComplete?: number;
  actionMetadata?: Record<string, unknown> | null;
  // Auto-simulation countdown
  timeout?: number; // Duration in seconds (e.g., 60)
  startTime?: string; // ISO timestamp when timer started
  simulated?: boolean; // True if response was auto-generated
  // Browser action type (for icon selection)
  actionType?: string;
  authAssistance?: {
    taskId?: string;
  };
  codeProvider?: CodeProvider;
}

/** Role-based visual config for the generic bubble fallback. */
export interface RoleConfigEntry {
  icon: React.ComponentType<{ className?: string }>;
  bg: string;
  border: string;
  text: string;
  label: string;
}
