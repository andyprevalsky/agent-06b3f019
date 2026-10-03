CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS "AgentTrajectorySearch" (
  "messageId" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "rootAgentId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "searchText" TEXT NOT NULL,
  "agentGoal" TEXT NOT NULL DEFAULT '',
  "agentTitle" TEXT,
  "archivePath" TEXT,
  "traceKind" TEXT NOT NULL DEFAULT 'message'
);

-- Local db push may retain an earlier prototype FK. Operational agents can
-- exist before a User row, and this derived projection must not block messages.
ALTER TABLE "AgentTrajectorySearch"
  DROP CONSTRAINT IF EXISTS "AgentTrajectorySearch_userId_fkey";

CREATE INDEX IF NOT EXISTS "AgentTrajectorySearch_userId_createdAt_messageId_idx"
  ON "AgentTrajectorySearch"("userId", "createdAt" DESC, "messageId" DESC);
CREATE INDEX IF NOT EXISTS "AgentTrajectorySearch_user_root_time_idx"
  ON "AgentTrajectorySearch"("userId", "rootAgentId", "createdAt" DESC, "messageId" DESC);
CREATE INDEX IF NOT EXISTS "AgentTrajectorySearch_searchText_trgm_idx"
  ON "AgentTrajectorySearch" USING GIN ("searchText" gin_trgm_ops);

CREATE OR REPLACE FUNCTION sync_agent_trajectory_search() RETURNS trigger AS $$
DECLARE
  owner_id TEXT;
  root_id TEXT;
  agent_surface TEXT;
  agent_goal TEXT;
  agent_title TEXT;
BEGIN
  IF btrim(NEW.text) = '' OR NEW.role::text = 'SYSTEM' THEN
    DELETE FROM "AgentTrajectorySearch"
    WHERE "messageId" = NEW.id AND "archivePath" IS NULL;
    RETURN NEW;
  END IF;

  WITH RECURSIVE lineage AS (
    SELECT a.id, a."parentAgentId", a."userId", a.source::text AS surface,
           a.goal, a.title,
           ARRAY[a.id] AS visited, 0 AS depth
    FROM "Agent" a WHERE a.id = NEW."agentId"
    UNION ALL
    SELECT parent.id, parent."parentAgentId", parent."userId", lineage.surface,
           lineage.goal, lineage.title,
           lineage.visited || parent.id, lineage.depth + 1
    FROM lineage
    JOIN "Agent" parent ON parent.id = lineage."parentAgentId"
    WHERE NOT parent.id = ANY(lineage.visited)
  )
  SELECT "userId", id, surface, goal, title
  INTO owner_id, root_id, agent_surface, agent_goal, agent_title
  FROM lineage ORDER BY depth DESC LIMIT 1;

  IF owner_id IS NULL OR root_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "AgentTrajectorySearch" (
    "messageId", "userId", "rootAgentId", "agentId", "surface", "role", "createdAt", "searchText",
    "agentGoal", "agentTitle"
  ) VALUES (
    NEW.id, owner_id, root_id, NEW."agentId", agent_surface,
    NEW.role::text, NEW."createdAt", NEW.text, agent_goal, agent_title
  ) ON CONFLICT ("messageId") DO UPDATE SET
    "userId" = EXCLUDED."userId",
    "rootAgentId" = EXCLUDED."rootAgentId",
    "agentId" = EXCLUDED."agentId",
    "surface" = EXCLUDED."surface",
    "role" = EXCLUDED."role",
    "createdAt" = EXCLUDED."createdAt",
    "searchText" = EXCLUDED."searchText",
    "agentGoal" = EXCLUDED."agentGoal",
    "agentTitle" = EXCLUDED."agentTitle"
  WHERE "AgentTrajectorySearch"."archivePath" IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Message_trajectory_search_sync" ON "Message";
CREATE TRIGGER "Message_trajectory_search_sync"
AFTER INSERT OR UPDATE OF text, role, "agentId", "createdAt" ON "Message"
FOR EACH ROW EXECUTE FUNCTION sync_agent_trajectory_search();

CREATE OR REPLACE FUNCTION delete_live_agent_trajectory_search() RETURNS trigger AS $$
BEGIN
  DELETE FROM "AgentTrajectorySearch"
  WHERE "messageId" = OLD.id AND "archivePath" IS NULL;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Message_trajectory_search_delete" ON "Message";
CREATE TRIGGER "Message_trajectory_search_delete"
AFTER DELETE ON "Message"
FOR EACH ROW EXECUTE FUNCTION delete_live_agent_trajectory_search();

CREATE OR REPLACE FUNCTION delete_user_agent_trajectory_search() RETURNS trigger AS $$
BEGIN
  DELETE FROM "AgentTrajectorySearch" WHERE "userId" = OLD."userId";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "User_trajectory_search_delete" ON "User";
CREATE TRIGGER "User_trajectory_search_delete"
AFTER DELETE ON "User"
FOR EACH ROW EXECUTE FUNCTION delete_user_agent_trajectory_search();

WITH RECURSIVE roots AS (
  SELECT a.id, a.id AS root_id FROM "Agent" a WHERE a."parentAgentId" IS NULL
  UNION ALL
  SELECT child.id, roots.root_id FROM "Agent" child
  JOIN roots ON child."parentAgentId" = roots.id
)
INSERT INTO "AgentTrajectorySearch" (
  "messageId", "userId", "rootAgentId", "agentId", "surface", "role", "createdAt", "searchText",
  "agentGoal", "agentTitle"
)
SELECT m.id, a."userId", roots.root_id, a.id, a.source::text,
       m.role::text, m."createdAt", m.text, a.goal, a.title
FROM "Message" m
JOIN "Agent" a ON a.id = m."agentId"
JOIN roots ON roots.id = a.id
WHERE btrim(m.text) <> '' AND m.role::text <> 'SYSTEM' AND a."userId" IS NOT NULL
ON CONFLICT ("messageId") DO NOTHING;

-- Remove rows left by earlier local projections before this role was excluded.
DELETE FROM "AgentTrajectorySearch" WHERE role = 'SYSTEM';
