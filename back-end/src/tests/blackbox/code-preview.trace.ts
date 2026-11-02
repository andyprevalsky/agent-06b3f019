/** Opt-in fixture diagnostics; no acceptance values or outcomes are changed. */
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

const TARGET = '/src/features/privacy/components/Privacy.tsx';
const CAP = 256;
const FRAME_BYTES = 32 * 1024;
const PHASES = new Set([
  'capture-start',
  'capture-gap',
  'watch-change',
  'hmr-hook',
  'transport-send',
  'module-request',
  'module-response',
  'transform-pre',
  'transform-post',
  'write-start',
  'write-end',
  'dom-receipt',
  'transport-received',
  'browser-module-request',
  'browser-module-response',
  'clock-calibration',
]);
const FIELDS = new Set([
  'nodeEpochMs',
  'nodeMonoMs',
  'viteEpochMs',
  'viteMonoMs',
  'hmrTimestamp',
  'requestTimestamp',
  'requestTimestampMissing',
  'target',
  'targetMatches',
  'ambiguous',
  'status',
  'edit',
  'wroteAt',
  'browserSeenAt',
  'latencyMs',
  'before',
  'after',
  'browserEpochMs',
  'browserMonoEpochMs',
  'eventCap',
  'droppedLowerBound',
  'captureIncomplete',
  'schemaVersion',
]);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
function project(phase: string, fields: Record<string, unknown>) {
  const out: Record<string, string | number> = { phase };
  for (const [key, value] of Object.entries(fields))
    if (FIELDS.has(key) && finite(value)) out[key] = value;
  return out;
}
function identity(raw: string) {
  if (raw.length > 2048) return null;
  const url = new URL(raw, 'http://127.0.0.1');
  if (!url.pathname.endsWith(TARGET)) return null;
  const values = url.searchParams.getAll('t');
  const timestamp = values.length === 1 && /^\d{1,16}$/.test(values[0]) ? Number(values[0]) : NaN;
  return {
    target: 1,
    ...(finite(timestamp) ? { requestTimestamp: timestamp } : { requestTimestampMissing: 1 }),
    ambiguous: finite(timestamp) ? 0 : 1,
  };
}

