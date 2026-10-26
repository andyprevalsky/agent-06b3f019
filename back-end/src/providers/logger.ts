/**
 * Structured JSON Logger
 *
 * Outputs one-line JSON in production, pretty-prints with color in dev.
 *
 * Usage:
 *   import { createLogger } from './lib/logger';
 *   const log = createLogger('Agents');
 *   log.info('Agent created', { agent_id: '...', user_id: '...' });
 */

const isDev = process.env.NODE_ENV !== 'production';

// ANSI color codes for dev pretty-printing
const COLORS = {
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
} as const;

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Keys whose values must never reach a log sink (CWE-532).
 *
 * Dev pretty-printing used to interpolate context values, so objects collapsed
 * to `[object Object]` — which destroyed the context a log line exists to carry
 * (an RCA on SMS tool selection lost every tool call this way) while
 * incidentally hiding secrets. Serializing them properly means the redaction
 * now has to be explicit, on both the dev and production paths.
 */
const SENSITIVE_KEY_RE =
  /(pass(word|phrase)|secret|api[-_]?key|authorization|cookie|credential|otp|signature|private[-_]?key)/i;

/**
 * `token` is ambiguous: `access_token` is a credential, `promptTokens` is
 * telemetry we rely on. Credentials are strings; counts are numbers, so only
 * redact the string form and keep the accounting readable.
 */
const TOKEN_KEY_RE = /token/i;

function isSensitive(key: string, value: unknown): boolean {
  if (SENSITIVE_KEY_RE.test(key)) return true;
  return TOKEN_KEY_RE.test(key) && typeof value === 'string';
}

const MAX_SERIALIZED_VALUE_CHARS = 2000;

function redact(value: unknown, depth = 0): unknown {
  // JSON.stringify throws on bigint, which would take down the production
  // single-line JSON path for a value that is only ever telemetry.
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitive(key, entry) ? '[redacted]' : redact(entry, depth + 1);
  }
  return out;
}

/**
 * One log event is one line. Prisma errors begin with a newline, so a raw value
 * rendered as `error=` followed by the cause on later lines, which line-based
 * readers (guest evidence triage, agent_logs) recorded as an empty error.
 * Quote and escape any multi-line value instead of dropping or truncating it.
 */
function singleLine(text: string): string {
  return /[\r\n]/.test(text) ? JSON.stringify(text.trim()) : text;
}

function formatValue(value: unknown): string {
  // Error message/stack are non-enumerable, so JSON.stringify would emit `{}`
  // and throw away the only part worth logging.
  if (value instanceof Error) return singleLine(value.stack ?? `${value.name}: ${value.message}`);
  if (typeof value === 'string') return singleLine(value);
  if (value === null || typeof value !== 'object') return String(value);
  try {
    const serialized = JSON.stringify(redact(value)) ?? String(value);
    return serialized.length > MAX_SERIALIZED_VALUE_CHARS
      ? `${serialized.slice(0, MAX_SERIALIZED_VALUE_CHARS)}…[truncated]`
      : serialized;
  } catch {
    return String(value);
  }
}

function formatExtra(extra: Record<string, unknown>): string {
  return Object.entries(extra)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(' ');
}

function emit(
  level: LogLevel,
  component: string,
  message: string,
  extra?: Record<string, unknown>
) {
  const timestamp = new Date().toISOString();

  const entry: LogEntry = {
    timestamp,
    level,
    component,
    message,
    ...(redact(extra || {}) as Record<string, unknown>),
  };

  if (isDev) {
    // Pretty-print for dev readability
    const color = COLORS[level];
    const extraStr = extra && Object.keys(extra).length > 0 ? ' ' + formatExtra(extra) : '';
    const line = `${color}[${timestamp}] ${level.toUpperCase()} [${component}] ${message}${extraStr}${COLORS.reset}`;
    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  } else {
    // Single-line JSON for production
    const json = JSON.stringify(entry);
    if (level === 'error') {
      process.stderr.write(json + '\n');
    } else {
      process.stdout.write(json + '\n');
    }
  }
}

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger {
  return {
    info: (message: string, extra?: Record<string, unknown>) =>
      emit('info', component, message, extra),
    warn: (message: string, extra?: Record<string, unknown>) =>
      emit('warn', component, message, extra),
    error: (message: string, extra?: Record<string, unknown>) =>
      emit('error', component, message, extra),
  };
}
