-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "temporalWorkflowId" TEXT;

-- CreateTable
CREATE TABLE "GoalBlueprint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "blueprint" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoalBlueprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoalBlueprint_userId_idx" ON "GoalBlueprint"("userId");

-- CreateIndex
CREATE INDEX "GoalBlueprint_created_at_idx" ON "GoalBlueprint"("created_at");

-- CreateIndex
CREATE INDEX "Agent_temporalWorkflowId_idx" ON "Agent"("temporalWorkflowId");
