-- Steel creates a persistent profile lazily on the first browser session.
-- Before that happens BrowserContext.contextId is legitimately unknown, so do
-- not store the empty-string sentinel in a required unique column.
ALTER TABLE "BrowserContext" ALTER COLUMN "contextId" DROP NOT NULL;

UPDATE "BrowserContext"
SET "contextId" = NULL
WHERE "contextId" = '';
