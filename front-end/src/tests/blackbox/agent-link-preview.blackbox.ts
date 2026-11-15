/**
 * /a/<agent-id> link previews (api/og/agent.ts, api/og/agent-image.tsx).
 *
 *   iMessage/Linq fetcher → /a/:id (vercel.json rewrite) → api/og/agent
 *     ├─ GET /index.html            (the normal app page)
 *     └─ GET api.roselabs.ai/api/agent-preview/:id  → { title, state }
 *   → index.html + agent og:title/description/image + restore of /?agent-id=<id>
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import agentPage, { IMAGE_VERSION } from '../../../api/og/agent';
import * as agentImage from '../../../api/og/agent-image';
import * as researchImage from '../../../api/og/image';
import { titleSize } from '../../../api/og/agent-image';
import { statusLine } from '../../../api/og/_agentPreview';

const INDEX = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
const ID = '15760726-8948-4430-8dea-0c1d6b5e53dd';

function stubFetch(preview: unknown, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/index.html')) return new Response(INDEX);
    if (preview instanceof Error) throw preview;
    return new Response(JSON.stringify(preview), { status });
  });
  return calls;
}

const page = (id: string) =>
  agentPage(new Request(`https://roselabs.ai/api/og/agent?agent-id=${id}`));
const meta = (html: string, key: string) =>
  html.match(new RegExp(`<meta\\s+(?:property|name)="${key}"\\s+content="([^"]*)"`))?.[1];

afterEach(() => vi.unstubAllGlobals());

describe('agent link preview page', () => {
  it('injects the agent title, status and per-state image, and reopens the agent', async () => {
    const calls = stubFetch({ title: 'California King Bed Transport', state: 'done' });
    const res = await page(ID);
    const html = await res.text();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(meta(html, 'og:title')).toBe('California King Bed Transport');
    expect(meta(html, 'og:description')).toBe('Done');
    expect(meta(html, 'og:image')).toBe(
      `https://roselabs.ai/api/og/agent-image?agent-id=${ID}&state=done&v=${IMAGE_VERSION}`,
    );
    expect(meta(html, 'twitter:image')).toBe(meta(html, 'og:image'));
    expect(meta(html, 'og:url')).toBe(`https://roselabs.ai/a/${ID}`);
    expect(html).not.toMatch(/og:video/);
    expect(html).toContain(`history.replaceState(null,'','/?agent-id=${ID}')`);
    expect(calls).toContain(`https://api.roselabs.ai/api/agent-preview/${ID}`);
  });

  it('escapes titles so a title can never break out of the tag', async () => {
    stubFetch({ title: 'Fix "quotes" & <script>', state: 'started' });
    const html = await (await page(ID)).text();
    expect(meta(html, 'og:title')).toBe('Fix &quot;quotes&quot; &amp; &lt;script&gt;');
    expect(meta(html, 'og:description')).toBe('Started · tap to follow along');
    expect(html).not.toContain('<script>"');
  });

  it('still serves the app page (generic tags) when the preview is unavailable', async () => {
    for (const failure of [new Error('timeout'), { error: 'Agent not found' }]) {
      stubFetch(failure, 404);
      const html = await (await page(ID)).text();
      expect(meta(html, 'og:title')).toBe(meta(INDEX, 'og:title'));
      expect(html).toContain(`history.replaceState(null,'','/?agent-id=${ID}')`);
      vi.unstubAllGlobals();
    }
  });

  it('never fetches preview data or rewrites the URL for a malformed id', async () => {
    const calls = stubFetch({ title: 'x', state: 'done' });
    const html = await (await page('not-a-uuid%27%3Cscript%3E')).text();
    expect(calls.every((url) => url.endsWith('/index.html'))).toBe(true);
    expect(html).not.toContain('replaceState');
  });
});

describe('link preview image runtime', () => {
  // Production regression (2026-11-15): Vercel's edge runtime blocks @vercel/og's
  // WebAssembly compile, so edge image functions returned empty PNGs.
  it('renders preview images on the Node runtime with a web GET handler', () => {
    for (const mod of [agentImage, researchImage] as Array<Record<string, unknown>>) {
      expect((mod.config as { runtime?: string } | undefined)?.runtime).not.toBe('edge');
      expect(typeof mod.GET).toBe('function');
    }
  });
});

describe('agent link preview image copy', () => {
  it('shows only the state, never run time or estimates', () => {
    expect(statusLine({ title: 't', state: 'started' })).toBe('Started · tap to follow along');
    expect(statusLine({ title: 't', state: 'done' })).toBe('Done');
    expect(statusLine({ title: 't', state: 'stopped' })).toBe('Stopped');
  });

  it('sizes every title (up to the 80-character cap) to fit three lines', () => {
    expect(titleSize('YC CLI Connection')).toBe(76);
    expect(titleSize('Connect my existing account iPhone using the')).toBe(64);
    expect(titleSize('x'.repeat(80))).toBe(54);
  });
});
