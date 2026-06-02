ALTER TABLE "UserAuthAssistanceRequest"
  ADD COLUMN IF NOT EXISTS "browserSessionId" TEXT;

CREATE INDEX IF NOT EXISTS "UserAuthAssistanceRequest_browserSessionId_idx"
  ON "UserAuthAssistanceRequest"("browserSessionId");
