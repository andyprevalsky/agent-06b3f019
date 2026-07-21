// Scope the benchmark browser-credential sync to just the domains a task needs.
// An account can hold ~22k cookies plus thousands of CookieBundle, origin-
// storage, and password rows. A task that declares
// environment.live_cookie_domains (e.g. ["doordash.com"]) sets
// SEED_COOKIE_DOMAINS, and every domain-bearing browser-auth table is restricted
// to that task's domains. With no declared domains, callers retain the complete
// account-wide sync.
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

type WhereClause = Record<string, unknown>;

function domainFieldClauses(field: string, domains: string[]): WhereClause[] {
  const clauses: WhereClause[] = [];
  for (const domain of domains) {
    clauses.push({ [field]: domain });
    clauses.push({ [field]: `.${domain}` });
    clauses.push({ [field]: { endsWith: `.${domain}` } });
  }
  return clauses;
}

function originClauses(domains: string[]): WhereClause[] {
  const clauses: WhereClause[] = [];
  for (const domain of domains) {
    // Exact host and subdomain host, each with an origin terminator, port, or
    // path boundary. Requiring :// or a leading dot avoids look-alikes such as
    // evil-amazon.com.
    clauses.push({ origin: { endsWith: `://${domain}` } });
    clauses.push({ origin: { contains: `://${domain}:` } });
    clauses.push({ origin: { contains: `://${domain}/` } });
    clauses.push({ origin: { endsWith: `.${domain}` } });
    clauses.push({ origin: { contains: `.${domain}:` } });
    clauses.push({ origin: { contains: `.${domain}/` } });
  }
  return clauses;
}

function scopedWhere(userId: string, clauses: WhereClause[]): WhereClause {
  return clauses.length === 0 ? { userId } : { userId, OR: clauses };
}

// These return Prisma-compatible `where` filters. They are typed loosely so the
// benchmark-only seed helper carries no generated Prisma dependency.
export function cookieSyncWhere(userId: string, domains: string[]): Record<string, unknown> {
  return scopedWhere(userId, domainFieldClauses('domain', domains));
}

export function authRealmSyncWhere(userId: string, domains: string[]): Record<string, unknown> {
  return scopedWhere(userId, domainFieldClauses('authRealm', domains));
}

export function originSyncWhere(userId: string, domains: string[]): Record<string, unknown> {
  return scopedWhere(userId, originClauses(domains));
}

export function passkeySyncWhere(userId: string, domains: string[]): Record<string, unknown> {
  if (domains.length === 0) return { userId };
  return {
    userId,
    OR: [
      ...domainFieldClauses('rpId', domains),
      ...domainFieldClauses('authRealm', domains),
      ...originClauses(domains),
    ],
  };
}

export type BrowserAuthRowTypes = {
  cookie: unknown;
  cookieBundle: unknown;
  steelSessionAuth: unknown;
  localStorageOrigin: unknown;
  indexedDBOrigin: unknown;
  browserPermission: unknown;
  cacheStorageOrigin: unknown;
  browserPassword: unknown;
  passkeyCredential: unknown;
};

export type BrowserAuthReaders<Rows extends BrowserAuthRowTypes> = {
  [Table in keyof Rows]: (where: Record<string, unknown>) => Promise<Rows[Table][]>;
};

// Bind the selector contract to the actual read boundary. seed-local consumes
// these readers directly, while blackbox tests inject fake table readers and
// verify the exact `where` each production read receives.
export function createScopedBrowserAuthReaders<Rows extends BrowserAuthRowTypes>(
  readers: BrowserAuthReaders<Rows>,
  userId: string,
  domains: string[]
): { [Table in keyof Rows]: () => Promise<Rows[Table][]> } {
  return {
    cookie: () => readers.cookie(cookieSyncWhere(userId, domains)),
    cookieBundle: () => readers.cookieBundle(authRealmSyncWhere(userId, domains)),
    steelSessionAuth: () => readers.steelSessionAuth(authRealmSyncWhere(userId, domains)),
    localStorageOrigin: () => readers.localStorageOrigin(originSyncWhere(userId, domains)),
    indexedDBOrigin: () => readers.indexedDBOrigin(originSyncWhere(userId, domains)),
    browserPermission: () => readers.browserPermission(originSyncWhere(userId, domains)),
    cacheStorageOrigin: () => readers.cacheStorageOrigin(originSyncWhere(userId, domains)),
    browserPassword: () => readers.browserPassword(originSyncWhere(userId, domains)),
    passkeyCredential: () => readers.passkeyCredential(passkeySyncWhere(userId, domains)),
  };
}
