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

/**
 * Creates per call while each lands on a session that fails CDP validation.
 * Tilion places creates across its pool's workers; with one dead worker of three
 * (2026-11-13) two creates still fail together about 1 in 9 times.
 * - New task sessions keep the original 2. Init is retried by its caller (the
 *   worker's init loop makes up to 5 calls, and a typed failure releases the init
 *   receipt for each); the user-initiated root browser keeps the same budget.
 * - Replacements (resume, rotation) and challenge recovery have no outer retry, so
 *   they get 4 (about 1 in 81). Every failed create may leave an unreleased session
 *   until Tilion's idle timeout, so the budget stays bounded per path.
 */
export const TILION_TASK_CREATE_ATTEMPTS = 2;
export const TILION_REPLACEMENT_CREATE_ATTEMPTS = 4;

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
