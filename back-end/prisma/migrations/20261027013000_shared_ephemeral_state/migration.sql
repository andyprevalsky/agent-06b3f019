-- Cross-instance ephemeral state for multi-instance backends (providers/sharedState.ts).

-- CreateTable
CREATE TABLE "SharedEphemeralState" (
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedEphemeralState_pkey" PRIMARY KEY ("namespace","key")
);

-- CreateIndex
CREATE INDEX "SharedEphemeralState_expiresAt_idx" ON "SharedEphemeralState"("expiresAt");

-- Holds PKCE verifiers and dedupe claims: never readable through the public API.
ALTER TABLE "SharedEphemeralState" ENABLE ROW LEVEL SECURITY;
