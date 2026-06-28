-- Default new agents to the Rose Ultra pool (claudeAuth → Opus 4.8) instead of
-- Rose Lite (Sonnet 4.6) so the main runner uses Opus 4.8 by default.
-- Only changes the column default; existing rows are untouched.
ALTER TABLE "Agent" ALTER COLUMN "model" SET DEFAULT 'rose-labs/rose-1-ultra';
