/**
 * Worker-captured browser state (Playwright storageState) carried into a
 * Tilion replacement. Tilion admits one CDP client and the worker holds it, so
 * the backend cannot harvest a live Tilion session itself; it refuses to
 * replace one without this (TilionUncarriedStateError → 409 carried_state_required,
 * routes.carried-state.ts).
 */
import type { TilionCarriedState } from '../../providers/browser/tilion';

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
