/**
 * agent-tools blackbox cases: displayed content actually renders, isolated.
 * Registered by agent-tools.blackbox.ts. Headless Chromium (the rose-ui CLI's
 * launcher: SwiftShader software GL) loads the served display URLs inside an
 * embedder page that frames them exactly like the FE contract:
 *
 *   http://127.0.0.1:<port>/host  (a Rose dev origin; local embedder server)
 *     └─ <iframe sandbox="allow-scripts allow-pointer-lock allow-popups" src=usercontent URL>
 *          three.js CDN page / .glb model viewer ─► WebGL pixels (PNG probe)
 *          probes: origin "null"; cookie, localStorage, parent.document refused
 *   http://rose-evil.test:<port>/host (same server, host-resolver mapped)
 *     └─ frame-ancestors refuses the same URL
 *   /host?fit=1 sizes the frame from its rose:resize messages like an expanded
 *     chat display (200..10000 px): served pages report their content height
 *
 * The embedder is a real loopback server, not a route fulfilment: Chromium's
 * Local Network Access checks block a "public" (fulfilled) page from framing
 * a loopback backend.
 *   top-level open of the URL ─► still an opaque origin (CSP sandbox)
 *
 * CDN modules (jsDelivr three@0.160.1) are fulfilled from the installed `three`
 * package so the check is hermetic; the CSP is still enforced on the real CDN
 * URL. DISPLAY_RENDER_LIVE_CDN=1 loads the real CDN instead.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';
import { dirname, join, resolve, sep } from 'path';
import { userUiAssetsDir } from '../../providers/userUi/seed';
import { threeCdnPage } from './agent-tools-display.cases';
import {
  assert,
  b64,
  BASE_URL,
  cubeGlb,
  display,
  items,
  otherA,
  RUN,
  storedBytes,
  userA,
  type BlackboxTest,
} from './agent-tools.support';

interface Png {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}
interface Frame {
  url(): string;
  evaluate<T>(fn: (() => T) | string): Promise<T>;
  waitForFunction(fn: () => unknown, arg?: unknown, opts?: { timeout: number }): Promise<unknown>;
}
interface Page {
  goto(url: string): Promise<unknown>;
  frames(): Frame[];
  mainFrame(): Frame;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): { screenshot(): Promise<Buffer> };
  on(event: 'console', fn: (msg: { text(): string }) => void): void;
}
interface Route {
  request(): { url(): string };
  fulfill(response: {
    status: number;
    body?: string | Buffer;
    headers?: Record<string, string>;
  }): Promise<void>;
}
interface Context {
  route(url: RegExp, handler: (route: Route) => Promise<void> | void): Promise<void>;
  newPage(): Promise<Page>;
}
interface Browser {
  newContext(opts: { viewport: { width: number; height: number } }): Promise<Context>;
  close(): Promise<void>;
}

const localRequire = createRequire(__filename);
const cli = localRequire(join(userUiAssetsDir(), 'bin', 'rose-ui.cjs')) as {
  launchBrowser(opts?: { noWebgpu?: boolean; args?: string[] }): Promise<Browser>;
  decodePng(buf: Buffer): Png;
};
const THREE_DIR = resolve(dirname(localRequire.resolve('three')), '..');
const THREE_CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.160\.1\//;
const SANDBOX = 'allow-scripts allow-pointer-lock allow-popups';
const FOREIGN_HOSTNAME = 'rose-evil.test';

/** Applies rose:resize from the frame the way an expanded chat display does. */
const FIT_FRAME_SCRIPT =
  `<script>addEventListener('message', (event) => {` +
  `const f = document.getElementById('f');` +
  `if (event.source !== f.contentWindow || event.data?.type !== 'rose:resize') return;` +
  `f.style.height = Math.min(10000, Math.max(200, Math.round(event.data.height))) + 'px';` +
  `});</script>`;

const hostHtml = (src: string, fit = false) =>
  `<!doctype html><html><body style="margin:0;background:#fff">` +
  `<iframe id="f" sandbox="${SANDBOX}" src="${src}" style="border:0;width:640px;height:400px;display:block"></iframe>` +
  (fit ? FIT_FRAME_SCRIPT : '') +
  `</body></html>`;

