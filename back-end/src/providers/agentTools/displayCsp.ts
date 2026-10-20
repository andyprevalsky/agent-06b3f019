/**
 * Response policy for everything the `display` tool serves on usercontent:
 * pages, multi-file bundles, and the built-in model / PDF viewers.
 *
 *   GET /usercontent/display/<agentId>/<sha256>.html          (single page)
 *   GET /usercontent/display/<agentId>/<bundleHash>/<path>    (bundle file)
 *     └─ Content-Security-Policy: displayCsp()  + Referrer-Policy: no-referrer
 *
 * Displayed content runs arbitrary agent-written CSS + JS: CDN scripts and
 * modules (three.js from jsDelivr/unpkg/esm.sh), inline scripts, eval,
 * WebGL/WebGPU, WebAssembly, blob: workers, web fonts, fetch/XHR/WebSocket to
 * the public web, audio and video.
 *
 * Isolation comes from the origin, not from the script policy:
 *   - served only from the usercontent origin (USERCONTENT_BASE_URL in prod),
 *     never the app origin, and framed by the FE with DISPLAY_IFRAME_SANDBOX
 *     (never allow-same-origin);
 *   - the response's own `sandbox` directive gives the document an opaque
 *     origin even when it is opened top-level, so it never shares usercontent
 *     storage with published apps or other displays;
 *   - opaque origin ⇒ no Rose cookies, localStorage, IndexedDB or service
 *     workers, and no parent DOM access; no top navigation, forms or modals;
 *   - frame-ancestors limits who may embed it to Rose's own origins.
 * What it gives up: a page can send anything the agent put in it to any host
 * (connect-src *, image beacons) and runs third-party scripts. no-referrer
 * keeps the display URL out of those requests.
 */
import { resolveAllowedOrigins } from '../corsConfig';

/** The ONLY sandbox flags a display frame gets (FE iframe + response CSP). */
export const DISPLAY_IFRAME_SANDBOX = 'allow-scripts allow-pointer-lock allow-popups';

const DEV_FRAME_ANCESTORS = ['http://localhost:*', 'http://127.0.0.1:*', 'https://*.vercel.app'];

/**
 * Sources allowed to frame display content: the usercontent origin itself,
 * the CORS-allowed Rose web origins, `file:` for the packaged Mac app
 * (Electron loadFile), local/Vercel hosts outside production, plus optional
 * extra sources from DISPLAY_FRAME_ANCESTORS (space or comma separated).
 */
export function displayFrameAncestors(env: Readonly<NodeJS.ProcessEnv> = process.env): string[] {
  const extra = (env.DISPLAY_FRAME_ANCESTORS ?? '').split(/[\s,]+/).filter(Boolean);
  const dev = env.NODE_ENV === 'production' ? [] : DEV_FRAME_ANCESTORS;
  return [...new Set(["'self'", ...resolveAllowedOrigins(env), ...dev, 'file:', ...extra])];
}

export function buildDisplayCsp(env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const any = "* data: blob: 'unsafe-inline' 'unsafe-eval'";
  return [
    `default-src ${any}`,
    `script-src ${any} 'wasm-unsafe-eval'`,
    'connect-src * data: blob:',
    'worker-src * data: blob:',
    `frame-ancestors ${displayFrameAncestors(env).join(' ')}`,
    `sandbox ${DISPLAY_IFRAME_SANDBOX}`,
  ].join('; ');
}

let cached: { key: string; csp: string } | null = null;

/** The display CSP for this process (recomputed only when its inputs change). */
export function displayCsp(): string {
  const env = process.env;
  const key = `${env.NODE_ENV}|${env.ALLOWED_ORIGINS}|${env.DISPLAY_FRAME_ANCESTORS}`;
  if (cached?.key !== key) cached = { key, csp: buildDisplayCsp(env) };
  return cached.csp;
}

/**
 * Headers for every display response (page, bundle file, viewer asset). A raw
 * PDF (opened top-level from the PDF viewer's "open" link) drops only the
 * `sandbox` directive: Chromium refuses to render a PDF in a sandboxed
 * document, and a PDF runs no script on the usercontent origin.
 */
export function displayResponseHeaders(contentType = ''): Record<string, string> {
  const csp = displayCsp();
  return {
    'Content-Security-Policy': contentType.startsWith('application/pdf')
      ? csp.replace(/; sandbox [^;]*$/, '')
      : csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
}
