/**
 * Platform checkpoints for persistent code sessions. They capture the exact
 * working state whether or not the agent committed anything:
 *
 *   HOME ──tar (minus caches/large/.git/credentials)──► worktree.tar.gz
 *   each git repo under HOME ──git bundle --all──────► repo-<n>.bundle
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

async function inspectRepo(
  fs: CodeSessionFs,
  tmp: string,
  repoPath: string,
  index: number
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
      `  git bundle create ${shellQuote(bundleFile)} --all >/dev/null 2>&1 && echo BUNDLE=1`,
      'fi',
      `git status --porcelain=v1 -uall 2>/dev/null | head -500 > ${shellQuote(`${tmp}/dirty-${index}.txt`)}`,
      'exit 0',
    ].join('\n')
  );
  const values = parseKeyValues(result.stdout);
  const head = values.get('HEAD') || null;
  const localCommits = Number(values.get('LOCAL') ?? '0') || 0;
  const hasRemoteRefs = (values.get('REMOTE_REFS') ?? '') !== '';
  let dirtyFiles: string[] = [];
  try {
    dirtyFiles = (await fs.readFile(`${tmp}/dirty-${index}.txt`))
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
  } catch {
    dirtyFiles = [];
  }
  const hasBundle = values.get('BUNDLE') === '1';
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
    },
    bundleFile: hasBundle ? bundleFile : null,
  };
}

export interface CreateCheckpointParams {
  fs: CodeSessionFs;
  userId: string;
  codeSessionId: string;
  seq: number;
  reason: string;
  codeProvider: string;
}

/** Capture HOME into a new checkpoint and upload it. Returns the manifest. */
export async function createCheckpoint(params: CreateCheckpointParams): Promise<CheckpointManifest> {
  const { fs, userId, codeSessionId, seq, reason, codeProvider } = params;
  const tmp = tmpDirFor(codeSessionId, seq, 'ckpt');
  const home = fs.home;
  const capKb = Math.max(1, Math.floor(maxFileBytes() / 1024));
  const prune = EXCLUDED_DIR_NAMES.map((name) => `-name ${shellQuote(name)}`).join(' -o ');
  const excludes = [
    '--anchored',
    ...EXCLUDED_TOP_LEVEL.map((name) => `--exclude=${shellQuote(`./${name}`)}`),
    '--no-wildcards',
    `--exclude-from=${shellQuote(`${tmp}/large.txt`)}`,
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
      `tar -czf "$T/${WORKTREE_ARTIFACT}" ${excludes} -C ${shellQuote(home)} .`,
      'TAR_RC=$?',
      // GNU tar exits 1 when a file changed while it was read; still usable.
      'if [ "$TAR_RC" -gt 1 ]; then echo "TAR_FAILED=$TAR_RC"; exit 5; fi',
      'find . -maxdepth 3 -name node_modules -prune -o -name .git -print | while read -r g; do',
      '  d=${g%/.git}; d=${d#./}; [ "$d" = "." ] && d=""; [ "$g" = "./.git" ] && d=""',
      '  echo "REPO=$d"',
      'done',
      `L=$(find ${shellQuote(cliLogDir(codeProvider))} -type f -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)`,
      'echo "CLILOG=$L"',
      'exit 0',
    ].join('\n'),
    { timeoutMs: 300_000 }
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
    const worktree = await fs.readFile(`${tmp}/${WORKTREE_ARTIFACT}`);
    if (worktree.length > maxArtifactBytes()) {
      throw new Error(
        `Checkpoint worktree is ${worktree.length} bytes (cap ${maxArtifactBytes()}); refusing to store`
      );
    }
    artifacts.set(WORKTREE_ARTIFACT, worktree);

    const repos: CheckpointRepo[] = [];
    for (const [index, repoPath] of [...new Set(repoPaths)].entries()) {
      const { repo, bundleFile } = await inspectRepo(fs, tmp, repoPath, index);
      if (bundleFile !== null && repo.bundle !== null) {
        artifacts.set(repo.bundle, await fs.readFile(bundleFile));
      }
      repos.push(repo);
    }

    let cliSessionId: string | null = null;
    if (cliLogPath !== null) {
      const content = await fs.readFile(`${home}/${cliLogPath}`);
      artifacts.set(CLI_LOG_ARTIFACT, content);
      cliSessionId = cliSessionIdFromLog(codeProvider, cliLogPath, content);
    }

    let skippedLargeFiles: string[] = [];
    try {
      skippedLargeFiles = (await fs.readFile(`${tmp}/large.txt`))
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
    await fs.exec(`rm -rf ${shellQuote(tmp)}`).catch(() => undefined);
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
  return (
    path === '' || (!path.startsWith('/') && !path.split('/').some((part) => part === '..'))
  );
}

/**
 * Restore a verified checkpoint into fs.home: untar the worktree, rebuild every
 * repo from its bundle (refs, HEAD, index) and put the CLI log back in place.
 */
export async function applyCheckpoint(
  fs: CodeSessionFs,
  checkpoint: VerifiedCheckpoint
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
    for (const repo of manifest.repos ?? []) {
      if (repo.bundle === null || !artifacts.has(repo.bundle) || !safeRelativePath(repo.path)) {
        continue;
      }
      const dir = repo.path === '' ? home : `${home}/${repo.path}`;
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
          `git fetch -q --update-head-ok ${shellQuote(`${tmp}/${repo.bundle}`)} '+refs/*:refs/*'`,
          setHead,
          // Mixed reset: index matches HEAD, the restored working files stay.
          'git reset -q',
          repo.remoteUrl !== null
            ? `git remote get-url origin >/dev/null 2>&1 || git remote add origin ${shellQuote(repo.remoteUrl)}`
            : 'true',
          'git config user.name >/dev/null || git config user.name "Rose Agent"',
          'git config user.email >/dev/null || git config user.email "agent@roselabs.ai"',
        ].join('\n'),
        { timeoutMs: 300_000 }
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Checkpoint repo restore failed for ${repo.path || '.'}: ${result.stderr.slice(0, 500)}`
        );
      }
    }
    const cliLog = artifacts.get(CLI_LOG_ARTIFACT);
    if (cliLog !== undefined && manifest.cliLogPath !== null && safeRelativePath(manifest.cliLogPath)) {
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
