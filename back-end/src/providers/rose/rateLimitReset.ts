/**
 * Extract the cooldown Anthropic/OpenAI actually hand us on a 429.
 *
 * Mirrors `_extract_rate_limited_until` in agents/providers/rose/claude_auth.py.
 * The two clients previously disagreed: the Python agent path read the reset
 * headers, while this TS backend read only `retry-after` (and only for the
 * in-request sleep, discarding it afterwards). A TS-side 429 therefore reached
 * `markComputeTokenUnavailable` with no timing at all and stamped a synthetic
 * 5-minute cooldown — which then CLOBBERED the real multi-day window the Python
 * path had just written from `anthropic-ratelimit-unified-7d-reset`.
 *
 * Resolution order (same as Python):
 *   1. Reset headers, in preference order.
 *   2. An ISO timestamp / epoch / "try again in N minutes" scraped from the body.
 *   3. `retry-after` (delta-seconds or HTTP-date).
 * Returns an ISO-8601 UTC string, or null when the provider genuinely told us
 * nothing — only then may a caller fall back to a synthetic cooldown.
 */

/** Reset headers in preference order — unified window first, then per-quota. */
const RESET_HEADER_NAMES = [
  'anthropic-ratelimit-unified-reset',
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-7d-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-requests-reset',
  'x-ratelimit-reset',
  'x-rate-limit-reset',
  'ratelimit-reset',
] as const;

const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const EPOCH_RESET_RE =
  /(?:reset|until|retry(?:_|\s|-)?after|available(?:_|\s|-)?at)[^\d]{0,32}(\d{10,13})/gi;
const DURATION_RE =
  /(?:try again|retry|reset|available)[^.\n]{0,80}?\bin\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)\b/i;

/** Epoch bounds: reject values that are obviously not a unix timestamp. */
const MIN_EPOCH_S = 1_000_000_000;
const MAX_EPOCH_S = 10_000_000_000;

function formatUtc(date: Date): string | null {
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  return date.toISOString();
}

/** Numeric epoch in seconds or milliseconds → ISO string. */
function parseEpochValue(value: string): string | null {
  if (!/^\d+$/.test(value.trim())) return null;
  let epoch = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(epoch)) return null;
  if (epoch > MAX_EPOCH_S) epoch = Math.floor(epoch / 1000);
  if (epoch < MIN_EPOCH_S || epoch > MAX_EPOCH_S) return null;
  return formatUtc(new Date(epoch * 1000));
}

/**
 * RFC 7231 HTTP-date (also accepted by `retry-after`), e.g.
 * "Wed, 21 Oct 2015 07:28:00 GMT".
 *
 * Must stay STRICT. `Date.parse` is far more permissive than the spec and will
 * happily read a bare `"42"` as the year 2042 — which, applied to a credential
 * cooldown, is a 16-year lockout from a header we failed to understand. Every
 * real HTTP-date contains a day/month name, so require an alphabetic character;
 * bare numerics are epoch candidates and are handled by `parseEpochValue`.
 */
function parseHttpDate(value: string): string | null {
  if (!/[a-z]/i.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return formatUtc(new Date(ms));
}

/** A header value: epoch, then ISO-8601, then HTTP-date. */
function parseResetValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = value.trim().replace(/^"|"$/g, '');
  if (stripped === '') return null;

  const epoch = parseEpochValue(stripped);
  if (epoch !== null) return epoch;

  // Bare ISO-8601 (Z or offset). Date.parse handles both; require a date-like
  // shape first so we don't accept arbitrary strings Date.parse tolerates.
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(stripped)) {
    const ms = Date.parse(stripped);
    if (!Number.isNaN(ms)) return formatUtc(new Date(ms));
  }

  return parseHttpDate(stripped);
}

/** Scrape a reset out of the JSON/text error body when headers are absent. */
function parseBodyResetTime(errorBody: string): string | null {
  const body = errorBody ?? '';

  for (const match of body.matchAll(ISO_TS_RE)) {
    const parsed = parseResetValue(match[0]);
    if (parsed !== null) return parsed;
  }

  for (const match of body.matchAll(EPOCH_RESET_RE)) {
    const parsed = parseEpochValue(match[1]);
    if (parsed !== null) return parsed;
  }

  const duration = DURATION_RE.exec(body);
  if (duration) {
    const amount = Number.parseInt(duration[1], 10);
    const unit = duration[2].toLowerCase();
    const seconds = unit.startsWith('minute')
      ? amount * 60
      : unit.startsWith('hour')
        ? amount * 60 * 60
        : amount;
    return formatUtc(new Date(Date.now() + seconds * 1000));
  }

  return null;
}

/** `retry-after`: delta-seconds, else HTTP-date. */
function parseRetryAfter(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = value.trim();
  const seconds = Number.parseFloat(stripped);
  if (!Number.isNaN(seconds) && /^\d+(\.\d+)?$/.test(stripped)) {
    return formatUtc(new Date(Date.now() + Math.max(0, seconds) * 1000));
  }
  return parseHttpDate(stripped);
}

