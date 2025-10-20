-- Draft migration: Add ToolUsage table for tracking tool costs
-- This tracks usage from tools like deep_research, web_search, etc.
-- Each tool execution can have multiple usage items (e.g., input tokens, output tokens, searches)

-- CreateTable
CREATE TABLE "ToolUsage" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "totalCostCents" INTEGER NOT NULL,
    "usageItems" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolUsage_agentId_idx" ON "ToolUsage"("agentId");

-- CreateIndex
CREATE INDEX "ToolUsage_createdAt_idx" ON "ToolUsage"("createdAt");

-- CreateIndex
CREATE INDEX "ToolUsage_toolName_idx" ON "ToolUsage"("toolName");

-- AddForeignKey
ALTER TABLE "ToolUsage" ADD CONSTRAINT "ToolUsage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Comments
COMMENT ON TABLE "ToolUsage" IS 'Tracks usage and costs from tools (web_search, deep_research, etc.)';
COMMENT ON COLUMN "ToolUsage"."totalCostCents" IS 'Pre-calculated total cost in cents (sum of all usage items)';
COMMENT ON COLUMN "ToolUsage"."usageItems" IS 'JSON array of UsageItem objects with detailed cost breakdown';

