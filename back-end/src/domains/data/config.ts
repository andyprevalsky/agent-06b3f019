/**
 * Data domain config — magic numbers, string constants, default values.
 */

// Limits
export const MAX_RESULTS = 100;
export const MAX_CONTEXT_MESSAGES = 3; // Messages before/after each match
export const MAX_RESULT_TOKENS = 8000; // Approximate token cap (~4 chars per token)
export const MAX_RESULT_CHARS = MAX_RESULT_TOKENS * 4;

// Default time range for search (days)
export const DEFAULT_SINCE_DAYS = 365;

// Context window expansion (ms) — 1 hour on each side of match
export const CONTEXT_WINDOW_MS = 3600000;

// Network (contacts) grep — max results returned
export const NETWORK_GREP_LIMIT = 20;
