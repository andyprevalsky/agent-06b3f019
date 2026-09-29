/**
 * FCaptcha flags `worker-hardware-concurrency-mismatch` when the page navigator
 * reports a spoofed hardwareConcurrency but a Web Worker still sees the host
 * value. Playwright/CDP init scripts do not run inside workers, and workers
 * expose `WorkerNavigator` (not `Navigator`) — the fingerprint script must wrap
 * Worker/SharedWorker and patch WorkerNavigator.prototype so the same navigator
 * props apply inside classic blob PoW workers.
 *
 * Repro: agent 7f8b9c24-9d64-4244-bac8-5f330b61b46d (browser-biometrics-webdecoy)
 * scored 0.168 with experimental detection worker-hardware-concurrency-mismatch
 * and bot reason "Page and Worker disagree on hardwareConcurrency".
 *
 * Follow-up (agent b08b5bd4): wrapping via `importScripts(originalBlobUrl)` races
 * FCaptcha's immediate `revokeObjectURL` after `new Worker(blob)` and surfaces
 * "Verification unavailable / Failed to execute 'importScripts'… blob:… failed
 * to load". The wrap must inline blob/data bodies before revoke, and this probe
 * cement that by revoking immediately after construction.
 */
import { buildFingerprintScript } from '../../providers/steel/injectionScripts';
import type { FingerprintData } from '../../providers/steel/types';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export async function testWorkerHardwareConcurrencyMatchesPage(
  makeFingerprint: () => FingerprintData
): Promise<void> {
  const { chromium } = await import('playwright');
  // Spoof a value that Chromium headless will not natively report (typical
  // headless Linux VMs report 2–4; Mac fingerprints use 8/10/12).
  const spoofedConcurrency = 10;
  const fp: FingerprintData = {
    ...makeFingerprint(),
    navigator: {
      ...makeFingerprint().navigator,
      hardwareConcurrency: spoofedConcurrency,
      deviceMemory: 8,
      platform: 'MacIntel',
    },
  };
  const script = buildFingerprintScript(fp);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(script);
    const page = await context.newPage();
    await page.goto('about:blank');

    const result = await page.evaluate(async () => {
      const pageHw = navigator.hardwareConcurrency;
      // Classic Worker via blob URL — the path FCaptcha PoW uses.
      const workerHw = await new Promise<{
        hw: number | null;
        errorMessage: string | null;
      }>((resolve) => {
        const body = `
          self.onmessage = () => {
            self.postMessage({ hw: self.navigator.hardwareConcurrency });
          };
        `;
        const url = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
        const worker = new Worker(url);
        // FCaptcha PoW revokes the blob URL immediately after construction.
        // importScripts(originalBlob) wrappers fail here with NetworkError.
        URL.revokeObjectURL(url);
        const timer = setTimeout(() => {
          worker.terminate();
          resolve({ hw: null, errorMessage: 'timeout' });
        }, 2000);
        worker.onmessage = (event: MessageEvent<{ hw: number }>) => {
          clearTimeout(timer);
          const hw = event.data?.hw ?? null;
          worker.terminate();
          resolve({ hw, errorMessage: null });
        };
        worker.onerror = (event: ErrorEvent) => {
          clearTimeout(timer);
          worker.terminate();
          resolve({
            hw: null,
            errorMessage: String(event?.message || event?.error || 'worker error'),
          });
        };
        worker.postMessage('probe');
      });
      return { pageHw, workerHw: workerHw.hw, workerError: workerHw.errorMessage };
    });

    assert(
      result.pageHw === spoofedConcurrency,
      `page navigator.hardwareConcurrency should be spoofed to ${spoofedConcurrency}, got ${result.pageHw}`
    );
    assert(
      result.workerHw !== null,
      `worker probe timed out or errored after immediate blob revoke` +
        (result.workerError ? ` (${result.workerError})` : '') +
        ` — blob Worker wrap must inline the script body, not importScripts the revoked URL`
    );
    assert(
      result.workerHw === spoofedConcurrency,
      `Worker navigator.hardwareConcurrency must match page spoof (${spoofedConcurrency}); ` +
        `got worker=${result.workerHw} page=${result.pageHw} — FCaptcha flags this as ` +
        `worker-hardware-concurrency-mismatch`
    );
  } finally {
    await browser.close();
  }
}
