CREATE INDEX CONCURRENTLY IF NOT EXISTS "ToolSideEffect_operationKey_trgm_idx"
ON "ToolSideEffect" USING GIN ("operationKey" gin_trgm_ops);
