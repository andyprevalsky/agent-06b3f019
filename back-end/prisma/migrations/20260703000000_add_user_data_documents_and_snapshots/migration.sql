-- Normalized user data documents and progressive user-snapshot distillation.
-- Ingested documents are searchable by source; snapshot revisions preserve how
-- each connector pass changed the dynamic user context.

CREATE TABLE "UserDataDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "url" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "contentHash" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDataDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserDataProviderSyncState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "config" JSONB DEFAULT '{}',
    "cursor" JSONB DEFAULT '{}',
    "lastStartedAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "nextSyncAt" TIMESTAMP(3),
    "realtimeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDataProviderSyncState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserSnapshotRevision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "documentId" TEXT,
    "source" TEXT NOT NULL,
    "before" JSONB NOT NULL DEFAULT '{}',
    "after" JSONB NOT NULL DEFAULT '{}',
    "changes" JSONB DEFAULT '{}',
    "model" TEXT,
    "promptKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSnapshotRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserDataDocument_userId_source_externalId_key" ON "UserDataDocument"("userId", "source", "externalId");
CREATE INDEX "UserDataDocument_userId_source_idx" ON "UserDataDocument"("userId", "source");
CREATE INDEX "UserDataDocument_userId_updatedAt_idx" ON "UserDataDocument"("userId", "updatedAt");
CREATE INDEX "UserDataDocument_userId_source_deletedAt_idx" ON "UserDataDocument"("userId", "source", "deletedAt");
CREATE UNIQUE INDEX "UserDataProviderSyncState_userId_source_key" ON "UserDataProviderSyncState"("userId", "source");
CREATE INDEX "UserDataProviderSyncState_userId_status_idx" ON "UserDataProviderSyncState"("userId", "status");
CREATE INDEX "UserDataProviderSyncState_nextSyncAt_idx" ON "UserDataProviderSyncState"("nextSyncAt");
CREATE UNIQUE INDEX "UserSnapshot_userId_key" ON "UserSnapshot"("userId");
CREATE INDEX "UserSnapshot_userId_idx" ON "UserSnapshot"("userId");
CREATE INDEX "UserSnapshotRevision_userId_createdAt_idx" ON "UserSnapshotRevision"("userId", "createdAt");
CREATE INDEX "UserSnapshotRevision_snapshotId_idx" ON "UserSnapshotRevision"("snapshotId");
CREATE INDEX "UserSnapshotRevision_documentId_idx" ON "UserSnapshotRevision"("documentId");
CREATE INDEX "UserSnapshotRevision_source_idx" ON "UserSnapshotRevision"("source");

ALTER TABLE "UserDataDocument"
  ADD CONSTRAINT "UserDataDocument_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserDataProviderSyncState"
  ADD CONSTRAINT "UserDataProviderSyncState_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserSnapshot"
  ADD CONSTRAINT "UserSnapshot_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserSnapshotRevision"
  ADD CONSTRAINT "UserSnapshotRevision_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserSnapshotRevision"
  ADD CONSTRAINT "UserSnapshotRevision_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "UserSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserSnapshotRevision"
  ADD CONSTRAINT "UserSnapshotRevision_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "UserDataDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserDataDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserDataProviderSyncState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserSnapshotRevision" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "UserDataDocument_select_own" ON "UserDataDocument"
  FOR SELECT
  USING ("userId" = (current_setting('request.jwt.claims', true)::json ->> 'sub'));

CREATE POLICY "UserDataProviderSyncState_select_own" ON "UserDataProviderSyncState"
  FOR SELECT
  USING ("userId" = (current_setting('request.jwt.claims', true)::json ->> 'sub'));

CREATE POLICY "UserSnapshot_select_own" ON "UserSnapshot"
  FOR SELECT
  USING ("userId" = (current_setting('request.jwt.claims', true)::json ->> 'sub'));

CREATE POLICY "UserSnapshotRevision_select_own" ON "UserSnapshotRevision"
  FOR SELECT
  USING ("userId" = (current_setting('request.jwt.claims', true)::json ->> 'sub'));
