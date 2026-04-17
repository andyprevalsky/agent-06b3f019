/** Phone number formatting utilities for the auth feature. */

function appendUSFormatted(prefix: string, digits: string): string {
  let out = prefix + '(' + digits.slice(0, 3);
  if (digits.length >= 3) {
    out += ')';
    if (digits.length > 3) {
      out += '-' + digits.slice(3, 6);
      if (digits.length > 6) out += '-' + digits.slice(6, 10);
    }
  }
  return out;
}

/** Formats a raw digit string into a display phone number: +1 (XXX)-XXX-XXXX. */
export function formatPhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits[0] === '1') {
    const rest = digits.slice(1);
    return rest.length === 0 ? '+1' : appendUSFormatted('+1 ', rest);
  }
  if (digits.length <= 10) return appendUSFormatted('+1 ', digits);
  return '+' + digits;
}

/** Strips a formatted phone number to E.164: +19729777432. */
export function stripPhoneNumber(formatted: string): string {
  return '+' + formatted.replace(/\D/g, '');
}
