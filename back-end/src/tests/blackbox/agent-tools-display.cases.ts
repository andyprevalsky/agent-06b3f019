/**
 * agent-tools blackbox cases for the full inline renderer (L-DISPLAY3).
 * Registered by agent-tools.blackbox.ts; agent-tools-render.cases.ts renders
 * the same served pages in headless Chromium.
 *
 *   page   (.html)                 ─► /usercontent/display/<agent>/<sha>.html
 *   bundle (folder / page + refs)  ─► /usercontent/display/<agent>/<hash>/<path>
 *   model  (.glb .gltf .obj .stl)  ─► bundle + generated three.js viewer (index.html)
 *   pdf                            ─► bundle + generated pdf.js viewer
 *   every display response: permissive CSP + `sandbox` (opaque origin),
 *   frame-ancestors, no-referrer, nosniff; images/videos keep storage pointers
 *
 * Invariants: relative paths resolve inside the bundle and nowhere else;
 * content-addressed + idempotent per bundle hash; caps (500 files, 50 MB per
 * bundle, 20 MB per file) and unsafe paths reject the whole call; a Rose agent
 * displays tree files by name alone (.html brings the files it references).
 */
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { prisma } from '../../providers/database';
import {
  agentB,
  assert,
  b64,
  bundleItem,
  cubeGlb,
  display,
  displayMessages,
  expectStatus,
  items,
  minimalPdf,
  otherA,
  rootA,
  RUN,
  userA,
  usercontentFetch,
  type BlackboxTest,
  type DisplayItem,
} from './agent-tools.support';

/** A page that imports three.js from a CDN and renders a red cube (data-state=ready). */
export function threeCdnPage(tag = RUN): string {
  return `<!doctype html>
<html data-state="loading"><head><meta charset="utf-8"><title>cube ${tag}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}</style></head>
<body><script type="module">
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.min.js';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.z = 2.2;
const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
scene.add(cube);
let frames = 0;
renderer.setAnimationLoop(() => {
  cube.rotation.x += 0.01; cube.rotation.y += 0.013;
  renderer.render(scene, camera);
  if (++frames === 3) document.documentElement.dataset.state = 'ready';
});
</script></body></html>`;
}

/** Directives every display response must carry, parsed from the header. */
export function assertDisplayCsp(csp: string | null, label: string, { sandbox = true } = {}) {
  assert(csp, `${label}: CSP header present`);
  const directives = new Map(
    csp.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values] as const;
    })
  );
  const has = (name: string, ...values: string[]) => {
    const got = directives.get(name) ?? [];
    for (const value of values) assert(got.includes(value), `${label}: ${name} has ${value} (${csp})`);
  };
  has('default-src', '*', 'data:', 'blob:', "'unsafe-inline'", "'unsafe-eval'");
  has('script-src', '*', 'data:', 'blob:', "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'");
  has('connect-src', '*');
  has('worker-src', '*', 'blob:');
  has('frame-ancestors', "'self'", 'http://localhost:*');
  assert(!(directives.get('frame-ancestors') ?? []).includes('*'), `${label}: frame-ancestors is not *`);
  if (sandbox) {
    assert(
      JSON.stringify(directives.get('sandbox')) ===
        JSON.stringify(['allow-scripts', 'allow-pointer-lock', 'allow-popups']),
      `${label}: sandbox allow-scripts allow-pointer-lock allow-popups (${csp})`
    );
  } else {
    assert(!directives.has('sandbox'), `${label}: raw PDF has no sandbox directive`);
  }
  assert(!csp.includes('allow-same-origin'), `${label}: never allow-same-origin`);
}

async function served(url: string, label: string, type: string) {
  const res = await usercontentFetch(url);
  assert(res.status === 200, `${label}: ${url} → ${res.status}`);
  assert(
    (res.headers.get('content-type') ?? '').startsWith(type),
    `${label}: content-type ${res.headers.get('content-type')} (want ${type})`
  );
  assert(res.headers.get('referrer-policy') === 'no-referrer', `${label}: no-referrer`);
  assert(res.headers.get('x-content-type-options') === 'nosniff', `${label}: nosniff`);
  assert(res.headers.get('access-control-allow-origin') === '*', `${label}: CORS for opaque frames`);
  return res;
}

const bundleBase = (item: DisplayItem) => {
  const url = item.file_pointer.usercontent_url ?? '';
  return url.slice(0, url.lastIndexOf('/') + 1);
};

