-- Additive ordering; existing projects retain their current alphabetical folder order.
-- Bound lock acquisition and the backfill; abort/rollback rather than stall deployment.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "ProjectFolder" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
UPDATE "ProjectFolder" AS folder SET "sortOrder" = ranked.position
FROM (
  SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "name", "id") - 1)::INTEGER AS position
  FROM "ProjectFolder"
) AS ranked WHERE folder."id" = ranked."id";
COMMIT;
