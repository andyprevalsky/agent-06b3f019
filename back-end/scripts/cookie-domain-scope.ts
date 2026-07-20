// Scope the benchmark browser-credential cookie sync to just the domains a task
// needs. The dominant cost of `seed-local.ts --credentials-only` is the cookie
// graph (an account can hold ~22k cookies → ~13 min, > the sync budget). A task
// that declares environment.live_cookie_domains (e.g. ["doordash.com"]) sets
// SEED_COOKIE_DOMAINS, and the sync then reads only that domain's cookies (~100
// rows, seconds) via the (userId, domain) index.
//
// Matching is deliberately suffix-safe: for a target "doordash.com" we match the
// host-only cookie ("doordash.com"), the domain cookie (".doordash.com"), and any
// subdomain ("www.doordash.com" → endsWith ".doordash.com"). The REQUIRED leading
// dot on the subdomain clause stops "evil-doordash.com" from matching.

export function parseCookieDomains(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

// Returns a Prisma Cookie `where` filter. Typed loosely on purpose so this helper
// carries no Prisma import; the caller passes it straight to findMany/count.
export function cookieSyncWhere(userId: string, domains: string[]): Record<string, unknown> {
  if (domains.length === 0) return { userId };
  const or: Record<string, unknown>[] = [];
  for (const domain of domains) {
    or.push({ domain });
    or.push({ domain: `.${domain}` });
    or.push({ domain: { endsWith: `.${domain}` } });
  }
  return { userId, OR: or };
}