/** Put a file in the agent tree the way a code agent's output attachment lands. */
async function treeFile(agentId: string, name: string, content: Buffer, mime: string) {
  const storagePath = `${userA}/outputs/${randomUUID()}/${name.split('/').pop()}`;
  const dir = process.env.DISPLAY_STORAGE_LOCAL_DIR;
  assert(dir, 'DISPLAY_STORAGE_LOCAL_DIR is set by run-blackbox-tests.sh');
  mkdirSync(dirname(join(dir, storagePath)), { recursive: true });
  writeFileSync(join(dir, storagePath), content);
  await prisma.message.create({
    data: {
      agentId,
      role: 'ASSISTANT',
      text: '',
      filePointer: {
        id: randomUUID(),
        storage_path: storagePath,
        original_filename: name,
        mime_type: mime,
        size_bytes: content.length,
        created_at: new Date().toISOString(),
      },
    },
  });
}

const SITE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="css/site.css?v=2">
<script type="module" src="./js/app.mjs"></script></head>
<body><img src="img/logo.png" srcset="img/logo.png 1x, img/logo@2x.png 2x">
<a href="https://example.com/x.png">ext</a><a href="#top">top</a>
<script>fetch('data/points.json')</script></body></html>`;
const SITE_CSS = "body{background:url('../img/bg.png')} @import 'theme.css';";
const SITE_JS = "import { n } from './util.mjs'; import * as THREE from 'three'; console.log(n, THREE);";

export function displayRendererCases(): BlackboxTest[] {
  return [
    {
      name: 'renderer: a three.js CDN page is a page on usercontent with the permissive sandboxed CSP',
      fn: async () => {
        const page = threeCdnPage();
        const res = await display(otherA, { items: [b64(Buffer.from(page), 'cube.html')] }, { apiKeyUser: userA });
        expectStatus(res, 201, 'display page');
        const [item] = items(res);
        assert(item.kind === 'page' && item.file_pointer.kind === 'page', `kind page: ${item.kind}`);
        assert(item.mime_type === 'text/html', 'text/html');
        const url = item.file_pointer.usercontent_url ?? '';
        assert(/\/usercontent\/display\/[0-9a-f-]{36}\/[0-9a-f]{64}\.html$/.test(url), `page url ${url}`);
        const got = await served(url, 'page', 'text/html');
        assertDisplayCsp(got.headers.get('content-security-policy'), 'page');
        assert((await got.text()) === page, 'exact page bytes');
      },
    },
    {
      name: 'renderer: a multi-file site bundle resolves relative assets under one prefix',
      fn: async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
        const files = {
          'index.html': SITE_HTML.replace('<body>', `<body data-run="${RUN}">`),
          'css/site.css': SITE_CSS,
          'css/theme.css': 'h1{color:red}',
          'js/app.mjs': SITE_JS,
          'js/util.mjs': 'export const n = 1;',
          'img/logo.png': png,
          'img/bg.png': png,
          'data/points.json': '[1,2,3]',
        };
        const res = await display(otherA, { items: [bundleItem('index.html', files)] }, { apiKeyUser: userA });
        expectStatus(res, 201, 'display bundle');
        const [item] = items(res);
        assert(item.kind === 'bundle', `kind bundle: ${item.kind}`);
        const bundle = item.file_pointer.bundle;
        assert(bundle?.entry === 'index.html' && bundle.file_count === 8, JSON.stringify(bundle));
        assert(item.sha256 === bundle.hash, 'result sha256 is the bundle hash');
        const url = item.file_pointer.usercontent_url ?? '';
        assert(url.endsWith(`/usercontent/display/${otherA}/${bundle.hash}/index.html`), `entry url ${url}`);
        const entry = await served(url, 'entry', 'text/html');
        assertDisplayCsp(entry.headers.get('content-security-policy'), 'bundle entry');
        assert((await entry.text()).includes(`data-run="${RUN}"`), 'entry bytes');
        const base = bundleBase(item);
        for (const [path, type] of [
          ['css/site.css', 'text/css'],
          ['css/theme.css', 'text/css'],
          ['js/app.mjs', 'text/javascript'],
          ['js/util.mjs', 'text/javascript'],
          ['img/logo.png', 'image/png'],
          ['data/points.json', 'application/json'],
        ] as const) {
          const asset = await served(`${base}${path}`, path, type);
          assertDisplayCsp(asset.headers.get('content-security-policy'), path);
          const expected = files[path as keyof typeof files];
          assert(Buffer.from(await asset.arrayBuffer()).equals(Buffer.from(expected)), `${path} bytes`);
        }
        // Relative URLs from css/site.css resolve to img/bg.png inside the bundle.
        const bg = new URL('../img/bg.png', `${base}css/site.css`).toString();
        await served(bg, 'css-relative', 'image/png');
        for (const path of [
          `${base}missing.js`,
          `${base}..%2F..%2Fsecret`,
          `${base}.hidden`,
          url.replace(otherA, agentB),
          url.replace(bundle.hash, '0'.repeat(64)),
        ]) {
          const miss = await usercontentFetch(path);
          assert(miss.status === 404, `${path} must 404, got ${miss.status}`);
        }
        const again = await display(otherA, { items: [bundleItem('index.html', files)] }, { apiKeyUser: userA });
        expectStatus(again, 200, 'same bundle again');
        assert(items(again)[0].status === 'duplicate', 'same bundle → duplicate (content-addressed)');
        assert(items(again)[0].message_id === item.message_id, 'same message');
      },
    },
    {
      name: 'renderer: a .glb gets the built-in three.js viewer; .obj/.stl too; a PDF gets the pdf.js viewer',
      fn: async () => {
        const glb = cubeGlb([1, 0, 0, 1], RUN);
        const res = await display(otherA, { items: [b64(glb, 'cube.glb')] }, { apiKeyUser: userA });
        expectStatus(res, 201, 'display glb');
        const [item] = items(res);
        assert(item.kind === 'model' && item.mime_type === 'model/gltf-binary', `${item.kind} ${item.mime_type}`);
        assert(item.file_pointer.bundle?.source === 'cube.glb', JSON.stringify(item.file_pointer.bundle));
        assert(item.file_pointer.usercontent_url?.endsWith('/index.html'), 'viewer is the entry');
        const viewer = await served(item.file_pointer.usercontent_url ?? '', 'viewer', 'text/html');
        assertDisplayCsp(viewer.headers.get('content-security-policy'), 'viewer');
        const html = await viewer.text();
        assert(html.includes('three@0.160.1') && html.includes('OrbitControls'), 'three.js viewer');
        assert(html.includes('"src":"cube.glb"') && html.includes('"format":"glb"'), 'viewer config');
        const model = await served(`${bundleBase(item)}cube.glb`, 'model', 'model/gltf-binary');
        assert(Buffer.from(await model.arrayBuffer()).equals(glb), 'model bytes');

        const obj = `# ${RUN}\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`;
        const stl = `solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t ${RUN}\n`;
        const more = await display(
          otherA,
          { items: [b64(Buffer.from(obj), 'tri.obj'), b64(Buffer.from(stl), 'tri.stl')] },
          { apiKeyUser: userA }
        );
        expectStatus(more, 201, 'obj + stl');
        assert(items(more).every((i) => i.kind === 'model'), 'obj and stl are models');
        assert(items(more)[0].mime_type === 'model/obj' && items(more)[1].mime_type === 'model/stl', 'types');

        const pdf = minimalPdf(`Rose ${RUN}`);
        const doc = await display(otherA, { items: [b64(pdf, 'report.pdf')] }, { apiKeyUser: userA });
        expectStatus(doc, 201, 'display pdf');
        const [pdfItem] = items(doc);
        assert(pdfItem.kind === 'pdf' && pdfItem.mime_type === 'application/pdf', pdfItem.kind);
        const pdfViewer = await served(pdfItem.file_pointer.usercontent_url ?? '', 'pdf viewer', 'text/html');
        assertDisplayCsp(pdfViewer.headers.get('content-security-policy'), 'pdf viewer');
        assert((await pdfViewer.text()).includes('pdfjs-dist@'), 'pdf.js viewer');
        const raw = await served(`${bundleBase(pdfItem)}report.pdf`, 'raw pdf', 'application/pdf');
        assertDisplayCsp(raw.headers.get('content-security-policy'), 'raw pdf', { sandbox: false });
        assert(Buffer.from(await raw.arrayBuffer()).equals(pdf), 'pdf bytes');

        const rows = await displayMessages(otherA);
        const row = rows.find((r) => (r.metadata as { display: { sha256: string } }).display.sha256 === item.sha256);
        const meta = row?.metadata as { display: { media_kind: string }; excludeFromModel: boolean };
        assert(meta?.display.media_kind === 'model' && meta.excludeFromModel, 'row metadata media_kind');
        assert((row?.filePointer as { kind?: string }).kind === 'model', 'row file_pointer.kind');
      },
    },
    {
      name: 'renderer: a Rose agent displays tree files by name alone (page + referenced files, model)',
      fn: async () => {
        const page = `<!doctype html><html><head><link rel="stylesheet" href="site-${RUN}.css"></head><body><img src="assets/pic-${RUN}.png"><script src="missing.js"></script></body></html>`;
        await treeFile(rootA, `page-${RUN}.html`, Buffer.from(page), 'text/html');
        await treeFile(rootA, `site-${RUN}.css`, Buffer.from('body{color:#123}'), 'text/css');
        await treeFile(rootA, `pic-${RUN}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]), 'image/png');
        await treeFile(rootA, `chair-${RUN}.glb`, cubeGlb([0, 0.4, 1, 1], `tree-${RUN}`), 'model/gltf-binary');
        const res = await display(
          rootA,
          { items: [{ file: `page-${RUN}.html` }, { file: `chair-${RUN}.glb` }] },
          { apiKeyUser: userA }
        );
        expectStatus(res, 201, 'display tree files');
        const [site, chair] = items(res);
        assert(site.kind === 'bundle' && site.file_pointer.bundle?.file_count === 3, JSON.stringify(site.file_pointer.bundle));
        const base = bundleBase(site);
        await served(`${base}site-${RUN}.css`, 'tree css', 'text/css');
        await served(`${base}assets/pic-${RUN}.png`, 'tree image by basename', 'image/png');
        assert((await usercontentFetch(`${base}missing.js`)).status === 404, 'unresolved refs are skipped');
        assert(chair.kind === 'model' && chair.file_pointer.bundle?.source === `chair-${RUN}.glb`, 'tree model');
        const child = await display(rootA, { items: [{ file: `chair-${RUN}.glb` }] }, { apiKeyUser: userA });
        expectStatus(child, 200, 'same model again');
        assert(items(child)[0].status === 'duplicate', 'idempotent per bundle hash');
      },
    },
    {
      name: 'renderer: bundle caps and unsafe paths reject the whole call',
      fn: async () => {
        const before = (await displayMessages(otherA)).length;
        const page = '<!doctype html><p>x</p>';
        const tooMany: Record<string, string> = { 'index.html': page };
        for (let i = 0; i < 500; i += 1) tooMany[`f/${i}.txt`] = 'x';
        const cases: [string, unknown, string][] = [
          ['501 files', bundleItem('index.html', tooMany), 'at most 500'],
          ['file over 20 MB', bundleItem('index.html', { 'index.html': page, 'big.bin': Buffer.alloc(20 * 1024 * 1024 + 1) }), '20 MB'],
          [
            'bundle over 50 MB',
            bundleItem('index.html', {
              'index.html': page,
              'a.bin': Buffer.alloc(18 * 1024 * 1024),
              'b.bin': Buffer.alloc(18 * 1024 * 1024),
              'c.bin': Buffer.alloc(18 * 1024 * 1024),
            }),
            '50 MB',
          ],
          ['traversal', bundleItem('index.html', { 'index.html': page, '../x.js': '1' }), 'invalid path'],
          ['dot path', bundleItem('index.html', { 'index.html': page, '.env': 'S=1' }), 'invalid path'],
          ['absolute', bundleItem('index.html', { 'index.html': page, '/etc/x': '1' }), 'invalid path'],
          ['entry missing', bundleItem('main.html', { 'index.html': page }), 'not one of the files'],
          ['entry not renderable', bundleItem('notes.txt', { 'notes.txt': 'hi' }), 'must be an .html page'],
          ['html entry that is not html', bundleItem('index.html', { 'index.html': 'plain words' }), 'must be an .html page'],
          ['model bundle with index.html', bundleItem('cube.glb', { 'cube.glb': cubeGlb(), 'index.html': page }), 'cannot contain index.html'],
          ['bad base64', { bundle: { entry: 'index.html', files: [{ path: 'index.html', content_base64: '@@@' }] } }, 'not valid base64'],
          ['two sources', { ...bundleItem('index.html', { 'index.html': page }), url: 'https://example.com' }, 'exactly one'],
        ];
        for (const [label, item, detail] of cases) {
          const res = await display(otherA, { items: [b64(Buffer.from(`<!doctype html><p>${label}</p>`), 'ok.html'), item] }, { apiKeyUser: userA });
          expectStatus(res, 400, label);
          assert(JSON.stringify(res.data).includes(detail), `${label}: detail "${detail}" in ${JSON.stringify(res.data).slice(0, 300)}`);
        }
        const notModel = await display(otherA, { items: [b64(Buffer.from('<html>no</html>'), 'x.obj')] }, { apiKeyUser: userA });
        expectStatus(notModel, 400, 'html named .obj is not a model');
        assert((await displayMessages(otherA)).length === before, 'nothing posted by rejected calls');
      },
    },
  ];
}
