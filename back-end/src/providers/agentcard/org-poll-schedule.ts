/**
 * Wait schedules for the polls that watch AgentCard Organization MCP state settle.
 *
 * AgentCard throttles the organization MCP org-wide (observed: 120 requests/minute, shared by EVERY
 * org caller — card issuance, the wallet-reclaim release observer, the minute cron reconciler and
 * the payment-lifecycle fan-out). A fixed-interval poll spends one request every `delayMs` for the
 * whole observation window, so a single reclaim (20 requests) or a single card mint (40 requests)
 * burned a large share of the org-wide window and starved every other caller — which surfaced as
 * `agentcard_org_mcp_rate_limited` on unrelated requests.
 *
 * Exponential backoff covers the SAME observation window with far fewer requests. The schedule
 * doubles from `delayMs` and the final wait is clipped so the total is EXACTLY the fixed cadence's
 * total wait, `(attempts - 1) * delayMs`. No deadline is extended; only the request count drops.
 */

/**
 * Waits to insert between successive observations. `waits.length + 1` observations are made, and
 * `sum(waits) === (attempts - 1) * delayMs` — identical wall clock to a fixed `delayMs` cadence.
 *
 * `delayMs <= 0` (used by tests that want no wall clock) keeps every one of `attempts`
 * observations: there is no wait budget to spend, so backoff cannot trade requests for time.
 */
export function orgPollWaitsMs(attempts: number, delayMs: number): number[] {
  const maxWaits = Math.max(0, Math.trunc(attempts) - 1);
  if (delayMs <= 0) return new Array<number>(maxWaits).fill(0);
  let remainingMs = maxWaits * delayMs;
  const waits: number[] = [];
  while (remainingMs > 0 && waits.length < maxWaits) {
    const waitMs = Math.min(delayMs * 2 ** waits.length, remainingMs);
    waits.push(waitMs);
    remainingMs -= waitMs;
  }
  return waits;
}
