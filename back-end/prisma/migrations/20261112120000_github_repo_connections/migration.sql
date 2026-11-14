-- GitHub repos become an integration ("github_repo"); a Project is now only a
-- folder. Nothing is dropped or renamed: Project, ProjectFolder, Project.repoUrl,
-- Agent.projectId and Agent.githubRepoUrl keep working (legacy alias layer).

CREATE TABLE "GithubRepoConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "canonicalRef" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "connectedRoseProjectRef" TEXT,
    "source" TEXT NOT NULL DEFAULT 'connect',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubRepoConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GithubRepoConnection_userId_canonicalRef_key" ON "GithubRepoConnection"("userId", "canonicalRef");
CREATE INDEX "GithubRepoConnection_integrationId_idx" ON "GithubRepoConnection"("integrationId");
CREATE INDEX "GithubRepoConnection_connectedRoseProjectRef_idx" ON "GithubRepoConnection"("connectedRoseProjectRef");

ALTER TABLE "GithubRepoConnection" ADD CONSTRAINT "GithubRepoConnection_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GithubRepoConnection" ADD CONSTRAINT "GithubRepoConnection_connectedRoseProjectRef_fkey" FOREIGN KEY ("connectedRoseProjectRef") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Nullable, no default: a metadata-only change on the Agent table.
ALTER TABLE "Agent" ADD COLUMN "githubRepoRef" TEXT;

-- legacy-project-import:begin
-- Idempotent import of every repo already connected through a project (repoUrl
-- normalized like providers/github.ts normalizeGithubUrl, plus the user's
-- GithubRepoAccess grant), so nobody reconnects. Mirrored at runtime by
-- providers/githubRepos/store.ts importLegacyProjectConnections; a repo the
-- user disconnected keeps a NOT_CONNECTED Integration row and is never re-imported.
-- The oldest project per (user, repo) becomes connectedRoseProjectRef.
INSERT INTO "Integration" ("id", "userId", "type", "name", "status", "isActive", "accountId", "config", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, legacy."userId", 'TOOL_SETUP', 'github_repo', 'CONNECTED', true,
       legacy.canonical_ref,
       jsonb_build_object('canonical_ref', legacy.canonical_ref, 'repo_url', legacy.repo_url),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (p."userId", lower(m[1] || '/' || regexp_replace(m[2], '\.git$', '')))
         p."userId",
         'gh:' || lower(m[1] || '/' || regexp_replace(m[2], '\.git$', '')) AS canonical_ref,
         'https://github.com/' || m[1] || '/' || regexp_replace(m[2], '\.git$', '') AS repo_url
  FROM "Project" p
  CROSS JOIN LATERAL COALESCE(
    regexp_match(p."repoUrl", '^https?://github\.com/([^/\s]+)/([^/\s]+)'),
    regexp_match(p."repoUrl", '^github\.com/([^/\s]+)/([^/\s]+)'),
    regexp_match(p."repoUrl", '^([^/\s]+)/([^/\s]+)$')
  ) AS m
  WHERE p."repoUrl" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "GithubRepoAccess" g
      WHERE g."userId" = p."userId"
        AND g."repoUrl" = 'https://github.com/' || m[1] || '/' || regexp_replace(m[2], '\.git$', '')
    )
  ORDER BY p."userId", lower(m[1] || '/' || regexp_replace(m[2], '\.git$', '')), p."createdAt", p."id"
) AS legacy
ON CONFLICT ("userId", "name", "accountId") DO NOTHING;

INSERT INTO "GithubRepoConnection" ("id", "userId", "integrationId", "canonicalRef", "repoUrl", "owner", "repoName", "defaultBranch", "connectedRoseProjectRef", "source", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, legacy."userId", i."id", legacy.canonical_ref, legacy.repo_url,
       legacy.owner, legacy.repo_name, legacy."defaultBranch", legacy.project_id, 'legacy_project',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (p."userId", lower(m[1] || '/' || regexp_replace(m[2], '\.git$', '')))
         p."userId", p."id" AS project_id, p."defaultBranch",
         m[1] AS owner,
         regexp_replace(m[2], '\.git$', '') AS repo_name,
         'gh:' || lower(m[1] || '/' || regexp_replace(m[2], '\.git$', '')) AS canonical_ref,
         'https://github.com/' || m[1] || '/' || regexp_replace(m[2], '\.git$', '') AS repo_url
  FROM "Project" p
  CROSS JOIN LATERAL COALESCE(
    regexp_match(p."repoUrl", '^https?://github\.com/([^/\s]+)/([^/\s]+)'),
    regexp_match(p."repoUrl", '^github\.com/([^/\s]+)/([^/\s]+)'),
    regexp_match(p."repoUrl", '^([^/\s]+)/([^/\s]+)$')
  ) AS m
  WHERE p."repoUrl" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "GithubRepoAccess" g
      WHERE g."userId" = p."userId"
        AND g."repoUrl" = 'https://github.com/' || m[1] || '/' || regexp_replace(m[2], '\.git$', '')
    )
  ORDER BY p."userId", lower(m[1] || '/' || regexp_replace(m[2], '\.git$', '')), p."createdAt", p."id"
) AS legacy
JOIN "Integration" i
  ON i."userId" = legacy."userId" AND i."name" = 'github_repo' AND i."accountId" = legacy.canonical_ref
 AND i."status" = 'CONNECTED'
ON CONFLICT ("userId", "canonicalRef") DO NOTHING;

-- Live agents in a project whose repo is connected carry its canonical ref
-- (bounded by agents that have a project; locks only those rows).
UPDATE "Agent" a
SET "githubRepoRef" = c."canonicalRef"
FROM "Project" p, "GithubRepoConnection" c
WHERE a."projectId" = p."id"
  AND a."githubRepoRef" IS NULL
  AND a."deletedAt" IS NULL
  AND c."userId" = p."userId"
  AND c."canonicalRef" = 'gh:' || lower(
    (regexp_match(p."repoUrl", '^https?://github\.com/([^/\s]+)/'))[1] || '/' ||
    regexp_replace((regexp_match(p."repoUrl", '^https?://github\.com/[^/\s]+/([^/\s]+)'))[1], '\.git$', '')
  );
-- legacy-project-import:end
