/**
 * Trace archive of one code inspection: the inspector CLI's whole trajectory
 * and its answer, in the CALLING agent's root bundle (the inspection is a
 * model call that agent's tree made), next to the session's checkpoints:
 *
 *   code/<codeSessionId>/inspect-<inspectionId>/
 *     attempt-<n>/stdout.jsonl      CLI stdout (Claude stream-json / Codex --json events)
 *     attempt-<n>/stderr.txt        CLI stderr
 *     attempt-<n>/exit-code.txt     CLI exit status
 *     attempt-<n>/answer.txt        Codex last message (when written)
 *     attempt-<n>/instructions.txt  inspector instructions appended to the CLI prompt
 *     attempt-<n>/cli-<sha256>      every CLI file the inspector wrote (cliFiles.ts)
 *     manifest.json                 question, result, per-attempt artifacts (sha256/size),
 *                                   CLI file HOME paths; written last
 *
 * The restored session transcript (already in that session's checkpoint) is
 * listed, not copied. Capture and archive are best-effort: an archive failure
 * is logged and never fails the inspection. Credentials are never read (the
 * env file is deleted before the CLI starts).
 */
import { createLogger } from '../logger';
import { archiveBytes, archiveEnabled } from '../traceArchive';
import { archiveContentType, resolveArchiveRootAgentId } from './archiveMirror';
import {
  captureCliFiles,
  cliFileScanScript,
  parseCliFileScan,
  sha256Hex,
  type CheckpointCliFile,
} from './cliFiles';
import type { InspectPaths } from './inspectSandbox';
import { type CodeSessionFs, shellQuote } from './sandboxFs';

const log = createLogger('CodeInspectArchive');

const CAPTURE_READ_TIMEOUT_MS = 60_000;

/** What one inspector attempt left in its sandbox. */
export interface InspectAttemptCapture {
  artifacts: Map<string, Buffer>;
  /** Every CLI file in the inspection HOME; `restored` ones are the session's own transcript. */
  cliFiles: Array<Omit<CheckpointCliFile, 'seq'> & { restored?: boolean }>;
  deferred: string[];
}

export function emptyInspectCapture(): InspectAttemptCapture {
  return { artifacts: new Map(), cliFiles: [], deferred: [] };
}

/** Read the attempt's outputs and CLI files before the sandbox is killed. Never throws. */
export async function captureInspectAttempt(
  fs: CodeSessionFs,
  paths: InspectPaths,
  restored: { path: string; sha256: string } | null
): Promise<InspectAttemptCapture> {
  const capture = emptyInspectCapture();
  const outputs: Array<[string, string]> = [
    ['stdout.jsonl', paths.out],
    ['stderr.txt', paths.err],
    ['exit-code.txt', paths.rc],
    ['answer.txt', paths.answer],
    ['instructions.txt', paths.instructions],
  ];
  for (const [name, path] of outputs) {
    try {
      capture.artifacts.set(name, await fs.readFile(path, { timeoutMs: CAPTURE_READ_TIMEOUT_MS }));
    } catch {
      // not written by this provider / run
    }
  }
  try {
    const scan = await fs.exec(
      [
        `cd ${shellQuote(fs.home)} || exit 3`,
        cliFileScanScript(`${paths.dir}/cli-files.list`),
        'exit 0',
      ].join('\n'),
      { timeoutMs: CAPTURE_READ_TIMEOUT_MS }
    );
    const entries = parseCliFileScan(scan.stdout);
    const own = entries.filter(
      (entry) =>
        restored === null || entry.path !== restored.path || entry.sha256 !== restored.sha256
    );
    for (const entry of entries) {
      if (own.includes(entry) || entry.sha256 === null) continue;
      capture.cliFiles.push({
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
        mtime: entry.mtime,
        artifact: 'cli-log.jsonl',
        restored: true,
      });
    }
    const captured = await captureCliFiles({
      fs,
      entries: own,
      seq: 0,
      known: new Map(),
      readBudget: () => ({ timeoutMs: CAPTURE_READ_TIMEOUT_MS }),
    });
    for (const [name, data] of captured.blobs) capture.artifacts.set(name, data);
    for (const file of captured.files) {
      capture.cliFiles.push({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        mtime: file.mtime,
        artifact: file.artifact,
      });
    }
    capture.deferred = captured.deferred;
  } catch (error) {
    log.warn('Listing inspector CLI files failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return capture;
}

export interface ArchivedInspectAttempt {
  provider: string;
  sandboxId: string;
  capture: InspectAttemptCapture;
}

/** Bundle-relative directory of one inspection. */
export function inspectionArchiveDir(codeSessionId: string, inspectionId: string): string {
  return `code/${codeSessionId}/inspect-${inspectionId}`;
}

/** Archive one inspection into the caller's root bundle, manifest last. Never throws. */
export async function archiveInspection(params: {
  inspectionId: string;
  userId: string;
  agentId: string;
  codeSessionId: string;
  checkpointSeq: number;
  question: string;
  result: unknown;
  attempts: ArchivedInspectAttempt[];
}): Promise<void> {
  if (!archiveEnabled()) return;
  const dir = inspectionArchiveDir(params.codeSessionId, params.inspectionId);
  try {
    const rootAgentId = await resolveArchiveRootAgentId(params.agentId);
    const attempts = [];
    for (const [index, attempt] of params.attempts.entries()) {
      const artifacts: Record<string, { sha256: string; size: number }> = {};
      for (const [name, body] of attempt.capture.artifacts) {
        await archiveBytes({
          rootAgentId,
          objectPath: `${dir}/attempt-${index + 1}/${name}`,
          body,
          ...archiveContentType(name),
          createOnly: true,
        });
        artifacts[name] = { sha256: sha256Hex(body), size: body.length };
      }
      attempts.push({
        attempt: index + 1,
        provider: attempt.provider,
        sandbox_id: attempt.sandboxId,
        artifacts,
        cli_files: attempt.capture.cliFiles,
        ...(attempt.capture.deferred.length > 0
          ? { cli_files_deferred: attempt.capture.deferred }
          : {}),
      });
    }
    const manifest = {
      version: 1,
      kind: 'code_inspection',
      inspection_id: params.inspectionId,
      code_session_id: params.codeSessionId,
      user_id: params.userId,
      agent_id: params.agentId,
      root_agent_id: rootAgentId,
      checkpoint_seq: params.checkpointSeq,
      created_at: new Date().toISOString(),
      question: params.question,
      result: params.result,
      attempts,
    };
    await archiveBytes({
      rootAgentId,
      objectPath: `${dir}/manifest.json`,
      body: Buffer.from(JSON.stringify(manifest), 'utf8'),
      contentType: 'application/json',
      compress: true,
      createOnly: true,
    });
    log.info('Code inspection archived', {
      inspectionId: params.inspectionId,
      codeSessionId: params.codeSessionId,
      rootAgentId,
      attempts: String(attempts.length),
    });
  } catch (error) {
    log.warn('Archiving a code inspection failed', {
      inspectionId: params.inspectionId,
      codeSessionId: params.codeSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
