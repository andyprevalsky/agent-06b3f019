/** Optional observer; never changes the scenario, assertion or test deadline. */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { readFile, writeFile } from 'node:fs/promises';
import { test as base, type Browser, type CDPSession } from '@playwright/test';
import { sanitizeTrace } from './folder-profile-data';

const START_MS = 3_000;
const FINAL_MS = 20_000;
const CLEANUP_MS = 5_000;
const INPUT_BYTES = 64 * 1024 * 1024;
type Complete = { stream?: string; dataLossOccurred?: boolean };
type Coverage = ReturnType<typeof sanitizeTrace>['coverage'];

/** Limits waiting, not the remote command. Cleanup must confirm stop or retire the browser. */
async function until<T>(end: number, operation: () => Promise<T>): Promise<T> {
  if (performance.now() >= end) throw new Error('observer-deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('observer-deadline')), end - performance.now());
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function scheduler(end: number) {
  try {
    const raw = await until(end, () => readFile('/proc/self/schedstat', 'utf8'));
    const v = raw.trim().split(/\s+/).map(Number);
    return v.length === 3 && v.every(Number.isFinite)
      ? { runNs: v[0], waitNs: v[1], timeslices: v[2] }
      : null;
  } catch {
    return null;
  }
}

class Capture {
  session?: CDPSession;
  result?: Complete;
  coverage?: Coverage;
  bytes = 0;
  started = false;
  endSent = false;
  stopped = false;
  closedStream = false;
  retired = false;
  reasons: string[] = [];
  phase:
    | 'start'
    | 'stop'
    | 'stream-read'
    | 'decoded-input-cap'
    | 'sanitize'
    | 'trace-write'
    | 'trace-attach' = 'start';
  private resolve!: (value: Complete) => void;
  private complete = new Promise<Complete>((resolve) => {
    this.resolve = resolve;
  });
  private listener = (value: Complete) => {
    this.result = {
      stream: typeof value.stream === 'string' ? value.stream : undefined,
      dataLossOccurred:
        typeof value.dataLossOccurred === 'boolean' ? value.dataLossOccurred : undefined,
    };
    this.stopped = true;
    this.resolve(value);
  };

  async start(browser: Browser, end: number) {
    this.session = await until(end, () => browser.newBrowserCDPSession());
    this.session.on('Tracing.tracingComplete', this.listener);
    this.started = true; // Unacknowledged start may still enable browser-wide tracing.
    await until(end, () =>
      this.session!.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        streamCompression: 'none',
        traceConfig: {
          recordMode: 'recordUntilFull',
          traceBufferSizeInKb: 32 * 1024,
          includedCategories: ['devtools.timeline', 'disabled-by-default-v8.cpu_profiler'],
        },
      }),
    );
    await until(end, () =>
      this.session!.send('Tracing.recordClockSyncMarker', { syncId: 'folder-profile-start' }),
    );
  }

  private async stop(end: number) {
    if (!this.session || !this.started || this.stopped) return;
    if (!this.endSent) {
      this.endSent = true;
      try {
        await until(end, () =>
          this.session!.send('Tracing.recordClockSyncMarker', { syncId: 'folder-profile-end' }),
        );
      } catch {
        this.reasons.push('end-marker-command-failed');
      }
      await until(end, () => this.session!.send('Tracing.end'));
    }
    await until(end, () => this.complete);
  }

  async save(end: number, path: string) {
    this.phase = 'stop';
    await this.stop(end);
    const stream = this.result?.stream;
    if (!stream || !this.session) throw new Error('no-stream');
    const chunks: Buffer[] = [];
    this.phase = 'stream-read';
    for (;;) {
      const part = await until(end, () =>
        this.session!.send('IO.read', { handle: stream, size: 256 * 1024 }),
      );
      const chunk = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
      this.bytes += chunk.length;
      if (this.bytes > INPUT_BYTES) {
        this.phase = 'decoded-input-cap';
        throw new Error('input-cap');
      }
      chunks.push(chunk);
      if (part.eof) break;
    }
    // Decoded-input cap, not total memory. Sync parsing cannot be timer-interrupted.
    this.phase = 'sanitize';
    const trace = sanitizeTrace(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    this.coverage = trace.coverage;
    this.phase = 'trace-write';
    await until(end, () => writeFile(path, JSON.stringify({ traceEvents: trace.traceEvents })));
  }

  async cleanup(browser: Browser, end: number) {
    try {
      // Reserve 3s of cleanup for retirement if CDP cannot be confirmed clean.
      const cdpEnd = Math.min(end - 3_000, performance.now() + 2_000);
      await this.stop(cdpEnd);
      if (!this.session) throw new Error('session-unconfirmed');
      if (this.result?.stream) {
        await until(cdpEnd, () => this.session!.send('IO.close', { handle: this.result!.stream! }));
        this.closedStream = true;
      }
      await until(cdpEnd, () => this.session!.detach());
    } catch {
      this.reasons.push('cleanup-unconfirmed');
      try {
        // Initiate retirement even if synchronous processing used up the deadline.
        const closing = browser.close({ reason: 'folder-profile-cleanup' });
        void closing.catch(() => undefined);
        await until(end, () => closing);
        this.retired = true;
      } catch {
        this.reasons.push('browser-retirement-unconfirmed');
      }
    } finally {
      this.session?.removeListener('Tracing.tracingComplete', this.listener);
    }
  }
}

export const test = base.extend<{ folderProfile: void }>({
  folderProfile: [
    async ({ browser }, use, info) => {
      // Opt-in only. Browser-wide CDP tracing with the V8 CPU profiler measurably
      // slows the case it observes: isolated on one core the 1280px body took
      // 35.5s with it and 25.3s without, so a CI default would spend a third of
      // the unchanged 90s deadline on diagnostics (RCA 2026-10-31-production-
      // semantic-gate-oversubscribed-two-vcpu-runner). Set
      // SEMANTIC_FOLDER_PROFILE=1 explicitly when a profile is wanted.
      const enabled = process.env.SEMANTIC_FOLDER_PROFILE ?? '0';
      if (enabled !== '1' || !info.title.endsWith('1280px')) {
        await use();
        return;
      }
      const capture = new Capture();
      const delay = monitorEventLoopDelay({ resolution: 20 });
      const started = performance.now();
      const cpu = process.cpuUsage();
      const rss = process.memoryUsage().rss;
      const startEnd = started + START_MS;
      delay.enable();
      let functionalError: unknown;
      let functionalThrew = false;
      let schedulerStart = null;
      try {
        schedulerStart = await scheduler(startEnd);
        try {
          await capture.start(browser, startEnd);
        } catch {
          capture.reasons.push('start-failed');
        }
        try {
          await use();
        } catch (error) {
          functionalError = error;
          functionalThrew = true;
        }
      } finally {
        const finished = performance.now();
        const finalEnd = finished + FINAL_MS;
        const nodeCpuUs = process.cpuUsage(cpu);
        const eventLoopMs = { max: delay.max / 1e6, p99: delay.percentile(99) / 1e6 };
        delay.disable();
        const finalizeCpu = process.cpuUsage();
        const finalizeRss = process.memoryUsage().rss;
        let schedulerEnd = null;
        try {
          schedulerEnd = await scheduler(finalEnd - 7_000);
          if (capture.started && !capture.reasons.length) {
            const path = info.outputPath('folder-browser-trace.json');
            await capture.save(finalEnd - 7_000, path);
            capture.phase = 'trace-attach';
            await until(finalEnd - 7_000, () =>
              info.attach('folder-browser-trace', { path, contentType: 'application/json' }),
            );
          }
        } catch {
          capture.reasons.push(`${capture.phase}-failed`);
        } finally {
          await capture.cleanup(
            browser,
            Math.min(finalEnd - 2_000, performance.now() + CLEANUP_MS),
          );
        }
        const coverage = capture.coverage;
        if (capture.result?.dataLossOccurred !== false)
          capture.reasons.push('data-loss-or-unknown');
        if (!coverage?.cpuNodes || !coverage.cpuSamples) capture.reasons.push('cpu-data-missing');
        if (!coverage?.timingEvents) capture.reasons.push('timing-data-missing');
        if (!coverage || coverage.mainFrameCommits < 2)
          capture.reasons.push('navigation-coverage-unconfirmed');
        if (!coverage?.markerStartPresent) capture.reasons.push('start-marker-missing');
        if (!coverage?.markerEndPresent) capture.reasons.push('end-marker-missing');
        const receipt = {
          capture: coverage ? (capture.reasons.length ? 'partial' : 'valid') : 'failed',
          reasons: capture.reasons,
          functionalOutcome: functionalThrew ? 'failed' : info.status,
          dataLossOccurred: capture.result?.dataLossOccurred ?? null,
          coverage,
          traceTimingUnits: 'microseconds',
          coverageLimit: 'observed-events-only-not-continuous-sampling-proof',
          decodedInputBytes: capture.bytes,
          decodedInputCapBytes: INPUT_BYTES,
          browserBufferKiB: 32768,
          cleanup: {
            stopped: capture.stopped,
            closedStream: capture.closedStream,
            browserRetired: capture.retired,
          },
          node: {
            cpuUs: nodeCpuUs,
            wallMs: finished - started,
            rssStartBytes: rss,
            schedulerStart,
            schedulerEnd,
            schedulerSource: 'node-main-thread-/proc/self/schedstat',
            schedulerUnavailableReason:
              schedulerStart && schedulerEnd ? null : 'unsupported-unreadable-or-deadline',
            eventLoopMs,
            browserProcessStats: 'unavailable',
          },
          finalizer: {
            elapsedMsBeforeMetadata: performance.now() - finished,
            cpuUsBeforeMetadata: process.cpuUsage(finalizeCpu),
            rssStartBytes: finalizeRss,
            rssBeforeMetadataBytes: process.memoryUsage().rss,
          },
          limitations: [
            'instrumentation-overhead',
            'sync-parse-not-interruptible',
            'input-cap-not-total-memory',
          ],
        };
        try {
          const metadataPath = info.outputPath('folder-runner-profile.json');
          await until(finalEnd, () => writeFile(metadataPath, JSON.stringify(receipt, null, 2)));
          await until(finalEnd, () =>
            info.attach('folder-runner-profile', {
              path: metadataPath,
              contentType: 'application/json',
            }),
          );
        } catch {
          info.annotations.push({ type: 'profile-error', description: 'metadata-attach-failed' });
        }
        if (capture.reasons.length)
          info.annotations.push({ type: 'profile-error', description: capture.reasons.join(',') });
      }
      if (functionalThrew) throw functionalError;
      if (capture.reasons.includes('cleanup-unconfirmed'))
        throw new Error('Diagnostic observer cleanup failed; restart worker');
    },
    { auto: true, timeout: 35_000 },
  ],
});
