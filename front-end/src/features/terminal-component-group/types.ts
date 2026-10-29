/**
 * Types for the terminal-component-group domain.
 *
 * Contains component-specific interfaces and type re-exports consumed across
 * the terminal UI component library.
 */

import type { FilePointer } from '@/lib/api';

// ─── App Sidebar ──────────────────────────────────────────────────────────

/** Sidebar top-level view identifier. */
export type SidebarView =
  | 'agents'
  | 'browse'
  | 'integrations'
  | 'settings'
  | 'usage'
  | 'network'
  | 'admin-health'
  | 'benchmarks';

/** One bottom-navigation entry in the sidebar. */
export interface SidebarNavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  isActive?: boolean;
}

/** Drip styles passed through to the sidebar for liquid-glass backdrop effects. */
export interface SidebarDripStyles {
  blur: number;
  bgOpacity: number;
  saturation: number;
  brightness: number;
  borderRgb: string;
  shadowIntensity: number;
}

/** Credits usage data returned by GET /api/credits/usage. */
export interface UsageData {
  total: number;
  used: number;
  remaining: number;
  tier: number | null;
  upgradeOptions: Array<{
    tier: number;
    name: string;
    url: string;
  }>;
}

// ─── Explore Agent ────────────────────────────────────────────────────────

export interface ExploreStep {
  title: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR';
  timestamp?: string;
  message?: string;
  toolName?: string;
  toolCallId?: string;
  /** list_agents steps: structured tree view (metadata.agentTree). */
  agentTree?: unknown;
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
  status: 'initiating' | 'in-progress' | 'on-hold' | 'ended' | 'error';
  to: string;
  callId?: string;
  listenUrl?: string;
  startedAt?: string;
  /** When the current hold began (status `on-hold`). */
  holdStartedAt?: string;
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

// ─── Claude Code Chip ─────────────────────────────────────────────────────

/** Incoming WebSocket message from the Claude Code terminal stream. */
export type WsMessage =
  | { type: 'buffer'; data: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'stdin_echo'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; data: string };

/**
 * Visible lifecycle state for a ClaudeCodeChip. 'paused' comes only from a Rose
 * Desktop `code_agent` snapshot (resumable session); the stock chip never derives it.
 */
export type ChipState = 'spinning_up' | 'live' | 'verifying' | 'completed' | 'failed' | 'paused';
export type CodeProvider = 'claude' | 'codex';

export interface ClaudeCodeChipProps {
  taskId: string;
  wsUrl?: string;
  codeProvider?: CodeProvider;
  /** Always show terminal regardless of state. */
  forceShow?: boolean;
  /** The spawn tool call (finds rows written before a task id exists, e.g. a local-target failure). */
  toolCallId?: string;
}

// ─── Completion Summary Card ──────────────────────────────────────────────

export interface OutputField {
  key: string;
  label: string;
  value:
    | string
    | number
    | boolean
    | null
    | string[]
    | unknown[]
    | FilePointer
    | FilePointer[]
    | Record<string, unknown>;
}

export interface ToolUsage {
  name: string;
  count: number;
}

export interface CompletionSummaryData {
  presentation?: { version: 1; mode: 'value'; field: string; encoding: 'text' | 'json' } | { version: 1; mode: 'report' };
  answerText?: string;
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
