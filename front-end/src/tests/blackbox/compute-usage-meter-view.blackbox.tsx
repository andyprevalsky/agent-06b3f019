/**
 * Compute usage bar states (usageMeterView), split from compute-usage-bars.blackbox.tsx.
 *
 *   no usage, no cooldown                → unknown: "No data yet" (never 0 or 100%)
 *   7d reported                          → ok: fill = % of the weekly quota left
 *   authoritative cooldown / spent window → exhausted: red, visible "resets <when>"
 *     (the weekly remainder stays measured unless the 7d window itself is the block;
 *      with the 7d window spent, the shown reset is the weekly one)
 *   Rose backoff (non-authoritative)     → cooling: last fill + "retry in 12m"
 *   snapshot older than 6h               → stale: "as of …"
 */
import { describe, expect, it } from 'vitest';

import { usageMeterView } from '@/features/integrations/components/subscriptionUsage';

import { cooldown } from './integrations-accounts.fixtures';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 3_600_000;

describe('usageMeterView', () => {
  it('counts a window whose reset has passed as fully remaining', () => {
    const view = usageMeterView({ usage: weeklyAt(100, NOW - HOUR), rateLimitedUntil: null }, NOW);
    expect(view).toMatchObject({ tone: 'ok', remainingPct: 100 });
  });

  it('marks an emptied 7d window exhausted even without a cooldown', () => {
    const view = usageMeterView({ usage: weeklyAt(100, NOW + HOUR), rateLimitedUntil: null }, NOW);
    expect(view).toMatchObject({ tone: 'exhausted', remainingPct: 0 });
  });

  it('ignores a cooldown that has already passed', () => {
    const view = usageMeterView(
      { usage: weeklyAt(25, NOW + HOUR), rateLimitedUntil: new Date(NOW - 1).toISOString() },
      NOW,
    );
    expect(view).toMatchObject({ tone: 'ok', remainingPct: 75 });
    expect(view.title).not.toMatch(/Rate-limited/);
  });

  it('clamps out-of-range usage', () => {
    expect(
      usageMeterView({ usage: weeklyAt(140, NOW + HOUR), rateLimitedUntil: null }, NOW)
        .remainingPct,
    ).toBe(0);
    expect(
      usageMeterView({ usage: weeklyAt(-5, NOW + HOUR), rateLimitedUntil: null }, NOW).remainingPct,
    ).toBe(100);
  });
});

const at = (ms: number) => new Date(ms).toISOString();
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

