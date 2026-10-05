/**
 * Steel session lifetime, derived from the browser activity budget.
 *
 * Steel's `timeout` is an absolute lifetime: the provider releases the session
 * when it elapses even while a CDP client is attached. The browser activity
 * (agents/domains/spawn_browser_agent_v3/config.py
 * `browser_start_to_close_timeout_minutes`) creates its session after it
 * starts and may run for its full budget, so the session must outlive that
 * budget plus teardown (recording finalize + disconnect), up to the plan's
 * maximum: a budget past that cap (the default 250-step budget is 102 minutes)
 * gets the longest session Steel allows, and the step loop moves to a
 * replacement session before it expires. The budget constants
 * and scaling below mirror the Python source; the parity test in
 * src/tests/unit/steel-session-lifetime.test.ts fails when they diverge.
 */

/** Budget for a step limit of BROWSER_STEPS_COVERED_BY_BASE_TIMEOUT or fewer. */
export const BROWSER_ACTIVITY_BASE_TIMEOUT_MINUTES = 30;
export const BROWSER_STEPS_COVERED_BY_BASE_TIMEOUT = 60;
export const BROWSER_DEFAULT_MAX_ITERATIONS = 250;
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

function browserMaxIterations(env: NodeJS.ProcessEnv): number {
  const raw = (env.BROWSER_MAX_ITERATIONS ?? '').trim();
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (value > 0) return value;
  }
  return BROWSER_DEFAULT_MAX_ITERATIONS;
}

/** Longest start-to-close budget a browser activity can be scheduled with. */
export function browserActivityBudgetMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const steps = browserMaxIterations(env);
  if (steps <= BROWSER_STEPS_COVERED_BY_BASE_TIMEOUT) return BROWSER_ACTIVITY_BASE_TIMEOUT_MINUTES;
  return Math.max(BROWSER_ACTIVITY_BASE_TIMEOUT_MINUTES, Math.floor(steps * 0.35) + 15);
}

export function steelSessionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const wantedMs =
    (browserActivityBudgetMinutes(env) + STEEL_SESSION_TEARDOWN_HEADROOM_MINUTES) * 60_000;
  return Math.min(STEEL_PLAN_MAX_SESSION_MS, wantedMs);
}
