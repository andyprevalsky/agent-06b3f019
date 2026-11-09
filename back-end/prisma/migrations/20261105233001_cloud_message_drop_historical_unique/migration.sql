-- The preceding successful concurrent migration protects all writer versions.
DROP INDEX CONCURRENTLY "ImessageQueue_phoneBrowserTaskId_key";
