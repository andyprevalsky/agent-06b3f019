/**
 * agent-tools blackbox cases: `display` runs JavaScript (.js / .mjs).
 * Registered by agent-tools.blackbox.ts.
 *
 *   scene.js (base64 | tree file | bundle entry | rose CLI path)
 *     └─► bundle: scene.js (+ the relative modules it imports)
 *                 + generated index.html (assets/display/script-viewer.html):
 *                   three.js import map, full-window body, module import of the script,
 *                   <html data-state="loading|ready|error">, error overlay
 *         kind "bundle", mime text/javascript, framed like any page (sandboxed CSP)
 *
 * Invariants: JS is accepted only under a declared .js/.mjs name (or a
 * JavaScript response) and only as UTF-8 text that is not markup; a script
 * bundle may not carry its own index.html; the generated page draws real
 * WebGL pixels from `import * as THREE from 'three'` in the sandboxed frame,
 * and a script that throws surfaces data-state="error" with its message.
 */
import { assertDisplayCsp, bundleBase, served, treeFile } from './agent-tools-display.cases';
import {
  displayFrame,
  fraction,
  isolationProbe,
  local,
  reddish,
  waitReady,
  withBrowser,
} from './agent-tools-render.cases';
import {
  assert,
  b64,
  bundleItem,
  display,
  expectStatus,
  items,
  otherA,
  rootA,
  RUN,
  userA,
  type BlackboxTest,
} from './agent-tools.support';

/** A three.js module that draws a spinning red cube full-window. */
export function threeCubeModule(tag = RUN): string {
  return `// cube ${tag}
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.z = 2.2;
const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
scene.add(cube);
renderer.setAnimationLoop(() => {
  cube.rotation.x += 0.01; cube.rotation.y += 0.013;
  renderer.render(scene, camera);
});
`;
}

function displayScriptCases(): BlackboxTest[] {
  return [
    {
      name: 'renderer: a .js module gets a generated module page (three.js import map) on usercontent',
      fn: async () => {
        const source = Buffer.from(threeCubeModule(`api-${RUN}`));
        const res = await display(
          otherA,
          { items: [b64(source, `scene-${RUN}.js`)] },
          { apiKeyUser: userA }
        );
        expectStatus(res, 201, 'display .js');
        const [item] = items(res);
        assert(
          item.kind === 'bundle' && item.mime_type === 'text/javascript',
          `${item.kind} ${item.mime_type}`
        );
        assert(
          item.file_pointer.bundle?.source === `scene-${RUN}.js` &&
            item.file_pointer.bundle.file_count === 2,
          JSON.stringify(item.file_pointer.bundle)
        );
        assert(item.file_pointer.usercontent_url?.endsWith('/index.html'), 'page is the entry');
        const page = await served(item.file_pointer.usercontent_url ?? '', 'page', 'text/html');
        assertDisplayCsp(page.headers.get('content-security-policy'), 'script page');
        const html = await page.text();
        assert(html.includes('<script type="importmap">'), 'import map');
        assert(html.includes('"three": "https://cdn.jsdelivr.net/npm/three@0.160.1/'), 'three');
        assert(html.includes('"three/addons/"'), 'three addons');
        assert(html.includes(`"src":"scene-${RUN}.js"`), 'page config names the script');
        const script = await served(
          `${bundleBase(item)}scene-${RUN}.js`,
          'script',
          'text/javascript'
        );
        assertDisplayCsp(script.headers.get('content-security-policy'), 'script file');
        assert(Buffer.from(await script.arrayBuffer()).equals(source), 'script bytes');

        const again = await display(
          otherA,
          { items: [b64(source, `scene-${RUN}.js`)] },
          { apiKeyUser: userA }
        );
        expectStatus(again, 200, 'same script again');
        assert(items(again)[0].status === 'duplicate', 'same script → duplicate');
      },
    },
    {
      name: 'renderer: a .mjs bundle entry and a tree .js bring the modules they import',
      fn: async () => {
        const entry = `import { spin } from './lib/spin-${RUN}.mjs'; import * as THREE from 'three'; spin(THREE);`;
        const res = await display(
          otherA,
          {
            items: [
              bundleItem('main.mjs', {
                'main.mjs': entry,
                [`lib/spin-${RUN}.mjs`]: 'export const spin = (T) => T;',
              }),
            ],
          },
          { apiKeyUser: userA }
        );
        expectStatus(res, 201, 'display .mjs bundle');
        const [bundle] = items(res);
        assert(
          bundle.kind === 'bundle' &&
            bundle.file_pointer.bundle?.source === 'main.mjs' &&
            bundle.file_pointer.bundle.entry === 'index.html' &&
            bundle.file_pointer.bundle.file_count === 3,
          JSON.stringify(bundle.file_pointer.bundle)
        );
        await served(`${bundleBase(bundle)}lib/spin-${RUN}.mjs`, 'imported module', 'text/');

        await treeFile(
          rootA,
          `orbit-${RUN}.js`,
          Buffer.from(`import { n } from './helper-${RUN}.js'; console.log(n);`),
          'text/javascript'
        );
        await treeFile(
          rootA,
          `helper-${RUN}.js`,
          Buffer.from('export const n = 1;'),
          'text/javascript'
        );
        const tree = await display(
          rootA,
          { items: [{ file: `orbit-${RUN}.js` }] },
          { apiKeyUser: userA }
        );
        expectStatus(tree, 201, 'display tree .js');
        const [orbit] = items(tree);
        assert(
          orbit.kind === 'bundle' && orbit.file_pointer.bundle?.file_count === 3,
          JSON.stringify(orbit.file_pointer.bundle)
        );
        await served(`${bundleBase(orbit)}helper-${RUN}.js`, 'tree import', 'text/javascript');
      },
    },
    {
      name: 'renderer: markup named .js, an undeclared script and a script bundle with index.html are refused',
      fn: async () => {
        const html = await display(
          otherA,
          { items: [b64(Buffer.from('<!doctype html><html><body>x</body></html>'), 'evil.js')] },
          { apiKeyUser: userA }
        );
        expectStatus(html, 400, 'markup named .js');
        const plain = await display(
          otherA,
          { items: [b64(Buffer.from("import * as THREE from 'three';"), 'scene.txt')] },
          { apiKeyUser: userA }
        );
        expectStatus(plain, 400, 'undeclared script');
        const clash = await display(
          otherA,
          {
            items: [
              bundleItem('main.js', { 'main.js': 'export {};', 'index.html': '<html></html>' }),
            ],
          },
          { apiKeyUser: userA }
        );
        expectStatus(clash, 400, 'script bundle with its own index.html');
        const details = JSON.stringify(clash.data);
        assert(details.includes('cannot contain index.html'), details);
      },
    },
  ];
}

