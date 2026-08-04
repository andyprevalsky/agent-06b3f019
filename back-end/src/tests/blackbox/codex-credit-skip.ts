// Credit-exhaustion skip detection for the Codex E2B smoke.
//
// The Codex E2B smoke drives a real paid third-party (ChatGPT OAuth → funded
// OpenAI key). When BOTH credential paths are out of credits/quota, the sandbox
// can never emit CODEX_E2B_DONE — but that is an external funding state we don't
// control, exactly the escalation class /deploy already treats as non-blocking.
// Rather than hard-fail (and force a human approval loop on every credit-
// exhausted deploy), the smoke converts that specific state into a loud SKIP —
// mirroring the deploy-approved Claude Code credential skip. Every OTHER failure
// mode (crash, timeout, wrong output, auth/OAuth revocation) still fails hard.

/** Thrown by the smoke to mark a run skipped because the account is out of funds. */
export class CredentialExhaustionSkip extends Error {
  readonly isCredentialExhaustionSkip = true;
  constructor(message: string) {
    super(message);
    this.name = 'CredentialExhaustionSkip';
  }
}

// Funding-exhaustion signals only (out of credits/quota). Deliberately does NOT
// match bare auth/OAuth-revocation errors (401 / "log out and sign in again"):
// those are user-fixable by re-authenticating and must stay a hard failure so a
// real broken-auth regression can never masquerade as a fundless skip.
// `no credits remaining` / `add credits to continue` are the literal wording the
// OpenAI API returns on an exhausted org balance ("You have no credits
// remaining. Add credits to continue using the API"). Their absence hard-failed
// a deploy on 2026-08-04 for exactly the funding state this skip exists to
// absorb, so both are matched explicitly. Neither phrase can be produced by an
// auth/OAuth revocation, so the deliberate exclusion above still holds.
//
// `credit_balance_exhausted` / `credit balance is too low` are the same state as
// delivered in a STRUCTURED provider error rather than prose — the API-key leg
// surfaces the machine code where the CLI surfaces the sentence, and only the
// prose reaches the raw output. Both dialects are matched so the skip does not
// depend on which leg reported the exhaustion.
const CODEX_CREDIT_EXHAUSTION_PATTERN =
  /insufficient[_ ]quota|insufficient credits|quota exceeded|check your plan and billing|(?<![\d.])402(?![\d.])|hit your usage limit|purchase more credits|out of credits|no credits remaining|add credits to continue|credit[_ ]balance[_ ]exhausted|credit balance is too low|billing (?:hard )?limit reached/i;

/**
 * Detect whether a Codex smoke run terminated because every available credential
 * (ChatGPT OAuth AND the funded OpenAI key) is out of credits/quota. Returns the
 * matched signal (truncated) when so, else null. Pure/synchronous so it is
 * cemented by regression cases without a live sandbox.
 *
 * Callers MUST first confirm the success sentinel (CODEX_E2B_DONE) is absent —
 * a healthy OAuth-usage-limit run that recovered via the funded key still
 * completes, and its recoverable error text must not be mistaken for exhaustion.
 */
export function detectCodexCreditExhaustion(output: string, events: unknown[]): string | null {
  const haystacks: string[] = [output];
  for (const event of events) {
    const typed = event as { message?: unknown; reason?: unknown; error?: unknown };
    for (const field of [typed?.message, typed?.reason, typed?.error]) {
      if (typeof field === 'string' && field) haystacks.push(field);
    }
  }
  for (const haystack of haystacks) {
    const match = haystack.match(CODEX_CREDIT_EXHAUSTION_PATTERN);
    if (match) return match[0].slice(0, 200);
  }
  return null;
}

/**
 * The single source of truth for "should the Codex E2B smoke SKIP (out of
 * credits) vs. keep asserting?". Skip ONLY when the run failed to reach the
 * success sentinel AND every credential path is out of credits/quota. A run
 * that produced CODEX_E2B_DONE can never skip — success always wins.
 */
