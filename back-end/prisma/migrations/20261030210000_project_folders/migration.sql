CREATE TABLE "ProjectFolder" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  CONSTRAINT "ProjectFolder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectFolder_projectId_name_key" ON "ProjectFolder"("projectId", "name");
ALTER TABLE "ProjectFolder" ADD CONSTRAINT "ProjectFolder_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Agent" ADD COLUMN "folderId" TEXT;
CREATE INDEX "Agent_folderId_idx" ON "Agent"("folderId");
-- The existing project->agent SET NULL and the new project->folder CASCADE can
-- run in either order. Check the folder FK after both cascades have settled.
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_folderId_fkey"
  FOREIGN KEY ("folderId") REFERENCES "ProjectFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Match the existing backend-only Project tables: no direct client access.
ALTER TABLE "ProjectFolder" ENABLE ROW LEVEL SECURITY;
