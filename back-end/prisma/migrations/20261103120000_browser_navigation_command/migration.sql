BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "BrowserSession" ADD COLUMN "navigationCommand" JSONB;
COMMIT;
