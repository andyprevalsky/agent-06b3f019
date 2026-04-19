import { readAllCookies } from './service';
import type { CookieData } from './types';

/**
 * Public entry point for cookie-reader. External callers (handlers/registry,
 * cookie-sync repo, blackbox test mocks) use `CookieReader.readCookies()` —
 * the class shape is preserved for backward compatibility with the legacy
 * `main/services/cookieReader.ts` import surface.
 *
 * The runtime layer is intentionally thin: it takes no arguments, delegates
 * the full flow to the service, and returns the typed result. All logging,
 * decryption, and I/O live behind the service/repo split.
 */
export class CookieReader {
  static async readCookies(): Promise<CookieData[]> {
    return readAllCookies();
  }
}
