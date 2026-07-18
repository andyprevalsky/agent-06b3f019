-- Optional email captured at login (phone + OTP flow). Nullable: email is
-- optional, existing rows keep NULL, and the login never fails on a missing or
-- malformed email. Backfilled only when a user has no email yet (never clobbered).
ALTER TABLE "User" ADD COLUMN "email" TEXT;
