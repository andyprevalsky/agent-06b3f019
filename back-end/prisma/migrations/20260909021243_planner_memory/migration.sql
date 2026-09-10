-- Planner memory: one row per finalized root trace bundle, written in the same
-- finalize path that publishes the R2 manifest so the table and the archive
-- never drift. criticalPath is a lazily filled, TTL-free cache of the
-- compressed trajectory. Goal retrieval is one indexed FTS query over
-- precomputed planner-scoring tokens; compression uses an atomic lease.
-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "memoryEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PlannerMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "goal" TEXT NOT NULL,
    "goalTokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "benchmarkTaskName" TEXT,
    "rootStatus" TEXT,
    "passed" BOOLEAN,
    "worldModelMode" TEXT NOT NULL DEFAULT 'real',
    "agentCreatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criticalPath" JSONB,
    "compressorVersion" TEXT,
    "compressedAt" TIMESTAMP(3),
    "compressionLeaseId" TEXT,
    "compressionLeaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannerMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlannerMemory_benchmarkTaskName_idx" ON "PlannerMemory"("benchmarkTaskName");

-- CreateIndex
CREATE INDEX "PlannerMemory_userId_idx" ON "PlannerMemory"("userId");

-- CreateIndex
CREATE INDEX "PlannerMemory_passed_archivedAt_idx" ON "PlannerMemory"("passed", "archivedAt");


-- Lexical retrieval index. Trigram similarity is computed only for the bounded
-- result set, so it does not need a second write-amplifying index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "PlannerMemory_goal_fts_idx" ON "PlannerMemory" USING GIN (to_tsvector('english', "goal"));
