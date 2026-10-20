/**
 * Terminal feature — constants, defaults, and configuration.
 *
 * Pure values with no side effects. May import from own types only.
 */

import type { OpeningMessage } from './types';

// ── Opening animation messages ────────────────────────────────────────────

/** Opening messages for reveal animation: [message, pauseDurationMs]. */
export const OPENING_MESSAGES: OpeningMessage[] = [
  ['Hello!', 1800],
  ["We're Rose.", 1800],
  ['A massive network of over 10,000 AIs.', 3800],
  ['We work together to form a super intelligent system.', 2500],
  ['Our purpose is to make your dreams come true.', 2500],
  ['What is the first goal you have?', 0], // Last message stays visible
];

// ── Popular goals carousel ────────────────────────────────────────────────

/**
 * Goals shown first, in this order, for Rose Desktop accounts only
 * (lib/roseDesktop.ts; UI ledger #15, #24). "Import Code Repo" is a plain goal
 * pill like every other one: first in the rotation, not pinned, no special
 * styling.
 */
export const ROSE_DESKTOP_POPULAR_GOALS: string[] = [
  'Import Code Repo',
  'Make me a website',
  'Go to youtube.com',
  'Go to instagram.com',
  'Go to linkedin.com',
  'Change my background photo',
  'Make me a game',
];

export const POPULAR_GOALS: string[] = [
  'Maximize my luck surface area',
  'Save children in Gaza',
  'Raise me 1 million dollars',
  'Get me socks',
  'Mitigate the impending climate crisis',
  'Make sure I accomplish my body goals',
  'Ensure my friends are well supported',
  'Get me 5 new friends',
  'End world hunger',
  'Optimize my nutrition',
  'Get me a girlfriend',
  'Make me a master painter',
  'Get me into Stanford',
  'Make sure my birthday is amazing',
  'Find me my first 10 customers',
  'Make sure my startup succeeds',
  'Make me happy',
  'Get me a boyfriend',
  'Cure cancer',
  'Make sure my parents are taken care of',
];

// ── Animation timing ──────────────────────────────────────────────────────

/** Duration of each tile animation frame in ms (~45ms per frame = 1 second total for 22 frames). */
export const FRAME_DURATION_MS = 45;

/** Ticker scroll speed in pixels per second. */
export const TICKER_SPEED_PX_PER_SEC = 30;

/** Agent polling interval in milliseconds. */
export const AGENT_POLL_INTERVAL_MS = 10000;

// ── Drippiness defaults ───────────────────────────────────────────────────

export const DEFAULT_BG_COLORS = 3;
export const DEFAULT_BLUR = 10;
export const DEFAULT_SHADOW = 16;
export const DEFAULT_BORDER = 23;

// ── Default model ─────────────────────────────────────────────────────────

export const DEFAULT_MODEL = 'rose-labs/rose-1-ultra';

// ── Browser review account ────────────────────────────────────────────────

/** Phone number for the entitlement-review account; it lands on Browse after auth. */
export const BROWSER_REVIEW_TEST_PHONE = '+15555550123';

// ── Default price limit ───────────────────────────────────────────────────

export {
  DEFAULT_TASK_PRICE_LIMIT_CENTS,
  DEFAULT_TASK_PRICE_LIMIT_CENTS as DEFAULT_PRICE_LIMIT_CENTS,
} from '@/lib/priceLimitDefaults';

// ── Context window fallback ───────────────────────────────────────────────

export const DEFAULT_CONTEXT_WINDOW = 100000;

// ── Scroll threshold ──────────────────────────────────────────────────────

/** Distance from bottom (in px) within which auto-scroll triggers. */
export const AUTO_SCROLL_THRESHOLD_PX = 500;

// ── Sorted agent status groups ────────────────────────────────────────────

export const PAUSED_STATUSES = ['PAUSED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'] as const;
