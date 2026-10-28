-- Query-box speed for Fast Mode ("fast" | "ultra"); Codex maps it to its native service tier.
ALTER TABLE "Agent" ADD COLUMN "fastModeSpeed" TEXT;
