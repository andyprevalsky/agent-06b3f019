/**
 * Blackbox tests for src/lib/encryption.ts
 *
 * Covers every exported function:
 *   - encryptPaymentData (async, Web Crypto round-trip)
 *   - parsePaymentEnvelope (pure, reverses the base64-JSON envelope)
 *   - detectCardType (pure, prefix matching)
 *   - validateCardNumber (pure, Luhn algorithm)
 *   - validateExpiry (pure, MM/YY + date-in-future check)
 *   - validateCVV (pure, length check per card type)
 *   - formatCardNumber (pure, groups-of-4 formatting)
 *   - formatExpiry (pure, MM/YY formatting)
 *
 * Web Crypto (crypto.subtle) is available in jsdom + Node 20+ (verified via probe),
 * so the happy path for encryptPaymentData is exercised.
 */
import { describe, it, expect } from 'vitest';
import {
  encryptPaymentData,
  parsePaymentEnvelope,
  detectCardType,
  validateCardNumber,
  validateExpiry,
  validateCVV,
  formatCardNumber,
  formatExpiry,
  type PaymentData,
} from '@/lib/encryption';

const samplePaymentData: PaymentData = {
  card_number: '4242424242424242', // Visa test card (Luhn-valid)
  cardholder_name: 'Test Holder',
  card_expiry: '12/30',
  card_cvv: '123',
  billing_street_address: '1 Market St',
  billing_address_line2: '',
  billing_city: 'San Francisco',
  billing_state: 'CA',
  billing_zipcode: '94103',
  billing_country: 'US',
  billing_phone: '+15555551234',
  billing_email: 'test@example.com',
  autoagentpaylimit_cents: 5000,
};

