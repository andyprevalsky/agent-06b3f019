-- Waitlist: support phone-based entries (gated logins) alongside email entries
ALTER TABLE "Waitlist" ADD COLUMN     "phone" TEXT,
ALTER COLUMN "name" SET DEFAULT '',
ALTER COLUMN "email" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Waitlist_phone_key" ON "Waitlist"("phone");

-- Every waitlist entry must be reachable: email (public form) or phone (gated login).
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_contact_present"
  CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL);

-- Grandfather every existing user past the invite gate (waitlist launch).
-- 181818 is MASTER_INVITE_CODE (back-end/src/domains/invite-codes/config.ts).
UPDATE "User" SET "usedInviteCode" = 181818 WHERE "usedInviteCode" IS NULL;
