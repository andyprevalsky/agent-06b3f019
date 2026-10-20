-- WhatsApp multi-account (plan row I2): attribute synced rows to the linked
-- account so one account can be deleted without touching the others.
-- Nullable adds are metadata-only (no table rewrite); NULL keeps the meaning
-- "legacy single account / other source" for every existing row, including the
-- reviewed WhatsApp history in the canonical seed fixture.

-- AlterTable
ALTER TABLE "MessageRecord" ADD COLUMN "sourceAccountId" TEXT;

-- AlterTable
ALTER TABLE "Person" ADD COLUMN "createdBySource" TEXT;
