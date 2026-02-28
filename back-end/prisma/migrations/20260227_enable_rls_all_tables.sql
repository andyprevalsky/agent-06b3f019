-- =============================================================================
-- COMPREHENSIVE RLS MIGRATION: Enable RLS on ALL public tables
-- =============================================================================
-- This migration enables Row Level Security on every table in the public schema
-- and creates appropriate policies for each table.
--
-- SAFETY:
-- - Backend (Prisma) uses service role key → bypasses RLS automatically
-- - Backend/worker broadcasts use service role key → bypasses RLS automatically
-- - Frontend uses broadcast events on private channels → not affected by table RLS
-- - This ONLY restricts direct frontend Supabase client queries (anon key + JWT)
--
-- IDEMPOTENT: Safe to run multiple times (DROP IF EXISTS + CREATE)
-- =============================================================================

BEGIN;

-- =============================================================================
-- STEP 1: Enable RLS on ALL tables
-- =============================================================================

ALTER TABLE "Agent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentAttentionRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentTool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BenchmarkRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrowserContext" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrowserPassword" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrowserPermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrowserSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CacheStorageOrigin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClaudeCodeSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Cookie" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Credit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailIntegrationCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GithubRepoAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoalBlueprint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoalHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImessageQueue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IndexedDBOrigin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Integration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LocalStorageOrigin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModelPricingCache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PendingLocalStorageBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Person" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoseApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoseApiKeyLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoseConversationModel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoseModelLatency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SharedMemory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SmsSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SmsShortcode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ToolUsage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Verifier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Waitlist" ENABLE ROW LEVEL SECURITY;

-- Legacy tables (exist in DB but not in Prisma schema)
-- Enable RLS with no policies = deny all frontend access
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations') THEN
    EXECUTE 'ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'DiskSyncSession') THEN
    EXECUTE 'ALTER TABLE "DiskSyncSession" ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'FileEntry') THEN
    EXECUTE 'ALTER TABLE "FileEntry" ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'SmsQueue') THEN
    EXECUTE 'ALTER TABLE "SmsQueue" ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'SmsQueuePending') THEN
    EXECUTE 'ALTER TABLE "SmsQueuePending" ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;


-- =============================================================================
-- STEP 2: Drop all existing policies (idempotency)
-- =============================================================================

-- Agent
DROP POLICY IF EXISTS "Users can view own agents" ON "Agent";
DROP POLICY IF EXISTS "Users can insert own agents" ON "Agent";
DROP POLICY IF EXISTS "Users can update own agents" ON "Agent";
DROP POLICY IF EXISTS "Users can delete own agents" ON "Agent";

-- Message
DROP POLICY IF EXISTS "Users can view own agent messages" ON "Message";
DROP POLICY IF EXISTS "Users can insert messages to own agents" ON "Message";

-- Verifier
DROP POLICY IF EXISTS "Users can view own agent verifiers" ON "Verifier";

-- AgentTool
DROP POLICY IF EXISTS "Users can view own agent tools" ON "AgentTool";

-- Tool
DROP POLICY IF EXISTS "Anyone can view tools" ON "Tool";

-- AgentAttentionRequest
DROP POLICY IF EXISTS "Users can view own attention requests" ON "AgentAttentionRequest";
DROP POLICY IF EXISTS "Users can update own attention requests" ON "AgentAttentionRequest";
DROP POLICY IF EXISTS "Users can insert own attention requests" ON "AgentAttentionRequest";
DROP POLICY IF EXISTS "Users can delete own attention requests" ON "AgentAttentionRequest";

