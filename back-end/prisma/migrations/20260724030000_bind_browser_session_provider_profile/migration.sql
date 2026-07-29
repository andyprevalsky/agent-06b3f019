ALTER TABLE "BrowserSession"
ADD COLUMN "providerProfileId" TEXT,
ADD COLUMN "providerProfileSource" TEXT,
ADD COLUMN "providerProfilePersist" BOOLEAN NOT NULL DEFAULT true;
