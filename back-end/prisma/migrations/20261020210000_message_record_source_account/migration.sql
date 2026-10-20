-- Telegram multi-account (plan row I8): attribute synced messages to the
-- provider-side account that synced them, for account-scoped deletion.
-- Nullable with no default, so adding it is a metadata-only change; existing
-- rows stay NULL (= the legacy/default account).

-- AlterTable
ALTER TABLE "MessageRecord" ADD COLUMN     "sourceAccountId" TEXT;