export function codexSmokeCreditSkipReason(output: string, events: unknown[]): string | null {
  if (output.includes('CODEX_E2B_DONE')) return null;
  return detectCodexCreditExhaustion(output, events);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ── Regression cases (cemented in the codex-code blackbox domain) ────────────

export function testDetectCreditExhaustion_positive(): void {
  // Funded-key exhaustion surfaced in raw output.
  assert(
    detectCodexCreditExhaustion('[Codex] Error code: insufficient_quota', []) !== null,
    'insufficient_quota in output must be detected as credit exhaustion'
  );
  // Exhaustion surfaced only in structured events (message/reason fields).
  assert(
    detectCodexCreditExhaustion('normal output', [
      { type: 'error', message: 'Quota exceeded. Check your plan and billing details.' },
    ]) !== null,
    'quota-exceeded event message must be detected'
  );
  assert(
    detectCodexCreditExhaustion('normal output', [
      { source: 'funded_api_key', reason: 'insufficient_quota' },
    ]) !== null,
    'insufficient_quota event reason must be detected'
  );
  // 402 payment-required is an out-of-funds signal.
  assert(
    detectCodexCreditExhaustion('request failed with status 402', []) !== null,
    'HTTP 402 must be detected as out of funds'
  );
  // The exact wording the OpenAI API returns for a defunded account, as seen in
  // the turn.failed event during a real deploy run.
  assert(
    detectCodexCreditExhaustion('normal output', [
      {
        type: 'error',
        message:
          'stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
      },
    ]) !== null,
    'the live "no credits remaining" wording must be detected as exhaustion'
  );
}

export function testDetectCreditExhaustion_observedOpenAiWording(): void {
  // VERBATIM from the 2026-08-04 deploy, which this detector failed to skip and
  // hard-failed instead. Pin the real wording, not a paraphrase.
  const real =
    'stream disconnected before completion: You have no credits remaining. ' +
    'Add credits to continue using the API at ' +
    'https://platform.openai.com/settings/organization/billing/.';
  assert(
    codexSmokeCreditSkipReason(real, []) !== null,
    "OpenAI's real $0-balance message must be detected as credit exhaustion"
  );
  // The same state as delivered in a structured provider-error event.
  assert(
    codexSmokeCreditSkipReason('no sentinel', [
      {
        type: 'error',
        error: {
          type: 'insufficient_quota',
          code: 'credit_balance_exhausted',
        } as unknown as string,
        message: 'You have no credits remaining.',
      },
    ]) !== null,
    'structured credit_balance_exhausted must be detected as credit exhaustion'
  );
  // Success still wins: a run that reached the sentinel can never skip, even if
  // a recoverable funding warning appeared earlier in its output.
  assert(
    codexSmokeCreditSkipReason(`warning: no credits remaining on key A\nCODEX_E2B_DONE`, []) ===
      null,
    'a run that produced CODEX_E2B_DONE must never skip'
  );
}

export function testDetectCreditExhaustion_negative(): void {
  // A healthy run with no funding signal is not a skip.
  assert(
    detectCodexCreditExhaustion('running codex... wrote file... CODEX_E2B_DONE', []) === null,
    'healthy output must not be treated as credit exhaustion'
  );
  // Bare OAuth re-auth / revocation is user-fixable auth, NOT out-of-funds — it
  // must remain a hard failure so a real broken-auth regression cannot hide.
  assert(
    detectCodexCreditExhaustion('your session has ended, log out and sign in again', [
      { type: 'error', message: 'refresh_token_invalidated' },
    ]) === null,
    'bare re-auth / token-revocation errors must NOT count as a fundless skip'
  );
  // An unrelated "402" embedded in a larger number must not false-positive.
  assert(
    detectCodexCreditExhaustion('processed 14025 tokens across 3402 spans', []) === null,
    'digits adjacent to 402 must not trigger the out-of-funds signal'
  );
}

export function testCreditExhaustion_neverOverridesSuccessSentinel(): void {
  // Even when a credit-exhaustion signal is present, a run that produced the
  // success sentinel completed (e.g. via funded-key fallback) and must NOT skip.
  const outputWithBoth = 'oauth hit your usage limit\nfell back to funded key\nCODEX_E2B_DONE\n';
  assert(
    detectCodexCreditExhaustion(outputWithBoth, []) !== null,
    'precondition: usage-limit text is present'
  );
  assert(
    codexSmokeCreditSkipReason(outputWithBoth, []) === null,
    'a run that produced CODEX_E2B_DONE must never be converted to a credit skip'
  );
  // No sentinel + exhaustion on all paths -> skip reason returned.
  assert(
    codexSmokeCreditSkipReason('all credentials returned insufficient_quota', []) !== null,
    'no success sentinel + exhaustion must yield a skip reason'
  );
}
