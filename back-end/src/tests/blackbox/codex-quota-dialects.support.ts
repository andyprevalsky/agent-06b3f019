/** Finite dialects already accepted by the native Codex producer/backend payment path. */
export const CODEX_QUOTA_DIALECTS = [
  'usage limit',
  'usage_limit',
  'usage_limit_reached',
  'hit your usage limit',
  'purchase more credits',
  'check your plan and billing',
  'Quota exceeded. Check your plan and billing details.',
  'insufficient_quota',
  'insufficient quota',
  'no credits remaining',
  'add credits to continue',
  'credit_balance_exhausted',
  'credit balance is too low',
  'out of credits',
  'purchase credits',
] as const;

/** Both field orders and supported same-line/multiline native diagnostic bodies. */
export function codexQuotaCollisions(): Array<{ label: string; reason: string }> {
  return CODEX_QUOTA_DIALECTS.flatMap((quota, index) =>
    [' ', '\n  '].flatMap((separator, line) =>
      [false, true].map((quotaFirst) => ({
        label: `dialect-${index}-line-${line}-quota-first-${quotaFirst}`,
        reason: (quotaFirst ? [quota, 'invalid_grant'] : ['invalid_grant', quota]).join(separator),
      }))
    )
  );
}
