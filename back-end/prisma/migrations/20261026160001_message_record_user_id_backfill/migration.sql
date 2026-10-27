-- Row locks only: inserts and reads continue. Rows inserted meanwhile are
-- filled by the MessageRecord_fill_user_id trigger.
UPDATE "MessageRecord" m
SET "userId" = p."userId"
FROM "Person" p
WHERE p.id = m."personId" AND m."userId" IS NULL;