/** The URL this test's backend serves for a display usercontent URL. */
export const local = (url: string) => {
  const parsed = new URL(url);
  return `${BASE_URL}${parsed.pathname}`;
};

interface Hosts {
  rose: string;
  foreign: string;
}

export async function withBrowser(
  fn: (page: Page, logs: string[], hosts: Hosts) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    const params = new URL(req.url ?? '/', 'http://x').searchParams;
    const html = hostHtml(params.get('src') ?? '', params.get('fit') === '1');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const hosts = {
    rose: `http://127.0.0.1:${port}/host`,
    foreign: `http://${FOREIGN_HOSTNAME}:${port}/host`,
  };
  const browser = await cli.launchBrowser({
    noWebgpu: true,
    args: [`--host-resolver-rules=MAP ${FOREIGN_HOSTNAME} 127.0.0.1`],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
    if (process.env.DISPLAY_RENDER_LIVE_CDN !== '1') {
      await context.route(THREE_CDN, (route) => {
        const rel = new URL(route.request().url()).pathname.replace(
          /^\/npm\/three@0\.160\.1\//,
          ''
        );
        const file = resolve(THREE_DIR, rel);
        if (!file.startsWith(THREE_DIR + sep) || !existsSync(file)) {
          return route.fulfill({ status: 404, body: 'not found' });
        }
        return route.fulfill({
          status: 200,
          body: readFileSync(file),
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'access-control-allow-origin': '*',
          },
        });
      });
    }
    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (msg) => logs.push(msg.text()));
    await fn(page, logs, hosts);
  } finally {
    await browser.close();
    server.close();
  }
}

export async function displayFrame(page: Page, url: string, host: string): Promise<Frame> {
  await page.goto(`${host}?src=${encodeURIComponent(url)}`);
  for (let i = 0; i < 100; i += 1) {
    const frame = page.frames().find((f) => f !== page.mainFrame());
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error('display iframe never attached');
}

export async function waitReady(frame: Frame, logs: string[], label: string) {
  await frame
    .waitForFunction(
      () => ['ready', 'error'].includes(document.documentElement.dataset.state ?? ''),
      undefined,
      { timeout: 45_000 }
    )
    .catch(() => undefined);
  const state = await frame.evaluate(() => ({
    state: document.documentElement.dataset.state ?? null,
    status: document.getElementById('status')?.textContent ?? null,
  }));
  assert(
    state.state === 'ready',
    `${label}: ${JSON.stringify(state)} logs=${logs.slice(-5).join(' | ')}`
  );
}

/** Fraction of pixels matching `test` in a PNG screenshot. */
export function fraction(png: Buffer, test: (r: number, g: number, b: number) => boolean): number {
  const img = cli.decodePng(png);
  let hits = 0;
  for (let i = 0; i < img.width * img.height; i += 1) {
    const o = i * img.channels;
    if (test(img.data[o], img.data[o + 1], img.data[o + 2])) hits += 1;
  }
  return hits / (img.width * img.height);
}

export const reddish = (r: number, g: number, b: number) => r > 110 && r > g * 1.8 && r > b * 1.8;

/** Preserve the bytes already measured, without replacing the pixel verdict. */
export function retainFailedRenderSample(
  png: Buffer,
  measured: number,
  minimum: number,
  label: string,
  artifactRoot = process.env.BLACKBOX_TEST_ARTIFACT_DIR
): string | undefined {
  if (measured > minimum || !artifactRoot) return;
  try {
    const directory = join(artifactRoot, `render-failure-${process.pid}-${randomUUID()}`);
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, 'sample.png'), png, { flag: 'wx', mode: 0o600 });
    writeFileSync(
      join(directory, 'sample.json'),
      JSON.stringify({
        label,
        measured,
        minimum,
        bytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
      }) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    return directory;
  } catch (error) {
    process.stderr.write(
      `Render sample retention failed: ${error instanceof Error ? error.name : 'unknown'}\n`
    );
    return;
  }
}

/**
 * Runs inside the display frame. A string, not a function: tsx's keepNames
 * helper (__name) does not exist in the page.
 */
const ISOLATION_PROBE = `(() => {
  const attempt = (fn) => { try { fn(); return 'readable'; } catch (err) { return err.name; } };
  return {
    origin: self.origin,
    cookie: attempt(() => document.cookie),
    storage: attempt(() => window.localStorage.length),
    parent: attempt(() => window.parent.document.title),
  };
})()`;

