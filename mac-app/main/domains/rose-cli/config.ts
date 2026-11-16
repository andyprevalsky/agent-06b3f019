/**
 * rose-cli — config layer
 */

export const LOG_TAG = 'RoseCli';

/** Renderer → main: (re)write the launcher if needed and return its path. */
export const ENSURE_INSTALLED_CHANNEL = 'roseCli:ensureInstalled';

/** The launcher, relative to the user's home. Never added to PATH or shell rc files. */
export const LAUNCHER_RELATIVE = '.rose/bin/rose';
export const LAUNCHER_MODE = 0o755;
/** Mode for ~/.rose and ~/.rose/bin when the app creates them (existing dirs are left alone). */
export const LAUNCHER_DIR_MODE = 0o700;

/** Packaged layout: <resources>/rose-cli/bin/rose.mjs (package.json build.extraResources). */
export const PACKAGED_CLI_DIR = 'rose-cli';
/** Dev layout: <repo>/scripts/lib/rose-sync/bin/rose.mjs. */
export const DEV_CLI_DIR = 'scripts/lib/rose-sync';
export const CLI_ENTRY_RELATIVE = 'bin/rose.mjs';
/** Compiled module dir (dist/main/main/domains/rose-cli) → repository root. */
export const COMPILED_DIR_TO_REPO_ROOT = '../../../../../..';

/** Import from this Mac (`rose import detect|scan|apply --json`). */
export const PICK_FOLDER_CHANNEL = 'roseCli:pickProjectFolder';
export const IMPORT_PROJECT_CHANNEL = 'roseCli:importProject';
export const CANCEL_IMPORT_CHANNEL = 'roseCli:cancelImport';
/** Main → renderer: one parsed stdout object per send, then the final exit. */
export const IMPORT_EVENT_CHANNEL = 'roseCli:importEvent';
export const PICK_FOLDER_TITLE = 'Choose a project to import';
export const PICK_FOLDER_BUTTON = 'Import';

/** Same format the backend mints (back-end/src/domains/projects/cliLoginService.ts). */
export const LOGIN_CODE_PATTERN = /^rlc_[A-Za-z0-9_-]{32}$/;
/** `import scan` reads the one-time code from here: argv is visible to every process (`ps`). */
export const LOGIN_CODE_ENV = 'ROSE_LOGIN_CODE';
export const IMPORT_AGENTS = ['codex', 'claude'] as const;
export const IMPORT_MAX_PROJECT_CHARS = 200;
export const IMPORT_MAX_URL_CHARS = 2_048;
/** Bound on one stdout line and on the serialized apply plan (plans can be large). */
export const IMPORT_MAX_JSON_CHARS = 16 * 1024 * 1024;
/** SIGTERM first; SIGKILL the process group if it is still running after this. */
export const IMPORT_CANCEL_GRACE_MS = 5_000;

export const IMPORT_BUSY_ERROR = 'An import is already running on this Mac.';
export const IMPORT_FAILED_MESSAGE = 'The import stopped before it finished.';
export const IMPORT_CANCELED_MESSAGE = 'The import was canceled.';
