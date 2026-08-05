/**
 * messaging-whatsapp: Baileys dynamic-import loader
 *
 * Baileys is an ESM-only package; a static import would break the CommonJS
 * Electron main build (TypeScript rewrites `import()` to `require()` under
 * `"module": "commonjs"`). We wrap it in a `Function` constructor so the real
 * dynamic import survives transpilation, and we memoize the result so repeat
 * connects don't re-import the module.
 *
 * Kept separate from `service.ts` so the WhatsAppClient class stays under the
 * strict max-lines cap.
 */
import fs from 'fs';
import type * as BaileysModule from '@whiskeysockets/baileys';

let baileys: typeof BaileysModule | null = null;

const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (
  path: string
) => Promise<unknown>;

/** Load the Baileys module lazily. Subsequent calls return the same instance. */
export async function loadBaileys(): Promise<typeof BaileysModule> {
  if (baileys === null) {
    baileys = (await dynamicImport('@whiskeysockets/baileys')) as typeof BaileysModule;
  }
  return baileys;
}

/** Reset the cached module instance. Exported for tests. */
export function resetBaileysCache(): void {
  baileys = null;
}

/** Minimal pino-like logger to silence Baileys' internal logs. */
interface SilentLogger {
  level: string;
  child: () => SilentLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
}

function makeSilentLogger(): SilentLogger {
  const logger: SilentLogger = {
    level: 'silent',
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  };
  return logger;
}

/**
 * Build a logger that appends Baileys' internal protocol chatter to
 * `WHATSAPP_DEBUG_LOG`. Without this, a server-side pairing rejection is
 * invisible — the silent logger swallows the stream error and all we observe
 * is a bare `connection closed`, which is indistinguishable from a QR timeout.
 *
 * Opt-in only; production keeps the silent logger.
 */
function makeDebugLogger(logPath: string): SilentLogger {
  const append = (level: string, args: unknown[]): void => {
    const line = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${line}\n`);
    } catch {
      // Never let diagnostics break the connection.
    }
  };

  const logger: SilentLogger = {
    level: 'trace',
    child: () => logger,
    trace: (...args: unknown[]) => append('trace', args),
    debug: (...args: unknown[]) => append('debug', args),
    info: (...args: unknown[]) => append('info', args),
    warn: (...args: unknown[]) => append('warn', args),
    error: (...args: unknown[]) => append('error', args),
    fatal: (...args: unknown[]) => append('fatal', args),
  };
  return logger;
}

/**
 * Logger handed to Baileys. Silent unless `WHATSAPP_DEBUG_LOG` names a file to
 * append protocol diagnostics to.
 */
export const silentBaileysLogger: SilentLogger = ((): SilentLogger => {
  const debugPath = process.env.WHATSAPP_DEBUG_LOG;
  return debugPath !== undefined && debugPath !== ''
    ? makeDebugLogger(debugPath)
    : makeSilentLogger();
})();
