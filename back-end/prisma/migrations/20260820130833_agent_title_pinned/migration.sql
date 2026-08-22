-- Sidebar rename + pin support.
--   title    : short generated label, overridable by the user's rename.
--   pinnedAt : non-null pins the agent to the top of the sidebar list.
--
-- IF NOT EXISTS keeps this replayable against an environment where a stray
-- `prisma db push` already conjured the columns (see the 2026-06-27
-- fastModeCacheEnabled incident, where a plain ADD COLUMN would have failed).
-- AlterTable
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "title" TEXT;
