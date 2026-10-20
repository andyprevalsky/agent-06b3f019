-- WhatsApp multi-account (plan row I2): record which account's sync created a
-- contact, so deleting that account can remove the contacts only it created.
-- Message attribution reuses MessageRecord.sourceAccountId
-- (20261020210000_message_record_source_account).
-- A nullable add is metadata-only (no table rewrite); NULL keeps the meaning
-- "legacy / another source" for every existing row, including the canonical
-- seed fixture's contacts.

-- AlterTable
ALTER TABLE "Person" ADD COLUMN "createdBySource" TEXT;
