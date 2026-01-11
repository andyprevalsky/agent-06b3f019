-- Initial schema for Rose API
-- Creates tables needed for API key management and model latency tracking

-- RoseApiKey table for storing API keys
CREATE TABLE IF NOT EXISTS "RoseApiKey" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "apiKey" TEXT NOT NULL UNIQUE,
  "name" TEXT,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast API key lookups
CREATE INDEX IF NOT EXISTS "RoseApiKey_apiKey_idx" ON "RoseApiKey" ("apiKey");
CREATE INDEX IF NOT EXISTS "RoseApiKey_userId_idx" ON "RoseApiKey" ("userId");

-- RoseApiKeyLog table for tracking API usage
CREATE TABLE IF NOT EXISTS "RoseApiKeyLog" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "apiKeyId" UUID NOT NULL REFERENCES "RoseApiKey"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL,
  "input" JSONB,
  "output" JSONB,
  "costCents" DECIMAL(10, 4) DEFAULT 0,
  "cotSteps" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for usage queries
CREATE INDEX IF NOT EXISTS "RoseApiKeyLog_apiKeyId_idx" ON "RoseApiKeyLog" ("apiKeyId");
CREATE INDEX IF NOT EXISTS "RoseApiKeyLog_userId_idx" ON "RoseApiKeyLog" ("userId");
CREATE INDEX IF NOT EXISTS "RoseApiKeyLog_createdAt_idx" ON "RoseApiKeyLog" ("createdAt");

-- RoseModelLatency table for caching model latencies
CREATE TABLE IF NOT EXISTS "RoseModelLatency" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "model" TEXT NOT NULL,
  "pool" TEXT NOT NULL,
  "latencyMs" INTEGER NOT NULL,
  "measuredAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE ("model", "pool")
);

-- Index for latency lookups
CREATE INDEX IF NOT EXISTS "RoseModelLatency_pool_idx" ON "RoseModelLatency" ("pool");
CREATE INDEX IF NOT EXISTS "RoseModelLatency_measuredAt_idx" ON "RoseModelLatency" ("measuredAt");

-- Enable Row Level Security (but allow service role full access)
ALTER TABLE "RoseApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoseApiKeyLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoseModelLatency" ENABLE ROW LEVEL SECURITY;

-- Policy: service_role can do everything
CREATE POLICY "service_role_full_access" ON "RoseApiKey" FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON "RoseApiKeyLog" FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON "RoseModelLatency" FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Policy: authenticated users can see their own API keys
CREATE POLICY "users_own_keys" ON "RoseApiKey" FOR SELECT TO authenticated USING ("userId" = auth.uid()::text);
CREATE POLICY "users_own_logs" ON "RoseApiKeyLog" FOR SELECT TO authenticated USING ("userId" = auth.uid()::text);

-- Grant permissions
GRANT ALL ON "RoseApiKey" TO service_role;
GRANT ALL ON "RoseApiKeyLog" TO service_role;
GRANT ALL ON "RoseModelLatency" TO service_role;
GRANT SELECT ON "RoseApiKey" TO authenticated;
GRANT SELECT ON "RoseApiKeyLog" TO authenticated;
GRANT SELECT ON "RoseModelLatency" TO authenticated;
