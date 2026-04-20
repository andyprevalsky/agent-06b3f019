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
  trace: () => void;
  debug: () => void;
  info: () => void;
  warn: () => void;
  error: () => void;
  fatal: () => void;
}

export const silentBaileysLogger: SilentLogger = ((): SilentLogger => {
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
})();
