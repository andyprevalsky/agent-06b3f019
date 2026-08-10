/**
 * Peak-RSS budget for the local/prod seed.
 *
 * WHY THIS EXISTS
 * The seed runs on every cold benchmark box, beside Postgres, Temporal, the
 * backend, the frontend and a 12-process worker pool. On 2026-07-29 it was
 * SIGKILLed (rc=137) on a 4GB fleet primary while syncing one SMS benchmark —
 * the box was excluded as an infra loss and the whole fleet run died before its
 * start barrier. Nothing measured the seed's footprint, so the regression that
 * introduced it is unknown and the next one would land the same way.
 *
 * THE RATCHET
 * `SEED_PEAK_RSS_BUDGET_MB` is an upper bound on the seed's observed peak RSS,
 * enforced by a checked-in test. It only ever moves DOWN. Raising it to make a
 * failing run pass is the reward-hack this file exists to prevent: the machine
 * size is fixed by what prod uses, so a seed that needs more RAM is a seed that
 * has to get leaner, not a machine that has to get bigger.
 *
 * When a change genuinely reduces peak RSS, lower the budget to the maximum of
 * five cold, fidelity-verified runs plus 20% headroom and note it below. That
 * is the only edit this constant should ever receive.
 */

/**
 * Ceiling on the seed's peak RSS. Lower this — never raise it.
 *
 * Measured with `scripts/measure-seed-memory.sh 5`: every run restores the
 * 2026-07-29 prod dump into a local read-only source and seeds a fresh target.
 * The five OS-level `/usr/bin/time -l` peaks were 190, 190, 161, 176, and
 * 191MB; all source/target fingerprints matched. 230 is ceil(191 * 1.20).
 *
 * History (newest first):
 *   230 — measured max 191MB + 20% headroom (2026-07-29). JSONB origin rows
 *         stream Postgres-to-Postgres without entering V8, and all growth
 *         tables use bounded pages. Pre-fix measured peak was 4823MB.
 *   400 — re-anchored to prod's 2048MB worker instead of the bench box's 4096MB
 *         (2026-07-29). The fleet already has 2x prod's RAM and still OOM'd;
 *         budgeting against the bigger box would license the growth.
 *   700 — provisional ceiling set alongside paging Message Records + People
 *         (2026-07-29). Before paging, `messageRecord.findMany({ take: 10_000 })`
 *         materialised every row and its message body in one array before the
 *         first write; that was the rc=137 SIGKILL on a 4GB primary.
 */
export const SEED_PEAK_RSS_BUDGET_MB = 230;

/** Exactly the user-requested headroom above the five-run measured maximum. */
export const SEED_RSS_HEADROOM_RATIO = 0.2;

/**
 * Prod's agent worker: performance-1x / 2048MB (agents/fly.toml [[vm]]).
 *
 * THIS is the baseline, not the bench box. The cloudbench fleet primary is
 * shared-cpu-2x / 4096MB — already 2x prod — and it still OOM'd. Anchoring the
 * budget to 4096 would treat that upgrade as the norm and let the seed grow into
 * it, so the constraint is deliberately prod's number: whatever runs in the
 * fleet must fit the machine prod actually pays for.
 */
export const PROD_WORKER_MEMORY_MB = 2048;

/**
 * What the bench primary currently has. Recorded for the headroom the fleet
 * gets over prod — NOT as the budget basis. If this ever needs to rise to make
 * a bench pass, the workload is wrong.
 */
export const FLEET_PRIMARY_MEMORY_MB = 4096;

/**
 * Share of the box the seed is allowed to occupy at its peak. The seed is one
 * of several colocated services; taking more than a fifth of the machine is
 * what produced the OOM.
 */
export const SEED_MAX_MACHINE_FRACTION = 0.2;

/**
 * Hard ceiling: 20% of a PROD-sized machine. The seed shares its box with
 * Postgres, Temporal, the backend, the frontend and a 12-process worker pool,
 * so a fifth of the machine is already generous.
 */
export const SEED_PEAK_RSS_CEILING_MB = PROD_WORKER_MEMORY_MB * SEED_MAX_MACHINE_FRACTION;

/** Where the seed writes its observed peak so the ratchet test can read it. */
export const SEED_RSS_REPORT_ENV = 'SEED_PEAK_RSS_REPORT';

export interface SeedRssReport {
  peakRssMb: number;
  budgetMb: number;
  tables: Array<{ name: string; peakRssMb: number }>;
}

/** True when an observed peak fits the ratchet. */
export function withinSeedBudget(peakRssMb: number): boolean {
  return peakRssMb <= SEED_PEAK_RSS_BUDGET_MB;
}
