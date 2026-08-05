import { randomInt } from 'node:crypto';

import { WAITLIST_FIXTURE_PHONE_PREFIXES } from '../../providers/waitlistIdentity';

/**
 * Return a unique-looking NANP fictional number that still exercises the
 * real-person waitlist path. The random area-code range includes 555, which
 * would produce the reserved +1555 fixture prefix, so reject classified
 * fixture numbers instead of letting roughly 1 in 790 tests become a fixture.
 */
export function uniqueRealWaitlistPhone(): string {
  while (true) {
    const areaCode = randomInt(200, 990);
    const subscriber = String(randomInt(100, 200)).padStart(4, '0');
    const phone = `+1${areaCode}555${subscriber}`;
    if (!WAITLIST_FIXTURE_PHONE_PREFIXES.some((prefix) => phone.startsWith(prefix))) {
      return phone;
    }
  }
}
