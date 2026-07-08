CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_agent_network_grep_trgm_idx"
ON public."Message"
USING gin (
  ((text || E'\n' || COALESCE(metadata::text, '') || E'\n' || COALESCE("filePointer"::text, '')))
  public.gin_trgm_ops
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_agentId_createdAt_id_idx"
ON public."Message" ("agentId", "createdAt" DESC, id DESC);
