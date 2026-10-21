/**
 * Timezone and locale for a browser whose provider does not derive them from
 * its exit IP. Tilion always reports America/New_York + en-US whatever the
 * exit country, so a GB exit would show a New York clock: an IP/timezone
 * mismatch that bot detectors score. Tilion honours country-level placement
 * only, so the country is the finest signal available.
 *
 * Unknown countries return null: the worker keeps the provider default rather
 * than inventing a zone. US exits are not placed by state (country only), so
 * the US default stays America/New_York.
 */
export interface ExitGeoLocale {
  country: string;
  timezone: string;
  locale: string;
  source: 'exit_country';
}

const COUNTRY_LOCALES: Readonly<Record<string, { timezone: string; locale: string }>> = {
  US: { timezone: 'America/New_York', locale: 'en-US' },
  CA: { timezone: 'America/Toronto', locale: 'en-CA' },
  MX: { timezone: 'America/Mexico_City', locale: 'es-MX' },
  BR: { timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
  AR: { timezone: 'America/Argentina/Buenos_Aires', locale: 'es-AR' },
  GB: { timezone: 'Europe/London', locale: 'en-GB' },
  IE: { timezone: 'Europe/Dublin', locale: 'en-IE' },
  FR: { timezone: 'Europe/Paris', locale: 'fr-FR' },
  DE: { timezone: 'Europe/Berlin', locale: 'de-DE' },
  ES: { timezone: 'Europe/Madrid', locale: 'es-ES' },
  IT: { timezone: 'Europe/Rome', locale: 'it-IT' },
  NL: { timezone: 'Europe/Amsterdam', locale: 'nl-NL' },
  PT: { timezone: 'Europe/Lisbon', locale: 'pt-PT' },
  SE: { timezone: 'Europe/Stockholm', locale: 'sv-SE' },
  PL: { timezone: 'Europe/Warsaw', locale: 'pl-PL' },
  CH: { timezone: 'Europe/Zurich', locale: 'de-CH' },
  AU: { timezone: 'Australia/Sydney', locale: 'en-AU' },
  NZ: { timezone: 'Pacific/Auckland', locale: 'en-NZ' },
  JP: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
  KR: { timezone: 'Asia/Seoul', locale: 'ko-KR' },
  IN: { timezone: 'Asia/Kolkata', locale: 'en-IN' },
  SG: { timezone: 'Asia/Singapore', locale: 'en-SG' },
  AE: { timezone: 'Asia/Dubai', locale: 'en-AE' },
  IL: { timezone: 'Asia/Jerusalem', locale: 'he-IL' },
  ZA: { timezone: 'Africa/Johannesburg', locale: 'en-ZA' },
};

export function exitGeoLocale(country: string | null | undefined): ExitGeoLocale | null {
  const code = (country ?? '').trim().toUpperCase();
  // ISO GB is sometimes written UK by proxy vendors.
  const known = COUNTRY_LOCALES[code === 'UK' ? 'GB' : code];
  return known === undefined ? null : { country: code, ...known, source: 'exit_country' };
}

/**
 * Fingerprint payload for a provider that does not localise its exit: the
 * exit-country timezone/locale replace the user's own, because the browser's
 * clock and language must match the IP, not the user.
 */
export function withExitGeoLocale<T extends { timezone: string | null }>(
  fingerprint: T | null,
  exit: ExitGeoLocale | null
): (T & { locale?: string }) | null {
  if (fingerprint === null || exit === null) return fingerprint;
  return { ...fingerprint, timezone: exit.timezone, locale: exit.locale };
}
