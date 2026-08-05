-- Restore an account contaminated by an impersonated machine-data sync.
--
-- While an admin impersonated :'victim', the mac-app uploaded the OPERATOR'S
-- machine data (cookies, browser passwords, browser state, iMessage history)
-- into :victim's account. This removes exactly the rows that hold the
-- operator's data and leaves the victim's own rows untouched.
--
-- Attribution rules. Every row deleted must be provably the OPERATOR'S. Overlap
-- with the operator's account is never sufficient on its own — two people can
-- legitimately share a site, a login, a contact, or a default-initialised store
-- — so each rule pairs a content/bucket match with incident-window provenance:
--   Cookie / CookieBundle  — (browserSource, browserProfile) buckets that only
--                            the operator's machine ever wrote, or (under
--                            'content-match') a byte-identical cookie value.
--   BrowserPassword        — (origin, username) present under the operator AND
--                            syncedAt inside the window. The ciphertext is keyed
--                            per user, so it cannot distinguish the two.
--   LocalStorage/IndexedDB/
--   CacheStorage/Permission— payload hash identical to the operator's AND
--                            written inside the window. These tables are keyed
--                            (userId, origin) with no browser column, so an
--                            operator row REPLACED any same-origin row of the
--                            victim's; the victim's original value was already
--                            destroyed by that upsert and is recoverable only
--                            from the backup.
--   Person / MessageRecord — contacts created inside the window, sharing a
--                            handle with the operator, carrying messages, and
--                            carrying NO message older than the window. Person
--                            cascades to MessageRecord, so a false positive
--                            destroys real conversation history — the
--                            no-older-history test is what prevents that.
--
-- ALWAYS dry-run first and review the counts:
--   sed 's/^COMMIT;$/ROLLBACK;/' <this file> > /tmp/dry.sql   # then -f /tmp/dry.sql
--
-- Usage (psql -v victim=... -v operator=... -v sync_start=...):
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--     -v victim=43c2f6ae-... -v operator=1f85ff25-... \
--     -v sync_start='2026-08-04 00:00:00' -v cookie_scope=operator-buckets \
--     -f scripts/restore-impersonation-contaminated-account.sql
--
-- Values are passed BARE: every use below is psql's quoted substitution
-- (:'victim'), which emits a properly escaped literal. Never switch these to
-- the raw :victim form — that pastes the value straight into the predicate and
-- a stray quote becomes SQL injection against production.
--
-- Runs in a single transaction and prints before/after counts. Take a backup
-- first: scripts/backup-impersonation-contaminated-account.sh

\set ON_ERROR_STOP on
SET statement_timeout = '900s';

BEGIN;

-- The (browserSource, browserProfile) buckets written by the operator's machine.
CREATE TEMP TABLE operator_browser_buckets(source text, profile text) ON COMMIT DROP;
INSERT INTO operator_browser_buckets
SELECT DISTINCT "browserSource", "browserProfile"
FROM "Cookie" WHERE "userId" = :'operator' AND "browserProfile" <> ''
UNION
SELECT DISTINCT "browserSource", "browserProfile"
FROM "Cookie" c WHERE c."userId" = :'operator' AND c."browserSource" IN ('atlas', 'safari');

\echo '--- BEFORE ---'
SELECT 'Cookie' t, count(*) FROM "Cookie" WHERE "userId" = :'victim'
UNION ALL SELECT 'CookieBundle', count(*) FROM "CookieBundle" WHERE "userId" = :'victim'
UNION ALL SELECT 'BrowserPassword', count(*) FROM "BrowserPassword" WHERE "userId" = :'victim'
UNION ALL SELECT 'LocalStorageOrigin', count(*) FROM "LocalStorageOrigin" WHERE "userId" = :'victim'
UNION ALL SELECT 'IndexedDBOrigin', count(*) FROM "IndexedDBOrigin" WHERE "userId" = :'victim'
UNION ALL SELECT 'CacheStorageOrigin', count(*) FROM "CacheStorageOrigin" WHERE "userId" = :'victim'
UNION ALL SELECT 'BrowserPermission', count(*) FROM "BrowserPermission" WHERE "userId" = :'victim'
UNION ALL SELECT 'Person', count(*) FROM "Person" WHERE "userId" = :'victim'
ORDER BY 1;

-- 1. Cookies written from the operator's browsers.
--
-- :'cookie_scope' picks the attribution rule, and picking the wrong one destroys
-- the victim's data:
--   'operator-buckets' — the victim's own client never wrote these
--                        (browserSource, browserProfile) buckets, so the whole
--                        bucket is the operator's. Verify this per account
--                        before using it.
--   'content-match'    — the victim's client writes the SAME buckets (e.g. they
--                        also run Chrome with named profiles), so only rows whose
--                        secret value is byte-identical to the operator's may be
--                        removed. Strictly narrower and always safe.
DELETE FROM "Cookie" c
WHERE c."userId" = :'victim'
  AND (
    (:'cookie_scope' = 'operator-buckets'
      AND EXISTS (SELECT 1 FROM operator_browser_buckets b
                  WHERE b.source = c."browserSource" AND b.profile = c."browserProfile"))
    OR
    (:'cookie_scope' = 'content-match'
      AND length(c.value) > 40
      AND EXISTS (SELECT 1 FROM "Cookie" a WHERE a."userId" = :'operator'
                  AND a.domain = c.domain AND a.name = c.name AND a.value = c.value))
  );