describe('usageMeterView states (C1-C5)', () => {
  it('C3: authoritative cooldown shows nextResetAt as visible text, time-only today', () => {
    const resetAt = NOW + HOUR;
    const view = usageMeterView(
      {
        usage: weeklyAt(40, NOW + 3 * 24 * HOUR),
        rateLimitedUntil: at(resetAt),
        cooldown: cooldown(at(resetAt), 'usage_window_5h', true),
        nextResetAt: at(resetAt),
      },
      NOW,
    );
    // A 5h block keeps the measured weekly remainder (7d 40% used → 60% left).
    expect(view).toMatchObject({ tone: 'exhausted', remainingPct: 60 });
    expect(view.label).toBe(`resets ${clock(resetAt)}`);
    expect(view.valueText).toBe(
      `5-hour limit reached, resets ${clock(resetAt)}; 60% of weekly quota left`,
    );
    expect(view.title).toMatch(/^Rate-limited until /);
  });

  it('C3: a reset on another day shows "Mon D"', () => {
    const resetAt = NOW + 3 * 24 * HOUR;
    const view = usageMeterView(
      { usage: weeklyAt(100, resetAt), rateLimitedUntil: null, cooldown: null, nextResetAt: null },
      NOW,
    );
    expect(view.tone).toBe('exhausted');
    expect(view.label).toBe(`resets ${day(resetAt)}`);
    expect(view.label).toMatch(/^resets [A-Z][a-z]{2} \d{1,2}$/);
  });

  it('C3: when the 5h window is the used-up one, its reset is shown', () => {
    const fiveReset = NOW + 2 * HOUR;
    const view = usageMeterView(
      {
        usage: {
          fiveHour: { usedPct: 100, resetsAt: at(fiveReset) },
          sevenDay: { usedPct: 60, resetsAt: at(NOW + 4 * 24 * HOUR) },
          observedAt: at(NOW - 60_000),
        },
        rateLimitedUntil: null,
      },
      NOW,
    );
    expect(view.tone).toBe('exhausted');
    expect(view.label).toBe(`resets ${clock(fiveReset)}`);
    // Only the 5h window is spent: the 7d meter keeps its measured 40% left.
    expect(view.remainingPct).toBe(40);
    expect(view.valueText).toBe(
      `5-hour limit reached, resets ${clock(fiveReset)}; 40% of weekly quota left`,
    );
  });

  it('C3: a generic authoritative rate limit keeps the measured weekly remainder', () => {
    const until = NOW + 30 * 60_000;
    const view = usageMeterView(
      {
        usage: {
          fiveHour: { usedPct: 10, resetsAt: at(NOW + 2 * HOUR) },
          sevenDay: { usedPct: 40, resetsAt: at(NOW + 4 * 24 * HOUR) },
          observedAt: at(NOW - 60_000),
        },
        rateLimitedUntil: at(until),
        cooldown: { until: at(until), reason: 'rate_limit', authoritative: true },
        nextResetAt: at(until),
      },
      NOW,
    );
    expect(view.tone).toBe('exhausted');
    expect(view.label).toBe(`resets ${clock(until)}`);
    // A provider rate limit is not a spent quota: the measured 60% stays on the meter.
    expect(view.remainingPct).toBe(60);
    expect(view.valueText).toBe(`Rate limited, resets ${clock(until)}; 60% of weekly quota left`);
  });

  it('C3: with both windows spent, the shown reset is the weekly one that clears the block', () => {
    const fiveReset = NOW + HOUR;
    const weekReset = NOW + 3 * 24 * HOUR;
    const view = usageMeterView(
      {
        usage: {
          fiveHour: { usedPct: 100, resetsAt: at(fiveReset) },
          sevenDay: { usedPct: 100, resetsAt: at(weekReset) },
          observedAt: at(NOW - 60_000),
        },
        rateLimitedUntil: null,
        cooldown: null,
        // The backend names the earliest spent-window reset; it does not unblock the 7d meter.
        nextResetAt: at(fiveReset),
      },
      NOW,
    );
    expect(view.tone).toBe('exhausted');
    expect(view.remainingPct).toBe(0);
    expect(view.label).toBe(`resets ${day(weekReset)}`);
    expect(view.valueText).toContain('Quota used up');
  });

  it('C3: an old 5h observation with no reset is not asserted exhausted', () => {
    const usage = (observedAt: number) => ({
      fiveHour: { usedPct: 100, resetsAt: null },
      sevenDay: { usedPct: 30, resetsAt: at(NOW + 4 * 24 * HOUR) },
      observedAt: at(observedAt),
    });
    // 7h old: that 5h window has certainly reset; the snapshot is just stale.
    const old = usageMeterView(
      { usage: usage(NOW - 7 * HOUR), rateLimitedUntil: null, cooldown: null },
      NOW,
    );
    expect(old).toMatchObject({ tone: 'ok', stale: true, remainingPct: 70, label: null });
    // A current one is still a used-up 5h window, with no invented reset.
    const current = usageMeterView(
      { usage: usage(NOW - 60_000), rateLimitedUntil: null, cooldown: null },
      NOW,
    );
    expect(current).toMatchObject({ tone: 'exhausted', label: 'no reset info', remainingPct: 70 });
  });

  it('C3: used up with no provider reset says so instead of inventing one', () => {
    const usage = {
      fiveHour: null,
      sevenDay: { usedPct: 100, resetsAt: null },
      observedAt: at(NOW - 60_000),
    };
    const view = usageMeterView({ usage, rateLimitedUntil: null, cooldown: null }, NOW);
    expect(view).toMatchObject({ tone: 'exhausted', label: 'no reset info' });
    // A Rose backoff on top adds its retry hint but is never shown as the reset.
    const stalled = usageMeterView(
      {
        usage,
        rateLimitedUntil: at(NOW + 12 * 60_000),
        cooldown: cooldown(at(NOW + 12 * 60_000), 'stall', false),
      },
      NOW,
    );
    expect(stalled).toMatchObject({ tone: 'exhausted', label: 'no reset info · retry in 12m' });
  });

  it('C4: a non-authoritative cooldown is cooling, keeps the last fill, never red', () => {
    const view = usageMeterView(
      {
        usage: weeklyAt(30, NOW + 3 * 24 * HOUR),
        rateLimitedUntil: at(NOW + 12 * 60_000),
        cooldown: cooldown(at(NOW + 12 * 60_000), 'stall', false),
        nextResetAt: null,
      },
      NOW,
    );
    expect(view).toMatchObject({ tone: 'cooling', remainingPct: 70, label: 'retry in 12m' });
    expect(view.valueText).toBe('Paused, retry in 12m; 70% of weekly quota left');

    const later = usageMeterView(
      {
        usage: null,
        rateLimitedUntil: null,
        cooldown: cooldown(at(NOW + 2 * HOUR), 'rate_limit', false),
      },
      NOW,
    );
    expect(later).toMatchObject({ tone: 'cooling', remainingPct: null });
    expect(later.label).toBe(`paused until ${clock(NOW + 2 * HOUR)}`);
  });

  it('C2: fill is 100 - usedPct', () => {
    const view = usageMeterView(
      { usage: weeklyAt(35, NOW + HOUR), rateLimitedUntil: null, cooldown: null },
      NOW,
    );
    expect(view).toMatchObject({ tone: 'ok', remainingPct: 65, label: null, stale: false });
    expect(view.valueText).toBe('65% of weekly quota left');
  });

  it('C1: no usage and no cooldown is unknown, labelled "No data yet", never zero', () => {
    const view = usageMeterView({ usage: null, rateLimitedUntil: null, cooldown: null }, NOW);
    expect(view).toMatchObject({ tone: 'unknown', remainingPct: null, label: 'No data yet' });
    expect(view.valueText).not.toMatch(/0%/);
  });

  it('C5: a snapshot older than 6h is stale with "as of"', () => {
    const usage = { ...weeklyAt(20, NOW + 2 * 24 * HOUR), observedAt: at(NOW - 7 * HOUR) };
    const view = usageMeterView({ usage, rateLimitedUntil: null, cooldown: null }, NOW);
    expect(view).toMatchObject({ tone: 'ok', remainingPct: 80, stale: true });
    expect(view.title).toMatch(/\nas of 7h ago$/);
    expect(view.valueText).toBe('80% of weekly quota left, as of 7h ago');
    expect(
      usageMeterView({ usage: weeklyAt(20, NOW + HOUR), rateLimitedUntil: null }, NOW).stale,
    ).toBe(false);
  });

  it('back-compat: cooldown key absent → bare rateLimitedUntil is a cooldown of unknown authority', () => {
    const view = usageMeterView(
      { usage: weeklyAt(30, NOW + 3 * 24 * HOUR), rateLimitedUntil: at(NOW + 4 * 60_000) },
      NOW,
    );
    expect(view).toMatchObject({ tone: 'cooling', remainingPct: 70, label: 'retry in 4m' });
    // ...but a used-up window is still exhausted, with the provider's reset.
    const resetAt = NOW + 3 * 24 * HOUR;
    const empty = usageMeterView(
      { usage: weeklyAt(100, resetAt), rateLimitedUntil: at(NOW + 4 * 60_000) },
      NOW,
    );
    expect(empty).toMatchObject({ tone: 'exhausted', label: `resets ${day(resetAt)}` });
  });
});

function weeklyAt(usedPct: number, resetsAtMs: number) {
  return {
    fiveHour: null,
    sevenDay: { usedPct, resetsAt: new Date(resetsAtMs).toISOString() },
    observedAt: new Date(NOW - HOUR).toISOString(),
  };
}
