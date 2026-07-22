CREATE TYPE "BrowserControlState" AS ENUM ('AGENT', 'USER_REQUESTED', 'USER');

ALTER TABLE "BrowserSession"
ADD COLUMN "controlState" "BrowserControlState" NOT NULL DEFAULT 'AGENT',
ADD COLUMN "controlLeaseExpiresAt" TIMESTAMP(3);
