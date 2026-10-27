-- `migrate deploy` applies every pending migration on one session. Production's
-- pooled session defaults to a 120s statement_timeout, and the Message trigram
-- build that follows took 177s on 2026-10-07. CREATE INDEX CONCURRENTLY must be
-- a migration's only statement, so lift the limit in this preceding migration;
-- it lasts only for this deploy's migration session.
SET statement_timeout = 0
