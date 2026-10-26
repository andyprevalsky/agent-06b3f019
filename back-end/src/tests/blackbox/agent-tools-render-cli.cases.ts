/** Shipped rose CLI accepts renderer artifacts by filesystem path. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  AGENT_TOOLS_CLI_PATH,
  relocateAgentToolsWorkspace,
  withAgentTools,
} from '../../providers/agentTools/workspace';
import { materializeUserUiInLocalHome } from '../../providers/userUi/workspace';
import {
  assert,
  BASE_URL,
  cubeGlb,
  displayMessages,
  execFileAsync,
  otherA,
  RUN,
  userA,
  type BlackboxTest,
} from './agent-tools.support';
export function rendererCliCases(): BlackboxTest[] {
  return [
    {
      name: 'shipped rose CLI: a folder, a page with its files, and a 3D model display by path alone',
      fn: async () => {
        const home = mkdtempSync(join(tmpdir(), 'rose-tools-display-'));
        try {
          const created = withAgentTools(null, {
            userId: userA,
            agentId: otherA,
            taskId: `cli-render-${RUN}`,
            provider: 'claude',
          });
          assert(created !== null, 'workspace with tools');
          const workspace = relocateAgentToolsWorkspace(
            created,
            home,
            `${BASE_URL}/api/agent-tools/${otherA}`
          );
          assert((await materializeUserUiInLocalHome(home, workspace, otherA)) !== null, 'home');
          const cli = join(home, AGENT_TOOLS_CLI_PATH);
          const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
          delete env.ROSE_TOOLS_URL;
          delete env.ROSE_TOOLS_TOKEN;
          const write = (rel: string, content: string | Buffer) => {
            const full = join(home, rel);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, content);
          };
          // A site folder: index.html + nested assets; dot-files and node_modules stay local.
          write(
            'site/index.html',
            `<!doctype html><link rel="stylesheet" href="css/a.css"><p>${RUN}</p>`
          );
          write('site/css/a.css', 'p{color:red}');
          write('site/js/app.js', 'console.log(1)');
          write('site/.env', 'SECRET=1');
          write('site/node_modules/x/index.js', 'skipped');
          // A page next to files it does and does not reference.
          write(
            'work/page.html',
            `<!doctype html><script type="module" src="./main.mjs"></script><img src="pic.png"><p>${RUN}</p>`
          );
          write('work/main.mjs', "import './lib/util.mjs'; fetch('data.json');");
          write('work/lib/util.mjs', 'export default 1;');
          write('work/data.json', '{}');
          write('work/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]));
          write('work/notes-private.txt', 'not referenced, never uploaded');
          write('models/chair.glb', cubeGlb([0.2, 0.6, 1, 1], `cli-${RUN}`));
          write('empty-folder/readme.txt', 'no entry');

          const run = (...args: string[]) =>
            execFileAsync('node', [cli, 'display', ...args], { env });
          const site = await run(join(home, 'site'));
          assert(
            /displayed text\/html as bundle \(3 files\) at \S+\/index\.html/.test(site.stdout),
            `folder: ${site.stdout}`
          );
          const page = await run(join(home, 'work', 'page.html'));
          assert(
            /displayed text\/html as bundle \(5 files\)/.test(page.stdout),
            `page + refs: ${page.stdout}`
          );
          const model = await run(join(home, 'models', 'chair.glb'));
          assert(
            /displayed model\/gltf-binary as model \(2 files\) at \S+\/index\.html/.test(
              model.stdout
            ),
            `model: ${model.stdout}`
          );
          const again = await run(join(home, 'site'));
          assert(
            again.stdout.includes('already displayed text/html as bundle'),
            `folder again: ${again.stdout}`
          );

          const rows = (await displayMessages(otherA)).filter(
            (r) => (r.metadata as { task_id?: string }).task_id === `cli-render-${RUN}`
          );
          const pointers = rows.map(
            (r) =>
              r.filePointer as {
                kind: string;
                usercontent_url: string;
                bundle: { file_count: number };
              }
          );
          assert(
            JSON.stringify(pointers.map((p) => p.kind)) ===
              JSON.stringify(['bundle', 'bundle', 'model']),
            `own rows: ${JSON.stringify(pointers.map((p) => p.kind))}`
          );
          const pageUrl = new URL(pointers[1].usercontent_url);
          const base = `${BASE_URL}${pageUrl.pathname.slice(0, pageUrl.pathname.lastIndexOf('/') + 1)}`;
          for (const rel of ['main.mjs', 'lib/util.mjs', 'data.json', 'pic.png']) {
            assert(
              (await fetch(`${base}${rel}`)).status === 200,
              `${rel} served next to page.html`
            );
          }
          for (const rel of ['notes-private.txt', '.env']) {
            assert((await fetch(`${base}${rel}`)).status === 404, `${rel} was never uploaded`);
          }
          const siteUrl = new URL(pointers[0].usercontent_url);
          const siteBase = `${BASE_URL}${siteUrl.pathname.slice(0, siteUrl.pathname.lastIndexOf('/') + 1)}`;
          assert((await fetch(`${siteBase}js/app.js`)).status === 200, 'whole folder uploaded');
          assert(
            (await fetch(`${siteBase}node_modules/x/index.js`)).status === 404,
            'node_modules skipped'
          );

          const empty = await run(join(home, 'empty-folder')).then(
            () => null,
            (err: { code?: number; stderr?: string }) => err
          );
          assert(
            empty?.code === 1 && /needs an index\.html/.test(empty.stderr ?? ''),
            `no entry: ${empty?.stderr}`
          );
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
    },
  ];
}
