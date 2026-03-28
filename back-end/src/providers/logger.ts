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

function formatExtra(extra: Record<string, unknown>): string {
  return Object.entries(extra)
    .map(([k, v]) => `${k}=${v}`)
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
    ...(extra || {}),
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
