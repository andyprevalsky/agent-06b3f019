-- Improve DB-backed Grep searches over user messages, contact fields, and agent-tree messages.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "MessageRecord_message_trgm_idx"
  ON "MessageRecord" USING GIN ("message" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Message_text_trgm_idx"
  ON "Message" USING GIN ("text" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Message_agentId_role_createdAt_idx"
  ON "Message"("agentId", "role", "createdAt");

CREATE INDEX IF NOT EXISTS "Person_grep_contact_trgm_idx"
  ON "Person" USING GIN (
    (
      COALESCE("firstName", '') || E'\n' ||
      COALESCE("lastName", '') || E'\n' ||
      COALESCE(email, '') || E'\n' ||
      COALESCE("phoneNumber", '') || E'\n' ||
      COALESCE(company, '') || E'\n' ||
      COALESCE(title, '') || E'\n' ||
      COALESCE(relation, '') || E'\n' ||
      COALESCE("communicationFrequency", '')
    ) gin_trgm_ops
  );