/**
 * Whichever of two parsed deadlines lands later. A credential must stay
 * ineligible until the LAST moment any signal says the provider is still
 * limiting it — releasing it at the earlier one guarantees a second 429.
 */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs)) return b;
  if (Number.isNaN(bMs)) return a;
  return bMs > aMs ? b : a;
}

/**
 * The provider's own reset time for this credential, or null when it gave none.
 * `headers` is anything with a case-insensitive `get()` (a `fetch` Headers).
 *
 * Reset headers keep their declared priority (the list is ordered narrowest
 * window first, so we must NOT take a max across them — a 7d reset header is
 * present even when only the 5h burst window is exhausted, and maxing would
 * lock a healthy credential out for a week). But `retry-after` is a *separate*
 * signal about the same credential, so the persisted deadline is the later of
 * the chosen reset and `retry-after`. Otherwise a response carrying both
 * (reset `T+2s` with `retry-after: 30`) would persist `T+2s` while
 * `providerRequiredWaitMs()` — which reads `retry-after` first — waits 30s,
 * and the credential would go eligible 28s before the provider allows it.
 */
export function extractRateLimitedUntil(
  headers: Pick<Headers, 'get'> | null | undefined,
  errorBody: string
): string | null {
  let fromReset: string | null = null;
  if (headers) {
    for (const name of RESET_HEADER_NAMES) {
      const parsed = parseResetValue(headers.get(name));
      if (parsed !== null) {
        fromReset = parsed;
        break;
      }
    }
  }

  if (fromReset === null) {
    fromReset = parseBodyResetTime(errorBody);
  }

  return laterOf(fromReset, parseRetryAfter(headers?.get('retry-after')));
}

/**
 * A reset this far out is a usage-window limit (5h/7d quota), not a burst
 * limit — burning in-place retries against it only wastes wall-clock, so the
 * caller should rotate credentials immediately. Mirrors
 * `_USAGE_WINDOW_RESET_THRESHOLD_S` / `_reset_is_far_future` in claude_auth.py.
 */
const USAGE_WINDOW_RESET_THRESHOLD_MS = 60 * 1000;

export function resetIsFarFuture(rateLimitedUntil: string | null | undefined): boolean {
  if (!rateLimitedUntil) return false;
  const ms = Date.parse(rateLimitedUntil);
  if (Number.isNaN(ms)) return false;
  return ms - Date.now() > USAGE_WINDOW_RESET_THRESHOLD_MS;
}

/**
 * How long the provider actually wants us to wait before retrying, in ms —
 * `retry-after` first, else the distance to the parsed reset. Returns null when
 * the provider gave no guidance, meaning the caller is free to use its own
 * exponential backoff.
 *
 * Callers must compare this against their sleep cap and ROTATE rather than
 * sleep short: retrying before the window closes is a guaranteed second 429
 * that burns an attempt, and sleeping the full window would stall the activity.
 * (A `retry-after: 30` clipped to a 5s cap did exactly that.)
 */
export function providerRequiredWaitMs(
  headers: Pick<Headers, 'get'> | null | undefined,
  errorBody: string,
  rateLimitedUntil?: string | null
): number | null {
  const retryAfter = headers?.get('retry-after');
  if (retryAfter !== null && retryAfter !== undefined) {
    const stripped = retryAfter.trim();
    if (/^\d+(\.\d+)?$/.test(stripped)) {
      return Math.max(0, Number.parseFloat(stripped) * 1000);
    }
    const retryAt = parseHttpDate(stripped);
    if (retryAt !== null) {
      return Math.max(0, Date.parse(retryAt) - Date.now());
    }
  }
  const reset = rateLimitedUntil ?? extractRateLimitedUntil(headers, errorBody);
  if (reset) {
    const ms = Date.parse(reset);
    if (!Number.isNaN(ms)) return Math.max(0, ms - Date.now());
  }
  return null;
}

/**
 * Jittered in-place retry delay that never sleeps less than a provider-required wait. Callers
 * decide first whether that wait fits their cap; a missing provider value uses exponential
 * fallback. Supplying randomness keeps the calculation deterministic in tests.
 */
export function boundedRateLimitBackoffMs(
  attempt: number,
  requiredWaitMs: number | null,
  capMs: number,
  random: () => number = Math.random
): number {
  const fallbackMs = Math.min(2 ** attempt * 1000, capMs);
  const delay =
    requiredWaitMs === null ? fallbackMs : Math.max(1000, Math.min(requiredWaitMs, capMs));
  const jitter = Math.max(0, Math.min(1, random())) * Math.min(delay * 0.25, 1000);
  return Math.min(delay + jitter, capMs);
}
