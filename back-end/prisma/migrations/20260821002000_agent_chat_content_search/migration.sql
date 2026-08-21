-- Case-insensitive substring search backs the sidebar's title, goal, and chat
-- content search. B-tree indexes cannot accelerate ILIKE '%needle%'; trigram
-- GIN indexes can, keeping each debounced search bounded as histories grow.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Agent_title_trgm_idx"
ON "Agent" USING GIN ("title" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Agent_goal_trgm_idx"
ON "Agent" USING GIN ("goal" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_text_trgm_idx"
ON "Message" USING GIN ("text" gin_trgm_ops);
