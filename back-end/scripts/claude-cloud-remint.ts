#!/usr/bin/env tsx
/**
 * CLI wrapper around the cloud re-mint core.
 *
 * The implementation lives in `src/providers/browser/claudeGrantMint.ts` so the
 * backend can import it without reaching outside `rootDir` (tsc rejects that,
 * and the violation was invisible while `npx tsc` was silently resolving a
 * typo-squat package instead of TypeScript).
 */
import {
  cloudRemint,
  verifyGrant,
  type CdpCookie,
} from '../src/providers/browser/claudeGrantMint';

const base = process.env.CDP_URL ?? 'http://127.0.0.1:9335';
const raw = process.env.CONFORMANCE_CLAUDE_COOKIES;
if (raw === undefined) {
  console.error(
    'CONFORMANCE_CLAUDE_COOKIES (JSON array of CDP cookies) is required.\n' +
      'In production these come from the stored account connection, not a local browser.'
  );
  process.exit(2);
}
void (async () => {
  const result = await cloudRemint(base, JSON.parse(raw) as CdpCookie[]);
  console.log(
    `minted expires_in=${result.expiresIn} (${(result.expiresIn / 86400).toFixed(0)}d) ` +
      `scope="${result.scope}" clickAttempts=${result.clickAttempts}`
  );
  const v = await verifyGrant(result.accessToken);
  console.log(`verify: ${v.ok ? 'PASS' : 'FAIL'} (${v.detail})`);
  process.exit(v.ok ? 0 : 1);
})();
