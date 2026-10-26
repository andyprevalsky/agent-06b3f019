/**
 * Shared project / codebase-sync types (backend side of the rose-sync wire
 * format; the capture side lives in mac-app/main/domains/code-sync and is
 * shared by `scripts/rose-sync`).
 */

export type ProjectEnvFileKind = 'env' | 'config';
/** managed = Project settings, sync = codebase sync, declared = awaiting sync. */
export type ProjectEnvFileSource = 'managed' | 'sync' | 'declared';

export interface ProjectSymlinkRecord {
  /** Repo-relative path of the link. */
  path: string;
  /** Original link target exactly as read on the source machine. */
  target: string;
  /** internal = target inside the checkout; external = outside (content captured). */
  kind: 'internal' | 'external';
  /** Env/config file path whose content was captured for an external link. */
  capturedAs?: string;
}

/** Non-secret description of a synced checkout (stored as JSON). */
export interface ProjectSyncManifest {
  version: 1;
  source?: { client: string; host?: string; dir?: string; capturedAt?: string };
  git?: {
    remoteUrl: string | null;
    branch: string | null;
    headSha: string | null;
    /** Commits on local branches that no remote has. */
    unpushedCommits: number;
    /** Paths with uncommitted (staged, unstaged or untracked) changes. */
    dirtyPaths: string[];
    /** Full bundle (no remote) vs. unpushed-only bundle. */
    bundleKind?: 'full' | 'unpushed' | null;
    /** Local branch names carried by the bundle. */
    bundleBranches?: string[];
  };
  /** Untracked symlinks in the checkout and how they are restored. */
  symlinks?: ProjectSymlinkRecord[];
  toolchain?: {
    node?: string | null;
    python?: string | null;
    toolVersions?: Record<string, string>;
    /** Versions found on the capturing machine (informational). */
    localVersions?: Record<string, string>;
    files?: Array<{ path: string; content: string }>;
  };
  setup?: {
    /** Commands to run when the project has no startup script. */
    commands?: string[];
    /** Detected from lockfiles; reported, never run automatically. */
    suggested?: Array<{ dir: string; command: string; reason: string }>;
  };
  warnings?: string[];
}

export interface ProjectWorkspaceFile {
  path: string;
  kind: ProjectEnvFileKind;
  content: Buffer;
  linkTarget: string | null;
}

/** Everything a code session needs to materialize a project (decrypted, in memory only). */
export interface ProjectWorkspace {
  project: {
    id: string;
    name: string;
    repoUrl: string | null;
    defaultBranch: string;
    startupScript: string | null;
    startupTimeoutS: number;
    /** Default code-sandbox size {cpu, memoryGb} for new sessions (C16); null = deployment default. */
    sandboxSize?: unknown;
  };
  revision: number;
  manifest: ProjectSyncManifest | null;
  files: ProjectWorkspaceFile[];
  gitBundle: Buffer | null;
  uncommittedPatch: Buffer | null;
  /** Secret values to redact from startup output. Never serialized. */
  redactions: string[];
  /** Token-bearing clone URL, resolved by the caller after an access check. */
  cloneUrl?: string | null;
}

export type StartupStatus = 'ok' | 'failed' | 'timeout' | 'skipped';

export interface ProjectStartupReport {
  status: StartupStatus;
  exitCode: number | null;
  durationMs: number;
  timeoutS: number;
  /** Redacted tail of combined stdout/stderr. */
  outputTail: string;
  /** Session-side log path (redacted output, 0600). */
  logPath: string;
  startedAt: string;
  finishedAt: string;
}

export interface ProjectRestoreReport {
  projectId: string;
  projectName: string;
  revision: number;
  repoDir: string;
  checkout: {
    branch: string | null;
    headSha: string | null;
    cloned: boolean;
    source: 'remote' | 'bundle' | 'empty' | 'existing';
    error?: string;
  };
  localWork: { stash: string | null; branches: string[]; patchPath: string | null };
  filesWritten: string[];
  symlinks: Array<{ path: string; target: string }>;
  warnings: string[];
}
