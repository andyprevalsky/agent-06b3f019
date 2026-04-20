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

/**
 * RSA-2048 Public Key used to encrypt Claude credentials before upload.
 * The corresponding private key lives on the backend as
 * `CLAUDE_CREDENTIAL_DECRYPTION_KEY`.
 */
export const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyb0JJxUJ5Xb/agJKydem
vW7TwQiSMb2JWxNhErFx6BmKrLV/ISXVV/upVnb+P81ALRBNEvbtT+E20URnAv3H
nOjaHB/ZZRccfn6G9sQ/TtGcj/BD/PAOtmAC19CsZeHBCwExxuGnHh6K2mcUK40B
55jYGV0oJF8njalwEAUwWWu6H5Trs2OwvN06D+SrycccmMaAMkKQxgPsQEE+9bIT
uU2H4vZYBbnfXJJJw7pCCA7Tu1SfkFh8R+cp+gBL3G9xQPFtukwM2qFrpLBZP/qt
se+GalFwrA45LYFLKaLMdAUOy6Z+6Td/5sbhAT/3LPFnll1cSRwh8MlF/xeskYsr
kwIDAQAB
-----END PUBLIC KEY-----`;
