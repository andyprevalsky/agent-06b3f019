-- AgentTrajectorySearch_searchText_trgm_idx has been absent from production
-- since 2026-10-07: its concurrent rebuild exhausted the database disk and
-- briefly made production read-only. At ~2.0M rows x ~494 trigrams the build's
-- validation sort alone needs more temporary space than the disk has free, and a
-- blocking build would stall the Message trigger that maintains this table.
-- Record the absence so the migration history matches production; restore it
-- in a new migration once disk headroom is provisioned.
DROP INDEX IF EXISTS "AgentTrajectorySearch_searchText_trgm_idx";
