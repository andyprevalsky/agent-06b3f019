import os from 'os';
import path from 'path';

export { RSA_PUBLIC_KEY_PEM } from '../../base/credentialEncryption';

/** Codex CLI auth file written by `codex login` for ChatGPT accounts. */
export const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');

/** Backend endpoint for encrypted Codex auth upload. */
export const GPT_CREDENTIAL_UPLOAD_PATH = '/api/integrations/gpt-code/credentials/upload';

/** npm package that provides the `codex` CLI. */
export const CODEX_NPM_PACKAGE = '@openai/codex';

/** Timeout for `npm install -g @openai/codex`. */
export const NPM_INSTALL_TIMEOUT_MS = 120_000;

/**
 * Timeout for the `codex --version` health probe.
 *
 * A `codex` shim can exist on PATH while its vendored platform binary is
 * missing (a partially-completed or interrupted npm install), in which case
 * every invocation fails with ENOENT. Probing catches that before we try to
 * drive a login through a broken CLI.
 */
export const CODEX_VERSION_PROBE_TIMEOUT_MS = 20_000;

/** Timeout for `codex login` (ChatGPT OAuth browser flow). */
export const CODEX_LOGIN_TIMEOUT_MS = 300_000;

/**
 * Cap for the short synchronous shell probes (`npm config get prefix`,
 * `which npm`). These run on the Electron main thread, so an unbounded hang in
 * a broken npm install would freeze the whole UI.
 */
export const SHELL_PROBE_TIMEOUT_MS = 10_000;

/** Grace period between SIGTERM and SIGKILL when reaping a timed-out child. */
export const KILL_ESCALATION_GRACE_MS = 5_000;
