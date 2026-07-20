-- AlterTable: model-driven IP rotation state for the browser agent (rotate_ip tool).
-- Keyed to the stable BrowserSession row id (the browser sub-agent run) so the
-- rotation cap survives session recycles. See docs/plans/active/rotate-ip-tool.md.
ALTER TABLE "BrowserSession" ADD COLUMN     "proxyRotationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "proxyTier" TEXT;