-- 2. Cookie bundles for those same browsers. Only meaningful under
--    'operator-buckets'; a bundle carries no secret of its own, and under
--    'content-match' the victim's own client owns these rows and rewrites them.
DELETE FROM "CookieBundle" cb
USING operator_browser_buckets b
WHERE :'cookie_scope' = 'operator-buckets'
  AND cb."userId" = :'victim' AND cb."browserSource" = b.source AND cb."browserProfile" = b.profile;

-- 3. Browser passwords written INTO the victim by the operator's sync.
--
-- A shared (origin, username) is NOT by itself proof of contamination: the
-- victim can legitimately hold a credential for the same site and login, and
-- deleting it would destroy their own data (the ciphertext differs per user, so
-- it cannot be used to tell the two apart). Provenance comes from the incident
-- window instead — `syncedAt` is @updatedAt, so a row the operator's sync wrote
-- necessarily carries a timestamp at or after sync_start, while the victim's
-- own untouched rows keep their earlier sync time.
DELETE FROM "BrowserPassword" v
WHERE v."userId" = :'victim'
  AND v."syncedAt" >= :'sync_start'::timestamp
  AND EXISTS (SELECT 1 FROM "BrowserPassword" a
              WHERE a."userId" = :'operator' AND a.origin = v.origin AND a.username = v.username);

-- 4-7. Browser state the operator's sync wrote.
--
-- Byte-identical payload hash AND written inside the incident window. The hash
-- alone is weaker than it looks: two users can hold genuinely identical state
-- for the same origin (an empty or default-initialised store hashes the same
-- for everybody), so the window is what separates "the operator's sync put this
-- here" from "the victim happens to have the same bytes".
DELETE FROM "LocalStorageOrigin" v
WHERE v."userId" = :'victim'
  AND v."updatedAt" >= :'sync_start'::timestamp
  AND EXISTS (SELECT 1 FROM "LocalStorageOrigin" a
              WHERE a."userId" = :'operator' AND a.origin = v.origin AND a.hash = v.hash);

DELETE FROM "IndexedDBOrigin" v
WHERE v."userId" = :'victim'
  AND v."updatedAt" >= :'sync_start'::timestamp
  AND EXISTS (SELECT 1 FROM "IndexedDBOrigin" a
              WHERE a."userId" = :'operator' AND a.origin = v.origin AND a.hash = v.hash);

DELETE FROM "CacheStorageOrigin" v
WHERE v."userId" = :'victim'
  AND v."updatedAt" >= :'sync_start'::timestamp
  AND EXISTS (SELECT 1 FROM "CacheStorageOrigin" a
              WHERE a."userId" = :'operator' AND a.origin = v.origin AND a.hash = v.hash);

DELETE FROM "BrowserPermission" v
WHERE v."userId" = :'victim'
  AND v."syncedAt" >= :'sync_start'::timestamp
  AND EXISTS (SELECT 1 FROM "BrowserPermission" a
              WHERE a."userId" = :'operator' AND a.origin = v.origin
                AND a.permission = v.permission AND a.setting = v.setting);

-- 8. Contacts created wholly by the operator's iMessage sync.
--
-- Person deletion cascades to MessageRecord, so a false positive destroys the
-- victim's real conversation history and is unrecoverable outside the backup.
-- A shared handle plus a timestamp inside the window is NOT enough: the victim
-- could independently acquire the same contact during the incident.
--
-- Every condition below must hold:
--   a) the contact appeared during the incident window;
--   b) the operator has the same handle (it came off THEIR device);
--   c) the contact has no message older than the window — a contact the victim
--      really talks to carries history that predates the operator's sync, and
--      that history is exactly what a cascade would destroy;
--   d) the contact carries at least one message, and every one of them landed
--      in the window (an operator sync always brings messages with it).
DELETE FROM "Person" p
WHERE p."userId" = :'victim'
  AND p."createdAt" >= :'sync_start'::timestamp
  AND EXISTS (
    SELECT 1 FROM "Person" a WHERE a."userId" = :'operator'
      AND ((a."phoneNumber" = p."phoneNumber" AND p."phoneNumber" IS NOT NULL)
        OR (a.email = p.email AND p.email IS NOT NULL))
  )
  AND NOT EXISTS (
    SELECT 1 FROM "MessageRecord" m
    WHERE m."personId" = p.id AND m."createdAt" < :'sync_start'::timestamp
  )
  AND EXISTS (SELECT 1 FROM "MessageRecord" m WHERE m."personId" = p.id);

