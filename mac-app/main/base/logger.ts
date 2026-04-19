import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import util from 'util';

// Log files in the mac-app directory (for dev) or app data (for prod)
const getLogDir = () => {
  // In dev, use the project directory; in prod, use app data
  if (!app.isPackaged) {
    return path.resolve(__dirname, '../../../../');
  }
  return app.getPath('userData');
};

const CONSOLE_LOG_FILE = 'mac-app-console-logs.log';
const IPC_LOG_FILE = 'mac-app-ipc-logs.log';

let consoleStream: fs.WriteStream | null = null;
let ipcStream: fs.WriteStream | null = null;

// Store original console methods
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function getTimestamp(): string {
  return new Date().toISOString();
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      return util.inspect(arg, { depth: 2, colors: false });
    })
    .join(' ');
}

function formatLogMessage(
  level: string,
  component: string,
  message: string,
  data?: unknown
): string {
  const timestamp = getTimestamp();
  const dataStr = data !== undefined ? ` ${JSON.stringify(data).slice(0, 200)}` : '';
  return `[${timestamp}] [${level}] [${component}]${dataStr ? ' ' : ''}${message}${dataStr}\n`;
}

export function initLogger(): void {
  const logDir = getLogDir();

  // Clear and open log files
  const consolePath = path.join(logDir, CONSOLE_LOG_FILE);
  const ipcPath = path.join(logDir, IPC_LOG_FILE);

  // Truncate existing files
  try {
    fs.writeFileSync(consolePath, '');
    fs.writeFileSync(ipcPath, '');
  } catch (err) {
    originalConsoleError('Failed to initialize log files:', err);
  }

  consoleStream = fs.createWriteStream(consolePath, { flags: 'a' });
  ipcStream = fs.createWriteStream(ipcPath, { flags: 'a' });

  // Override console.log to capture all output
  console.log = (...args: unknown[]) => {
    const message = formatArgs(args);
    const timestamp = getTimestamp();
    consoleStream?.write(`[${timestamp}] [LOG] ${message}\n`);
    originalConsoleLog.apply(console, args);
  };

  // Override console.error to capture all errors
  console.error = (...args: unknown[]) => {
    const message = formatArgs(args);
    const timestamp = getTimestamp();
    consoleStream?.write(`[${timestamp}] [ERROR] ${message}\n`);
    originalConsoleError.apply(console, args);
  };

  // Override console.warn to capture all warnings
  console.warn = (...args: unknown[]) => {
    const message = formatArgs(args);
    const timestamp = getTimestamp();
    consoleStream?.write(`[${timestamp}] [WARN] ${message}\n`);
    originalConsoleWarn.apply(console, args);
  };

  originalConsoleLog(`[Logger] Console logs: ${consolePath}`);
  originalConsoleLog(`[Logger] IPC logs: ${ipcPath}`);
}

export function logConsole(component: string, message: string, data?: unknown): void {
  // Just call console.log - the override handles writing to file
  console.log(`[${component}] ${message}`, data !== undefined ? data : '');
}

export function logConsoleError(component: string, message: string, error?: unknown): void {
  // Just call console.error - the override handles writing to file
  console.error(`[${component}] ${message}`, error !== undefined ? error : '');
}

export function logIpc(direction: 'IN' | 'OUT', channel: string, data?: unknown): void {
  const formatted = formatLogMessage(direction, 'IPC', channel, data);
  ipcStream?.write(formatted);
}

export function closeLogger(): void {
  consoleStream?.end();
  ipcStream?.end();
  consoleStream = null;
  ipcStream = null;
}

/**
 * Extract a human-readable message from any caught error value.
 * Catch variables are typed as `unknown` under strict TypeScript; use this
 * helper instead of annotating catches with `any` to keep lint + types happy.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? String(error);
  } catch {
    return String(error);
  }
}