export function hmrObserver(frontEnd: string, home: string) {
  const output = process.env.ROSE_PREVIEW_HMR_TRACE_DIR;
  const enabled = Boolean(output);
  const events: object[] = [];
  let dropped = 0;
  const gaps = {
    oversizedFrames: 0,
    malformedFrames: 0,
    oversizedUpdates: 0,
    invalidTargets: 0,
    skippedFramesAtCap: 0,
    callbackErrors: 0,
  };
  const record = (phase: string, data: Record<string, unknown> = {}) => {
    if (!enabled) return;
    if (events.length < CAP)
      events.push(
        project(phase, { nodeEpochMs: Date.now(), nodeMonoMs: performance.now(), ...data })
      );
    else dropped++;
  };
  if (output) {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const configPath = join(frontEnd, 'vite.config.ts');
    const config = readFileSync(configPath, 'utf8');
    if (config.split('plugins: [react()],').length !== 2)
      throw new Error('HMR diagnostic fixture config shape changed');
    writeFileSync(
      join(frontEnd, '.rose-hmr-trace.mjs'),
      `
const target = '${TARGET}';
let count = 0, dropped = 0;
const emit = (phase, extra = {}) => { try { console.log('ROSE_HMR_TRACE ' + JSON.stringify({phase, viteEpochMs: Date.now(), viteMonoMs: performance.now(), ...extra})); } catch {} };
const event = (phase, extra = {}) => {
  if (++count <= 256) emit(phase, extra);
  else { dropped++; if (dropped === 1 || (dropped & (dropped - 1)) === 0) emit('capture-gap', {droppedLowerBound: dropped, captureIncomplete: 1, eventCap: 256}); }
};
const matches = id => typeof id === 'string' && id.length <= 2048 && id.split('?')[0].endsWith(target);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const identity = raw => {
  const url = new URL(raw, 'http://127.0.0.1');
  const values = url.searchParams.getAll('t');
  const t = values.length === 1 && /^\\d{1,16}$/.test(values[0]) ? Number(values[0]) : NaN;
  return {target: 1, ...(finite(t) ? {requestTimestamp: t} : {requestTimestampMissing: 1}), ambiguous: finite(t) ? 0 : 1};
};
event('capture-start', {schemaVersion: 2, eventCap: 256});
export function hmrTracePlugin(post = false) {
  return {
    name: post ? 'rose-hmr-diagnostic-post' : 'rose-hmr-diagnostic-pre', enforce: post ? 'post' : 'pre',
    transform(code, id) { if (matches(id)) event(post ? 'transform-post' : 'transform-pre', identity(id)); },
    ...(post ? {} : {
      configureServer(server) {
        const onChange = id => { if (matches(id)) event('watch-change', {target: 1}); };
        server.watcher.prependListener('change', onChange);
        const originalSend = server.hot.send;
        function send(...args) {
          try {
            const p = args[0];
            if (p && p.type === 'update' && Array.isArray(p.updates)) {
              if (p.updates.length > 64) event('capture-gap', {captureIncomplete: 1});
              else {
                const selected = p.updates.filter(u => u && matches(u.path));
                for (const u of selected) {
                  if (finite(u.timestamp)) event('transport-send', {target: 1, hmrTimestamp: u.timestamp, targetMatches: selected.length, ambiguous: selected.length === 1 ? 0 : 1});
                  else event('capture-gap', {captureIncomplete: 1});
                }
              }
            }
          } catch { event('capture-gap', {captureIncomplete: 1}); }
          return originalSend.apply(this, args);
        }
        server.hot.send = send;
        server.middlewares.use((req, res, next) => {
          try {
            if (matches(req.url)) {
              const id = identity(req.url);
              event('module-request', id);
              res.once('finish', () => event('module-response', {...id, status: res.statusCode}));
            }
          } catch { event('capture-gap', {captureIncomplete: 1}); }
          next();
        });
        server.httpServer?.once('close', () => {
          server.watcher.removeListener('change', onChange);
          if (server.hot.send === send) server.hot.send = originalSend;
        });
      },
      handleHotUpdate(ctx) { if (matches(ctx.file)) event('hmr-hook', {target: 1, ...(finite(ctx.timestamp) ? {hmrTimestamp: ctx.timestamp} : {captureIncomplete: 1})}); }
    })
  };
}
`
    );
    writeFileSync(
      configPath,
      "import { hmrTracePlugin } from './.rose-hmr-trace.mjs';\n" +
        config.replace(
          'plugins: [react()],',
          'plugins: [hmrTracePlugin(), react(), hmrTracePlugin(true)],'
        )
    );
  }
  return {
    enabled,
    record,
    attach(page: Page) {
      if (!enabled) return;
      page.on('websocket', (socket) =>
        socket.on('framereceived', (frame) => {
          if (events.length >= CAP) {
            gaps.skippedFramesAtCap++;
            return;
          }
          const payload = frame.payload;
          if (
            payload.length > FRAME_BYTES ||
            (typeof payload === 'string' && Buffer.byteLength(payload) > FRAME_BYTES)
          ) {
            gaps.oversizedFrames++;
            return;
          }
          try {
            const body = JSON.parse(
              typeof payload === 'string' ? payload : payload.toString('utf8')
            );
            if (body?.type !== 'update' || !Array.isArray(body.updates)) return;
            if (body.updates.length > 64) {
              gaps.oversizedUpdates++;
              return;
            }
            const selected = body.updates.filter(
              (u: { path?: unknown } | null) =>
                u &&
                typeof u.path === 'string' &&
                u.path.length <= 2048 &&
                u.path.split('?')[0].endsWith(TARGET)
            );
            for (const u of selected) {
              if (!finite(u.timestamp)) {
                gaps.invalidTargets++;
                continue;
              }
              record('transport-received', {
                target: 1,
                hmrTimestamp: u.timestamp,
                targetMatches: selected.length,
                ambiguous: selected.length === 1 ? 0 : 1,
              });
            }
          } catch {
            gaps.malformedFrames++;
          }
        })
      );
      page.on('request', (request) => {
        try {
          const id = identity(request.url());
          if (id) record('browser-module-request', id);
        } catch {
          gaps.callbackErrors++;
        }
      });
      page.on('response', (response) => {
        try {
          const id = identity(response.url());
          if (id) record('browser-module-response', { ...id, status: response.status() });
        } catch {
          gaps.callbackErrors++;
        }
      });
    },
    async clock(page: Page, edit: number) {
      const before = Date.now();
      const browser = await page.evaluate(() => ({
        epochMs: Date.now(),
        monoEpochMs: performance.timeOrigin + performance.now(),
      }));
      record('clock-calibration', {
        edit,
        before,
        after: Date.now(),
        browserEpochMs: browser.epochMs,
        browserMonoEpochMs: browser.monoEpochMs,
      });
    },
    save() {
      if (!output) return;
      const vite: object[] = [];
      const capture = {
        malformedLines: 0,
        invalidLines: 0,
        oversizedLines: 0,
        omittedFields: 0,
        skippedLines: 0,
        readFailure: 0,
        tailTruncated: 0,
        viteDroppedLowerBound: 0,
        viteDropCountExact: false,
        pairingRequiresUniqueTimestamp: true,
      };
      try {
        const fd = openSync(join(home, '.rose/preview/vite.log'), 'r');
        let text: string;
        try {
          const size = fstatSync(fd).size;
          const bytes = Buffer.alloc(Math.min(size, 512 * 1024));
          capture.tailTruncated = size > bytes.length ? 1 : 0;
          text = bytes
            .subarray(0, readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)))
            .toString('utf8');
        } finally {
          closeSync(fd);
        }
        for (const line of text.split('\n')) {
          if (!line.startsWith('ROSE_HMR_TRACE ')) continue;
          if (line.length > 4096) {
            capture.oversizedLines++;
            continue;
          }
          if (vite.length >= 320) {
            capture.skippedLines++;
            continue;
          }
          try {
            const entry = JSON.parse(line.slice(15));
            if (
              !entry ||
              !PHASES.has(entry.phase) ||
              !finite(entry.viteEpochMs) ||
              !finite(entry.viteMonoMs)
            ) {
              capture.invalidLines++;
              continue;
            }
            capture.omittedFields += Object.keys(entry).filter(
              (key) => key !== 'phase' && (!FIELDS.has(key) || !finite(entry[key]))
            ).length;
            vite.push(project(entry.phase, entry));
            if (finite(entry.droppedLowerBound))
              capture.viteDroppedLowerBound = Math.max(
                capture.viteDroppedLowerBound,
                entry.droppedLowerBound
              );
          } catch {
            capture.malformedLines++;
          }
        }
      } catch {
        capture.readFailure++;
      }
      try {
        writeFileSync(
          join(output, 'hmr-trace.json'),
          JSON.stringify(
            {
              diagnosticOnly: true,
              schemaVersion: 2,
              pid: process.pid,
              events,
              nodeDropped: dropped,
              gaps,
              vite,
              capture,
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
      } catch {
        process.stderr.write('HMR diagnostic collection failed; native outcome unchanged\n');
      }
    },
  };
}