\echo '--- AFTER ---'
SELECT 'Cookie' t, count(*) FROM "Cookie" WHERE "userId" = :'victim'
UNION ALL SELECT 'CookieBundle', count(*) FROM "CookieBundle" WHERE "userId" = :'victim'
UNION ALL SELECT 'BrowserPassword', count(*) FROM "BrowserPassword" WHERE "userId" = :'victim'
UNION ALL SELECT 'LocalStorageOrigin', count(*) FROM "LocalStorageOrigin" WHERE "userId" = :'victim'
UNION ALL SELECT 'IndexedDBOrigin', count(*) FROM "IndexedDBOrigin" WHERE "userId" = :'victim'
UNION ALL SELECT 'CacheStorageOrigin', count(*) FROM "CacheStorageOrigin" WHERE "userId" = :'victim'
UNION ALL SELECT 'BrowserPermission', count(*) FROM "BrowserPermission" WHERE "userId" = :'victim'
UNION ALL SELECT 'Person', count(*) FROM "Person" WHERE "userId" = :'victim'
ORDER BY 1;

-- Residual check: no row the operator's sync WROTE may remain.
--
-- Scoped to the incident window for the same reason the deletes are: a victim
-- credential that merely shares an (origin, username) with the operator is
-- theirs, and counting it here would report a phantom residue and push an
-- operator toward deleting legitimate data to "clean up".
\echo '--- RESIDUAL operator-written data in victim account (must all be 0) ---'
SELECT 'cookies_matching_operator' k, count(*)
FROM "Cookie" v JOIN "Cookie" a
  ON a."userId" = :'operator' AND a.domain = v.domain AND a.name = v.name AND a.value = v.value
WHERE v."userId" = :'victim' AND length(v.value) > 40
UNION ALL
SELECT 'passwords_matching_operator', count(*)
FROM "BrowserPassword" v JOIN "BrowserPassword" a
  ON a."userId" = :'operator' AND a.origin = v.origin AND a.username = v.username
WHERE v."userId" = :'victim' AND v."syncedAt" >= :'sync_start'::timestamp
UNION ALL
SELECT 'localstorage_matching_operator', count(*)
FROM "LocalStorageOrigin" v JOIN "LocalStorageOrigin" a
  ON a."userId" = :'operator' AND a.origin = v.origin AND a.hash = v.hash
WHERE v."userId" = :'victim'
UNION ALL
SELECT 'indexeddb_matching_operator', count(*)
FROM "IndexedDBOrigin" v JOIN "IndexedDBOrigin" a
  ON a."userId" = :'operator' AND a.origin = v.origin AND a.hash = v.hash
WHERE v."userId" = :'victim'
UNION ALL
SELECT 'cachestorage_matching_operator', count(*)
FROM "CacheStorageOrigin" v JOIN "CacheStorageOrigin" a
  ON a."userId" = :'operator' AND a.origin = v.origin AND a.hash = v.hash
WHERE v."userId" = :'victim'
UNION ALL
SELECT 'permissions_matching_operator', count(*)
FROM "BrowserPermission" v JOIN "BrowserPermission" a
  ON a."userId" = :'operator' AND a.origin = v.origin
     AND a.permission = v.permission AND a.setting = v.setting
WHERE v."userId" = :'victim'
UNION ALL
-- Bundles carry no secret value, but under 'content-match' the delete above is a
-- deliberate no-op, so report what remains rather than implying zero.
SELECT 'cookiebundles_in_operator_buckets', count(*)
FROM "CookieBundle" cb JOIN operator_browser_buckets b
  ON cb."browserSource" = b.source AND cb."browserProfile" = b.profile
WHERE cb."userId" = :'victim'
UNION ALL
-- Only contacts still matching the FULL deletion rule count as residue. A
-- mutual contact, or one the victim owned before the incident, is legitimately
-- theirs and must not be reported as something left to clean up.
SELECT 'contacts_written_by_operator_sync', count(*)
FROM "Person" p
WHERE p."userId" = :'victim'
  AND p."createdAt" >= :'sync_start'::timestamp
  AND EXISTS (
    SELECT 1 FROM "Person" a WHERE a."userId" = :'operator'
      AND ((a."phoneNumber" = p."phoneNumber" AND p."phoneNumber" IS NOT NULL)
        OR (a.email = p.email AND p.email IS NOT NULL)))
  AND NOT EXISTS (
    SELECT 1 FROM "MessageRecord" m
    WHERE m."personId" = p.id AND m."createdAt" < :'sync_start'::timestamp)
  AND EXISTS (SELECT 1 FROM "MessageRecord" m WHERE m."personId" = p.id);

COMMIT;