describe('encryption.ts', () => {
  // ─────────────────────────────────────────────────────────────────────
  // detectCardType
  // ─────────────────────────────────────────────────────────────────────
  describe('detectCardType', () => {
    it('detects Visa (starts with 4)', () => {
      expect(detectCardType('4242424242424242')).toBe('visa');
      expect(detectCardType('4111 1111 1111 1111')).toBe('visa');
    });

    it('detects Mastercard (51-55 prefix)', () => {
      expect(detectCardType('5105105105105100')).toBe('mastercard');
      expect(detectCardType('5555555555554444')).toBe('mastercard');
    });

    it('detects Mastercard (2221-2720 prefix)', () => {
      expect(detectCardType('2221000000000009')).toBe('mastercard');
      expect(detectCardType('2720999999999999')).toBe('mastercard');
    });

    it('detects Amex (34 or 37 prefix)', () => {
      expect(detectCardType('340000000000009')).toBe('amex');
      expect(detectCardType('378282246310005')).toBe('amex');
    });

    it('detects Discover (6011, 65, 644-649, 622 prefix)', () => {
      expect(detectCardType('6011111111111117')).toBe('discover');
      expect(detectCardType('6500000000000002')).toBe('discover');
      expect(detectCardType('6440000000000000')).toBe('discover');
      expect(detectCardType('6220000000000000')).toBe('discover');
    });

    it('returns "unknown" for unrecognized prefix', () => {
      expect(detectCardType('1234567890123456')).toBe('unknown');
      expect(detectCardType('')).toBe('unknown');
      expect(detectCardType('9999999999999999')).toBe('unknown');
    });

    it('strips whitespace before checking', () => {
      expect(detectCardType('  4242 4242 4242 4242  ')).toBe('visa');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // validateCardNumber (Luhn)
  // ─────────────────────────────────────────────────────────────────────
  describe('validateCardNumber', () => {
    it('accepts a Luhn-valid Visa number', () => {
      expect(validateCardNumber('4242424242424242')).toBe(true);
    });

    it('accepts a Luhn-valid Amex number (15 digits)', () => {
      expect(validateCardNumber('378282246310005')).toBe(true);
    });

    it('rejects numbers that fail Luhn check', () => {
      expect(validateCardNumber('4242424242424243')).toBe(false);
      expect(validateCardNumber('1234567890123456')).toBe(false);
    });

    it('rejects numbers outside 13-19 digit range', () => {
      expect(validateCardNumber('4242')).toBe(false); // too short
      expect(validateCardNumber('42424242424242424242')).toBe(false); // too long (20)
    });

    it('rejects non-digit characters', () => {
      expect(validateCardNumber('4242-4242-4242-4242')).toBe(false);
      expect(validateCardNumber('abcd4242424242424242')).toBe(false);
    });

    it('strips whitespace before validating', () => {
      expect(validateCardNumber('4242 4242 4242 4242')).toBe(true);
    });

    it('handles empty string', () => {
      expect(validateCardNumber('')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // validateExpiry
  // ─────────────────────────────────────────────────────────────────────
  describe('validateExpiry', () => {
    it('accepts a future expiry', () => {
      // Year 2099 is comfortably in the future
      expect(validateExpiry('12/99')).toBe(true);
    });

    it('rejects malformed input', () => {
      expect(validateExpiry('1230')).toBe(false); // no slash
      expect(validateExpiry('1/30')).toBe(false); // missing zero-pad
      expect(validateExpiry('12/3')).toBe(false);
      expect(validateExpiry('')).toBe(false);
      expect(validateExpiry('aa/bb')).toBe(false);
    });

    it('rejects month out of range', () => {
      expect(validateExpiry('00/30')).toBe(false);
      expect(validateExpiry('13/30')).toBe(false);
    });

    it('rejects expired year', () => {
      // 2000 is in the past; year < currentYear branch
      expect(validateExpiry('12/00')).toBe(false);
    });

    it('rejects expired month in current year', () => {
      // Construct an MM/YY that's this-year-but-month-already-passed
      const now = new Date();
      const currentYear2 = String(now.getFullYear() - 2000).padStart(2, '0');
      if (now.getMonth() + 1 > 1) {
        // January of this year is already in the past if we're past Jan
        expect(validateExpiry(`01/${currentYear2}`)).toBe(false);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // validateCVV
  // ─────────────────────────────────────────────────────────────────────
  describe('validateCVV', () => {
    it('requires 3 digits for non-Amex', () => {
      expect(validateCVV('123', 'visa')).toBe(true);
      expect(validateCVV('999', 'mastercard')).toBe(true);
      expect(validateCVV('12', 'visa')).toBe(false);
      expect(validateCVV('1234', 'visa')).toBe(false);
    });

    it('requires 4 digits for Amex', () => {
      expect(validateCVV('1234', 'amex')).toBe(true);
      expect(validateCVV('123', 'amex')).toBe(false);
      expect(validateCVV('12345', 'amex')).toBe(false);
    });

    it('rejects non-digit characters', () => {
      expect(validateCVV('12a', 'visa')).toBe(false);
      expect(validateCVV('abcd', 'amex')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateCVV('', 'visa')).toBe(false);
      expect(validateCVV('', 'amex')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // formatCardNumber
  // ─────────────────────────────────────────────────────────────────────
  describe('formatCardNumber', () => {
    it('inserts spaces every 4 digits', () => {
      expect(formatCardNumber('4242424242424242')).toBe('4242 4242 4242 4242');
    });

    it('strips non-digit characters', () => {
      expect(formatCardNumber('4242-4242-4242-4242')).toBe('4242 4242 4242 4242');
      expect(formatCardNumber('abcd4242 4242xx4242')).toBe('4242 4242 4242');
    });

    it('handles partial input', () => {
      expect(formatCardNumber('4242')).toBe('4242');
      expect(formatCardNumber('42')).toBe('42');
      expect(formatCardNumber('')).toBe('');
    });

    it('caps output at 19 chars (16 digits + 3 spaces)', () => {
      const longInput = '12345678901234567890';
      expect(formatCardNumber(longInput).length).toBeLessThanOrEqual(19);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // formatExpiry
  // ─────────────────────────────────────────────────────────────────────
  describe('formatExpiry', () => {
    it('inserts slash after 2 digits', () => {
      expect(formatExpiry('1230')).toBe('12/30');
    });

    it('returns as-is when < 2 digits', () => {
      expect(formatExpiry('1')).toBe('1');
      expect(formatExpiry('')).toBe('');
    });

    it('strips non-digit characters', () => {
      expect(formatExpiry('12/30')).toBe('12/30');
      expect(formatExpiry('ab12cd30ef')).toBe('12/30');
    });

    it('truncates to MM/YY (4 digits total)', () => {
      expect(formatExpiry('123456')).toBe('12/34');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // parsePaymentEnvelope
  // ─────────────────────────────────────────────────────────────────────
  describe('parsePaymentEnvelope', () => {
    it('parses a valid base64-encoded JSON envelope', () => {
      const envelope = {
        version: 1 as const,
        encrypted_aes_key: 'aGVsbG8=',
        iv: 'aGVsbG8=',
        ciphertext: 'aGVsbG8=',
        card_last_four: '4242',
        card_type: 'visa',
        billing_city: 'SF',
        billing_country: 'US',
        autoagentpaylimit_cents: 5000,
      };
      const encoded = btoa(JSON.stringify(envelope));
      expect(parsePaymentEnvelope(encoded)).toEqual(envelope);
    });

    it('returns null for invalid base64', () => {
      expect(parsePaymentEnvelope('!!!not-base64!!!')).toBeNull();
    });

    it('returns null for base64 that is not valid JSON', () => {
      expect(parsePaymentEnvelope(btoa('this is plain text, not json'))).toBeNull();
    });

    it('returns null for empty input (atob throws or JSON.parse fails)', () => {
      // Empty string decodes cleanly but JSON.parse('') throws
      expect(parsePaymentEnvelope('')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // encryptPaymentData (happy path, uses crypto.subtle)
  // ─────────────────────────────────────────────────────────────────────
  describe('encryptPaymentData', () => {
    it('produces a base64-encoded envelope parseable by parsePaymentEnvelope', async () => {
      const encrypted = await encryptPaymentData(samplePaymentData);
      expect(typeof encrypted).toBe('string');
      expect(encrypted.length).toBeGreaterThan(0);

      const envelope = parsePaymentEnvelope(encrypted);
      expect(envelope).not.toBeNull();
      expect(envelope!.version).toBe(1);
      expect(envelope!.card_last_four).toBe('4242');
      expect(envelope!.card_type).toBe('visa');
      expect(envelope!.billing_city).toBe('San Francisco');
      expect(envelope!.billing_country).toBe('US');
      expect(envelope!.autoagentpaylimit_cents).toBe(5000);
      // Encrypted fields are base64 strings with nonzero length
      expect(envelope!.encrypted_aes_key.length).toBeGreaterThan(0);
      expect(envelope!.iv.length).toBeGreaterThan(0);
      expect(envelope!.ciphertext.length).toBeGreaterThan(0);
    }, 10_000);

    it('produces different ciphertext each call (random IV + random AES key)', async () => {
      const first = await encryptPaymentData(samplePaymentData);
      const second = await encryptPaymentData(samplePaymentData);
      expect(first).not.toBe(second);

      const envA = parsePaymentEnvelope(first)!;
      const envB = parsePaymentEnvelope(second)!;
      expect(envA.iv).not.toBe(envB.iv);
      expect(envA.ciphertext).not.toBe(envB.ciphertext);
      expect(envA.encrypted_aes_key).not.toBe(envB.encrypted_aes_key);
    }, 10_000);

    it('surfaces card_last_four derived from card_number', async () => {
      const encrypted = await encryptPaymentData({
        ...samplePaymentData,
        card_number: '5555555555554444',
      });
      const env = parsePaymentEnvelope(encrypted)!;
      expect(env.card_last_four).toBe('4444');
      expect(env.card_type).toBe('mastercard');
    }, 10_000);
  });
});
