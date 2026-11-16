/**
 * rose-cli — types layer
 *
 * The Rose Mac app provides the `rose` CLI itself (scripts/lib/rose-sync,
 * bundled as Resources/rose-cli), so importing a project from this Mac never
 * needs `npm i -g @roselabs.ai/cli`.
 */

import type { RoseCliImportAgent } from '../../../shared/types/ipc';

export type {
  RoseCliFolderPickResult,
  RoseCliImportEvent,
  RoseCliImportRequest,
  RoseCliImportStartResult,
  RoseCliInstallResult,
} from '../../../shared/types/ipc';

/** Where the launcher lives and what it runs. */
export interface LauncherTarget {
  /** Absolute launcher path (~/.rose/bin/rose). */
  launcherPath: string;
  /** The running app's own binary, run as Node (ELECTRON_RUN_AS_NODE). */
  execPath: string;
  /** The bundled CLI entry (<resources>/rose-cli/bin/rose.mjs). */
  cliEntry: string;
}

/** The filesystem the installer needs (repo.ts implements it). */
export interface LauncherIo {
  exists: (p: string) => Promise<boolean>;
  /** Current launcher text and permission bits, or null when it does not exist. */
  readLauncher: (p: string) => Promise<{ content: string; mode: number } | null>;
  /** Atomically replace the launcher (missing dirs created 0700, file 0755). */
  writeLauncher: (p: string, content: string) => Promise<void>;
}

/** An import request after validation (the plan already serialized for stdin). */
export type ValidImportRequest =
  | { action: 'detect' }
  | {
      action: 'scan';
      folder: string;
      loginCode: string;
      apiUrl: string;
      project?: string;
      agent?: RoseCliImportAgent;
    }
  | { action: 'apply'; folder: string; planJson: string; githubImport: boolean; apiUrl: string };

/** `rose` arguments for one request; `folder` is the cwd (null → the user's home). */
export interface ImportInvocation {
  args: string[];
  /** Extra environment for this run only (the scan login code; never on argv). */
  env: Record<string, string>;
  folder: string | null;
  stdin: string | null;
}

/** The launcher process to start (argv-style, never through a shell). */
export interface ImportSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin then closed; null → no stdin. */
  stdin: string | null;
}

/** A running import (repo.ts wraps child_process; tests use fakes). */
export interface ImportChild {
  onStdout: (listener: (chunk: string) => void) => void;
  /** Exactly once: the exit code, or null when killed by a signal or it never started. */
  onClose: (listener: (code: number | null) => void) => void;
  /** Signal the whole process group (the CLI and the agent it runs). */
  kill: (signal: NodeJS.Signals) => void;
}
