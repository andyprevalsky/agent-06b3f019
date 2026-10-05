/**
 * Steel session lifetime, derived from the browser activity budget.
 *
 * Steel's `timeout` is an absolute lifetime: the provider releases the session
 * when it elapses even while a CDP client is attached. The browser activity
 * (agents/domains/spawn_browser_agent_v3/config.py
 * `browser_start_to_close_timeout_minutes`) creates its session after it
 * starts and may run for its full budget, so the session must outlive that
 * budget plus teardown (recording finalize + disconnect). The budget constants
 * and scaling below mirror the Python source; the parity test in
 * src/tests/unit/steel-session-lifetime.test.ts fails when they diverge.
 */

export const BROWSER_ACTIVITY_START_TO_CLOSE_MINUTES = 30;
export const BROWSER_DEFAULT_MAX_ITERATIONS = 250;
/** Only an explicit BROWSER_MAX_ITERATIONS above this many steps lengthens the budget. */
export const BROWSER_STEPS_COVERED_BY_BASE_TIMEOUT = 60;
export const STEEL_SESSION_TEARDOWN_HEADROOM_MINUTES = 5;
/** Steel rejects longer timeouts on our plan with "exceeds the maximum for your plan (60 min)". */
export const STEEL_PLAN_MAX_SESSION_MS = 60 * 60_000;
/**
 * A resumed browser task may reuse a live session only while it outlives one
 * more supervised step plus teardown. Mirrors the Python
 * `BROWSER_SESSION_MIN_REMAINING_SECONDS`, which yields the step loop to a
 * replacement session at the same threshold.
 */
export const BROWSER_SESSION_MIN_REMAINING_MS = 7 * 60_000;

function browserMaxIterationsOverride(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.BROWSER_MAX_ITERATIONS ?? '').trim();
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (value > 0) return value;
  }
  return null;
}

/** Longest start-to-close budget a browser activity can be scheduled with. */
export function browserActivityBudgetMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const steps = browserMaxIterationsOverride(env);
  if (steps !== null && steps > BROWSER_STEPS_COVERED_BY_BASE_TIMEOUT) {
    return Math.max(BROWSER_ACTIVITY_START_TO_CLOSE_MINUTES, Math.floor(steps * 0.35) + 15);
  }
  return BROWSER_ACTIVITY_START_TO_CLOSE_MINUTES;
}

export function steelSessionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const wantedMs =
    (browserActivityBudgetMinutes(env) + STEEL_SESSION_TEARDOWN_HEADROOM_MINUTES) * 60_000;
  return Math.min(STEEL_PLAN_MAX_SESSION_MS, wantedMs);
}
