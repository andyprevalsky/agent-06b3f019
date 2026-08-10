import { codexSmokeCreditSkipReason } from './codex-credit-skip';

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
}
