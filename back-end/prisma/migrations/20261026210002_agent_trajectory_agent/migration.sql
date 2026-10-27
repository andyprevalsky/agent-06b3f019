-- Trajectory search stores each agent's goal/title once (AgentTrajectoryAgent)
-- instead of copying them onto every AgentTrajectorySearch message row.
-- Idempotent: the local runtime SQL hook re-applies this file on every run.
CREATE TABLE IF NOT EXISTS "AgentTrajectoryAgent" (
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentGoal" TEXT NOT NULL DEFAULT '',
    "agentTitle" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTrajectoryAgent_pkey" PRIMARY KEY ("agentId")
);

CREATE INDEX IF NOT EXISTS "AgentTrajectoryAgent_userId_idx" ON "AgentTrajectoryAgent"("userId");

ALTER TABLE "AgentTrajectoryAgent" ENABLE ROW LEVEL SECURITY;

-- No backfill here: a whole-table INSERT ... SELECT hits the boot-time
-- statement timeout (57014; see 20260929120000). Legacy rows keep their own
-- copy, which search prefers, until `backfill-agent-trajectory-search.ts
-- --agent-goals` moves them in bounded primary-key batches.

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

  INSERT INTO "AgentTrajectoryAgent" ("agentId", "userId", "agentGoal", "agentTitle", "updatedAt")
  VALUES (NEW."agentId", owner_id, COALESCE(agent_goal, ''), agent_title, CURRENT_TIMESTAMP)
  ON CONFLICT ("agentId") DO UPDATE SET
    "agentGoal" = EXCLUDED."agentGoal",
    "agentTitle" = EXCLUDED."agentTitle",
    "updatedAt" = EXCLUDED."updatedAt"
  WHERE "AgentTrajectoryAgent"."userId" = EXCLUDED."userId"
    AND ("AgentTrajectoryAgent"."agentGoal", "AgentTrajectoryAgent"."agentTitle")
      IS DISTINCT FROM (EXCLUDED."agentGoal", EXCLUDED."agentTitle");

  INSERT INTO "AgentTrajectorySearch" (
    "messageId", "userId", "rootAgentId", "agentId", "surface", "role", "createdAt", "searchText",
    "agentGoal", "agentTitle"
  ) VALUES (
    NEW.id, owner_id, root_id, NEW."agentId", agent_surface,
    NEW.role::text, NEW."createdAt", NEW.text, '', NULL
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

CREATE OR REPLACE FUNCTION delete_user_agent_trajectory_search() RETURNS trigger AS $$
BEGIN
  DELETE FROM "AgentTrajectorySearch" WHERE "userId" = OLD."userId";
  DELETE FROM "AgentTrajectoryAgent" WHERE "userId" = OLD."userId";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
