-- A saved login is unique per browser source and profile, so the same
-- site+username saved in Chrome and Safari (or two Chrome profiles) keeps one
-- row each instead of the last upload overwriting the other source's row.
-- Safe on existing data: rows unique on (userId, origin, username) are unique
-- on any superset of those columns, and both added columns are NOT NULL.
-- Both statements run in one migration transaction, so the table is never
-- without a unique key for the upsert conflict target.

-- DropIndex
DROP INDEX "BrowserPassword_userId_origin_username_key";

-- CreateIndex
CREATE UNIQUE INDEX "BrowserPassword_userId_origin_username_browserSource_browse_key" ON "BrowserPassword"("userId", "origin", "username", "browserSource", "browserProfile");
