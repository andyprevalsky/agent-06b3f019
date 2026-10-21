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
import { COUNTRY_ZONES } from './exitGeoZones';

export interface ExitGeoLocale {
  country: string;
  timezone: string;
  locale: string;
  /** user_fingerprint: the user's own zone lies in the exit country and is kept. */
  source: 'exit_country' | 'user_fingerprint';
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

type GeoFingerprint = {
  timezone: string | null;
  userAgentOverride?: { acceptLanguage?: string };
};

/** Whether an IANA zone belongs to a supported exit country (aliases included). */
export function zoneInCountry(timezone: string, country: string): boolean {
  const code = country.trim().toUpperCase();
  return COUNTRY_ZONES[code === 'UK' ? 'GB' : code]?.includes(timezone) === true;
}

/**
 * Timezone/locale for a provider that does not localise its exit (Tilion).
 *
 * Page dates must follow the USER's timezone (RCA
 * 2026-08-05-fingerprint-timezone-format-spoof-uses-host-tz), so a user zone
 * inside the exit country is kept: a California user exiting in the US stays
 * America/Los_Angeles. The exit country's default applies only when the user
 * has no fingerprint zone or it lies in another country. An unknown exit
 * country never overrides the user.
 */
export function resolveExitGeoLocale<T extends GeoFingerprint>(
  fingerprint: T | null,
  exitCountry: string | null | undefined
): { fingerprint: (T & { locale?: string }) | null; exitGeoLocale: ExitGeoLocale | null } {
  const exit = exitGeoLocale(exitCountry);
  const userZone = fingerprint?.timezone ?? null;
  const userLocale = fingerprint?.userAgentOverride?.acceptLanguage?.split(',')[0]?.trim();
  if (userZone !== null && (exit === null || zoneInCountry(userZone, exit.country))) {
    const code = (exitCountry ?? '').trim().toUpperCase();
    return {
      fingerprint,
      exitGeoLocale: {
        country: exit?.country ?? code,
        timezone: userZone,
        locale:
          userLocale !== undefined && userLocale !== '' ? userLocale : (exit?.locale ?? 'en-US'),
        source: 'user_fingerprint',
      },
    };
  }
  if (exit === null) return { fingerprint, exitGeoLocale: null };
  return {
    fingerprint:
      fingerprint === null
        ? null
        : { ...fingerprint, timezone: exit.timezone, locale: exit.locale },
    exitGeoLocale: exit,
  };
}
