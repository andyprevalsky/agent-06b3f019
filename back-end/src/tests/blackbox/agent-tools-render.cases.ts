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
import { existsSync, readFileSync } from 'fs';
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

const hostHtml = (src: string) =>
  `<!doctype html><html><body style="margin:0;background:#fff">` +
  `<iframe id="f" sandbox="${SANDBOX}" src="${src}" style="border:0;width:640px;height:400px;display:block"></iframe>` +
  `</body></html>`;

/** The URL this test's backend serves for a display usercontent URL. */
const local = (url: string) => {
  const parsed = new URL(url);
  return `${BASE_URL}${parsed.pathname}`;
};

interface Hosts {
  rose: string;
  foreign: string;
}

async function withBrowser(
  fn: (page: Page, logs: string[], hosts: Hosts) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    const src = new URL(req.url ?? '/', 'http://x').searchParams.get('src') ?? '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(hostHtml(src));
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

async function displayFrame(page: Page, url: string, host: string): Promise<Frame> {
  await page.goto(`${host}?src=${encodeURIComponent(url)}`);
  for (let i = 0; i < 100; i += 1) {
    const frame = page.frames().find((f) => f !== page.mainFrame());
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error('display iframe never attached');
}

async function waitReady(frame: Frame, logs: string[], label: string) {
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
function fraction(png: Buffer, test: (r: number, g: number, b: number) => boolean): number {
  const img = cli.decodePng(png);
  let hits = 0;
  for (let i = 0; i < img.width * img.height; i += 1) {
    const o = i * img.channels;
    if (test(img.data[o], img.data[o + 1], img.data[o + 2])) hits += 1;
  }
  return hits / (img.width * img.height);
}

const reddish = (r: number, g: number, b: number) => r > 110 && r > g * 1.8 && r > b * 1.8;

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

function isolationProbe(frame: Frame) {
  return frame.evaluate<{ origin: string; cookie: string; storage: string; parent: string }>(
    ISOLATION_PROBE
  );
}

export function displayRenderCases(): BlackboxTest[] {
  return [
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
          const red = fraction(await page.locator('#f').screenshot(), reddish);
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
