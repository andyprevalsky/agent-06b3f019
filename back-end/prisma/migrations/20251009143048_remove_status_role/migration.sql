-- AlterEnum
-- Remove STATUS from MessageRole enum and rename AGENT to ASSISTANT
-- Note: This will fail if any existing rows have role = 'STATUS'
-- Run: UPDATE "Message" SET role = 'ASSISTANT' WHERE role = 'STATUS' OR role = 'AGENT';
-- before applying this migration if needed

ALTER TYPE "MessageRole" RENAME TO "MessageRole_old";
CREATE TYPE "MessageRole" AS ENUM ('SYSTEM', 'ASSISTANT', 'USER', 'TOOL');
ALTER TABLE "Message" ALTER COLUMN "role" TYPE "MessageRole" USING (
  CASE 
    WHEN "role"::text = 'AGENT' THEN 'ASSISTANT'
    ELSE "role"::text
  END
)::"MessageRole";
DROP TYPE "MessageRole_old";

