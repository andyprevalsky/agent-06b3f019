/**
 * CLI trajectory files in a code-session HOME. A checkpoint (and a code
 * inspection) keeps every one of them, not just the newest transcript:
 *
 *   ~/.claude/projects/<cwd slug>/<sessionId>.jsonl            main transcript (--resume)
 *   ~/.claude/projects/<cwd slug>/<sessionId>/subagents/...    subagent/sidechain transcripts + .meta.json
 *   ~/.claude/projects/<cwd slug>/<sessionId>/tool-results/... large tool outputs the transcript points at
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl               every Codex rollout (resumed, forked, sub-agents)
 *   ~/.codex/archived_sessions/...                             archived rollouts
 *
 *   sandbox (one exec): find ──► CLISTAT size mtime path
 *                       sha256sum ──► CLIHASH sha path
 *                       first rollout line ──► CLISUB path (Codex sub-agent thread)
 *        │
 *        ▼
 *   mainCliLogPath ──► the provider's own top-level session (never a subagent file)
 *   captureCliFiles ──► content-addressed: a version whose sha256 is already stored
 *                       (an earlier checkpoint) is referenced, never downloaded again;
 *                       new versions become `cli-<sha256>` artifacts of this checkpoint
 *
 * Storage grows with the number of distinct file versions, not with
 * checkpoints × files: an unchanged subagent transcript is stored once.
 */
import { createHash } from 'crypto';
import { createLogger } from '../logger';
import { type CodeSessionFs, shellQuote } from './sandboxFs';

const log = createLogger('CodeSessionCliFiles');

/** HOME-relative directories holding CLI trajectories (Claude and Codex, whatever the provider). */
export const CLI_FILE_DIRS = ['.claude/projects', '.codex/sessions', '.codex/archived_sessions'];

/** The main session transcript, per checkpoint (restored for `--resume`). */
export const CLI_LOG_ARTIFACT = 'cli-log.jsonl';

const CLI_BLOB_PREFIX = 'cli-';
const CLI_BLOB_PATTERN = /^cli-[0-9a-f]{64}$/;

/** Artifact name of one content-addressed CLI file version. */
export function cliBlobArtifact(sha256: string): string {
  return `${CLI_BLOB_PREFIX}${sha256}`;
}

/** A CLI file version artifact (not needed to restore a sandbox). */
export function isCliBlobArtifact(name: string): boolean {
  return CLI_BLOB_PATTERN.test(name);
}

/** One CLI file as listed in the sandbox. */
export interface CliFileEntry {
  /** Path relative to HOME. */
  path: string;
  /** sha256 at scan time; null when the file appeared between listing and hashing. */
  sha256: string | null;
  size: number;
  /** Modification time, epoch seconds (fractional). */
  mtime: number;
  /** A Codex rollout of a sub-agent thread (never the session to resume). */
  subagent: boolean;
}

/** Where the bytes of one file version live: artifact `artifact` of checkpoint `seq`. */
export interface CliBlobRef {
  seq: number;
  artifact: string;
}

