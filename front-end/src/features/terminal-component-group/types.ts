/**
 * Types for the terminal-component-group domain.
 *
 * Contains component-specific interfaces and type re-exports consumed across
 * the terminal UI component library.
 */

import type { FilePointer } from '@/lib/api';

// ─── Explore Agent ────────────────────────────────────────────────────────

export interface ExploreStep {
  title: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  timestamp?: string;
  message?: string;
  toolName?: string;
}

// ─── Wait-For Chip ────────────────────────────────────────────────────────

export interface WaitForCheck {
  title: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  timestamp?: string;
  message?: string;
  checkNum?: number;
  maxChecks?: number;
  conditionMet?: boolean;
  exploreTaskId?: string;
  /** Embedded explore agent data (filled by MessageList) */
  explore?: {
    title: string;
    fullGoal?: string;
    message: string;
    status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
    steps: ExploreStep[];
  };
}

// ─── Phone Call Card ──────────────────────────────────────────────────────

export interface PhoneCallMetadata {
  status: 'initiating' | 'in-progress' | 'ended' | 'error';
  to: string;
  callId?: string;
  listenUrl?: string;
  startedAt?: string;
  duration?: number;
  endedReason?: string;
  recordingUrl?: string;
  transcript?: string;
  summary?: string;
  structuredData?: Record<string, unknown>;
  error?: string;
}

// ─── Feedback Banner ──────────────────────────────────────────────────────

export interface FeedbackData {
  rating: number;
  issueType?: string;
  comment?: string;
  helpImprove: boolean;
}

// ─── Completion Summary Card ──────────────────────────────────────────────

export interface OutputField {
  key: string;
  label: string;
  value: string | number | string[] | FilePointer | FilePointer[] | Record<string, unknown>;
}

export interface ToolUsage {
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
