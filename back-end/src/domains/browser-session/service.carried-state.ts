/**
 * Worker-captured browser state (Playwright storageState) carried into a
 * Tilion replacement. Tilion admits one CDP client and the worker holds it, so
 * the backend cannot harvest a live Tilion session itself; it refuses to
 * replace one without this (TilionUncarriedStateError → 409 carried_state_required).
 */
import type { Response } from 'express';
import { TilionUncarriedStateError, type TilionCarriedState } from '../../providers/browser/tilion';

export interface RequestStorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<Record<string, unknown>>;
}

/** Zod validated the outer shape; entries are Playwright's own cookie/origin records. */
export function carriedStateFromRequest(storageState: RequestStorageState | undefined): {
  carriedState?: TilionCarriedState;
} {
  if (storageState === undefined) return {};
  return {
    carriedState: {
      cookies: storageState.cookies as TilionCarriedState['cookies'],
      origins: storageState.origins as TilionCarriedState['origins'],
    },
  };
}

export function respondIfCarriedStateRequired(error: unknown, res: Response): boolean {
  if (!(error instanceof TilionUncarriedStateError)) return false;
  res.status(409).json({
    error: 'carried_state_required',
    provider: 'tilion',
    task_id: error.taskId,
    message:
      'The live Tilion session holds browser state only the worker can capture; ' +
      'retry with storage_state (Playwright storageState) in the request body.',
  });
  return true;
}
