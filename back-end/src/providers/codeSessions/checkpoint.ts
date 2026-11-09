/**
 * Platform checkpoints for persistent code sessions. They capture the exact
 * working state whether or not the agent committed anything:
 *
 *   HOME ──tar (minus caches/large/.git/credentials)──► worktree.tar.gz
 *          and, for a repo git can rebuild from HEAD, minus its tracked files that
 *          are unchanged since HEAD (the tree of a large repo is not session state)
 *   each git repo under HOME ──git bundle --all --not --remotes──► repo-<n>.bundle
 *                               (local-only commits; refs listed in the manifest)
 *   newest Claude/Codex session log ─────────────────► cli-log.jsonl
 *   manifest.json: seq, sha256 + size of every artifact, HEAD/branch/dirty
 *                  files per repo, cli session id
 *
 * Stored under user/<userId>/code-sessions/<id>/<seq>/. The manifest is
 * written last, so a seq without a manifest is an incomplete checkpoint. A
 * restore verifies every hash before touching the target HOME.
 */
import { createHash } from 'crypto';
import { createLogger } from '../logger';
import { checkpointKey, getCheckpointObject, putCheckpointObject } from './artifactStore';
import { type CodeSessionFs, shellQuote } from './sandboxFs';

const log = createLogger('CodeSessionCheckpoint');

export const MANIFEST_NAME = 'manifest.json';
export const WORKTREE_ARTIFACT = 'worktree.tar.gz';
export const CLI_LOG_ARTIFACT = 'cli-log.jsonl';

/** Directory names never checkpointed: dependency/build caches and CLI state. */
const EXCLUDED_DIR_NAMES = [
  'node_modules',
  '.git',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  'dist',
  'build',
  'target',
  '.npm',
  '.claude',
  '.codex',
  '.rose',
];
/** Top-level template/credential files the sandbox recreates on every start. */
const EXCLUDED_TOP_LEVEL = ['ws-server.mjs', 'rose-bridge.mjs', '.claude.json'];

export interface CheckpointRepo {
  /** Repo directory relative to HOME ('' for HOME itself). */
  path: string;
  bundle: string | null;
  head: string | null;
  branch: string | null;
  remoteUrl: string | null;
  /** Commits on HEAD not contained in any remote-tracking ref. */
  localCommits: number;
  pushed: boolean;
  dirtyFiles: string[];
  /** Local refs (branches, tags, stash) and their shas, restored onto a fresh clone. */
  refs?: Record<string, string>;
  /** origin/HEAD's branch (the repo default) when known. */
  defaultBranch?: string | null;
  /** Lines added/removed per file vs the merge base with the merge target (incl. uncommitted). */
  files?: Array<{ path: string; added: number; removed: number }>;
  /**
   * worktree.tar.gz omits this repo's tracked files that were unchanged since HEAD:
   * restore rebuilds them from the repo (`git checkout-index`) and removes
   * `deletedFiles`. Absent on older checkpoints, whose archive holds every file.
   */
  worktreeFromGit?: boolean;
  /** Tracked files that were missing from the working tree (deleted, staged or not). */
  deletedFiles?: string[];
  /** How many unchanged tracked files the archive omitted (observability). */
  gitOmittedFiles?: number;
}

export interface CheckpointManifest {
  version: 1;
  codeSessionId: string;
  userId: string;
  seq: number;
  reason: string;
  codeProvider: string;
  createdAt: string;
  artifacts: Record<string, { sha256: string; size: number }>;
  repos: CheckpointRepo[];
  cliSessionId: string | null;
  /** CLI log path relative to HOME, restored to the same place. */
  cliLogPath: string | null;
  skippedLargeFiles: string[];
}

