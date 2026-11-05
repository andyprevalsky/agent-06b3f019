-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "maintenanceLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "maintenanceNightly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maintenanceOnGithubChange" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maintenanceRunId" TEXT,
ADD COLUMN     "maintenanceScript" TEXT,
ADD COLUMN     "maintenanceTimeoutS" INTEGER NOT NULL DEFAULT 480,
ADD COLUMN     "maintenanceWatchCheckedAt" TIMESTAMP(3),
ADD COLUMN     "maintenanceWatchedSha" TEXT,
ADD COLUMN     "templatePrevSnapshotId" TEXT,
ADD COLUMN     "templateSnapshotAt" TIMESTAMP(3),
ADD COLUMN     "templateSnapshotId" TEXT,
ADD COLUMN     "templateSnapshotRunId" TEXT,
ADD COLUMN     "templateSnapshotSha" TEXT,
ADD COLUMN     "templateSnapshotSize" JSONB;

-- CreateTable
CREATE TABLE "ProjectMaintenanceRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'sync',
    "status" TEXT NOT NULL,
    "slotKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "exitCode" INTEGER,
    "headSha" TEXT,
    "sandboxId" TEXT,
    "snapshotId" TEXT,
    "fromSnapshotId" TEXT,
    "error" TEXT,
    "logTail" TEXT,

    CONSTRAINT "ProjectMaintenanceRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectMaintenanceRun_projectId_startedAt_idx" ON "ProjectMaintenanceRun"("projectId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMaintenanceRun_projectId_slotKey_key" ON "ProjectMaintenanceRun"("projectId", "slotKey");

-- AddForeignKey
ALTER TABLE "ProjectMaintenanceRun" ADD CONSTRAINT "ProjectMaintenanceRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backend-only table (logs may quote project output): RLS on with no policy
-- denies anon/authenticated roles; the backend service role bypasses RLS.
ALTER TABLE "ProjectMaintenanceRun" ENABLE ROW LEVEL SECURITY;
