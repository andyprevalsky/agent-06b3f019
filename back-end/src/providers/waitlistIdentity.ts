/**
 * Canonical waitlist contact identity: normalization, fixture classification,
 * and the one definition of "a real waitlist person".
 *
 * Lives in providers/ because both domains/waitlist (import/backfill) and
 * domains/admin-health (list, invite, signup metric) need the same predicate,
 * and cross-domain imports are banned.
 *
 * A row counts when it has an email OR a phone and is not one of our own test
 * fixtures. Phone-bearing is deliberately NOT part of the definition: the admin
 * surfaces used `phone IS NOT NULL` as a stand-in for "not fixture junk", which
 * silently hid every email-only signup — including everyone who arrives through
 * the public landing form, which collects no phone at all.
 */

import { Prisma } from '@prisma/client';

/**
 * Domains our own suites mint contacts under. These are NOT reserved by RFC
 * 2606/6761 — they are `.dev` names this repo's fixtures chose — so no generic
 * rule catches them and each must be listed explicitly.
 */
export const WAITLIST_FIXTURE_EMAIL_DOMAINS = ['blackbox-test.dev', 'contract-test.dev'] as const;

/**
 * Individual harness accounts that live on a real domain, so no domain rule can
 * catch them. The chat-lifecycle ratchet mints its Supabase user under our own
 * roselabs.ai (scripts/generate-test-session.ts), and the contact backfill then
 * copies it into Waitlist — where it reads as a real email-only signup.
 * roselabs.ai itself must stay allowed: real teammates do sign up.
 */
export const WAITLIST_FIXTURE_EMAIL_ADDRESSES = ['chat-lifecycle-ratchet@roselabs.ai'] as const;

/** RFC-reserved domains that can never belong to a real person. */
export const WAITLIST_RESERVED_EMAIL_DOMAINS = [
  'example.com',
  'example.net',
  'example.org',
  'example.test',
] as const;

/** Prefixes of the reserved ranges our fixtures dial. */
export const WAITLIST_FIXTURE_PHONE_PREFIXES = ['+1555', '+1999'] as const;

const RESERVED_NAME_PATTERN =
  /^(?:test|test[-_ ].*|blackbox|blackbox[-_ ].*|benchmark|benchmark[-_ ].*|smoke|smoke[-_ ].*|coverage|coverage[-_ ].*)$/;

export interface WaitlistContactIdentity {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export function normalizeWaitlistEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized === '' ? null : normalized;
}

export function normalizeWaitlistPhone(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits === '' ? null : `+${digits}`;
}

export function isWaitlistTestContact(input: WaitlistContactIdentity): boolean {
  const name = input.name?.trim().toLowerCase() ?? '';
  const email = normalizeWaitlistEmail(input.email);
  const phone = normalizeWaitlistPhone(input.phone);
  const domain = email?.split('@').at(-1) ?? '';

  const reservedName = RESERVED_NAME_PATTERN.test(name);
  const reservedDomain =
    (WAITLIST_RESERVED_EMAIL_DOMAINS as readonly string[]).includes(domain) ||
    domain.endsWith('.test') ||
    domain === 'invalid' ||
    domain.endsWith('.invalid');
  const fixtureDomain = (WAITLIST_FIXTURE_EMAIL_DOMAINS as readonly string[]).includes(domain);
  const fixtureAddress =
    email !== null && (WAITLIST_FIXTURE_EMAIL_ADDRESSES as readonly string[]).includes(email);
  const fixturePhone =
    phone !== null && WAITLIST_FIXTURE_PHONE_PREFIXES.some((prefix) => phone.startsWith(prefix));

  return reservedName || reservedDomain || fixtureDomain || fixtureAddress || fixturePhone;
}

/** Has a usable contact identifier and is not one of our fixtures. */
export function isRealWaitlistPerson(input: WaitlistContactIdentity): boolean {
  if (isWaitlistTestContact(input)) return false;
  return (
    normalizeWaitlistEmail(input.email) !== null || normalizeWaitlistPhone(input.phone) !== null
  );
}

/** SQL-side twin of isRealWaitlistPerson, for queries that page/count in the DB. */
export function realWaitlistPersonSql(alias = ''): Prisma.Sql {
  const prefix = alias === '' ? Prisma.empty : Prisma.raw(`"${alias}".`);
  const fixtureDomains = Prisma.join(
    [...WAITLIST_FIXTURE_EMAIL_DOMAINS, ...WAITLIST_RESERVED_EMAIL_DOMAINS].map(
      (domain) => Prisma.sql`${domain}`
    )
  );
  const fixturePhones = Prisma.join(
    WAITLIST_FIXTURE_PHONE_PREFIXES.map((prefix) => Prisma.sql`${prefix + '%'}`)
  );
  const fixtureAddresses = Prisma.join(
    WAITLIST_FIXTURE_EMAIL_ADDRESSES.map((address) => Prisma.sql`${address}`)
  );

  return Prisma.sql`(
    (
      NULLIF(btrim(COALESCE(${prefix}"email", '')), '') IS NOT NULL
      OR NULLIF(regexp_replace(COALESCE(${prefix}"phone", ''), '[^0-9]', '', 'g'), '') IS NOT NULL
    )
    AND lower(split_part(COALESCE(${prefix}"email", ''), '@', 2)) NOT IN (${fixtureDomains})
    AND lower(btrim(COALESCE(${prefix}"email", ''))) NOT IN (${fixtureAddresses})
    AND lower(COALESCE(${prefix}"email", '')) NOT LIKE '%.test'
    AND lower(COALESCE(${prefix}"email", '')) NOT LIKE '%.invalid'
    AND lower(COALESCE(${prefix}"email", '')) NOT LIKE '%@invalid'
    AND lower(btrim(COALESCE(${prefix}"name", ''))) !~ ${RESERVED_NAME_PATTERN.source}
    AND '+' || regexp_replace(COALESCE(${prefix}"phone", ''), '[^0-9]', '', 'g') NOT LIKE ALL (ARRAY[${fixturePhones}])
  )`;
}
