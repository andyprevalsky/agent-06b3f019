-- Planner memory retrieval moves from lexical scoring to semantic embeddings.
-- One row per PlannerMemory holds the voyage-4 (1024-dim) vector of its goal.
-- Exact cosine over the visibility-filtered rows (benchmark + own user) is
-- fast at the current corpus size, so no ANN index yet.
CREATE EXTENSION IF NOT EXISTS vector;

-- Lexical retrieval is removed: its FTS index and pre-tokenized goal column.
DROP INDEX IF EXISTS "PlannerMemory_goal_fts_idx";
ALTER TABLE "PlannerMemory" DROP COLUMN IF EXISTS "goalTokens";

-- CreateTable
CREATE TABLE "PlannerMemoryEmbedding" (
    "plannerMemoryId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "goalHash" TEXT NOT NULL,
    "goalVector" vector(1024) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannerMemoryEmbedding_pkey" PRIMARY KEY ("plannerMemoryId")
);

-- CreateIndex
CREATE INDEX "PlannerMemoryEmbedding_model_idx" ON "PlannerMemoryEmbedding"("model");

-- AddForeignKey
ALTER TABLE "PlannerMemoryEmbedding" ADD CONSTRAINT "PlannerMemoryEmbedding_plannerMemoryId_fkey" FOREIGN KEY ("plannerMemoryId") REFERENCES "PlannerMemory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security matches PlannerMemory (service-role access only).
ALTER TABLE "PlannerMemoryEmbedding" ENABLE ROW LEVEL SECURITY;
