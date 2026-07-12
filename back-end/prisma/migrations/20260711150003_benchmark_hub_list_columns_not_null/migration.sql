-- Prisma models declare these scalar lists as required (String[]), but the
-- guarded CREATEs in 20260710161315 left them nullable on tables that already
-- existed from `db push`. Backfill NULLs and enforce NOT NULL so SQL matches
-- the client contract (HubRunRequest consumers iterate these unconditionally).
UPDATE "BenchmarkTask" SET "tags" = ARRAY[]::TEXT[] WHERE "tags" IS NULL;
UPDATE "BenchmarkTask" SET "expectedTools" = ARRAY[]::TEXT[] WHERE "expectedTools" IS NULL;
UPDATE "BenchmarkRunRequest" SET "taskNames" = ARRAY[]::TEXT[] WHERE "taskNames" IS NULL;
UPDATE "BenchmarkRunRequest" SET "simOn" = ARRAY[]::TEXT[] WHERE "simOn" IS NULL;

ALTER TABLE "BenchmarkTask" ALTER COLUMN "tags" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BenchmarkTask" ALTER COLUMN "tags" SET NOT NULL;
ALTER TABLE "BenchmarkTask" ALTER COLUMN "expectedTools" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BenchmarkTask" ALTER COLUMN "expectedTools" SET NOT NULL;
ALTER TABLE "BenchmarkRunRequest" ALTER COLUMN "taskNames" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BenchmarkRunRequest" ALTER COLUMN "taskNames" SET NOT NULL;
ALTER TABLE "BenchmarkRunRequest" ALTER COLUMN "simOn" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BenchmarkRunRequest" ALTER COLUMN "simOn" SET NOT NULL;
