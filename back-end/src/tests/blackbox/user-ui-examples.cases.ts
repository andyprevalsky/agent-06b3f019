/**
 * user-ui blackbox cases: the shipped seed (README + hyper-expressive examples)
 * and the session tooling around it. Registered by user-ui.blackbox.ts.
 *
 *   userUiSeedFiles() ──► every example present, README indexes them,
 *                         seed bundle validates as a publishable manifest
 *   seed + manifest wiring all examples ──► real `rose-ui publish` ──► usercontent
 *                         serves each entry and asset with the right type + CSP
 *   prepareUserUiWorkspace(active user) ──► CLI + preview host installed,
 *                         ROSE_UI_PUBLISHED_* env points at the active version
 */
import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { validateUserUiBundle } from '../../providers/userUi/manifest';
import {
  USER_UI_CLI_VERSION,
  USER_UI_PREVIEW_HOST_PATH,
  USER_UI_SEED_EXAMPLES,
  userUiCliScript,
  userUiReadme,
  userUiSeedFiles,
} from '../../providers/userUi/seed';
import { prepareUserUiWorkspace } from '../../providers/userUi/workspace';

const execFileAsync = promisify(execFile);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export interface UserUiCaseContext {
  baseUrl: string;
  /** JWT of a user with at least one published version. */
  token: () => string;
  userId: () => string;
  mintPublishToken: (auth: string) => Promise<string>;
}

/** A manifest that wires every hyper-expressive example into a real slot. */
const ALL_EXAMPLES_MANIFEST = {
  version: 1,
  theme: 'root/theme.json',
  shell: { entry: 'examples/rose-os/index.html' },
  slots: {
    background: { entry: 'examples/shader-background/index.html' },
    menu: { entry: 'examples/media-menu/index.html' },
    'home.dashboard': { entry: 'examples/agent-dashboard/index.html' },
    'agent.panel': { entry: 'examples/particles-worker/index.html' },
  },
  inline: {
    hello: { entry: 'examples/inline-hello/index.html', summary: 'Hello counter' },
    growth: { entry: 'examples/wasm-viz/index.html', summary: 'Rust to WASM growth simulation' },
  },
  capabilities: ['read'],
};

/** Assets the examples load at runtime, with the content type each needs. */
const RUNTIME_ASSETS: [string, string][] = [
  ['examples/wasm-viz/viz.wasm', 'application/wasm'],
  ['examples/particles-worker/particles.worker.js', 'text/javascript; charset=utf-8'],
  ['examples/media-menu/orb.mp4', 'video/mp4'],
  ['examples/media-menu/orb.avif', 'image/avif'],
  ['examples/media-menu/orb.webp', 'image/webp'],
];

