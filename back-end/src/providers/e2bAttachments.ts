import { CODE_AGENT_ATTACHMENTS_DIR, CODE_AGENT_OUTPUT_DIR } from './codeAgentPrompt';
import { createLogger } from './logger';
import { type FilePointer, downloadFromStorage } from './storage';

const log = createLogger('E2B');

interface AttachmentSandbox {
  commands: { run(cmd: string): Promise<unknown> };
  files: { write(path: string, data: Blob): Promise<unknown> };
}

/**
 * Stage user attachments into a code-agent sandbox's attachments dir (and
 * create the output dir). Per-file failures are logged and skipped; returns
 * the remote paths that were written.
 */
export async function uploadAttachmentsToSandbox(
  sandbox: AttachmentSandbox,
  attachments: FilePointer[] | undefined,
  label: string
): Promise<string[]> {
  const uploadedFiles: string[] = [];
  if (!attachments || attachments.length === 0) return uploadedFiles;
  log.info(`Uploading ${attachments.length} attachments to ${label} sandbox`);
  await sandbox.commands.run(`mkdir -p ${CODE_AGENT_ATTACHMENTS_DIR} ${CODE_AGENT_OUTPUT_DIR}`);

  for (const fp of attachments) {
    try {
      // All files are stored in storage; E2B takes a Blob.
      const content = await downloadFromStorage(fp.storage_path);
      const remotePath = `${CODE_AGENT_ATTACHMENTS_DIR}/${fp.original_filename}`;
      await sandbox.files.write(remotePath, new Blob([content]));
      uploadedFiles.push(remotePath);
      log.info(`Uploaded: ${fp.original_filename} (${content.length} bytes)`);
    } catch (err) {
      log.error(`Failed to upload ${fp.original_filename}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info(`Uploaded ${uploadedFiles.length}/${attachments.length} files`);
  return uploadedFiles;
}
