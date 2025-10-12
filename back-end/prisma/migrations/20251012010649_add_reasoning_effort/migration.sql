-- CreateEnum
CREATE TYPE "ReasoningEffort" AS ENUM ('low', 'medium', 'high');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "reasoningEffort" "ReasoningEffort" NOT NULL DEFAULT 'low';
