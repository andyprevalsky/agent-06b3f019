-- Retain indexed historical task lookup without blocking queue writes.
CREATE INDEX CONCURRENTLY "ImessageQueue_phoneBrowserTaskId_idx"
  ON "ImessageQueue"("phoneBrowserTaskId");
