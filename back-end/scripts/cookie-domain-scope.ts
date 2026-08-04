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

export type DomainFieldMatch = {
  mode: 'equals' | 'endsWith';
  value: string;
};

/**
 * The single description of "this host-shaped column belongs to this domain".
 *
 * Both the Prisma read path and the SQL COPY-stream read path are derived from
 * this list, so the two can never drift apart on the suffix-safety rule: the
 * REQUIRED leading dot on the endsWith clause is what stops "evil-doordash.com"
 * from being pulled into a "doordash.com" benchmark fixture.
 */
export function domainFieldMatches(domains: string[]): DomainFieldMatch[] {
  const matches: DomainFieldMatch[] = [];
  for (const domain of domains) {
    matches.push({ mode: 'equals', value: domain });
    matches.push({ mode: 'equals', value: `.${domain}` });
    matches.push({ mode: 'endsWith', value: `.${domain}` });
  }
  return matches;
}

function domainFieldClauses(field: string, domains: string[]): WhereClause[] {
  return domainFieldMatches(domains).map(({ mode, value }) =>
    mode === 'equals' ? { [field]: value } : { [field]: { endsWith: value } }
  );
}

export type OriginDomainMatch = {
  mode: 'endsWith' | 'contains';
  value: string;
};

export function originDomainMatches(domains: string[]): OriginDomainMatch[] {
  const matches: OriginDomainMatch[] = [];
  for (const domain of domains) {
    // Exact host and subdomain host, each with an origin terminator, port, or
    // path boundary. Requiring :// or a leading dot avoids look-alikes such as
    // evil-amazon.com.
    matches.push({ mode: 'endsWith', value: `://${domain}` });
    matches.push({ mode: 'contains', value: `://${domain}:` });
    matches.push({ mode: 'contains', value: `://${domain}/` });
    matches.push({ mode: 'endsWith', value: `.${domain}` });
    matches.push({ mode: 'contains', value: `.${domain}:` });
    matches.push({ mode: 'contains', value: `.${domain}/` });
  }
  return matches;
}

function originClauses(domains: string[]): WhereClause[] {
  return originDomainMatches(domains).map(({ mode, value }) => ({
    origin: { [mode]: value },
  }));
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

/**
 * A page of a scoped read. Browser-auth tables carry multi-MB encrypted JSON
 * blobs (LocalStorageOrigin.entries, IndexedDBOrigin.databases), so the read
 * boundary is paged: materializing a whole table costs gigabytes of V8 heap
 * once the JSON is parsed into objects, which OOM-kills every memory-bounded
 * bench guest. `undefined` means "read everything" for the small tables.
 */
export type BrowserAuthPage = { skip: number; take: number };

// The bounded default for any PAGED cookie read through these selectors.
//
// This is deliberately small. It used to be inflated to 500 to buy back
// production round trips, because the seed pulled a ~22k-cookie account through
// Prisma page by page: 25 rows per page cost ~880 round trips (too slow for the
// deploy stack's 120s readiness contract) while 500 rows per page pushed peak
// RSS past the seed ratchet. That tradeoff no longer exists — seed-local streams
// the Cookie table Postgres-to-Postgres with COPY (see seed-jsonb-stream.ts), so
// the seed pays ONE round trip and holds no rows in the V8 heap. Page size is
// once again purely a residency bound for callers that page.
export const DEFAULT_COOKIE_PAGE_SIZE = 50;

export type BrowserAuthReaders<Rows extends BrowserAuthRowTypes> = {
  [Table in keyof Rows]: (
    where: Record<string, unknown>,
    page?: BrowserAuthPage
  ) => Promise<Rows[Table][]>;
};

// Bind the selector contract to the actual read boundary. seed-local consumes
// these readers directly, while blackbox tests inject fake table readers and
// verify the exact `where` each production read receives.
export function createScopedBrowserAuthReaders<Rows extends BrowserAuthRowTypes>(
  readers: BrowserAuthReaders<Rows>,
  userId: string,
  domains: string[]
): {
  [Table in keyof Rows]: (page?: BrowserAuthPage) => Promise<Rows[Table][]>;
} {
  return {
    cookie: (page) => readers.cookie(cookieSyncWhere(userId, domains), page),
    cookieBundle: (page) => readers.cookieBundle(authRealmSyncWhere(userId, domains), page),
    steelSessionAuth: (page) => readers.steelSessionAuth(authRealmSyncWhere(userId, domains), page),
    localStorageOrigin: (page) =>
      readers.localStorageOrigin(originSyncWhere(userId, domains), page),
    indexedDBOrigin: (page) => readers.indexedDBOrigin(originSyncWhere(userId, domains), page),
    browserPermission: (page) => readers.browserPermission(originSyncWhere(userId, domains), page),
    cacheStorageOrigin: (page) =>
      readers.cacheStorageOrigin(originSyncWhere(userId, domains), page),
    browserPassword: (page) => readers.browserPassword(originSyncWhere(userId, domains), page),
    passkeyCredential: (page) => readers.passkeyCredential(passkeySyncWhere(userId, domains), page),
  };
}
