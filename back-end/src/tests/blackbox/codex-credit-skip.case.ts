import {
  codexCreateUnavailableSkipReason,
  codexSmokeCreditSkipReason,
  codexSmokeLoginUnusableSkipReason,
} from './codex-credit-skip';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

export function testCodexCreditSkip_matchesLiveOutOfCreditsWording() {
  // Verbatim from the 2026-08-05 deploy: the pattern had "out of credits" but
  // OpenAI emits "no credits remaining", so the smoke hard-failed a pure
  // funding state and forced a manual BLACKBOX_TEST_SKIP_DOMAINS bypass.
  const message =
    'stream disconnected before completion: You have no credits remaining. ' +
    'Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.';
  assert(
    codexSmokeCreditSkipReason(message, []) !== null,
    'live "no credits remaining" wording must be recognized as credit exhaustion'
  );
}

export function testCodexCreditSkip_readsNestedErrorObject() {
  // The provider sends `{"error": {"message": "..."}}`; the detector only read
  // `error` when it was a bare string, so the nested funding signal was missed
  // even once the wording matched.
  const events = [
    {
      type: 'error',
      error: { message: 'You have no credits remaining. Add credits to continue.' },
    },
  ];
  assert(
    codexSmokeCreditSkipReason('no sentinel here', events) !== null,
    'nested error.message must be searched for funding-exhaustion signals'
  );
}

export function testCodexCreditSkip_successStillWins() {
  assert(
    codexSmokeCreditSkipReason('CODEX_E2B_DONE', [
      { type: 'error', error: { message: 'You have no credits remaining.' } },
    ]) === null,
    'a run that produced the success sentinel can never be downgraded to a skip'
  );
}

export function testCodexCreditSkip_authRevocationStillFailsHard() {
  assert(
    codexSmokeCreditSkipReason('401 Unauthorized: please log out and sign in again', []) === null,
    'auth/OAuth revocation is user-fixable and must remain a hard failure, not a funding skip'
  );
  assert(
    codexSmokeCreditSkipReason(
      '[Codex] Error: Your access token could not be refreshed because your refresh token was revoked.\n' +
        '[Codex] ChatGPT OAuth unusable — continuing on the funded Azure OpenAI deployment\n' +
        'You have no credits remaining. Add credits to continue.',
      [
        { type: 'auth_fallback', reason: 'oauth_refresh_invalid' },
        { type: 'error', message: 'You have no credits remaining.' },
      ]
    ) === null,
    'funded-key exhaustion cannot excuse a revoked OAuth credential'
  );
  assert(
    codexSmokeCreditSkipReason('You have no credits remaining.', [
      { type: 'error', error: { message: 'token_revoked' } },
    ]) === null,
    'code-only token_revoked must remain a hard failure even with funded-key exhaustion'
  );
}

export function testCodexCreditSkip_structuredUnusableLoginPausedForRetryIsSkip() {
  const revoked = 'Your access token could not be refreshed: refresh_token_invalidated';
  assert(
    codexSmokeLoginUnusableSkipReason([
      {
        type: 'error',
        message: revoked,
        usage_limit: null,
        login_unusable: { reason: 'oauth_refresh_invalid' },
      },
    ]) === 'login_unusable: oauth_refresh_invalid',
    'a structured unusable login (no Azure switch armed) paused for a retry is an unavailable-credential skip'
  );
  assert(
    codexSmokeLoginUnusableSkipReason([{ type: 'error', message: revoked, usage_limit: null }]) ===
      null,
    'revocation prose without the structured field still fails hard'
  );
  assert(
    codexSmokeLoginUnusableSkipReason([
      { type: 'error', message: revoked, login_unusable: { reason: 'oauth_refresh_invalid' } },
      { type: 'auth_fallback', reason: 'oauth_refresh_invalid' },
    ]) === null,
    'a run that switched to Azure must complete there; it never skips'
  );
}

export function testCodexCreditSkip_matchesE2bTeamBlockedWording() {
  // Verbatim from the 2026-09-03 backend-coverage fail: POST /sandboxes
  // returns 403 while GET /sandboxes still 200s. The smoke never reaches
  // CODEX_E2B_DONE, so create-time must skip on this funding signal.
  const createBody = '{"error":"403: team is blocked: missing payment method"}';
  assert(
    codexSmokeCreditSkipReason(createBody, []) !== null,
    'E2B team-blocked / missing payment method must be recognized as credit exhaustion'
  );
  assert(
    codexSmokeCreditSkipReason('Expected status 200, got 403: {"error":"Forbidden"}', []) === null,
    'a generic 403 must remain a hard failure, not a funding skip'
  );
}

export function testCodexCreditSkip_createUnavailableOnCooldownIsSkip() {
  // Verbatim from the 2026-10-02 coverage fail: create returned this 500 body
  // after waitForFundedGptKeyRestore exhausted, because the shared funded key
  // was still on its leftover out-of-credits cooldown and no OAuth/pool token
  // existed. That is every Codex path unusable — deploy-approved SKIP.
  const createBody =
    '{"error":"Code agent credentials are unavailable; the session could not be started"}';
  assert(
    codexCreateUnavailableSkipReason(createBody, true) !== null,
    'create-time credentials-unavailable + funded-key cooldown must skip'
  );
  assert(
    codexCreateUnavailableSkipReason(createBody, false) === null,
    'create-time credentials-unavailable without cooldown must stay a hard failure'
  );
}
