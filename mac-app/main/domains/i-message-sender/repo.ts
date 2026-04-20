/**
 * i-message-sender — repo layer
 *
 * Sole boundary owner for the `osascript` child process. The service layer
 * never imports `child_process` directly — it always goes through
 * {@link runOsascript} so blackbox tests can stub a single seam.
 *
 * Using `promisify(execFile)` preserves the exact Node callback contract the
 * existing blackbox suite targets: `execFile(command, args, cb(err, result))`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { OSASCRIPT_BIN } from './config';

const execFileAsync = promisify(execFile);

/**
 * Execute an AppleScript via `osascript -e <script>`. Rejects on a non-zero
 * exit; resolves with undefined on success (stdout/stderr are discarded — the
 * service layer has no use for them).
 */
export async function runOsascript(script: string): Promise<void> {
  await execFileAsync(OSASCRIPT_BIN, ['-e', script]);
}
