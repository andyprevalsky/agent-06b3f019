/**
 * Canonical crypto provider.
 * Domain code must import from here instead of 'crypto' directly.
 * ESLint no-restricted-imports enforces this in src/domains/.
 */
export {
  randomUUID,
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  constants,
} from 'crypto';
