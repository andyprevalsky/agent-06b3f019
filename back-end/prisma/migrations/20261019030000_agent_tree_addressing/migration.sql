-- Agent tree addressing (list_agents / send_message).
-- In-flight background tasks per agent, written by the tree-state PATCH.
ALTER TABLE "Agent" ADD COLUMN "backgroundTasks" JSONB;
-- Codex-style task path ("/root/outreach/draft_a"), unique per live tree row.
ALTER TABLE "Agent" ADD COLUMN "taskPath" TEXT;
