-- Enable Row Level Security on all tables
-- Run this if you want to use Supabase Realtime from frontend

-- Enable RLS
ALTER TABLE "Agent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentTool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Verifier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own agents
CREATE POLICY "Users can view own agents"
  ON "Agent"
  FOR SELECT
  USING (auth.uid()::text = "userId");

CREATE POLICY "Users can insert own agents"
  ON "Agent"
  FOR INSERT
  WITH CHECK (auth.uid()::text = "userId");

CREATE POLICY "Users can update own agents"
  ON "Agent"
  FOR UPDATE
  USING (auth.uid()::text = "userId")
  WITH CHECK (auth.uid()::text = "userId");

CREATE POLICY "Users can delete own agents"
  ON "Agent"
  FOR DELETE
  USING (auth.uid()::text = "userId");

-- Policy: Users can only see messages from their agents
CREATE POLICY "Users can view own agent messages"
  ON "Message"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Agent"
      WHERE "Agent"."id" = "Message"."agentId"
      AND "Agent"."userId" = auth.uid()::text
    )
  );

CREATE POLICY "Users can insert messages to own agents"
  ON "Message"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Agent"
      WHERE "Agent"."id" = "Message"."agentId"
      AND "Agent"."userId" = auth.uid()::text
    )
  );

-- Policy: Users can view verifiers for their agents
CREATE POLICY "Users can view own agent verifiers"
  ON "Verifier"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Agent"
      WHERE "Agent"."id" = "Verifier"."agentId"
      AND "Agent"."userId" = auth.uid()::text
    )
  );

-- Policy: Users can view agent-tool relationships for their agents
CREATE POLICY "Users can view own agent tools"
  ON "AgentTool"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Agent"
      WHERE "Agent"."id" = "AgentTool"."agentId"
      AND "Agent"."userId" = auth.uid()::text
    )
  );

-- Policy: Everyone can view available tools (or restrict if needed)
CREATE POLICY "Anyone can view tools"
  ON "Tool"
  FOR SELECT
  USING (true);

-- Note: Backend connections bypass RLS (they use service role or session pooler)
-- This only affects direct frontend connections with anon key

