// Token limit (30k tokens ~ 120k chars at 4 chars/token)
export const MAX_TOKEN_COUNT = 30000;
export const CHARS_PER_TOKEN = 4;
export const MAX_CHAR_COUNT = MAX_TOKEN_COUNT * CHARS_PER_TOKEN;

// LRU cache settings
export const CACHE_MAX_ENTRIES = 500;
export const CACHE_TTL_MS = 3600 * 1000; // 1 hour
