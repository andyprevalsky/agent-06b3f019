/**
 * Shared Anthropic API-key cooldown, split out of computeCredentials.ts (which
 * re-exports it) like cerebrasApiKeyCooldown.ts.
 */
import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('ComputeCredentials');

// ── Shared Anthropic API-key cooldown ──────────────────────────────────────
//
// The funded ANTHROPIC_API_KEY (a global default for any user) is a single
// credential. When it reports out-of-credits (402) or bad-key (401/403) there
// is no point any agent on any Temporal workflow retrying it until it recovers.
// We persist a cooldown in the DB — reusing the same `Integration.rateLimitedUntil`
// column the OAuth pool tokens use — so every backend instance AND every Fly
// worker shares one backoff instead of each independently hammering the key.
//
// A tiny in-memory write-through cache keeps the LLM hot path off the DB: the
// row is re-read at most once per recheck interval, cooled or clear, so a
// cooldown cleared in the DB is honored by every instance within that interval.
const ANTHROPIC_API_KEY_COOLDOWN_MS = 30 * 60 * 1000; // 30 min (out-of-credits)
const ANTHROPIC_API_KEY_COOLDOWN_DB_RECHECK_MS = 15 * 1000;
// Sentinel singleton row. userId has no FK; name is outside the served
// ['claude_code','gpt_code'] set, so this row is never handed out as a token.
const ANTHROPIC_API_KEY_COOLDOWN_USER_ID = '00000000-0000-0000-0000-000000000000';
const ANTHROPIC_API_KEY_COOLDOWN_NAME = 'anthropic_api_key_cooldown';
const ANTHROPIC_API_KEY_COOLDOWN_KEY = {
  userId: ANTHROPIC_API_KEY_COOLDOWN_USER_ID,
  name: ANTHROPIC_API_KEY_COOLDOWN_NAME,
  accountId: '',
};

let cachedCooldownUntilMs = 0;
let lastCooldownDbCheckMs = 0;
let cooldownCacheRevision = 0;

/** True when the shared Anthropic API key is currently backed off. */
export async function isAnthropicApiKeyOnCooldown(): Promise<boolean> {
  const now = Date.now();
  if (now - lastCooldownDbCheckMs < ANTHROPIC_API_KEY_COOLDOWN_DB_RECHECK_MS) {
    return now < cachedCooldownUntilMs;
  }
  lastCooldownDbCheckMs = now;
  const cacheRevision = cooldownCacheRevision;
  const row = await prisma.integration.findUnique({
    where: { userId_name_accountId: ANTHROPIC_API_KEY_COOLDOWN_KEY },
    select: { rateLimitedUntil: true },
  });
  if (cacheRevision !== cooldownCacheRevision) {
    return Date.now() < cachedCooldownUntilMs;
  }
  cachedCooldownUntilMs = row?.rateLimitedUntil ? row.rateLimitedUntil.getTime() : 0;
  return Date.now() < cachedCooldownUntilMs;
}

/** When the shared Anthropic API key's backoff ends; null when it is not backed off. */
export async function anthropicApiKeyCooldownUntil(now = new Date()): Promise<Date | null> {
  const row = await prisma.integration.findUnique({
    where: { userId_name_accountId: ANTHROPIC_API_KEY_COOLDOWN_KEY },
    select: { rateLimitedUntil: true },
  });
  const until = row?.rateLimitedUntil ?? null;
  return until !== null && until > now ? until : null;
}

/** Back the shared Anthropic API key off for the cooldown window (DB + cache). */
export async function markAnthropicApiKeyOnCooldown(reason: string): Promise<void> {
  const until = new Date(Date.now() + ANTHROPIC_API_KEY_COOLDOWN_MS);
  cooldownCacheRevision++;
  cachedCooldownUntilMs = until.getTime();
  // A read issued before the upsert below commits would drop this mark.
  lastCooldownDbCheckMs = Date.now();
  await prisma.integration.upsert({
    where: { userId_name_accountId: ANTHROPIC_API_KEY_COOLDOWN_KEY },
    create: {
      userId: ANTHROPIC_API_KEY_COOLDOWN_USER_ID,
      name: ANTHROPIC_API_KEY_COOLDOWN_NAME,
      type: 'TOOL_SETUP',
      status: 'NOT_CONNECTED',
      rateLimitedUntil: until,
      failureReason: reason,
    },
    update: { rateLimitedUntil: until, failureReason: reason },
  });
  log.warn('Anthropic API key backed off', { reason, until: until.toISOString() });
}

/** Test-only: clear both the in-memory cache and the DB cooldown row. */
export async function __resetAnthropicApiKeyCooldown(): Promise<void> {
  cooldownCacheRevision++;
  cachedCooldownUntilMs = 0;
  lastCooldownDbCheckMs = 0;
  await prisma.integration.deleteMany({
    where: {
      userId: ANTHROPIC_API_KEY_COOLDOWN_USER_ID,
      name: ANTHROPIC_API_KEY_COOLDOWN_NAME,
    },
  });
}
