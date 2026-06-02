CREATE TABLE "AgentPhoneMessage" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "providerAgentId" TEXT,
  "providerNumberId" TEXT,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentPhoneMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentPhoneMessage_externalId_key" ON "AgentPhoneMessage"("externalId");
CREATE INDEX "AgentPhoneMessage_userId_receivedAt_idx" ON "AgentPhoneMessage"("userId", "receivedAt");
CREATE INDEX "AgentPhoneMessage_to_idx" ON "AgentPhoneMessage"("to");

ALTER TABLE "AgentPhoneMessage" ADD CONSTRAINT "AgentPhoneMessage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
