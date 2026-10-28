/**
 * C15 credential order for a code session: every subscription before any
 * funded key (Andy, 2026-10-28: "codex -> claude token before going to api
 * key or azure"). P is the provider the session runs on (or a fresh spawn
 * prefers), Q the other one:
 *
 *   1. P subscriptions (own, then shared) ── same harness, native resume
 *   2. Q subscriptions (own, then shared) ── provider switch: checkpoint
 *                                            restore + handoff prompt
 *   3. P funded key (Azure / Anthropic key) ─ same harness, no handoff
 *   4. Q funded key ──────────────────────── provider switch
 *   5. nothing ───────────────────────────── the retry stays paused
 *
 * Inside a provider the spawn already leases own → shared → funded
 * (resolveCodexSpawnAuth, fetchClaudeCodeCredentialsWithMeta + the funded
 * key), so the provider is the only choice made here. One pure function: the
 * spawn/retry plan (codeSpawnCredentialPlan), the outlook's next lease
 * (pickNextLease) and code inspect (codeProviderOrder) all read it.
 */

export type CodeProvider = 'claude' | 'codex';

/** A subscription login (own or shared pool) or the provider's funded key. */
export type CodeCredentialTier = 'subscription' | 'funded';

/** Whether each provider has a leasable credential of each tier right now. */
export type CodeCredentialTiers = Record<CodeProvider, Record<CodeCredentialTier, boolean>>;

export interface CodeCredentialStep {
  provider: CodeProvider;
  tier: CodeCredentialTier;
}

/** Every leasable step, in the C15 order above. */
export function codeCredentialOrder(
  tiers: CodeCredentialTiers,
  prefer: CodeProvider
): CodeCredentialStep[] {
  const other: CodeProvider = prefer === 'claude' ? 'codex' : 'claude';
  const steps: CodeCredentialStep[] = [
    { provider: prefer, tier: 'subscription' },
    { provider: other, tier: 'subscription' },
    { provider: prefer, tier: 'funded' },
    { provider: other, tier: 'funded' },
  ];
  return steps.filter((step) => tiers[step.provider][step.tier]);
}

/** The credential the next spawn (or retry) takes; null when nothing is leasable. */
export function pickCodeCredential(
  tiers: CodeCredentialTiers,
  prefer: CodeProvider
): CodeCredentialStep | null {
  return codeCredentialOrder(tiers, prefer)[0] ?? null;
}

/** Providers in the order their first leasable credential appears (inspect tries each in turn). */
export function codeProviderOrder(
  tiers: CodeCredentialTiers,
  prefer: CodeProvider
): CodeProvider[] {
  return [...new Set(codeCredentialOrder(tiers, prefer).map((step) => step.provider))];
}
