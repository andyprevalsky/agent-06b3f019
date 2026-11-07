-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "usage5hResetsAt" TIMESTAMP(3),
ADD COLUMN     "usage5hUsedPct" DOUBLE PRECISION,
ADD COLUMN     "usage7dResetsAt" TIMESTAMP(3),
ADD COLUMN     "usage7dUsedPct" DOUBLE PRECISION,
ADD COLUMN     "usageObservedAt" TIMESTAMP(3);
