-- Durable idempotency records for non-idempotent external tool side effects.
CREATE TABLE "ToolSideEffect" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "externalId" TEXT,
    "request" JSONB,
    "response" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolSideEffect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ToolSideEffect_operationKey_key" ON "ToolSideEffect"("operationKey");
CREATE INDEX "ToolSideEffect_operationType_idx" ON "ToolSideEffect"("operationType");
CREATE INDEX "ToolSideEffect_status_idx" ON "ToolSideEffect"("status");
CREATE INDEX "ToolSideEffect_externalId_idx" ON "ToolSideEffect"("externalId");
