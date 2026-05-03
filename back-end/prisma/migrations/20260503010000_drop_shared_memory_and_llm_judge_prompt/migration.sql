-- Drop the Verifier.llmJudgePrompt column. Schema and code stopped writing this
-- value when verifiers became schema-driven, but no DROP COLUMN ever shipped, so
-- prod inserts hit a NOT NULL constraint violation on every POST /api/agents.
ALTER TABLE "Verifier" DROP COLUMN IF EXISTS "llmJudgePrompt";

-- Drop the SharedMemory table. The model and all backing infra were removed in
-- the same change but the table was left orphaned in prod.
DROP TABLE IF EXISTS "SharedMemory";

-- Drop the Agent.reasoningEffort column and its enum. The column was manually
-- removed from prod long ago but no migration was ever recorded, so the
-- migration history claims a column that does not exist. IF EXISTS keeps this
-- safe on environments where the manual drop never happened.
ALTER TABLE "Agent" DROP COLUMN IF EXISTS "reasoningEffort";
DROP TYPE IF EXISTS "ReasoningEffort";
