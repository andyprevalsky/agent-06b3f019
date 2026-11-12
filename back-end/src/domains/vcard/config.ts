import { readFileSync } from 'fs';
import { join } from 'path';

/** Rose contact phone number */
export const ROSE_PHONE =
  process.env.SMS_PROVIDER === 'linq'
    ? (process.env.LINQ_FROM_PHONE ?? '+14154498072')
    : '+14154498072';

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
