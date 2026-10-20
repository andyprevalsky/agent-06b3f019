/**
 * local-code-runner — config layer
 */
import type { LocalCodeProvider } from './types';

export const LOG_TAG = 'LocalCodeRunner';

/** Persisted device id + folder grants (encrypted electron-store). */
export const STORE_NAME = 'local-code-runner';

/** Backend endpoints (joined with config.apiUrl). */
export const REGISTER_PATH = '/api/local-devices/register';
export const CONTROL_PATH = '/api/local-devices/control';

/** Header the main process stamps on renderer requests and its own sockets. */
export const DEVICE_ID_HEADER = 'X-Rose-Device-Id';

/** Control-channel reconnect backoff: 1s, 2s, 4s ... capped at 30s. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** Bounded wait for ws-server.mjs to print its readiness record. */
export const WS_SERVER_READY_TIMEOUT_MS = 20_000;

/** Per-session scratch HOME (Claude/Codex config, logs) under userData. */
export const SESSIONS_DIR = 'local-code-sessions';
export const TERMINAL_LOG_FILE = 'terminal.log';

/** ws-server.mjs per provider, relative to the repo root (dev) or resources (packaged). */
export const WS_SERVER_RELATIVE: Record<LocalCodeProvider, string> = {
  claude: 'claude-code/ws-server.mjs',
  codex: 'codex-code/ws-server.mjs',
};
/** Packaged layout: resources/code-agent/<provider>/ws-server.mjs (+ node_modules/ws). */
export const PACKAGED_CODE_AGENT_DIR = 'code-agent';
/** Dev layout: <repo>/e2b-templates/<provider>/ws-server.mjs. */
export const DEV_TEMPLATES_DIR = 'e2b-templates';

/** Folders that can never be granted (too broad to be a working folder). */
export const FORBIDDEN_GRANT_ROOTS = [
  '/',
  '/System',
  '/Library',
  '/Applications',
  '/Users',
  '/private',
];

/** Only these keys of the Mac app's own environment reach a session. */
export const SESSION_ENV_ALLOWLIST = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

/** Backend-provided env keys a session may receive (never paths/PORT/HOME). */
export const SESSION_ENV_FROM_BACKEND = new Set([
  'CLAUDE_CODE_GOAL',
  'CLAUDE_CODE_MODEL',
  'CLAUDE_CODE_CREDENTIALS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODE_AGENT_SYSTEM_PROMPT',
  'CODEX_GOAL',
  'CODEX_MODEL',
  'CODEX_AUTH_JSON',
  'CODE_AGENT_HARNESS_MODE',
]);
