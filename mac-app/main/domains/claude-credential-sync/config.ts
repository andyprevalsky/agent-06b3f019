/**
 * Configuration constants for the claude-credential-sync domain.
 *
 * Houses the Keychain service name, the RSA public key used for credential
 * encryption, and the command timeouts for the install/OAuth flow.
 */

/** macOS Keychain service identifier used by the Claude Code CLI. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Long-lived-token lifetime: 1 year. */
export const LONG_LIVED_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Timeout for `npm install -g @anthropic-ai/claude-code`. */
export const NPM_INSTALL_TIMEOUT_MS = 120_000;

/** Timeout for `claude setup-token` (OAuth browser flow). */
export const CLAUDE_SETUP_TOKEN_TIMEOUT_MS = 300_000;

/** Timeout for the shell-path probe when discovering PATH in packaged builds. */
export const SHELL_PATH_PROBE_TIMEOUT_MS = 3_000;

export { RSA_PUBLIC_KEY_PEM } from '../../base/credentialEncryption';
