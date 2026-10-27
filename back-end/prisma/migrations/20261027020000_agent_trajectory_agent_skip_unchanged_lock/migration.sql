-- Every Message insert/update ran the AgentTrajectoryAgent upsert below.
-- ON CONFLICT DO UPDATE locks the conflicting row even when its WHERE clause
-- skips the update, so any open transaction that wrote one message held the
-- agent's row and blocked every other message write for that agent until it
-- committed. Skip the upsert (and its row lock) when the stored goal/title
-- already match; a goal or title change still updates as before.
-- Idempotent: the local runtime SQL hook re-applies this file on every run.
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

  IF NOT EXISTS (
    SELECT 1 FROM "AgentTrajectoryAgent"
    WHERE "agentId" = NEW."agentId"
      AND "userId" = owner_id
      AND ("agentGoal", "agentTitle") IS NOT DISTINCT FROM (COALESCE(agent_goal, ''), agent_title)
  ) THEN
    INSERT INTO "AgentTrajectoryAgent" ("agentId", "userId", "agentGoal", "agentTitle", "updatedAt")
    VALUES (NEW."agentId", owner_id, COALESCE(agent_goal, ''), agent_title, CURRENT_TIMESTAMP)
    ON CONFLICT ("agentId") DO UPDATE SET
      "agentGoal" = EXCLUDED."agentGoal",
      "agentTitle" = EXCLUDED."agentTitle",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "AgentTrajectoryAgent"."userId" = EXCLUDED."userId"
      AND ("AgentTrajectoryAgent"."agentGoal", "AgentTrajectoryAgent"."agentTitle")
        IS DISTINCT FROM (EXCLUDED."agentGoal", EXCLUDED."agentTitle");
  END IF;

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