/** A CLI file in a checkpoint manifest: its version and the artifact that holds it. */
export interface CheckpointCliFile extends CliBlobRef {
  /** Path relative to HOME. */
  path: string;
  sha256: string;
  size: number;
  mtime: number;
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Bash lines (run from HOME) that list every CLI file with its size, mtime and
 * sha256. `listFile` is a scratch path for the NUL-separated file list. Names
 * with control characters or backslashes (never written by either CLI) are
 * skipped: sha256sum escapes them and the line protocol cannot carry them.
 */
export function cliFileScanScript(listFile: string): string {
  const list = shellQuote(listFile);
  return [
    'CLI_DIRS=""',
    `for d in ${CLI_FILE_DIRS.map(shellQuote).join(' ')}; do [ -d "$d" ] && CLI_DIRS="$CLI_DIRS $d"; done`,
    'if [ -n "$CLI_DIRS" ]; then',
    `  find $CLI_DIRS -type f ! -path '*[[:cntrl:]]*' ! -path '*\\\\*' -fprint0 ${list} -printf 'CLISTAT=%s %T@ %p\\n'`,
    `  xargs -0 -r sha256sum -- < ${list} | sed 's/^/CLIHASH=/'`,
    '  while IFS= read -r -d "" f; do',
    '    case "$f" in',
    // A sub-agent thread's session_meta names its parent thread / sub-agent source.
    `      .codex/*.jsonl) head -n 1 -- "$f" | grep -qF -e '"parent_thread_id":"' -e '"source":{"subagent"' && printf 'CLISUB=%s\\n' "$f" ;;`,
    '    esac',
    `  done < ${list}`,
    'fi',
  ].join('\n');
}

/** Parse cliFileScanScript output (other lines are ignored). */
export function parseCliFileScan(stdout: string): CliFileEntry[] {
  const entries = new Map<string, CliFileEntry>();
  const hashes = new Map<string, string>();
  const subagents = new Set<string>();
  for (const line of stdout.split('\n')) {
    const stat = /^CLISTAT=(\d+) ([0-9.]+) (.+)$/.exec(line);
    if (stat !== null) {
      const path = stat[3].replace(/^\.\//, '');
      entries.set(path, {
        path,
        sha256: null,
        size: Number(stat[1]),
        mtime: Number(stat[2]),
        subagent: false,
      });
      continue;
    }
    const hash = /^CLIHASH=([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (hash !== null) {
      hashes.set(hash[2].replace(/^\.\//, ''), hash[1]);
      continue;
    }
    if (line.startsWith('CLISUB='))
      subagents.add(line.slice('CLISUB='.length).replace(/^\.\//, ''));
  }
  return [...entries.values()]
    .map((entry) => ({
      ...entry,
      sha256: hashes.get(entry.path) ?? null,
      subagent: subagents.has(entry.path),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The provider's main session transcript: the newest top-level Claude session
 * file (`projects/<slug>/<id>.jsonl`, never `<id>/subagents/agent-*.jsonl`), or
 * the newest Codex rollout that is not a sub-agent thread.
 */
export function mainCliLogPath(codeProvider: string, entries: CliFileEntry[]): string | null {
  const candidates = entries.filter((entry) => {
    if (codeProvider === 'codex') {
      return /^\.codex\/sessions\/(?:.+\/)?[^/]+\.jsonl$/.test(entry.path) && !entry.subagent;
    }
    const match = /^\.claude\/projects\/[^/]+\/([^/]+)\.jsonl$/.exec(entry.path);
    return match !== null && !match[1].startsWith('agent-');
  });
  let best: CliFileEntry | null = null;
  for (const entry of candidates) {
    if (
      best === null ||
      entry.mtime > best.mtime ||
      (entry.mtime === best.mtime && entry.path > best.path)
    ) {
      best = entry;
    }
  }
  return best?.path ?? null;
}

/** Claude: the JSONL basename. Codex: the rollout's session_meta payload id. */
export function cliSessionIdFromLog(
  codeProvider: string,
  logPath: string,
  content: Buffer
): string | null {
  if (codeProvider !== 'codex') {
    const base = logPath.split('/').pop() ?? '';
    return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) || null : null;
  }
  for (const line of content.toString('utf8').split('\n').slice(0, 20)) {
    try {
      const entry = JSON.parse(line) as { type?: string; payload?: { id?: unknown } };
      if (entry.type === 'session_meta' && typeof entry.payload?.id === 'string') {
        return entry.payload.id;
      }
    } catch {
      // keep scanning
    }
  }
  const match = /rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(logPath);
  return match?.[1] ?? null;
}

/** Blob references an earlier manifest already holds, keyed by sha256. */
export function knownCliBlobs(previous: {
  seq: number;
  artifacts?: Record<string, { sha256: string; size: number }>;
  cliFiles?: CheckpointCliFile[];
}): Map<string, CliBlobRef> {
  const known = new Map<string, CliBlobRef>();
  for (const file of previous.cliFiles ?? []) {
    if (
      typeof file?.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(file.sha256) &&
      Number.isInteger(file.seq) &&
      file.seq >= 1 &&
      file.seq <= previous.seq &&
      typeof file.artifact === 'string' &&
      (file.artifact === CLI_LOG_ARTIFACT || isCliBlobArtifact(file.artifact))
    ) {
      known.set(file.sha256, { seq: file.seq, artifact: file.artifact });
    }
  }
  // Every stored artifact of the previous checkpoint itself (incl. a legacy cli-log.jsonl).
  for (const [artifact, meta] of Object.entries(previous.artifacts ?? {})) {
    if ((artifact === CLI_LOG_ARTIFACT || isCliBlobArtifact(artifact)) && !known.has(meta.sha256)) {
      known.set(meta.sha256, { seq: previous.seq, artifact });
    }
  }
  return known;
}

export interface CapturedCliFiles {
  files: CheckpointCliFile[];
  /** New artifacts (cli-<sha256>) to store with this checkpoint. */
  blobs: Map<string, Buffer>;
  /** Listed files not captured this time (deadline reserve, or gone before the read). */
  deferred: string[];
}

/**
 * Capture every listed CLI file. A version already in `known` is referenced;
 * any other is downloaded (and re-hashed: a file the CLI is still appending to
 * is recorded as read). `known` gains the new versions. `readBudget` returns
 * the read options for the next download, or null to defer the rest.
 */
export async function captureCliFiles(params: {
  fs: CodeSessionFs;
  entries: CliFileEntry[];
  seq: number;
  known: Map<string, CliBlobRef>;
  readBudget: (pendingBytes: number) => { timeoutMs?: number } | null;
}): Promise<CapturedCliFiles> {
  const { fs, entries, seq, known } = params;
  const files: CheckpointCliFile[] = [];
  const blobs = new Map<string, Buffer>();
  const deferred: string[] = [];
  let pendingBytes = 0;
  for (const entry of entries) {
    const existing = entry.sha256 === null ? undefined : known.get(entry.sha256);
    if (existing !== undefined && entry.sha256 !== null) {
      files.push({
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
        mtime: entry.mtime,
        ...existing,
      });
      continue;
    }
    const budget = params.readBudget(pendingBytes);
    if (budget === null) {
      deferred.push(entry.path);
      continue;
    }
    let data: Buffer;
    try {
      data = await fs.readFile(`${fs.home}/${entry.path}`, budget);
    } catch (error) {
      log.warn('CLI file read failed; deferred to the next capture', {
        path: entry.path,
        error: error instanceof Error ? error.message : String(error),
      });
      deferred.push(entry.path);
      continue;
    }
    const sha256 = sha256Hex(data);
    let ref = known.get(sha256);
    if (ref === undefined) {
      ref = { seq, artifact: cliBlobArtifact(sha256) };
      known.set(sha256, ref);
      blobs.set(ref.artifact, data);
      pendingBytes += data.length;
    }
    files.push({ path: entry.path, sha256, size: data.length, mtime: entry.mtime, ...ref });
  }
  return { files, blobs, deferred };
}

/** Time kept free after CLI file downloads for the uploads: a floor plus the bytes at 2 MiB/s. */
const CLI_FILE_UPLOAD_RESERVE_MS = 10_000;
const UPLOAD_BYTES_PER_SEC = 2 * 1024 * 1024;

/**
 * Stored CLI file versions of the previous checkpoint (seq − 1, else the last
 * committed one). None when neither manifest can be read: every file is then
 * stored again, never lost.
 */
export async function previousCliBlobs(
  codeSessionId: string,
  seq: number,
  previousSeq: number | null | undefined,
  readManifest: (seq: number) => Promise<Buffer | null>
): Promise<Map<string, CliBlobRef>> {
  const candidates = [seq - 1, previousSeq ?? 0].filter(
    (candidate, index, all) => candidate >= 1 && candidate < seq && all.indexOf(candidate) === index
  );
  for (const candidate of candidates) {
    try {
      const raw = await readManifest(candidate);
      if (raw === null) continue;
      const previous = JSON.parse(raw.toString('utf8')) as Parameters<typeof knownCliBlobs>[0] & {
        codeSessionId?: string;
      };
      if (previous.codeSessionId !== codeSessionId || previous.seq !== candidate) continue;
      return knownCliBlobs(previous);
    } catch (error) {
      log.warn('Previous checkpoint manifest unreadable; storing every CLI file again', {
        codeSessionId,
        seq: String(candidate),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return new Map();
}

/**
 * A checkpoint's CLI files: the main transcript (already read and stored as
 * cli-log.jsonl) plus every other listed file. Restore never needs the others,
 * so a close running out of budget defers them to the next checkpoint (which
 * still lists them as new) instead of failing.
 */
export async function captureCheckpointCliFiles(params: {
  fs: CodeSessionFs;
  codeSessionId: string;
  codeProvider: string;
  seq: number;
  entries: CliFileEntry[];
  /** Read options for the main transcript (it is required: a failed read throws). */
  mainReadOpts: () => { timeoutMs?: number };
  known: Map<string, CliBlobRef>;
  deadlineAt: number | undefined;
  /** Upper bound for one download. */
  stepCapMs: number;
  /** Bytes this checkpoint will upload so far (main transcript excluded). */
  storedBytes: () => number;
}): Promise<
  CapturedCliFiles & { main: { path: string; data: Buffer } | null; cliSessionId: string | null }
> {
  const { fs, seq, known, deadlineAt } = params;
  const mainPath = mainCliLogPath(params.codeProvider, params.entries);
  const main =
    mainPath === null
      ? null
      : {
          path: mainPath,
          data: await fs.readFile(`${fs.home}/${mainPath}`, params.mainReadOpts()),
        };
  const files: CheckpointCliFile[] = [];
  if (main !== null) {
    const sha256 = sha256Hex(main.data);
    known.set(sha256, { seq, artifact: CLI_LOG_ARTIFACT });
    const mtime = params.entries.find((entry) => entry.path === main.path)?.mtime ?? 0;
    files.push({
      path: main.path,
      sha256,
      size: main.data.length,
      mtime,
      seq,
      artifact: CLI_LOG_ARTIFACT,
    });
  }
  const captured = await captureCliFiles({
    fs: params.fs,
    entries: params.entries.filter((entry) => entry.path !== main?.path),
    seq,
    known,
    readBudget: (pendingBytes) => {
      if (deadlineAt === undefined) return {};
      const reserve =
        CLI_FILE_UPLOAD_RESERVE_MS +
        Math.ceil(
          ((params.storedBytes() + (main?.data.length ?? 0) + pendingBytes) /
            UPLOAD_BYTES_PER_SEC) *
            1000
        );
      const available = deadlineAt - Date.now() - reserve;
      return available > 0 ? { timeoutMs: Math.min(params.stepCapMs, available) } : null;
    },
  });
  if (captured.deferred.length > 0) {
    log.warn('Checkpoint deferred CLI files to the next checkpoint', {
      codeSessionId: params.codeSessionId,
      seq: String(seq),
      deferred: String(captured.deferred.length),
    });
  }
  return {
    ...captured,
    main,
    cliSessionId:
      main === null ? null : cliSessionIdFromLog(params.codeProvider, main.path, main.data),
    files: [...files, ...captured.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    ),
  };
}
