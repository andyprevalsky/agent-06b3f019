/**
 * Outcome accounting for Tilion creates that fail CDP validation.
 *
 *   create ─► validate ✗ ─► release (✓ or unconfirmed) ─► next create (bounded)
 *                                     └─ all attempts ✗ ─► tilionValidationFailure
 */
import { createLogger } from '../logger';
import { BrowserSessionValidationError } from './types';

const log = createLogger('Tilion');

export class TilionSessionValidationError extends Error {}

export interface TilionValidationAttempt {
  sessionId: string | undefined;
  /** The validation error, then the release error when DELETE was unconfirmed. */
  errors: unknown[];
}

/**
 * Final error after every create failed CDP validation. All sessions identified
 * → typed: nothing is bound and every allocation is known, so a caller may retry.
 * A create that returned no session id stays an untyped, ambiguous failure.
 */
export function tilionValidationFailure(failed: TilionValidationAttempt[]): Error {
  const last = failed[failed.length - 1]!;
  const errors = failed.flatMap((attempt) => attempt.errors);
  const message =
    last.errors.length > 1
      ? `Tilion session ${last.sessionId} failed validation and cleanup`
      : String((last.errors[0] as Error).message);
  const sessionIds = failed.map((attempt) => attempt.sessionId);
  if (sessionIds.every((id): id is string => typeof id === 'string' && id !== '')) {
    return new BrowserSessionValidationError('tilion', sessionIds, errors, message);
  }
  return errors.length === 1 ? (errors[0] as Error) : new AggregateError(errors, message);
}

/**
 * Release a create that failed. Returns when another create should run (a CDP
 * validation failure with attempts left, even if its DELETE was unconfirmed);
 * otherwise throws the final outcome.
 */
export async function settleFailedTilionCreate(
  error: unknown,
  sessionId: string | undefined,
  mayRetry: boolean,
  failed: TilionValidationAttempt[],
  release: (sessionId: string) => Promise<void>
): Promise<void> {
  let releaseError: unknown = null;
  if (sessionId) {
    try {
      await release(sessionId);
    } catch (failure) {
      releaseError = failure;
    }
  }
  if (!(error instanceof TilionSessionValidationError)) {
    if (releaseError === null) throw error;
    throw new AggregateError(
      [error, releaseError],
      `Tilion session ${sessionId} failed validation and cleanup`
    );
  }
  failed.push({ sessionId, errors: releaseError === null ? [error] : [error, releaseError] });
  if (!mayRetry) throw tilionValidationFailure(failed);
  log.warn('Tilion session failed validation; creating another', {
    sessionId,
    released: releaseError === null,
    error: error.message,
  });
}
