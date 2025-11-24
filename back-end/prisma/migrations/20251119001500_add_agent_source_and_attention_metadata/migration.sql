-- CreateEnum
CREATE TYPE "AgentSource" AS ENUM ('WEB', 'MAC_APP');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "source" "AgentSource" NOT NULL DEFAULT 'WEB';

-- AlterTable
ALTER TABLE "AgentAttentionRequest" ADD COLUMN     "metadata" JSONB;

-- Seed new tool entry if it does not exist
INSERT INTO "Tool" ("name", "description")
VALUES ('send_sms_as_user', 'Send SMS through user iMessage client (requires approval)')
ON CONFLICT ("name") DO NOTHING;




