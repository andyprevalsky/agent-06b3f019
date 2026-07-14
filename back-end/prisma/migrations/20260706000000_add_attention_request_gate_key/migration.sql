-- Gate dedup: give AgentAttentionRequest a nullable gateKey and enforce that at
-- most one PENDING (unanswered) gate exists per (userId, gateKey). Multiple
-- agents that hit the same gate fan in onto that single request. See
-- docs/plans/active/sms-onboarding-and-gates.md.

ALTER TABLE "AgentAttentionRequest" ADD COLUMN "gateKey" TEXT;

CREATE INDEX "AgentAttentionRequest_userId_gateKey_idx"
  ON "AgentAttentionRequest"("userId", "gateKey");

-- Partial unique index (not expressible in schema.prisma). "Unanswered" is
-- userResponse IS NULL, matching countUnanswered() in the repo.
CREATE UNIQUE INDEX "AgentAttentionRequest_pending_gateKey_key"
  ON "AgentAttentionRequest"("userId", "gateKey")
  WHERE "userResponse" IS NULL AND "gateKey" IS NOT NULL;
