/**
 * Shared project / codebase-sync types (backend side of the rose-sync wire
 * format; the capture side lives in mac-app/main/domains/code-sync).
 */

export type ProjectEnvFileKind = 'env' | 'config';
export type ProjectEnvFileSource = 'managed' | 'sync' | 'declared';

/** Non-secret description of a synced checkout (stored as JSON, greppable). */
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
  };
  /** Untracked symlinks in the checkout and how they are restored. */
  symlinks?: Array<{
    path: string;
    target: string;
    kind: 'internal' | 'external';
    /** Captured into this env/config file path (external links). */
    capturedAs?: string;
  }>;
  toolchain?: {
    node?: string | null;
    python?: string | null;
    toolVersions?: Record<string, string>;
    files?: Array<{ path: string; content: string }>;
  };
  setup?: { suggested: Array<{ dir: string; command: string; reason: string }> };
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
  };
  revision: number;
  manifest: ProjectSyncManifest | null;
  files: ProjectWorkspaceFile[];
  gitBundle: Buffer | null;
  uncommittedPatch: Buffer | null;
  /** Secret values to redact from startup output. Never serialized. */
  redactions: string[];
}

export type StartupStatus = 'ok' | 'failed' | 'timeout' | 'skipped';

export interface ProjectRestoreReport {
  projectId: string;
  revision: number;
  repoDir: string;
  checkout: { branch: string | null; headSha: string | null; cloned: boolean; error?: string };
  localWork: { stash: string | null; branches: string[]; patchPath: string | null };
  filesWritten: string[];
  symlinks: Array<{ path: string; target: string }>;
  startup: {
    status: StartupStatus;
    exitCode: number | null;
    durationMs: number;
    timeoutS: number;
    /** Redacted tail of combined output. */
    outputTail: string;
  };
  warnings: string[];
}
