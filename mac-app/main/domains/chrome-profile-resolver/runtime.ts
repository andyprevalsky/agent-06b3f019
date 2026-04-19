/**
 * Runtime layer for chrome-profile-resolver.
 *
 * Public surface consumed by other domains (cookie-reader, local-storage-reader,
 * cache-storage-reader, permission-reader) and the blackbox tests via the
 * `main/services/chromeProfileResolver` shim. Identical to the pre-refactor
 * flat file so wiring and `vi.mock` seams don't need to change.
 *
 * `resolveChromeProfileDir` is re-exported directly. `resolveChromeProfilePath`
 * is wrapped only to adapt the rest-args `...segments` signature to the
 * service's array-based signature (service layers take typed args, not rest).
 */

import { resolveChromeProfilePath as resolveChromeProfilePathService } from './service';

export { resolveChromeProfileDir } from './service';

/** See `service.resolveChromeProfilePath` for the full contract. */
export function resolveChromeProfilePath(...segments: string[]): string | null {
  return resolveChromeProfilePathService(segments);
}
