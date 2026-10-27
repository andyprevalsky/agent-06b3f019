/** Unique synthetic identities shared by test client and its isolated backend. */
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePhoneAllowlist } from '../../providers/phoneAllowlist';
let next = 0;
/** Concurrent domain processes share one pool; an exclusive claim file keeps each phone single-use. */
export function phoneFixtureNumber(): string {
  const pool = parsePhoneAllowlist(process.env.CLOUD_IPHONE_ALLOWED_PHONES).filter((phone) =>
    phone.startsWith('+1999')
  );
  const claims = join(
    tmpdir(),
    `rose-phone-fixtures-${createHash('sha256').update(pool.join(',')).digest('hex').slice(0, 16)}`
  );
  mkdirSync(claims, { recursive: true });
  while (next < pool.length) {
    const phone = pool[next++];
    try {
      closeSync(openSync(join(claims, phone), 'wx'));
      return phone;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(
    pool.length
      ? 'Synthetic phone identity pool exhausted for this run'
      : 'Run phone cases through scripts/run-blackbox-tests.sh (synthetic identity pool missing)'
  );
}
/** A run-unique account phone outside the allowlist (other suites own +15555550123). */
export function ineligiblePhoneFixtureNumber(): string {
  return phoneFixtureNumber().replace(/^\+1999/, '+1555');
}
