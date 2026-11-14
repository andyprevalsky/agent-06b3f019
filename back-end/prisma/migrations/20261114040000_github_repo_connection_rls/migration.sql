-- GithubRepoConnection (20261112120000_github_repo_connections) was created
-- without row-level security. `anon` and `authenticated` hold SELECT on every
-- public table and the Data API exposes `public`, so RLS is the only barrier.
-- Backend-only table: RLS on with no policy denies Data API access; the backend
-- connects as a BYPASSRLS role, so no application path changes.
--
-- Idempotent: production was already repaired with this exact statement on
-- 2026-11-14 after the post-deploy drift check reported the exposure.
-- ENABLE ROW LEVEL SECURITY takes an ACCESS EXCLUSIVE lock even when RLS is
-- already on; bound the wait so a long transaction fails this migration fast
-- instead of queueing every reader behind it. migrate deploy runs this file
-- outside a transaction, so the limit is set for the session and reset.
SET lock_timeout = '15s';
ALTER TABLE IF EXISTS public."GithubRepoConnection" ENABLE ROW LEVEL SECURITY;
RESET lock_timeout;
