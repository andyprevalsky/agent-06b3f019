-- Narrow recent-role queries to stored messages without scanning every trace
-- row for a user. Build concurrently so production reads and writes continue.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AgentTrajectorySearch_user_role_kind_time_idx"
  ON "AgentTrajectorySearch"("userId", "role", "traceKind", "createdAt" DESC, "messageId" DESC);