function scriptRenderCases(): BlackboxTest[] {
  return [
    {
      name: "render: a .js module importing 'three' draws WebGL pixels in the sandboxed frame",
      fn: async () => {
        const res = await display(
          otherA,
          { items: [b64(Buffer.from(threeCubeModule(`render-${RUN}`)), 'cube.js')] },
          { apiKeyUser: userA }
        );
        assert(res.status === 201 || res.status === 200, `display .js ${res.status}`);
        const url = local(items(res)[0].file_pointer.usercontent_url ?? '');
        await withBrowser(async (page, logs, hosts) => {
          const frame = await displayFrame(page, url, hosts.rose);
          await waitReady(frame, logs, 'script page');
          await page.waitForTimeout(400);
          const red = fraction(await page.locator('#f').screenshot(), reddish);
          assert(red > 0.04, `WebGL cube pixels: ${(red * 100).toFixed(2)}% red`);
          const probe = await isolationProbe(frame);
          assert(probe.origin === 'null', `opaque origin: ${JSON.stringify(probe)}`);
          assert(probe.storage === 'SecurityError', `no storage: ${JSON.stringify(probe)}`);
          process.stdout.write(`    .js module page: ${(red * 100).toFixed(1)}% red pixels\n`);
        });
      },
    },
    {
      name: 'render: a .js module that throws shows its error on the page (data-state=error)',
      fn: async () => {
        const res = await display(
          otherA,
          {
            items: [b64(Buffer.from(`// ${RUN}\nthrow new Error('boom-${RUN}');\n`), 'broken.js')],
          },
          { apiKeyUser: userA }
        );
        assert(res.status === 201 || res.status === 200, `display broken .js ${res.status}`);
        const url = local(items(res)[0].file_pointer.usercontent_url ?? '');
        await withBrowser(async (page, _logs, hosts) => {
          const frame = await displayFrame(page, url, hosts.rose);
          await frame
            .waitForFunction(() => document.documentElement.dataset.state === 'error', undefined, {
              timeout: 30_000,
            })
            .catch(() => undefined);
          const seen = await frame.evaluate(() => ({
            state: document.documentElement.dataset.state ?? null,
            text: document.getElementById('rose-script-error')?.textContent ?? '',
          }));
          assert(
            seen.state === 'error' && seen.text.includes(`boom-${RUN}`),
            `error surfaced: ${JSON.stringify(seen)}`
          );
        });
      },
    },
  ];
}

export function displayScriptAllCases(): BlackboxTest[] {
  return [...displayScriptCases(), ...scriptRenderCases()];
}
