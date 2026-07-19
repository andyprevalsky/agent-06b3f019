-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "isBenchmark" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "GoalHistory" ADD COLUMN     "isBenchmark" BOOLEAN NOT NULL DEFAULT false;
