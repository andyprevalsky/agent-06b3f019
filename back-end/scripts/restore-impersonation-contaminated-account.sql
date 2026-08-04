-- Restore an account contaminated by an impersonated machine-data sync.
--
-- While an admin impersonated :victim, the mac-app uploaded the OPERATOR'S
-- machine data (cookies, browser passwords, browser state, iMessage history)
-- into :victim's account. This removes exactly the rows that hold the
-- operator's data and leaves the victim's own rows untouched.
--
-- Attribution rules (each row deleted must be provably the operator's):
--   Cookie / CookieBundle  — (browserSource, browserProfile) buckets that only
--                            the operator's machine ever wrote. The victim's own
--                            client synced Chrome with an EMPTY browserProfile,
--                            so ('chrome','') is hers and is preserved.
--   BrowserPassword        — (origin, username) pairs also present under the
--                            operator's account.
--   LocalStorage/IndexedDB/
--   CacheStorage/Permission— (origin, hash) identical to the operator's row.
--                            These tables are keyed (userId, origin) with no
--                            browser column, so an operator row REPLACED any
--                            same-origin row of the victim's. Deleting removes
--                            the operator's data; the victim's original value
--                            was already destroyed by the upsert and is only
--                            recoverable from a database backup.
--   Person / MessageRecord — contacts + messages created by the operator's
--                            iMessage sync runs, restricted to handles that are
--                            also the operator's contacts.
--
-- Usage (psql -v victim=... -v operator=... -v sync_start=...):
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
--     -v victim="'43c2f6ae-...'" -v operator="'1f85ff25-...'" \
--     -v sync_start="'2026-08-04 00:00:00'" \
--     -f scripts/restore-impersonation-contaminated-account.sql
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
FROM "Cookie" WHERE "userId" = :operator AND "browserProfile" <> ''
UNION
SELECT DISTINCT "browserSource", "browserProfile"
FROM "Cookie" c WHERE c."userId" = :operator AND c."browserSource" IN ('atlas', 'safari');

\echo '--- BEFORE ---'
SELECT 'Cookie' t, count(*) FROM "Cookie" WHERE "userId" = :victim
UNION ALL SELECT 'CookieBundle', count(*) FROM "CookieBundle" WHERE "userId" = :victim
UNION ALL SELECT 'BrowserPassword', count(*) FROM "BrowserPassword" WHERE "userId" = :victim
UNION ALL SELECT 'LocalStorageOrigin', count(*) FROM "LocalStorageOrigin" WHERE "userId" = :victim
UNION ALL SELECT 'IndexedDBOrigin', count(*) FROM "IndexedDBOrigin" WHERE "userId" = :victim
UNION ALL SELECT 'CacheStorageOrigin', count(*) FROM "CacheStorageOrigin" WHERE "userId" = :victim
UNION ALL SELECT 'BrowserPermission', count(*) FROM "BrowserPermission" WHERE "userId" = :victim
UNION ALL SELECT 'Person', count(*) FROM "Person" WHERE "userId" = :victim
ORDER BY 1;

-- 1. Cookies written from the operator's browsers.
--
-- :cookie_scope picks the attribution rule, and picking the wrong one destroys
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
WHERE c."userId" = :victim
  AND (
    (:cookie_scope = 'operator-buckets'
      AND EXISTS (SELECT 1 FROM operator_browser_buckets b
                  WHERE b.source = c."browserSource" AND b.profile = c."browserProfile"))
    OR
    (:cookie_scope = 'content-match'
      AND length(c.value) > 40
      AND EXISTS (SELECT 1 FROM "Cookie" a WHERE a."userId" = :operator
                  AND a.domain = c.domain AND a.name = c.name AND a.value = c.value))
  );

-- 2. Cookie bundles for those same browsers. Only meaningful under
--    'operator-buckets'; a bundle carries no secret of its own, and under
--    'content-match' the victim's own client owns these rows and rewrites them.
DELETE FROM "CookieBundle" cb
USING operator_browser_buckets b
WHERE :cookie_scope = 'operator-buckets'
  AND cb."userId" = :victim AND cb."browserSource" = b.source AND cb."browserProfile" = b.profile;

-- 3. Browser passwords the operator also holds.
DELETE FROM "BrowserPassword" v
WHERE v."userId" = :victim
  AND EXISTS (SELECT 1 FROM "BrowserPassword" a
              WHERE a."userId" = :operator AND a.origin = v.origin AND a.username = v.username);

-- 4-7. Browser state whose payload hash is byte-identical to the operator's.
DELETE FROM "LocalStorageOrigin" v
WHERE v."userId" = :victim
  AND EXISTS (SELECT 1 FROM "LocalStorageOrigin" a
              WHERE a."userId" = :operator AND a.origin = v.origin AND a.hash = v.hash);

DELETE FROM "IndexedDBOrigin" v
WHERE v."userId" = :victim
  AND EXISTS (SELECT 1 FROM "IndexedDBOrigin" a
              WHERE a."userId" = :operator AND a.origin = v.origin AND a.hash = v.hash);

DELETE FROM "CacheStorageOrigin" v
WHERE v."userId" = :victim
  AND EXISTS (SELECT 1 FROM "CacheStorageOrigin" a
              WHERE a."userId" = :operator AND a.origin = v.origin AND a.hash = v.hash);

DELETE FROM "BrowserPermission" v
WHERE v."userId" = :victim
  AND EXISTS (SELECT 1 FROM "BrowserPermission" a
              WHERE a."userId" = :operator AND a.origin = v.origin
                AND a.permission = v.permission AND a.setting = v.setting);

-- 8. Contacts (and their messages, via ON DELETE CASCADE) created by the
--    operator's iMessage sync. Restricted to handles the operator also has, so
--    a contact the victim independently acquired in the same window survives.
DELETE FROM "Person" p
WHERE p."userId" = :victim
  AND p."createdAt" >= :sync_start
  AND EXISTS (
    SELECT 1 FROM "Person" a WHERE a."userId" = :operator
      AND ((a."phoneNumber" = p."phoneNumber" AND p."phoneNumber" IS NOT NULL)
        OR (a.email = p.email AND p.email IS NOT NULL))
  );

\echo '--- AFTER ---'
SELECT 'Cookie' t, count(*) FROM "Cookie" WHERE "userId" = :victim
UNION ALL SELECT 'CookieBundle', count(*) FROM "CookieBundle" WHERE "userId" = :victim
UNION ALL SELECT 'BrowserPassword', count(*) FROM "BrowserPassword" WHERE "userId" = :victim
UNION ALL SELECT 'LocalStorageOrigin', count(*) FROM "LocalStorageOrigin" WHERE "userId" = :victim
UNION ALL SELECT 'IndexedDBOrigin', count(*) FROM "IndexedDBOrigin" WHERE "userId" = :victim
UNION ALL SELECT 'CacheStorageOrigin', count(*) FROM "CacheStorageOrigin" WHERE "userId" = :victim
UNION ALL SELECT 'BrowserPermission', count(*) FROM "BrowserPermission" WHERE "userId" = :victim
UNION ALL SELECT 'Person', count(*) FROM "Person" WHERE "userId" = :victim
ORDER BY 1;

-- Residual check: nothing of the operator's may remain.
\echo '--- RESIDUAL operator data in victim account (must all be 0) ---'
SELECT 'cookies_matching_operator' k, count(*)
FROM "Cookie" v JOIN "Cookie" a
  ON a."userId" = :operator AND a.domain = v.domain AND a.name = v.name AND a.value = v.value
WHERE v."userId" = :victim AND length(v.value) > 40
UNION ALL
SELECT 'passwords_matching_operator', count(*)
FROM "BrowserPassword" v JOIN "BrowserPassword" a
  ON a."userId" = :operator AND a.origin = v.origin AND a.username = v.username
WHERE v."userId" = :victim
UNION ALL
SELECT 'localstorage_matching_operator', count(*)
FROM "LocalStorageOrigin" v JOIN "LocalStorageOrigin" a
  ON a."userId" = :operator AND a.origin = v.origin AND a.hash = v.hash
WHERE v."userId" = :victim
UNION ALL
SELECT 'indexeddb_matching_operator', count(*)
FROM "IndexedDBOrigin" v JOIN "IndexedDBOrigin" a
  ON a."userId" = :operator AND a.origin = v.origin AND a.hash = v.hash
WHERE v."userId" = :victim
UNION ALL
SELECT 'cachestorage_matching_operator', count(*)
FROM "CacheStorageOrigin" v JOIN "CacheStorageOrigin" a
  ON a."userId" = :operator AND a.origin = v.origin AND a.hash = v.hash
WHERE v."userId" = :victim
UNION ALL
SELECT 'permissions_matching_operator', count(*)
FROM "BrowserPermission" v JOIN "BrowserPermission" a
  ON a."userId" = :operator AND a.origin = v.origin
     AND a.permission = v.permission AND a.setting = v.setting
WHERE v."userId" = :victim
UNION ALL
-- Bundles carry no secret value, but under 'content-match' the delete above is a
-- deliberate no-op, so report what remains rather than implying zero.
SELECT 'cookiebundles_in_operator_buckets', count(*)
FROM "CookieBundle" cb JOIN operator_browser_buckets b
  ON cb."browserSource" = b.source AND cb."browserProfile" = b.profile
WHERE cb."userId" = :victim
UNION ALL
SELECT 'contacts_shared_with_operator', count(*)
FROM "Person" p WHERE p."userId" = :victim AND EXISTS (
  SELECT 1 FROM "Person" a WHERE a."userId" = :operator
    AND ((a."phoneNumber" = p."phoneNumber" AND p."phoneNumber" IS NOT NULL)
      OR (a.email = p.email AND p.email IS NOT NULL)));

COMMIT;
