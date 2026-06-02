ALTER TABLE "AgentIdentity"
ADD COLUMN "phoneProvider" TEXT,
ADD COLUMN "phoneProviderAgentId" TEXT,
ADD COLUMN "phoneProviderNumberId" TEXT;

CREATE INDEX "AgentIdentity_phone_idx" ON "AgentIdentity"("phone");