export function isolationProbe(frame: Frame) {
  return frame.evaluate<{ origin: string; cookie: string; storage: string; parent: string }>(
    ISOLATION_PROBE
  );
}

/** Polls the host frame's height until `want` holds (10 s), returning it. */
async function frameHeightWhen(page: Page, want: (height: number) => boolean, label: string) {
  let height = 0;
  for (let i = 0; i < 100; i += 1) {
    height = await page
      .mainFrame()
      .evaluate(() => document.getElementById('f')?.getBoundingClientRect().height ?? 0);
    if (want(height)) return height;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label}: frame height ${height}px`);
}

/**
 * An SVG display is only ever an image. Chromium loads the SVG's stored bytes
 * (served as image/svg+xml, as storage does) through <img>, exactly like the FE,
 * and the SVG's <script> and onload try to hit a loopback beacon: nothing may
 * arrive. Opening the same bytes as a document (the positive control) does run
 * them, which is why signed SVG URLs force a download.
 */
async function svgBeaconHits(
  storagePath: string
): Promise<{ image: string[]; document: string[] }> {
  const hits: string[] = [];
  let svg = Buffer.alloc(0);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.startsWith('/beacon')) {
      hits.push(req.url ?? '');
      res.writeHead(204).end();
    } else if (path === '/chart.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(svg);
    } else {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><img id="i" src="/chart.svg" alt="chart">');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stored = storedBytes(storagePath);
  assert(stored, 'svg render check needs the local display store');
  svg = Buffer.from(stored.toString('utf8').replaceAll('BEACON_ORIGIN', origin));
  const browser = await cli.launchBrowser({ noWebgpu: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/host`);
    await page.waitForFunction(() => {
      const img = document.getElementById('i') as HTMLImageElement | null;
      return img !== null && img.complete && img.naturalWidth > 0;
    });
    await page.waitForTimeout(1500);
    const image = [...hits];
    await page.goto(`${origin}/chart.svg`);
    await page.waitForTimeout(1500);
    return { image, document: hits.slice(image.length) };
  } finally {
    await browser.close();
    server.close();
  }
}

