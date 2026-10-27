/**
 * Child process for testMessagingUpload_survivesProcessExitAfterAck: accept an
 * iMessage upload exactly as the route does, then exit at once, as a web
 * process replaced by a deploy (or killed by OOM) right after its 200 would.
 *
 * Usage: tsx integrations.messaging-ingestion.child.ts <userId> <contactsJsonPath>
 */

import fs from 'fs';
import { processIMessageUpload } from '../../domains/integrations/uploadService.messaging';

async function main(): Promise<void> {
  const [userId, contactsPath] = process.argv.slice(2);
  const contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf-8')) as Parameters<
    typeof processIMessageUpload
  >[1];
  const { jobId } = await processIMessageUpload(userId, contacts);
  console.log(`acked ${jobId}`);
  process.exit(0);
}

void main();
