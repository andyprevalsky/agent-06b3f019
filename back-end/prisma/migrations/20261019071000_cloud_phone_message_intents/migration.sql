-- Keep existing relay entries on the Mac transport; cloud intents are explicitly selected.
ALTER TABLE "ImessageQueue" ADD COLUMN "transport" TEXT NOT NULL DEFAULT 'mac';
ALTER TABLE "ImessageQueue" ADD COLUMN "phoneBrowserTaskId" TEXT;
ALTER TABLE "ImessageQueue" ADD COLUMN "phoneSendOperationId" TEXT;
CREATE UNIQUE INDEX "ImessageQueue_phoneSendOperationId_key" ON "ImessageQueue"("phoneSendOperationId");
CREATE UNIQUE INDEX "ImessageQueue_phoneBrowserTaskId_key" ON "ImessageQueue"("phoneBrowserTaskId");