export function displayRenderCases(): BlackboxTest[] {
  return [
    {
      name: 'render: a displayed SVG never runs its script or onload as an <img> (a document would)',
      fn: async () => {
        const svg = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" ` +
            `onload="fetch('BEACON_ORIGIN/beacon?onload')">` +
            `<script>fetch('BEACON_ORIGIN/beacon?script')</script>` +
            `<rect width="40" height="20" fill="red"/><desc>${RUN}</desc></svg>`
        );
        const res = await display(
          otherA,
          { items: [b64(svg, 'chart.svg')] },
          { apiKeyUser: userA }
        );
        assert(res.status === 201 || res.status === 200, `display svg ${res.status}`);
        const item = items(res)[0];
        assert(
          item.mime_type === 'image/svg+xml' && item.kind === 'image',
          `${item.kind} ${item.mime_type}`
        );
        const { image, document } = await svgBeaconHits(item.file_pointer.storage_path);
        assert(image.length === 0, `svg script ran inside <img>: ${JSON.stringify(image)}`);
        assert(
          document.length > 0,
          'positive control: the same svg opened as a document must run (else the probe proves nothing)'
        );
      },
    },
    {
      name: 'render: failed pixel evidence preserves the measured PNG and leaves the verdict unchanged',
      fn: async () => {
        const directory = mkdtempSync(join(tmpdir(), 'rose-render-evidence-'));
        try {
          const res = await display(
            otherA,
            { items: [b64(Buffer.from(threeCdnPage(`evidence-${RUN}`)), 'cube.html')] },
            { apiKeyUser: userA }
          );
          assert(res.status === 201 || res.status === 200, `display page ${res.status}`);
          const url = local(items(res)[0].file_pointer.usercontent_url ?? '');
          await withBrowser(async (page, logs, hosts) => {
            const frame = await displayFrame(page, url, hosts.rose);
            await waitReady(frame, logs, 'render evidence control');
            await page.waitForTimeout(300);
            const positive = await page.locator('#f').screenshot();
            const positiveRed = fraction(positive, reddish);
            assert(positiveRed > 0.04, 'positive control has real WebGL pixels');
            assert(
              retainFailedRenderSample(positive, positiveRed, 0.04, 'positive', directory) ===
                undefined,
              'healthy sample creates no failure artifact'
            );
            await frame.evaluate(() => {
              const canvas = document.querySelector('canvas');
              const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
              if (!gl) throw new Error('real WebGL control unavailable');
              gl.getExtension('WEBGL_lose_context')?.loseContext();
            });
            await frame.waitForFunction(
              () => document.querySelector('canvas')?.getContext('webgl2')?.isContextLost(),
              undefined,
              { timeout: 5000 }
            );
            const negative = await page.locator('#f').screenshot();
            const negativeRed = fraction(negative, reddish);
            assert(!(negativeRed > 0.04), 'lost context still fails the original pixel predicate');
            const retained = retainFailedRenderSample(
              negative,
              negativeRed,
              0.04,
              'context-loss control',
              directory
            );
            assert(retained, 'failed sample was retained');
            assert(
              readFileSync(join(retained, 'sample.png')).equals(negative),
              'retained PNG is exactly the measured buffer'
            );
            const receipt = JSON.parse(readFileSync(join(retained, 'sample.json'), 'utf8'));
            assert(
              receipt.measured === negativeRed && receipt.minimum === 0.04,
              'original measurement and threshold retained'
            );
            assert(
              receipt.sha256 === createHash('sha256').update(negative).digest('hex'),
              'PNG receipt hashes the measured bytes'
            );
            assert(
              retainFailedRenderSample(
                negative,
                negativeRed,
                0.04,
                'write-error control',
                join(directory, 'absent', 'parent')
              ) === undefined,
              'retention write error does not replace the pixel verdict'
            );
          });
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'render: a three.js CDN page draws WebGL pixels in the sandboxed frame, isolated from Rose',
      fn: async () => {
        const res = await display(
          otherA,
          { items: [b64(Buffer.from(threeCdnPage(`render-${RUN}`)), 'cube.html')] },
          { apiKeyUser: userA }
        );
        assert(res.status === 201 || res.status === 200, `display page ${res.status}`);
        const url = local(items(res)[0].file_pointer.usercontent_url ?? '');
        await withBrowser(async (page, logs, hosts) => {
          const frame = await displayFrame(page, url, hosts.rose);
          await waitReady(frame, logs, 'three.js CDN page');
          const features = await frame.evaluate(() => ({
            wasm: document.documentElement.dataset.wasm,
            margin: getComputedStyle(document.body).margin,
          }));
          assert(features.wasm === 'ready', 'sandbox permits WebAssembly compilation');
          assert(features.margin === '0px', 'inline CSS is applied');
          await page.waitForTimeout(300);
          const shot = await page.locator('#f').screenshot();
          const red = fraction(shot, reddish);
          retainFailedRenderSample(shot, red, 0.04, 'WebGL cube');
          assert(red > 0.04, `WebGL cube pixels: ${(red * 100).toFixed(2)}% red`);
          const probe = await isolationProbe(frame);
          assert(probe.origin === 'null', `opaque origin: ${JSON.stringify(probe)}`);
          assert(probe.cookie === 'SecurityError', `no cookies: ${JSON.stringify(probe)}`);
          assert(probe.storage === 'SecurityError', `no storage: ${JSON.stringify(probe)}`);
          assert(probe.parent === 'SecurityError', `no parent DOM: ${JSON.stringify(probe)}`);
          process.stdout.write(`    three.js CDN page: ${(red * 100).toFixed(1)}% red pixels\n`);
        });
      },
    },
    {
      name: 'render: the .glb model viewer renders the model (orbit controls, auto-framed)',
      fn: async () => {
        const res = await display(
          otherA,
          { items: [b64(cubeGlb([1, 0.05, 0.05, 1], `render-${RUN}`), 'red-cube.glb')] },
          { apiKeyUser: userA }
        );
        assert(res.status === 201 || res.status === 200, `display glb ${res.status}`);
        const url = local(items(res)[0].file_pointer.usercontent_url ?? '');
        await withBrowser(async (page, logs, hosts) => {
          const frame = await displayFrame(page, url, hosts.rose);
          await waitReady(frame, logs, 'model viewer');
          await page.waitForTimeout(400);
          const shot = await page.locator('#f').screenshot();
          const red = fraction(shot, reddish);
          retainFailedRenderSample(shot, red, 0.03, 'GLB model');
          assert(red > 0.03, `model pixels: ${(red * 100).toFixed(2)}% red`);
          const model = await frame.evaluate(
            () =>
              (window as unknown as { __roseModel?: { triangles: number; format: string } })
                .__roseModel ?? null
          );
          assert(
            model?.format === 'glb' && model.triangles === 12,
            `viewer stats ${JSON.stringify(model)}`
          );
          assert(
            (await isolationProbe(frame)).origin === 'null',
            'viewer runs in an opaque origin'
          );
          process.stdout.write(`    glb viewer: ${(red * 100).toFixed(1)}% red pixels\n`);
        });
      },
    },
    {
      name: 'render: a framed display page reports its content height; a viewport-height layout stops growing',
      fn: async () => {
        const pages = {
          tall: `<!doctype html><html><body style="margin:0"><div style="height:2400px">tall ${RUN}</div></body></html>`,
          short: `<!doctype html><html><body style="margin:0"><div style="height:300px">short ${RUN}</div></body></html>`,
          viewport: `<!doctype html><html><body style="min-height:100vh">viewport ${RUN}</body></html>`,
        };
        const urls: Record<string, string> = {};
        for (const [name, html] of Object.entries(pages)) {
          const res = await display(
            otherA,
            { items: [b64(Buffer.from(html), `${name}.html`)] },
            { apiKeyUser: userA }
          );
          assert(res.status === 201 || res.status === 200, `display ${name} ${res.status}`);
          urls[name] = local(items(res)[0].file_pointer.usercontent_url ?? '');
        }
        await withBrowser(async (page, _logs, hosts) => {
          const fit = (name: string) => `${hosts.rose}?fit=1&src=${encodeURIComponent(urls[name])}`;
          await page.goto(fit('tall'));
          await frameHeightWhen(page, (h) => h === 2400, 'tall page grows to its content');
          await page.goto(fit('short'));
          await frameHeightWhen(page, (h) => h === 300, 'short page shrinks to its content');
          // body min-height:100vh + its 8px margins is always 16px taller than the frame.
          await page.goto(fit('viewport'));
          await frameHeightWhen(page, (h) => h > 400, 'viewport page reports once');
          await page.waitForTimeout(1500);
          const settled = await frameHeightWhen(page, (h) => h > 0, 'viewport page');
          assert(settled <= 432, `viewport-height page stopped growing: ${settled}px`);
          await page.waitForTimeout(1000);
          const later = await frameHeightWhen(page, (h) => h > 0, 'viewport page later');
          assert(later === settled, `viewport-height page is stable: ${settled} → ${later}px`);
          await page.goto(urls.tall);
          const topLevel = await page
            .mainFrame()
            .evaluate(() => document.querySelectorAll('script[data-rose-display-height]').length);
          assert(topLevel === 1, `served page carries one height reporter (${topLevel})`);
        });
      },
    },
    {
      name: 'render: frame-ancestors refuses a non-Rose embedder; a top-level open is still opaque',
      fn: async () => {
        const res = await display(
          otherA,
          { items: [b64(Buffer.from(threeCdnPage(`ancestors-${RUN}`)), 'cube.html')] },
          { apiKeyUser: userA }
        );
        assert(res.status === 201 || res.status === 200, `display page ${res.status}`);
        const url = local(items(res)[0].file_pointer.usercontent_url ?? '');
        await withBrowser(async (page, _logs, hosts) => {
          const frame = await displayFrame(page, url, hosts.foreign);
          await page.waitForTimeout(1500);
          const state = await frame
            .evaluate(() => document.documentElement.dataset.state ?? null)
            .catch(() => null);
          assert(
            state !== 'ready' && state !== 'loading',
            `foreign embedder must not load the page (state ${state}, url ${frame.url()})`
          );
          await page.goto(url);
          const origin = await page.mainFrame().evaluate(() => self.origin);
          assert(origin === 'null', `top-level display document is sandboxed: ${origin}`);
        });
      },
    },
  ];
}