-- All other tables (clean slate)
DROP POLICY IF EXISTS "Users can select own data" ON "GoalBlueprint";
DROP POLICY IF EXISTS "Users can select own data" ON "ToolUsage";
DROP POLICY IF EXISTS "Users can select own data" ON "User";
DROP POLICY IF EXISTS "Users can select own data" ON "Credit";
DROP POLICY IF EXISTS "Users can select own data" ON "Subscription";
DROP POLICY IF EXISTS "Users can select own data" ON "BrowserContext";
DROP POLICY IF EXISTS "Users can select own data" ON "GithubRepoAccess";
DROP POLICY IF EXISTS "Users can select own data" ON "Person";
DROP POLICY IF EXISTS "Users can select own data" ON "Integration";
DROP POLICY IF EXISTS "Users can select own data" ON "EmailIntegrationCredential";
DROP POLICY IF EXISTS "Users can select own data" ON "RoseApiKey";
DROP POLICY IF EXISTS "Users can select own data" ON "RoseApiKeyLog";
DROP POLICY IF EXISTS "Users can select own data" ON "BenchmarkRun";
DROP POLICY IF EXISTS "Users can select own data" ON "Feedback";
DROP POLICY IF EXISTS "Users can select own data" ON "GoalHistory";
DROP POLICY IF EXISTS "Users can select own data" ON "ImessageQueue";
DROP POLICY IF EXISTS "Users can select own data" ON "PendingLocalStorageBatch";
DROP POLICY IF EXISTS "Users can select own data" ON "LocalStorageOrigin";
DROP POLICY IF EXISTS "Users can select own data" ON "IndexedDBOrigin";
DROP POLICY IF EXISTS "Users can select own data" ON "BrowserPermission";
DROP POLICY IF EXISTS "Users can select own data" ON "CacheStorageOrigin";
DROP POLICY IF EXISTS "Users can select own data" ON "Cookie";
DROP POLICY IF EXISTS "Users can select own data" ON "BrowserPassword";
DROP POLICY IF EXISTS "Users can select own data" ON "SmsSession";
DROP POLICY IF EXISTS "Users can select own data" ON "SmsShortcode";
DROP POLICY IF EXISTS "Users can select own data" ON "MessageRecord";
DROP POLICY IF EXISTS "Users can select own data" ON "BrowserSession";
DROP POLICY IF EXISTS "Users can select own data" ON "ClaudeCodeSession";
DROP POLICY IF EXISTS "Anyone can read" ON "ModelPricingCache";
DROP POLICY IF EXISTS "Anyone can read" ON "RoseModelLatency";
DROP POLICY IF EXISTS "Anyone can read" ON "RoseConversationModel";
DROP POLICY IF EXISTS "Deny all" ON "SharedMemory";
DROP POLICY IF EXISTS "Deny all" ON "Waitlist";


-- =============================================================================
-- STEP 3: Create policies
-- =============================================================================

-- -------------------------------------------------------
-- A. AGENT TABLE (direct userId)
-- -------------------------------------------------------
CREATE POLICY "Users can view own agents"
  ON "Agent" FOR SELECT
  USING (auth.uid()::text = "userId");

CREATE POLICY "Users can insert own agents"
  ON "Agent" FOR INSERT
  WITH CHECK (auth.uid()::text = "userId");

CREATE POLICY "Users can update own agents"
  ON "Agent" FOR UPDATE
  USING (auth.uid()::text = "userId")
  WITH CHECK (auth.uid()::text = "userId");

CREATE POLICY "Users can delete own agents"
  ON "Agent" FOR DELETE
  USING (auth.uid()::text = "userId");


-- -------------------------------------------------------
-- B. MESSAGE TABLE (via agentId → Agent.userId)
-- -------------------------------------------------------
CREATE POLICY "Users can view own agent messages"
  ON "Message" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Agent"
      WHERE "Agent"."id" = "Message"."agentId"
      AND "Agent"."userId" = auth.uid()::text
    )
  );

CREATE POLICY "Users can insert messages to own agents"
  ON "Message" FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Agent"
      WHERE "Agent"."id" = "Message"."agentId"
      AND "Agent"."userId" = auth.uid()::text
    )
  );


