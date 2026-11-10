ALTER TABLE "ClaudeCodeSession" ADD COLUMN "closeResult" JSONB;
ALTER TABLE "CodeSession" ADD COLUMN "closingTaskId" TEXT, ADD COLUMN "closingEpoch" TEXT;