export class CheckpointIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointIntegrityError';
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function maxFileBytes(): number {
  const raw = Number(process.env.CODE_SESSION_CHECKPOINT_MAX_FILE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 25 * 1024 * 1024;
}

function maxArtifactBytes(): number {
  const raw = Number(process.env.CODE_SESSION_CHECKPOINT_MAX_ARTIFACT_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 200 * 1024 * 1024;
}

/** Default bound for one checkpoint shell step (scan, repo inspection, archive). */
const STEP_TIMEOUT_MS = 300_000;
/** Worktree download timeout: this floor plus the archive size at 2 MiB/s. */
const ARCHIVE_READ_BASE_MS = 10_000;
const ARCHIVE_READ_BYTES_PER_SEC = 2 * 1024 * 1024;

export class CheckpointDeadlineError extends Error {
  constructor(step: string) {
    super(`Checkpoint deadline passed before ${step}`);
    this.name = 'CheckpointDeadlineError';
  }
}

/** A step's timeout: its own bound, never past the checkpoint deadline. */
function stepTimeoutMs(deadlineAt: number | undefined, capMs: number, step: string): number {
  if (deadlineAt === undefined) return capMs;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new CheckpointDeadlineError(step);
  return Math.min(capMs, remaining);
}

/** Read options for a sandbox download: unbounded by us without a deadline (SDK default). */
function readOpts(deadlineAt: number | undefined, step: string): { timeoutMs?: number } {
  return deadlineAt === undefined
    ? {}
    : { timeoutMs: stepTimeoutMs(deadlineAt, STEP_TIMEOUT_MS, step) };
}

/** More deleted tracked files than this and the repo's whole working tree stays in the archive. */
const MAX_DELETED_TRACKED_FILES = 2000;

/**
 * A repo whose tracked files restore can rebuild: HEAD's objects come back from the
 * incremental bundle (local-only history) or from a remote that already holds HEAD
 * (restore fetches it first), and the checkout recreates the files.
 */
function reproducibleFromGit(repo: CheckpointRepo): boolean {
  if (repo.head === null) return false;
  return repo.bundle !== null || (repo.pushed && repo.remoteUrl !== null);
}

function tmpDirFor(codeSessionId: string, seq: number, op: string): string {
  return `/tmp/rose-code-${op}-${codeSessionId}-${seq}-${process.pid}`;
}

/** Strip credentials (x-access-token:<token>@) from a remote URL. */
export function sanitizeRemoteUrl(url: string | null): string | null {
  if (url === null || url.trim() === '') return null;
  try {
    const parsed = new URL(url.trim());
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url.trim().replace(/\/\/[^@/]+@/, '//');
  }
}

function parseKeyValues(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) out.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return out;
}

function cliLogDir(codeProvider: string): string {
  return codeProvider === 'codex' ? '.codex/sessions' : '.claude/projects';
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

const MAX_DIFF_FILES = 200;

function parseNumstat(stdout: string): Array<{ path: string; added: number; removed: number }> {
  const files: Array<{ path: string; added: number; removed: number }> = [];
  for (const line of stdout.split('\n')) {
    const match = /^(NUMSTAT|UNTRACKED)=(\d+|-)\t(?:(\d+|-)\t)?(.+)$/.exec(line);
    if (match === null || files.length >= MAX_DIFF_FILES) continue;
    const added = match[2] === '-' ? 0 : Number(match[2]);
    const removed = match[1] === 'UNTRACKED' || match[3] === '-' ? 0 : Number(match[3] ?? 0);
    files.push({ path: match[4], added, removed });
  }
  return files;
}

async function inspectRepo(
  fs: CodeSessionFs,
  tmp: string,
  repoPath: string,
  index: number,
  diffBase: string | null,
  deadlineAt: number | undefined
): Promise<{ repo: CheckpointRepo; bundleFile: string | null }> {
  const dir = repoPath === '' ? fs.home : `${fs.home}/${repoPath}`;
  const bundleFile = `${tmp}/repo-${index}.bundle`;
  const result = await fs.exec(
    [
      `cd ${shellQuote(dir)} || exit 3`,
      'HEAD_SHA=$(git rev-parse -q --verify HEAD 2>/dev/null)',
      'echo "HEAD=$HEAD_SHA"',
      'echo "BRANCH=$(git symbolic-ref -q --short HEAD 2>/dev/null)"',
      'echo "REMOTE=$(git remote get-url origin 2>/dev/null)"',
      'if [ -n "$HEAD_SHA" ]; then',
      '  echo "LOCAL=$(git rev-list --count HEAD --not --remotes 2>/dev/null)"',
      '  echo "REMOTE_REFS=$(git for-each-ref --count=1 --format=x refs/remotes 2>/dev/null)"',
      // Only history a remote does not already hold: a full `--all` bundle of a
      // large repo (Rose: 1.4 GB) per checkpoint is not storable. Restore
      // fetches the remote first, so these prerequisites are present there.
      // No local-only commits -> git refuses an empty bundle -> refs alone.
      `  git bundle create ${shellQuote(bundleFile)} --all --not --remotes >/dev/null 2>&1 && echo BUNDLE=1`,
      '  echo "DEFAULT=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"',
      `  git for-each-ref --count=500 --format='REF=%(refname) %(objectname)' refs/heads refs/tags refs/stash 2>/dev/null`,
      // Per-file +/- against the merge base with the merge target (UI summary).
      `  B=${shellQuote(diffBase ?? '')}`,
      '  if [ -n "$B" ] && git rev-parse -q --verify "refs/remotes/origin/$B" >/dev/null 2>&1; then BASE="origin/$B"; else BASE=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); fi',
      '  MB=""; [ -n "$BASE" ] && MB=$(git merge-base HEAD "$BASE" 2>/dev/null)',
      `  [ -n "$MB" ] && git diff --numstat "$MB" 2>/dev/null | head -${MAX_DIFF_FILES} | sed 's/^/NUMSTAT=/'`,
      `  git ls-files --others --exclude-standard 2>/dev/null | head -50 | while IFS= read -r f; do [ -f "$f" ] && printf 'UNTRACKED=%s\\t%s\\n' "$(wc -l < "$f" | tr -d ' ')" "$f"; done`,
      'fi',
      `git status --porcelain=v1 -uall 2>/dev/null | head -500 > ${shellQuote(`${tmp}/dirty-${index}.txt`)}`,
      'exit 0',
    ].join('\n'),
    { timeoutMs: stepTimeoutMs(deadlineAt, 120_000, 'repo inspection') }
  );
  const values = parseKeyValues(result.stdout);
  const head = values.get('HEAD') || null;
  const localCommits = Number(values.get('LOCAL') ?? '0') || 0;
  const hasRemoteRefs = (values.get('REMOTE_REFS') ?? '') !== '';
  let dirtyFiles: string[] = [];
  try {
    dirtyFiles = (
      await fs.readFile(`${tmp}/dirty-${index}.txt`, readOpts(deadlineAt, 'dirty list'))
    )
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
  } catch {
    dirtyFiles = [];
  }
  const hasBundle = values.get('BUNDLE') === '1';
  const refs: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const match = /^REF=(refs\/\S+) ([0-9a-f]{40,64})$/.exec(line.trim());
    if (match !== null) refs[match[1]] = match[2];
  }
  const defaultRef = values.get('DEFAULT') ?? '';
  return {
    repo: {
      path: repoPath,
      bundle: hasBundle ? `repo-${index}.bundle` : null,
      head,
      branch: values.get('BRANCH') || null,
      remoteUrl: sanitizeRemoteUrl(values.get('REMOTE') ?? null),
      localCommits,
      pushed: head !== null && hasRemoteRefs && localCommits === 0,
      dirtyFiles,
      refs,
      defaultBranch: defaultRef.startsWith('origin/') ? defaultRef.slice('origin/'.length) : null,
      files: parseNumstat(result.stdout),
    },
    bundleFile: hasBundle ? bundleFile : null,
  };
}

/**
 * Shell for one repo: append its tracked files that are unchanged since HEAD to the
 * tar exclude list, and keep its deleted tracked files for restore. The repo stays
 * fully archived (nothing appended, no GITBACKED line) whenever git cannot replay it
 * exactly: sparse/assume-unchanged entries, submodules, tracked paths with a content filter (LFS), names
 * git quotes, or more deletions than the manifest should carry.
 */
function gitTrackedScan(repoPath: string, index: number): string {
  const dir = repoPath === '' ? '.' : repoPath;
  const prefix = repoPath === '' ? './' : `./${repoPath}/`;
  return [
    '(',
    `  cd ${shellQuote(dir)} || exit 0`,
    '  g() { git -c core.quotepath=false "$@"; }',
    "  if g ls-files 2>/dev/null | g check-attr --stdin filter 2>/dev/null | grep -q -v ': unspecified$'; then exit 0; fi",
    "  if g ls-files -v 2>/dev/null | grep -q -E '^([a-z]|S) '; then exit 0; fi",
    "  if g ls-files -s 2>/dev/null | grep -q -E '^160000 '; then exit 0; fi",
    '  g update-index -q --refresh >/dev/null 2>&1 || true',
    `  g diff-index --name-only HEAD > "$T/ch-${index}.txt" 2>/dev/null || exit 0`,
    `  g diff-index --name-only --diff-filter=D HEAD > "$T/del-${index}.txt" 2>/dev/null || exit 0`,
    `  g ls-files > "$T/all-${index}.txt" 2>/dev/null || exit 0`,
    `  if grep -q '^"' "$T/ch-${index}.txt" "$T/all-${index}.txt"; then exit 0; fi`,
    `  [ "$(wc -l < "$T/del-${index}.txt" | tr -d ' ')" -le ${MAX_DELETED_TRACKED_FILES} ] || exit 0`,
    `  P=${shellQuote(prefix)} awk 'FILENAME==ARGV[1]{m[$0]=1;next} !($0 in m){print ENVIRON["P"] $0}' "$T/ch-${index}.txt" "$T/all-${index}.txt" > "$T/omit-${index}.txt"`,
    `  cat "$T/omit-${index}.txt" >> "$T/tracked.txt"`,
    `  echo "GITBACKED=${index}"`,
    `  echo "OMITTED=${index} $(wc -l < "$T/omit-${index}.txt" | tr -d ' ')"`,
    ')',
  ].join('\n');
}

export interface CreateCheckpointParams {
  fs: CodeSessionFs;
  userId: string;
  codeSessionId: string;
  seq: number;
  reason: string;
  codeProvider: string;
  /** Merge target the per-file diff stats are measured against (null = default branch). */
  diffBase?: string | null;
  /**
   * Epoch ms the whole checkpoint must finish by (close: well inside the worker's
   * close timeout). Every step is bounded by it; past it the checkpoint throws.
   */
  deadlineAt?: number;
}

/** Capture HOME into a new checkpoint and upload it. Returns the manifest. */
export async function createCheckpoint(
  params: CreateCheckpointParams
): Promise<CheckpointManifest> {
  const { fs, userId, codeSessionId, seq, reason, codeProvider, deadlineAt } = params;
  const tmp = tmpDirFor(codeSessionId, seq, 'ckpt');
  const capBytes = maxArtifactBytes();
  const home = fs.home;
  const capKb = Math.max(1, Math.floor(maxFileBytes() / 1024));
  const prune = EXCLUDED_DIR_NAMES.map((name) => `-name ${shellQuote(name)}`).join(' -o ');
  const excludes = [
    '--anchored',
    ...EXCLUDED_TOP_LEVEL.map((name) => `--exclude=${shellQuote(`./${name}`)}`),
    '--no-wildcards',
    `--exclude-from=${shellQuote(`${tmp}/large.txt`)}`,
    `--exclude-from=${shellQuote(`${tmp}/tracked.txt`)}`,
    '--wildcards',
    '--no-anchored',
    ...EXCLUDED_DIR_NAMES.map((name) => `--exclude=${shellQuote(name)}`),
  ].join(' ');
  const scan = await fs.exec(
    [
      `T=${shellQuote(tmp)}`,
      'rm -rf "$T" && mkdir -p "$T" || exit 4',
      `cd ${shellQuote(home)} || exit 3`,
      `find . \\( ${prune} \\) -prune -o -type f -size +${capKb}k -print > "$T/large.txt"`,
      'find . -maxdepth 3 -name node_modules -prune -o -name .git -print | while read -r g; do',
      '  d=${g%/.git}; d=${d#./}; [ "$d" = "." ] && d=""; [ "$g" = "./.git" ] && d=""',
      '  echo "REPO=$d"',
      'done',
      `L=$(find ${shellQuote(cliLogDir(codeProvider))} -type f -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)`,
      'echo "CLILOG=$L"',
      'exit 0',
    ].join('\n'),
    { timeoutMs: stepTimeoutMs(deadlineAt, STEP_TIMEOUT_MS, 'scan') }
  );
  if (scan.exitCode !== 0) {
    throw new Error(
      `Checkpoint scan failed (exit ${scan.exitCode}): ${scan.stderr.slice(0, 500) || scan.stdout.slice(0, 500)}`
    );
  }

  try {
    const lines = scan.stdout.split('\n');
    const repoPaths = lines
      .filter((line) => line.startsWith('REPO='))
      .map((line) => line.slice('REPO='.length).trim());
    const cliLogLine = lines.find((line) => line.startsWith('CLILOG='));
    const cliLogPath = cliLogLine?.slice('CLILOG='.length).trim().replace(/^\.\//, '') || null;

    const artifacts = new Map<string, Buffer>();

    const repos: CheckpointRepo[] = [];
    for (const [index, repoPath] of [...new Set(repoPaths)].entries()) {
      const { repo, bundleFile } = await inspectRepo(
        fs,
        tmp,
        repoPath,
        index,
        params.diffBase ?? null,
        deadlineAt
      );
      if (bundleFile !== null && repo.bundle !== null) {
        artifacts.set(repo.bundle, await fs.readFile(bundleFile, readOpts(deadlineAt, 'bundle')));
      }
      repos.push(repo);
    }

    // The archive holds what git cannot reproduce. A repo's tracked files that are
    // unchanged since HEAD are git content: restore rebuilds them from the repo, so
    // a repo that outgrows the artifact cap (Rose) no longer fails every close.
    const gitRepos = repos
      .map((repo, index) => ({ repo, index }))
      .filter(({ repo }) => reproducibleFromGit(repo));
    const archive = await fs.exec(
      [
        `T=${shellQuote(tmp)}`,
        `cd ${shellQuote(home)} || exit 3`,
        ': > "$T/tracked.txt"',
        ...gitRepos.map(({ repo, index }) => gitTrackedScan(repo.path, index)),
        // The archive is never downloaded past the cap: head stops tar one byte
        // over it, and the size is reported so an over-cap archive is refused here.
        `tar -czf - ${excludes} -C ${shellQuote(home)} . | head -c ${capBytes + 1} > "$T/${WORKTREE_ARTIFACT}"`,
        'TAR_RC=${PIPESTATUS[0]}',
        `SIZE=$(wc -c < "$T/${WORKTREE_ARTIFACT}" | tr -d ' ')`,
        'echo "WORKTREE_BYTES=$SIZE"',
        `if [ "$SIZE" -gt ${capBytes} ]; then echo "WORKTREE_OVER_CAP=1"; exit 6; fi`,
        // GNU tar exits 1 when a file changed while it was read; still usable.
        'if [ "$TAR_RC" -gt 1 ]; then echo "TAR_FAILED=$TAR_RC"; exit 5; fi',
        'awk \'FILENAME==ARGV[1]{m[$0]=1;next} !($0 in m)\' "$T/tracked.txt" "$T/large.txt" > "$T/large-skipped.txt"',
        'exit 0',
      ].join('\n'),
      { timeoutMs: stepTimeoutMs(deadlineAt, STEP_TIMEOUT_MS, 'archive') }
    );
    if (archive.stdout.includes('WORKTREE_OVER_CAP=1')) {
      throw new Error(
        `Checkpoint worktree is over ${capBytes} bytes (cap); refusing to download or store`
      );
    }
    if (archive.exitCode !== 0) {
      throw new Error(
        `Checkpoint archive failed (exit ${archive.exitCode}): ${archive.stderr.slice(0, 500) || archive.stdout.slice(0, 500)}`
      );
    }
    for (const line of archive.stdout.split('\n')) {
      const backed = /^GITBACKED=(\d+)$/.exec(line.trim());
      if (backed === null) continue;
      const repo = repos[Number(backed[1])];
      if (repo === undefined) continue;
      repo.worktreeFromGit = true;
      repo.deletedFiles = (
        await fs.readFile(`${tmp}/del-${backed[1]}.txt`, readOpts(deadlineAt, 'deleted list'))
      )
        .toString('utf8')
        .split('\n')
        .filter(Boolean);
    }
    for (const line of archive.stdout.split('\n')) {
      const omitted = /^OMITTED=(\d+) (\d+)$/.exec(line.trim());
      const repo = omitted === null ? undefined : repos[Number(omitted[1])];
      if (omitted !== null && repo !== undefined) repo.gitOmittedFiles = Number(omitted[2]);
    }

    const sizeLine = archive.stdout.split('\n').find((line) => line.startsWith('WORKTREE_BYTES='));
    const reportedBytes = Number(sizeLine?.slice('WORKTREE_BYTES='.length).trim() ?? NaN);
    const sizeTimeoutMs =
      ARCHIVE_READ_BASE_MS +
      Math.ceil(
        ((Number.isFinite(reportedBytes) ? reportedBytes : capBytes) / ARCHIVE_READ_BYTES_PER_SEC) *
          1000
      );
    const worktree = await fs.readFile(`${tmp}/${WORKTREE_ARTIFACT}`, {
      timeoutMs: stepTimeoutMs(deadlineAt, sizeTimeoutMs, 'worktree download'),
    });
    if (worktree.length > capBytes) {
      throw new Error(
        `Checkpoint worktree is ${worktree.length} bytes (cap ${capBytes}); refusing to store`
      );
    }
    artifacts.set(WORKTREE_ARTIFACT, worktree);

    let cliSessionId: string | null = null;
    if (cliLogPath !== null) {
      const content = await fs.readFile(`${home}/${cliLogPath}`, readOpts(deadlineAt, 'CLI log'));
      artifacts.set(CLI_LOG_ARTIFACT, content);
      cliSessionId = cliSessionIdFromLog(codeProvider, cliLogPath, content);
    }

    let skippedLargeFiles: string[] = [];
    try {
      skippedLargeFiles = (
        await fs.readFile(`${tmp}/large-skipped.txt`, readOpts(deadlineAt, 'skipped list'))
      )
        .toString('utf8')
        .split('\n')
        .map((line) => line.replace(/^\.\//, ''))
        .filter(Boolean);
    } catch {
      skippedLargeFiles = [];
    }

    const manifest: CheckpointManifest = {
      version: 1,
      codeSessionId,
      userId,
      seq,
      reason,
      codeProvider,
      createdAt: new Date().toISOString(),
      artifacts: {},
      repos,
      cliSessionId,
      cliLogPath,
      skippedLargeFiles,
    };
    for (const [name, data] of artifacts) {
      stepTimeoutMs(deadlineAt, STEP_TIMEOUT_MS, `upload of ${name}`);
      await putCheckpointObject(checkpointKey(userId, codeSessionId, seq, name), data);
      manifest.artifacts[name] = { sha256: sha256(data), size: data.length };
    }
    await putCheckpointObject(
      checkpointKey(userId, codeSessionId, seq, MANIFEST_NAME),
      Buffer.from(JSON.stringify(manifest), 'utf8')
    );
    log.info('Checkpoint stored', {
      codeSessionId,
      seq,
      reason,
      artifacts: Object.keys(manifest.artifacts).join(','),
      bytes: String([...artifacts.values()].reduce((sum, data) => sum + data.length, 0)),
    });
    return manifest;
  } finally {
    await fs
      .exec(
        `rm -rf ${shellQuote(tmp)}`,
        deadlineAt === undefined ? undefined : { timeoutMs: 15_000 }
      )
      .catch(() => undefined);
  }
}

export interface VerifiedCheckpoint {
  manifest: CheckpointManifest;
  artifacts: Map<string, Buffer>;
}

/** Download a checkpoint and verify every artifact hash. Never touches a sandbox. */
export async function loadVerifiedCheckpoint(
  userId: string,
  codeSessionId: string,
  seq: number
): Promise<VerifiedCheckpoint> {
  const raw = await getCheckpointObject(checkpointKey(userId, codeSessionId, seq, MANIFEST_NAME));
  if (raw === null) throw new CheckpointIntegrityError(`Checkpoint ${seq} has no manifest`);
  let manifest: CheckpointManifest;
  try {
    manifest = JSON.parse(raw.toString('utf8')) as CheckpointManifest;
  } catch {
    throw new CheckpointIntegrityError(`Checkpoint ${seq} manifest is not valid JSON`);
  }
  if (
    manifest.version !== 1 ||
    manifest.codeSessionId !== codeSessionId ||
    manifest.userId !== userId ||
    manifest.seq !== seq ||
    typeof manifest.artifacts !== 'object' ||
    manifest.artifacts === null
  ) {
    throw new CheckpointIntegrityError(`Checkpoint ${seq} manifest does not match its session`);
  }
  const artifacts = new Map<string, Buffer>();
  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    const data = await getCheckpointObject(checkpointKey(userId, codeSessionId, seq, name));
    if (data === null) throw new CheckpointIntegrityError(`Checkpoint ${seq} is missing ${name}`);
    if (data.length !== expected.size || sha256(data) !== expected.sha256) {
      throw new CheckpointIntegrityError(`Checkpoint ${seq} artifact ${name} failed sha256 check`);
    }
    artifacts.set(name, data);
  }
  if (!artifacts.has(WORKTREE_ARTIFACT)) {
    throw new CheckpointIntegrityError(`Checkpoint ${seq} has no worktree archive`);
  }
  return { manifest, artifacts };
}

function safeRelativePath(path: string): boolean {
  return path === '' || (!path.startsWith('/') && !path.split('/').some((part) => part === '..'));
}

/**
 * Restore a verified checkpoint into fs.home: untar the worktree, rebuild every
 * repo (fetch its remote, then the incremental bundle of local-only commits,
 * then every recorded ref, HEAD and index) and put the CLI log back in place.
 */
export interface ApplyCheckpointOptions {
  /** Credentialed fetch URL for a repo's (sanitized) remote. */
  authRemoteUrl?: (remoteUrl: string) => string;
}

/** refs/heads/*, refs/tags/* and refs/stash: no option-looking or traversal names. */
const SAFE_REF = /^refs\/(?:heads\/|tags\/)?(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

export async function applyCheckpoint(
  fs: CodeSessionFs,
  checkpoint: VerifiedCheckpoint,
  options: ApplyCheckpointOptions = {}
): Promise<{ cliSessionId: string | null }> {
  const { manifest, artifacts } = checkpoint;
  const tmp = tmpDirFor(manifest.codeSessionId, manifest.seq, 'restore');
  const home = fs.home;
  try {
    await fs.exec(`rm -rf ${shellQuote(tmp)} && mkdir -p ${shellQuote(tmp)} ${shellQuote(home)}`);
    for (const [name, data] of artifacts) {
      await fs.writeFile(`${tmp}/${name}`, data);
    }
    const untar = await fs.exec(
      `tar -xzf ${shellQuote(`${tmp}/${WORKTREE_ARTIFACT}`)} -C ${shellQuote(home)}`,
      { timeoutMs: 300_000 }
    );
    if (untar.exitCode !== 0) {
      throw new Error(`Checkpoint untar failed: ${untar.stderr.slice(0, 500)}`);
    }
    for (const [repoIndex, repo] of (manifest.repos ?? []).entries()) {
      if (!safeRelativePath(repo.path)) continue;
      const bundle = repo.bundle !== null && artifacts.has(repo.bundle) ? repo.bundle : null;
      const refs = Object.entries(repo.refs ?? {}).filter(
        ([ref, sha]) => SAFE_REF.test(ref) && /^[0-9a-f]{40,64}$/.test(sha)
      );
      if (bundle === null && repo.remoteUrl === null && refs.length === 0) continue;
      const dir = repo.path === '' ? home : `${home}/${repo.path}`;
      const remote =
        repo.remoteUrl !== null
          ? (options.authRemoteUrl?.(repo.remoteUrl) ?? repo.remoteUrl)
          : null;
      // Tracked files the archive omitted come back from HEAD; files that were deleted
      // stay deleted. A path in the list that could leave the repo is never removed.
      const deleted = (repo.deletedFiles ?? []).filter(safeRelativePath);
      if (repo.worktreeFromGit === true) {
        await fs.writeFile(
          `${tmp}/deleted-${repoIndex}.txt`,
          Buffer.from(deleted.map((path) => `${path}\n`).join(''), 'utf8')
        );
      }
      const rebuildTracked =
        repo.worktreeFromGit === true
          ? [
              // Only files missing from the working tree: the archived (modified) ones stay.
              'git ls-files -d -z | git checkout-index -q -z --stdin',
              `while IFS= read -r f; do rm -f -- "$f"; done < ${shellQuote(`${tmp}/deleted-${repoIndex}.txt`)}`,
            ]
          : [];
      const setHead =
        repo.branch !== null
          ? `git symbolic-ref HEAD ${shellQuote(`refs/heads/${repo.branch}`)}`
          : repo.head !== null
            ? `git update-ref --no-deref HEAD ${shellQuote(repo.head)}`
            : 'true';
      const result = await fs.exec(
        [
          'set -e',
          `mkdir -p ${shellQuote(dir)} && cd ${shellQuote(dir)}`,
          '[ -d .git ] || git init -q',
          ...(remote !== null
            ? [
                `git remote set-url origin ${shellQuote(remote)} 2>/dev/null || git remote add origin ${shellQuote(remote)}`,
                // The incremental bundle's prerequisites live on the remote.
                "git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'",
                'git remote set-head origin -a >/dev/null 2>&1 || true',
              ]
            : []),
          ...(bundle !== null
            ? [`git fetch -q ${shellQuote(`${tmp}/${bundle}`)} '+refs/*:refs/rose-restore/*'`]
            : []),
          ...refs.map(([ref, sha]) => `git update-ref ${shellQuote(ref)} ${shellQuote(sha)}`),
          'git for-each-ref --format=\'%(refname)\' refs/rose-restore | while read -r r; do git update-ref -d "$r"; done',
          setHead,
          // Mixed reset: index matches HEAD, the restored working files stay.
          'git reset -q',
          ...rebuildTracked,
          'git config user.name >/dev/null || git config user.name "Rose Agent"',
          'git config user.email >/dev/null || git config user.email "agent@roselabs.ai"',
        ].join('\n'),
        // A fresh sandbox re-downloads the remote: a control-plane bound, not a session limit.
        { timeoutMs: 20 * 60_000 }
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Checkpoint repo restore failed for ${repo.path || '.'}: ${result.stderr.slice(0, 500)}`
        );
      }
    }
    const cliLog = artifacts.get(CLI_LOG_ARTIFACT);
    if (
      cliLog !== undefined &&
      manifest.cliLogPath !== null &&
      safeRelativePath(manifest.cliLogPath)
    ) {
      await fs.writeFile(`${home}/${manifest.cliLogPath}`, cliLog);
    }
    log.info('Checkpoint restored', {
      codeSessionId: manifest.codeSessionId,
      seq: String(manifest.seq),
      repos: String((manifest.repos ?? []).length),
    });
    return { cliSessionId: manifest.cliSessionId };
  } finally {
    await fs.exec(`rm -rf ${shellQuote(tmp)}`).catch(() => undefined);
  }
}
