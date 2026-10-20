-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "startupScript" TEXT,
    "startupTimeoutS" INTEGER NOT NULL DEFAULT 120,
    "autoWake" BOOLEAN NOT NULL DEFAULT false,
    "syncSalt" TEXT NOT NULL,
    "syncRevision" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectEnvFile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'env',
    "source" TEXT NOT NULL DEFAULT 'managed',
    "variables" JSONB NOT NULL DEFAULT '[]',
    "encryptedContent" TEXT,
    "fingerprint" TEXT,
    "linkTarget" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectEnvFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSyncSnapshot" (
    "projectId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "encryptedGitBundle" TEXT,
    "gitBundleFingerprint" TEXT,
    "encryptedUncommittedPatch" TEXT,
    "patchFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSyncSnapshot_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Project_userId_name_key" ON "Project"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectEnvFile_projectId_path_key" ON "ProjectEnvFile"("projectId", "path");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectEnvFile" ADD CONSTRAINT "ProjectEnvFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSyncSnapshot" ADD CONSTRAINT "ProjectSyncSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backend-only tables: rows hold encrypted secrets, so no client policy is
-- granted (RLS on with no policy denies anon/authenticated roles; the backend
-- service role bypasses RLS).
ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectEnvFile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectSyncSnapshot" ENABLE ROW LEVEL SECURITY;