export function userUiExampleCases(ctx: UserUiCaseContext) {
  return [
    {
      name: 'seed ships every example and the README indexes them',
      fn: async () => {
        const files = userUiSeedFiles();
        const paths = new Set(files.map((f) => f.path));
        for (const name of USER_UI_SEED_EXAMPLES) {
          assert(paths.has(`examples/${name}/index.html`), `seed has examples/${name}/index.html`);
        }
        for (const [asset] of RUNTIME_ASSETS) assert(paths.has(asset), `seed has ${asset}`);
        assert(paths.has('examples/wasm-viz/src/lib.rs'), 'wasm example ships its Rust source');
        const total = files.reduce((sum, f) => sum + f.content.length, 0);
        assert(total < 512 * 1024, `seed stays small (${total} bytes)`);
        const readme = userUiReadme();
        for (const name of USER_UI_SEED_EXAMPLES) {
          assert(readme.includes(`examples/${name}`), `README indexes examples/${name}`);
        }
        for (const term of [
          'rose-ui screenshot',
          'rose-ui record',
          'rose-ui perf',
          'rose-ui check',
          'rose-ui dev',
          'screenshots/current',
          'worker-src blob:',
          '50 ms',
        ]) {
          assert(readme.includes(term), `README documents ${term}`);
        }
        assert(
          userUiCliScript().includes(`const CLI_VERSION = '${USER_UI_CLI_VERSION}'`),
          'CLI version matches USER_UI_CLI_VERSION'
        );
      },
    },
    {
      name: 'seed bundle and the all-examples manifest validate',
      fn: async () => {
        const seed = validateUserUiBundle(userUiSeedFiles());
        assert(seed.ok, `seed bundle invalid: ${seed.ok ? '' : seed.errors.join('; ')}`);
        const wired = validateUserUiBundle([
          ...userUiSeedFiles().filter((f) => f.path !== 'rose-ui.json'),
          { path: 'rose-ui.json', content: Buffer.from(JSON.stringify(ALL_EXAMPLES_MANIFEST)) },
        ]);
        assert(wired.ok, `all-examples bundle invalid: ${wired.ok ? '' : wired.errors.join('; ')}`);
      },
    },
    {
      name: 'every example publishes through the real CLI and serves with the right types',
      fn: async () => {
        const home = mkdtempSync(join(tmpdir(), 'rose-ui-examples-'));
        try {
          for (const file of userUiSeedFiles()) {
            const full = join(home, 'rose_user_ui', file.path);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, file.content);
          }
          writeFileSync(
            join(home, 'rose_user_ui', 'rose-ui.json'),
            JSON.stringify(ALL_EXAMPLES_MANIFEST)
          );
          // Local-only captures must never be published.
          mkdirSync(join(home, 'rose_user_ui', 'screenshots', 'current'), { recursive: true });
          writeFileSync(join(home, 'rose_user_ui', 'screenshots', 'current', 'home.png'), 'x');
          const cli = join(home, 'rose-ui');
          writeFileSync(cli, userUiCliScript(), { mode: 0o755 });
          const { stdout } = await execFileAsync(
            process.execPath,
            [cli, 'publish', '--no-activate'],
            {
              env: {
                PATH: process.env.PATH,
                HOME: home,
                ROSE_UI_PUBLISH_URL: `${ctx.baseUrl}/api/user-ui/versions`,
                ROSE_UI_PUBLISH_TOKEN: await ctx.mintPublishToken(ctx.token()),
              },
            }
          );
          const match = /published version ([0-9a-f-]{36}) \((\d+) files/.exec(stdout);
          assert(match, `cli output: ${stdout}`);
          assert(
            Number(match[2]) === userUiSeedFiles().length,
            `published ${match[2]} files; screenshots/ must be skipped`
          );
          const base = `${ctx.baseUrl}/usercontent/${match[1]}/`;
          const entries = [
            ALL_EXAMPLES_MANIFEST.shell.entry,
            ...Object.values(ALL_EXAMPLES_MANIFEST.slots).map((s) => s.entry),
            ...Object.values(ALL_EXAMPLES_MANIFEST.inline).map((v) => v.entry),
          ];
          for (const entry of entries) {
            const res = await fetch(`${base}${entry}`);
            assert(res.status === 200, `${entry} → ${res.status}`);
            assert(res.headers.get('content-type')?.startsWith('text/html'), `${entry} is html`);
            assert(
              res.headers.get('content-security-policy')?.includes('worker-src blob:'),
              `${entry} CSP allows blob: workers`
            );
            const html = await res.text();
            assert(html.includes("type: 'rose:ready'"), `${entry} posts rose:ready`);
          }
          const seedBytes = new Map(userUiSeedFiles().map((f) => [f.path, f.content]));
          for (const [asset, type] of RUNTIME_ASSETS) {
            const res = await fetch(`${base}${asset}`);
            assert(res.status === 200, `${asset} → ${res.status}`);
            assert(
              res.headers.get('content-type') === type,
              `${asset} type ${res.headers.get('content-type')}`
            );
            assert(
              res.headers.get('access-control-allow-origin') === '*',
              `${asset} CORS for opaque frames`
            );
            const bytes = Buffer.from(await res.arrayBuffer());
            assert(bytes.equals(seedBytes.get(asset)!), `${asset} bytes round-trip`);
          }
          const shot = await fetch(`${base}screenshots/current/home.png`);
          assert(shot.status === 404, 'screenshots/ was not published');
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'workspace installs the preview tooling and points at the published version',
      fn: async () => {
        const workspace = await prepareUserUiWorkspace(ctx.userId());
        assert(workspace.source.kind === 'active', 'user has an active version');
        const paths = workspace.files.map((f) => f.path);
        assert(paths.includes('.rose/bin/rose-ui'), 'CLI installed');
        assert(paths.includes(USER_UI_PREVIEW_HOST_PATH), 'preview host installed');
        const versionId = workspace.source.versionId;
        assert(workspace.envs.ROSE_UI_PUBLISHED_VERSION_ID === versionId, 'published version env');
        const published = workspace.envs.ROSE_UI_PUBLISHED_BASE_URL;
        assert(published?.endsWith(`/usercontent/${versionId}/`), `published base ${published}`);
        const manifest = await fetch(`${ctx.baseUrl}/usercontent/${versionId}/rose-ui.json`);
        assert(manifest.status === 200, 'published manifest is reachable for screenshots');
      },
    },
  ];
}
