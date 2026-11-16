/** Time-left estimate for the iPhone setup card (pure; rendered by IPhoneSetupProgress). */
import type { IPhoneSetupStep } from '@/lib/api/iphone';

/**
 * Typical minutes per setup step, measured from prod setup agents 1772a64a, 33712aad,
 * c1ad83f7 (2026-11-15) and f1802539 (2026-11-14): step boundaries are each step's first
 * setup-check call. session ~1, portrait_lock 3-8, apple_account ~2, icloud 6.5-8,
 * imessage 2-2.6, gmail 2.2-7 (to the 2-Step prompt), passcode ~5. The API exposes no
 * step start times, so the in-progress step counts in full. Unknown step keys add nothing.
 */
export const SETUP_STEP_MINUTES: Readonly<Record<string, number>> = {
  session: 1,
  portrait_lock: 5,
  apple_account: 2,
  icloud: 8,
  imessage: 3,
  gmail: 5,
  passcode: 5,
};
const ALL_STEPS_MINUTES = Object.values(SETUP_STEP_MINUTES).reduce((sum, m) => sum + m, 0);

/** "About N min left" | "Almost done"; never negative or fractional. */
export function setupTimeLeftLabel(steps: readonly IPhoneSetupStep[]): string {
  const minutes =
    steps.length === 0
      ? ALL_STEPS_MINUTES
      : steps
          .filter((step) => step.status !== 'done')
          .reduce((sum, step) => sum + (SETUP_STEP_MINUTES[step.key] ?? 0), 0);
  const rounded = Math.max(0, Math.round(minutes));
  return rounded < 1 ? 'Almost done' : `About ${rounded} min left`;
}
