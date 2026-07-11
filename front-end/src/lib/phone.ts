/**
 * International phone-number helpers (libphonenumber-js).
 *
 * Canonical wire/storage format everywhere is E.164 (`+<dialcode><national>`),
 * e.g. +19729777432 (US) or +525512345678 (MX). These helpers back the
 * country-code phone inputs so LATAM (and any other) numbers work end to end.
 */

import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  isPossiblePhoneNumber,
  parsePhoneNumberFromString,
} from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';

export type { CountryCode };

export interface CountryOption {
  code: CountryCode;
  name: string;
  dialCode: string;
  flag: string;
}

export const DEFAULT_COUNTRY: CountryCode = 'US';

/** US + LATAM surface first in the picker; everything else follows A→Z. */
const PRIORITY_COUNTRIES: CountryCode[] = [
  'US',
  'MX',
  'BR',
  'AR',
  'CO',
  'CL',
  'PE',
  'EC',
  'VE',
  'GT',
  'CR',
  'PA',
  'UY',
  'PY',
  'BO',
  'DO',
  'HN',
  'NI',
  'SV',
];

/** ISO 3166 alpha-2 → regional-indicator flag emoji. */
function flagEmoji(code: string): string {
  return String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function toOption(code: CountryCode): CountryOption {
  return {
    code,
    name: countryName(code),
    dialCode: getCountryCallingCode(code),
    flag: flagEmoji(code),
  };
}

export const COUNTRY_OPTIONS: CountryOption[] = (() => {
  const prioritySet = new Set<CountryCode>(PRIORITY_COUNTRIES);
  const rest = getCountries()
    .filter((code) => !prioritySet.has(code))
    .map(toOption)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...PRIORITY_COUNTRIES.map(toOption), ...rest];
})();

export function getDialCode(country: CountryCode): string {
  return getCountryCallingCode(country);
}

/** National digits of an E.164-ish value for the given country ('' when empty). */
export function nationalDigits(value: string, country: CountryCode): string {
  const digits = value.replace(/\D/g, '');
  const dial = getCountryCallingCode(country);
  return digits.startsWith(dial) ? digits.slice(dial.length) : digits;
}

/**
 * Compose the canonical E.164-ish value from a country + typed national digits.
 * Complete numbers are parsed so trunk prefixes (e.g. leading 0) normalize away;
 * partial input falls back to naive dial-code concatenation.
 */
export function composeE164(country: CountryCode, national: string): string {
  const digits = national.replace(/\D/g, '');
  if (digits === '') return '';
  const parsed = parsePhoneNumberFromString(digits, country);
  if (parsed !== undefined) return parsed.number;
  return `+${getCountryCallingCode(country)}${digits}`;
}

/** Format national digits for display as the user types (e.g. "55 1234 5678"). */
export function formatNationalDigits(country: CountryCode, national: string): string {
  const digits = national.replace(/\D/g, '');
  if (digits === '') return '';
  return new AsYouType(country).input(digits);
}

/**
 * Exact country from a complete, parseable international number.
 * Returns undefined for partial/ambiguous input (e.g. a bare `+1…`), so
 * callers can avoid overriding a manually selected country that shares a
 * calling code (US/CA on +1, RU/KZ on +7).
 */
export function detectCountryExact(value: string): CountryCode | undefined {
  if (!value.startsWith('+')) return undefined;
  return parsePhoneNumberFromString(value)?.country;
}

/** Detect the country from a typed/pasted international value (`+52…`). */
export function detectCountry(value: string): CountryCode | undefined {
  if (!value.startsWith('+')) return undefined;
  const exact = detectCountryExact(value);
  if (exact !== undefined) return exact;
  // Partial input: longest matching dial code wins; picker order breaks ties.
  const digits = value.replace(/\D/g, '');
  let best: CountryCode | undefined;
  let bestLength = 0;
  for (const option of COUNTRY_OPTIONS) {
    if (digits.startsWith(option.dialCode) && option.dialCode.length > bestLength) {
      best = option.code;
      bestLength = option.dialCode.length;
    }
  }
  return best;
}

/**
 * Length-plausibility check used to gate submits. Deliberately NOT strict
 * validity — dev/review numbers like +15555550123 must remain submittable.
 */
export function isSubmittablePhone(value: string): boolean {
  if (value === '') return false;
  return isPossiblePhoneNumber(value);
}

/** Human display for a stored E.164 value, e.g. "+52 55 1234 5678". */
export function formatE164Display(value: string): string {
  return parsePhoneNumberFromString(value)?.formatInternational() ?? value;
}