-- -------------------------------------------------------
-- C. VERIFIER TABLE (via agentId → Agent.userId)
-- -------------------------------------------------------
CREATE POLICY "Users can view own agent verifiers"
  ON "Verifier" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Agent"
      WHERE "Agent"."id" = "Verifier"."agentId"
      AND "Agent"."userId" = auth.uid()::text
    )
  );


-- -------------------------------------------------------
-- D. AGENT TOOL TABLE (via agentId → Agent.userId)
-- -------------------------------------------------------
CREATE POLICY "Users can view own agent tools"
  ON "AgentTool" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Agent"
      WHERE "Agent"."id" = "AgentTool"."agentId"
      AND "Agent"."userId" = auth.uid()::text
    )
  );


-- -------------------------------------------------------
-- E. TOOL TABLE (public read)
-- -------------------------------------------------------
CREATE POLICY "Anyone can view tools"
  ON "Tool" FOR SELECT
  USING (true);


-- -------------------------------------------------------
-- F. AGENT ATTENTION REQUEST (direct userId, full CRUD)
-- -------------------------------------------------------
CREATE POLICY "Users can view own attention requests"
  ON "AgentAttentionRequest" FOR SELECT
  USING (auth.uid()::text = "userId");

CREATE POLICY "Users can insert own attention requests"
  ON "AgentAttentionRequest" FOR INSERT
  WITH CHECK (auth.uid()::text = "userId");

CREATE POLICY "Users can update own attention requests"
  ON "AgentAttentionRequest" FOR UPDATE
  USING (auth.uid()::text = "userId")
  WITH CHECK (auth.uid()::text = "userId");

CREATE POLICY "Users can delete own attention requests"
  ON "AgentAttentionRequest" FOR DELETE
  USING (auth.uid()::text = "userId");


-- -------------------------------------------------------
-- G. TABLES WITH DIRECT userId (SELECT only from frontend)
-- Backend handles all writes via service role
-- -------------------------------------------------------

-- GoalBlueprint
CREATE POLICY "Users can select own data"
  ON "GoalBlueprint" FOR SELECT
  USING (auth.uid()::text = "userId");

-- ToolUsage
CREATE POLICY "Users can select own data"
  ON "ToolUsage" FOR SELECT
  USING (auth.uid()::text = "userId");

-- User
CREATE POLICY "Users can select own data"
  ON "User" FOR SELECT
  USING (auth.uid()::text = "userId");

-- Credit
CREATE POLICY "Users can select own data"
  ON "Credit" FOR SELECT
  USING (auth.uid()::text = "userId");

-- Subscription
CREATE POLICY "Users can select own data"
  ON "Subscription" FOR SELECT
  USING (auth.uid()::text = "userId");

-- BrowserContext
CREATE POLICY "Users can select own data"
  ON "BrowserContext" FOR SELECT
  USING (auth.uid()::text = "userId");

-- GithubRepoAccess
CREATE POLICY "Users can select own data"
  ON "GithubRepoAccess" FOR SELECT
  USING (auth.uid()::text = "userId");

-- Person
CREATE POLICY "Users can select own data"
  ON "Person" FOR SELECT
  USING (auth.uid()::text = "userId");

-- Integration
CREATE POLICY "Users can select own data"
  ON "Integration" FOR SELECT
  USING (auth.uid()::text = "userId");

-- EmailIntegrationCredential
CREATE POLICY "Users can select own data"
  ON "EmailIntegrationCredential" FOR SELECT
  USING (auth.uid()::text = "userId");

-- RoseApiKey
CREATE POLICY "Users can select own data"
  ON "RoseApiKey" FOR SELECT
  USING (auth.uid()::text = "userId");

-- RoseApiKeyLog
CREATE POLICY "Users can select own data"
  ON "RoseApiKeyLog" FOR SELECT
  USING (auth.uid()::text = "userId");

-- BenchmarkRun
CREATE POLICY "Users can select own data"
  ON "BenchmarkRun" FOR SELECT
  USING (auth.uid()::text = "userId");

-- Feedback
CREATE POLICY "Users can select own data"
  ON "Feedback" FOR SELECT
  USING (auth.uid()::text = "userId");

