import { readFileSync } from 'fs';
import { join } from 'path';
import { isLinqEnabled } from '../../providers/linq';

const SURGE_PHONE = '+14154498072';

/**
 * Rose's number for this recipient: the Linq number when their texts route via
 * Linq (same rule as smsQueue), else the Surge number. Saving a number that
 * never answers them would strand their replies.
 */
export function rosePhoneFor(recipientPhone?: string | null): string {
  const linqPhone = process.env.LINQ_FROM_PHONE ?? '';
  if (linqPhone === '') return SURGE_PHONE;
  const routed =
    recipientPhone !== null && recipientPhone !== undefined && recipientPhone !== ''
      ? isLinqEnabled(recipientPhone)
      : isLinqEnabled();
  return routed ? linqPhone : SURGE_PHONE;
}

/** Rose contact email */
export const ROSE_EMAIL = 'rose@roselabs.ai';

/** Rose organization name */
export const ROSE_ORG = 'Rose Labs';

/** Rose website URL */
export const ROSE_URL = 'https://roselabs.ai';

/** Rose birthday (Jan 1, 2026) */
export const ROSE_BIRTHDAY = new Date(2026, 0, 1);

/** Default system name when user has no custom name */
export const DEFAULT_SYSTEM_NAME = 'Rose';

/**
 * Pre-loaded default Rose contact photo as base64 (256x256, ~35KB).
 * This avoids fetching the full-size 556KB image at runtime and keeps vCards under MMS size limits.
 */
export const DEFAULT_PHOTO_BASE64 = readFileSync(
  join(__dirname, '../../assets/rose-contact-256.png')
).toString('base64');