-- GoalHistory
CREATE POLICY "Users can select own data"
  ON "GoalHistory" FOR SELECT
  USING (auth.uid()::text = "userId");

-- ImessageQueue
CREATE POLICY "Users can select own data"
  ON "ImessageQueue" FOR SELECT
  USING (auth.uid()::text = "userId");

-- PendingLocalStorageBatch
CREATE POLICY "Users can select own data"
  ON "PendingLocalStorageBatch" FOR SELECT
  USING (auth.uid()::text = "userId");

-- LocalStorageOrigin
CREATE POLICY "Users can select own data"
  ON "LocalStorageOrigin" FOR SELECT
  USING (auth.uid()::text = "userId");

-- IndexedDBOrigin
CREATE POLICY "Users can select own data"
  ON "IndexedDBOrigin" FOR SELECT
  USING (auth.uid()::text = "userId");

-- BrowserPermission
CREATE POLICY "Users can select own data"
  ON "BrowserPermission" FOR SELECT
  USING (auth.uid()::text = "userId");

-- CacheStorageOrigin
CREATE POLICY "Users can select own data"
  ON "CacheStorageOrigin" FOR SELECT
  USING (auth.uid()::text = "userId");

-- Cookie
CREATE POLICY "Users can select own data"
  ON "Cookie" FOR SELECT
  USING (auth.uid()::text = "userId");

-- BrowserPassword
CREATE POLICY "Users can select own data"
  ON "BrowserPassword" FOR SELECT
  USING (auth.uid()::text = "userId");

-- SmsSession
CREATE POLICY "Users can select own data"
  ON "SmsSession" FOR SELECT
  USING (auth.uid()::text = "userId");

-- SmsShortcode
CREATE POLICY "Users can select own data"
  ON "SmsShortcode" FOR SELECT
  USING (auth.uid()::text = "userId");


-- -------------------------------------------------------
-- H. TABLES VIA AGENT RELATIONSHIP (agentId → Agent.userId)
-- -------------------------------------------------------

-- BrowserSession (via contextId → BrowserContext.userId)
CREATE POLICY "Users can select own data"
  ON "BrowserSession" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "BrowserContext"
      WHERE "BrowserContext"."id" = "BrowserSession"."contextId"
      AND "BrowserContext"."userId" = auth.uid()::text
    )
  );

-- ClaudeCodeSession (via agentId → Agent.userId)
CREATE POLICY "Users can select own data"
  ON "ClaudeCodeSession" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Agent"
      WHERE "Agent"."id" = "ClaudeCodeSession"."agentId"
      AND "Agent"."userId" = auth.uid()::text
    )
  );

-- MessageRecord (via personId → Person.userId)
CREATE POLICY "Users can select own data"
  ON "MessageRecord" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Person"
      WHERE "Person"."id" = "MessageRecord"."personId"
      AND "Person"."userId" = auth.uid()::text
    )
  );


-- -------------------------------------------------------
-- I. PUBLIC READ TABLES (system/cache data, read-only)
-- -------------------------------------------------------

CREATE POLICY "Anyone can read"
  ON "ModelPricingCache" FOR SELECT
  USING (true);

CREATE POLICY "Anyone can read"
  ON "RoseModelLatency" FOR SELECT
  USING (true);

CREATE POLICY "Anyone can read"
  ON "RoseConversationModel" FOR SELECT
  USING (true);


-- -------------------------------------------------------
-- J. SYSTEM TABLES (no policies = deny all from frontend)
-- Backend uses service role, so it's unaffected.
-- -------------------------------------------------------

-- SharedMemory: accessed by agents via service role only
-- No policy = deny all frontend access

-- Waitlist: admin/backend only
-- No policy = deny all frontend access

-- _prisma_migrations: internal Prisma
-- No policy = deny all frontend access

-- DiskSyncSession, FileEntry, SmsQueue, SmsQueuePending: legacy
-- No policy = deny all frontend access


COMMIT;
